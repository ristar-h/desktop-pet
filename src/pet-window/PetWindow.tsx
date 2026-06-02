/**
 * PetWindow — Desktop Pet Floating Window (Standalone Version)
 *
 * Features:
 * 1. Loads animation frames from disk on startup
 * 2. State machine auto-switches actions based on system idle time
 * 3. Walk state moves the window across screen
 * 4. Click → happy, Drag → drag state
 * 5. Right-click context menu
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { DEFAULT_ACTION_SPECS, ALL_ACTIONS } from "../core/types";
import type { ActionState } from "../core/types";
import { PetStateMachine } from "./state-machine";
import { ContextMenu } from "../components/ContextMenu";
import { loadConfig, getPetSizePx, saveConfig } from "../utils/config-store";
import type { AppConfig } from "../utils/config-store";

const DEFAULT_AVATAR_ID = "default";

// 缩放范围与步长
const MIN_PET_SIZE = 80;
const MAX_PET_SIZE = 320;
const WHEEL_STEP = 10;

// 桌宠四周留白（用于显示右键菜单 + 接收"空白处"点击）
// 总窗口尺寸 = petSize + 2 * FRAME_PADDING
const FRAME_PADDING = 220;

// 热区检测用的隐藏 canvas 尺寸（小一些节省内存即可）
const HIT_CANVAS_SIZE = 64;
// alpha 阈值：小于此值视为透明（不响应事件）
const HIT_ALPHA_THRESHOLD = 30;

export function PetWindow() {
  const [actionFrames, setActionFrames] = useState<Partial<Record<ActionState, string[]>>>({});
  const [currentAction, setCurrentAction] = useState<ActionState>("idle");
  const [frameIndex, setFrameIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [petSize, setPetSize] = useState(180);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [currentAvatarId, setCurrentAvatarId] = useState(DEFAULT_AVATAR_ID);
  // 菜单开关动画期间临时隐藏桌宠：
  // 期间 Tauri 窗口位置/尺寸 与 React padding 状态会有 ~1 帧不一致，
  // 不隐藏的话桌宠会"闪到屏幕左上角"。隐藏期 ~150ms，肉眼无感知。
  const [isWindowTransitioning, setIsWindowTransitioning] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateMachineRef = useRef<PetStateMachine | null>(null);
  const walkAnimRef = useRef<number | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  const hitCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const saveSizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 当前窗口实际使用的 padding（菜单展开时 = FRAME_PADDING，否则 = 0）
  const currentPaddingRef = useRef<number>(0);
  // 同步 menuOpen 给非 React 回调（如原生 wheel 监听）
  const menuOpenRef = useRef<boolean>(false);
  // 启动时待应用的 baseAction（在状态机启动后再 setBaseAction）
  const pendingBaseActionRef = useRef<ActionState | null>(null);
  // 所有 Tauri event listener 的 unlisten 句柄，cleanup 时统一移除
  // （StrictMode 在 dev 下会让 useEffect 跑两次，必须能移除避免重复响应）
  const unlistensRef = useRef<Array<() => void>>([]);
  /**
   * walk 移动的 Generation 计数器：每次启动新 walk 递增。
   * await 期间状态可能已被切走（race condition），通过比对 generation 立即退出过期循环。
   */
  const walkGenerationRef = useRef<number>(0);
  // 同步最新的 petSize 给闭包/异步函数读取（避免 stale closure）
  const petSizeRef = useRef<number>(180);

  // 每次 render 同步最新的 petSize 到 ref
  petSizeRef.current = petSize;

  // ---- Initialization ----
  useEffect(() => {
    init();
    return () => {
      stateMachineRef.current?.stop();
      if (walkAnimRef.current) cancelAnimationFrame(walkAnimRef.current);
      // 统一移除所有 Tauri event listener，避免 StrictMode 双 mount / 重新初始化时的重复响应
      unlistensRef.current.forEach((u) => {
        try {
          u();
        } catch {}
      });
      unlistensRef.current = [];
    };
  }, []);

  async function init() {
    const config = await loadConfig();
    if (config) {
      configRef.current = config;
      // 优先使用自定义尺寸，否则用三档预设
      const customSize = (config as AppConfig & { customPetSize?: number }).customPetSize;
      const initialSize =
        typeof customSize === "number" && customSize >= MIN_PET_SIZE && customSize <= MAX_PET_SIZE
          ? customSize
          : getPetSizePx(config.petSize);
      setPetSize(initialSize);
      petSizeRef.current = initialSize;
      // 启动时同步窗口尺寸
      resizePetWindow(initialSize);

      // 恢复上次位置（如果有）
      const lastPos = config.lastPosition;
      if (lastPos && Number.isFinite(lastPos.x) && Number.isFinite(lastPos.y)) {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const { LogicalPosition } = await import("@tauri-apps/api/dpi");
          const { x, y } = clampToScreen(lastPos.x, lastPos.y, initialSize);
          await getCurrentWindow().setPosition(new LogicalPosition(x, y));
        } catch {}
      }

      // 恢复 baseAction（M6）
      const savedBaseAction = (config as AppConfig & { baseAction?: ActionState }).baseAction;

      // 读取当前形象 ID
      const savedAvatarId = config.currentAvatarId;
      if (savedAvatarId && /^[a-zA-Z0-9_-]{1,64}$/.test(savedAvatarId)) {
        setCurrentAvatarId(savedAvatarId);
        await loadAllActions(savedAvatarId);
      } else {
        await loadAllActions(DEFAULT_AVATAR_ID);
      }

      // 把 savedBaseAction 在状态机启动后应用
      if (savedBaseAction && ALL_ACTIONS.includes(savedBaseAction as ActionState)) {
        pendingBaseActionRef.current = savedBaseAction;
      }
    } else {
      await loadAllActions();
    }

    setupSystemIdleListener();
    initStateMachine();
  }

  /**
   * 把 (x, y) 限制在屏幕可视区域内。
   * 拖动场景：保证桌宠整体可见（防止用户拖到屏幕外丢失）。
   */
  function clampToScreen(x: number, y: number, size: number): { x: number; y: number } {
    const sw = window.screen.availWidth;
    const sh = window.screen.availHeight;
    return {
      x: Math.max(0, Math.min(sw - size, Math.round(x))),
      y: Math.max(0, Math.min(sh - size, Math.round(y))),
    };
  }

  // ---- Hide / Fade-In helpers ----
  // 任何用户触发的视觉切换（菜单开关、动作切换、形象切换、远程 force-action）都必须：
  //   1. 同步 DOM 隐藏桌宠（绕过 React batching，立即生效，避免下一次 paint 闪一下旧/新形象）
  //   2. 在 React 状态、Tauri 窗口、frame 都稳定后再淡入
  // 注意：自动状态机切换（idle ↔ stretch ↔ looking_around）不走这条路，否则会一直 fade。
  const hidePetSync = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.style.transition = "none";
      containerRef.current.style.opacity = "0";
      containerRef.current.style.visibility = "hidden";
    }
    setIsWindowTransitioning(true);
  }, []);

  const showPetFadeIn = useCallback(() => {
    // 双 RAF 确保 React commit + 浏览器 paint + Tauri 窗口尺寸都已生效
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.style.visibility = "visible";
          containerRef.current.style.transition = "opacity 0.15s ease";
          containerRef.current.style.opacity = "1";
        }
        setIsWindowTransitioning(false);
      });
    });
  }, []);

  // ---- State Machine ----
  function initStateMachine() {
    const sm = new PetStateMachine();

    sm.onChange((newState, prevState) => {
      console.log(`[Pet] ${prevState} → ${newState}`);
      setCurrentAction(newState);
      setFrameIndex(0);

      // Start/stop walk movement
      if (newState === "walk") {
        startWalkMovement();
      } else if (prevState === "walk") {
        stopWalkMovement();
      }

      // Flip direction for looking_around randomly
      if (newState === "looking_around") {
        setFacingLeft(Math.random() > 0.5);
      }
    });

    sm.start();
    stateMachineRef.current = sm;

    // 应用启动时恢复的 baseAction
    if (pendingBaseActionRef.current) {
      sm.setBaseAction(pendingBaseActionRef.current);
      pendingBaseActionRef.current = null;
    }
  }

  // ---- System Idle Listener (from Rust backend) ----
  async function setupSystemIdleListener() {
    try {
      const { listen } = await import("@tauri-apps/api/event");

      const u1 = await listen<number>("system:idle-time", (event) => {
        const idleSecs = event.payload;
        stateMachineRef.current?.updateIdleTime(idleSecs);
      });
      unlistensRef.current.push(u1);

      // Listen for settings changes from main window
      const u2 = await listen<{ action: string }>("pet:force-action", (event) => {
        const action = event.payload.action as ActionState;
        // 同步隐藏，避免远程切换动作时旧形象在新位置/新动作切换瞬间闪一下
        hidePetSync();
        // 通过状态机设为新的 baseAction（不破坏其他自动转换规则）
        stateMachineRef.current?.setBaseAction(action);
        setFrameIndex(0);
        // 持久化 baseAction（防抖）
        persistBaseAction(action);
        showPetFadeIn();
      });
      unlistensRef.current.push(u2);

      const u3 = await listen("pet:reload", () => {
        loadAllActions();
      });
      unlistensRef.current.push(u3);

      const u4 = await listen<{ frames: string[]; action?: ActionState }>(
        "pet:update-frames",
        (event) => {
          const { frames, action } = event.payload;
          const targetAction = action ?? "idle";
          setActionFrames((prev) => ({ ...prev, [targetAction]: frames }));
        }
      );
      unlistensRef.current.push(u4);

      const u5 = await listen<{ size: number }>("pet:resize", (event) => {
        setPetSize(event.payload.size);
        petSizeRef.current = event.payload.size;
        resizePetWindow(event.payload.size);
      });
      unlistensRef.current.push(u5);

      // 切换形象（重新生成完成后会触发）
      const u6 = await listen<{ avatarId: string }>(
        "pet:switch-avatar",
        async (event) => {
          const id = event.payload.avatarId;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return;
          // 立即隐藏旧形象：loadAllActions 可能要 200~500ms 读盘+解码，
          // 这期间 actionFrames 还是旧形象，frame 计时器还在跑 → 不隐藏会看到旧形象继续频闪
          hidePetSync();
          setCurrentAvatarId(id);
          await loadAllActions(id);
          // 切换形象时回到 baseAction：通过状态机走 transition，
          // 这会触发 onChange → 自然 stopWalkMovement，避免 walk 中切形象后
          // 状态机仍 walk 但 React 显示静态图、桌宠"飘"过屏幕的 bug
          const sm = stateMachineRef.current;
          if (sm) {
            const base = sm.getBaseAction();
            sm.setBaseAction(base);
          }
          showPetFadeIn();
        }
      );
      unlistensRef.current.push(u6);
    } catch (err) {
      console.error("[Pet] Event listener setup failed:", err);
    }
  }

  // ---- Load Frames from Disk ----
  async function loadAllActions(avatarId?: string) {
    const targetId = avatarId ?? currentAvatarId;
    try {
      const fs = await import("@tauri-apps/plugin-fs");
      const path = await import("@tauri-apps/api/path");
      const appData = await path.appDataDir();
      const avatarDir = await path.join(appData, "avatars", targetId);

      const loaded: Partial<Record<ActionState, string[]>> = {};

      for (const action of ALL_ACTIONS) {
        try {
          const actionDir = await path.join(avatarDir, action);
          const exists = await fs.exists(actionDir);
          if (!exists) continue;

          const entries = await fs.readDir(actionDir);
          const pngFiles = entries
            .filter((e) => e.name?.endsWith(".png"))
            .map((e) => e.name!)
            .sort();

          if (pngFiles.length === 0) continue;

          const dataUrls: string[] = [];
          for (const fileName of pngFiles) {
            const filePath = await path.join(actionDir, fileName);
            const binary = await fs.readFile(filePath);
            const base64 = uint8ToBase64(binary);
            dataUrls.push(`data:image/png;base64,${base64}`);
          }
          loaded[action] = dataUrls;
        } catch (err) {
          console.warn(`[Pet] Failed to load ${action}:`, err);
        }
      }

      setActionFrames(loaded);
      console.log("[Pet] Loaded actions:", Object.keys(loaded).length);
    } catch (err) {
      console.error("[Pet] Disk load failed:", err);
    }
  }

  // ---- Walk Movement (moves actual window position) ----
  async function startWalkMovement() {
    // 先停掉前一次的（如果有），并递增 generation 让正在 await 的旧调用作废
    stopWalkMovement();
    const myGeneration = ++walkGenerationRef.current;

    // 走路速度跟随桌宠尺寸（小桌宠看起来不会"飘"，大桌宠不显得拖步）
    const baseSpeed = 15 + Math.random() * 10; // 15-25 px/s
    const currentPetSize = petSizeRef.current;
    const speed = baseSpeed * (currentPetSize / 180); // 以 medium 180 为基准

    // 一次性获取 Tauri API 引用（后续帧不再动态 import）
    const winMod = await import("@tauri-apps/api/window");
    const dpiMod = await import("@tauri-apps/api/dpi");
    const win = winMod.getCurrentWindow();
    const LogicalPositionCls = dpiMod.LogicalPosition;

    // 获取桌宠所在屏的边界
    let monitorMinX = 0;
    let monitorMaxX = window.screen.availWidth;
    try {
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const m = await currentMonitor();
      if (m) {
        const sf = m.scaleFactor ?? 1;
        monitorMinX = m.position.x / sf;
        monitorMaxX = (m.position.x + m.size.width) / sf;
      }
    } catch {}

    // 关键检查：await 期间状态可能已变
    if (
      myGeneration !== walkGenerationRef.current ||
      stateMachineRef.current?.getState() !== "walk"
    ) {
      return;
    }

    // 读取当前真实位置作为起点（一次性，后续帧不再读取）
    let trackX: number;
    let trackY: number;
    try {
      const pos = await win.outerPosition();
      const sf = await win.scaleFactor();
      trackX = pos.x / sf;
      trackY = pos.y / sf;
    } catch {
      return;
    }

    // 再次确认 generation/state
    if (
      myGeneration !== walkGenerationRef.current ||
      stateMachineRef.current?.getState() !== "walk"
    ) {
      return;
    }

    /**
     * 决定走路方向：基于当前真实位置，避免在边界反复随机后立即撞墙停下。
     * - 贴近右边界（距离 < 1.5x petSize）→ 强制向左
     * - 贴近左边界（距离 < 1.5x petSize）→ 强制向右
     * - 中间区域 → 随机
     */
    let direction: 1 | -1;
    const edgeThreshold = currentPetSize * 1.5;
    const distFromRight = monitorMaxX - currentPetSize - trackX;
    const distFromLeft = trackX - monitorMinX;

    if (distFromRight < edgeThreshold && distFromLeft >= edgeThreshold) {
      direction = -1; // 贴右边 → 向左
    } else if (distFromLeft < edgeThreshold && distFromRight >= edgeThreshold) {
      direction = 1; // 贴左边 → 向右
    } else {
      direction = Math.random() > 0.5 ? 1 : -1;
    }
    setFacingLeft(direction === -1);

    let lastTime = performance.now();

    /**
     * moveStep 是同步函数 — 无 await，无 race condition。
     * 位置用本地浮点变量 trackX 追踪，亚像素不丢失。
     * setPosition 以 fire-and-forget 方式调用，不阻塞帧循环。
     */
    function moveStep() {
      // 仅需一个 generation/state 检查（同步函数无挂起点）
      if (
        myGeneration !== walkGenerationRef.current ||
        stateMachineRef.current?.getState() !== "walk"
      ) {
        walkAnimRef.current = null;
        return;
      }

      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      // 本地浮点追踪位移（亚像素不丢失）
      trackX += direction * speed * dt;

      // 边界检测 + 撞墙调头
      const maxX = monitorMaxX - petSizeRef.current;
      if (trackX < monitorMinX) {
        trackX = monitorMinX;
        direction = 1;
        setFacingLeft(false);
      } else if (trackX > maxX) {
        trackX = maxX;
        direction = -1;
        setFacingLeft(true);
      }

      // Fire-and-forget 设置窗口位置（不 await，避免阻塞帧循环）
      win.setPosition(new LogicalPositionCls(Math.round(trackX), Math.round(trackY)));

      // 调度下一帧
      walkAnimRef.current = requestAnimationFrame(moveStep);
    }

    walkAnimRef.current = requestAnimationFrame(moveStep);
  }

  function stopWalkMovement() {
    // 递增 generation 让所有进行中的 await 闭包失效
    walkGenerationRef.current++;
    if (walkAnimRef.current) {
      cancelAnimationFrame(walkAnimRef.current);
      walkAnimRef.current = null;
    }
  }

  // ---- Resize Pet Window ----
  /**
   * 重设窗口尺寸（按"当前 padding"计算窗口实际大小）。
   * 仅当菜单打开时窗口才会扩大；菜单关时窗口紧贴桌宠像素，避免拦截其他应用事件。
   *
   * @param newPetSize 桌宠形象的目标像素尺寸
   * @param oldPetSize 之前的桌宠尺寸（用于位置补偿）；省略则不补偿位置
   * @param paddingOverride 强制使用的 padding；省略时取 currentPaddingRef.current
   */
  async function resizePetWindow(
    newPetSize: number,
    oldPetSize?: number,
    paddingOverride?: number
  ) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
      const win = getCurrentWindow();

      const padding = paddingOverride ?? currentPaddingRef.current;
      const newWinSize = newPetSize + 2 * padding;

      // 位置补偿：桌宠在窗口内居中，所以缩放时窗口左上角要反向偏移 (Δsize/2)
      if (typeof oldPetSize === "number") {
        try {
          const pos = await win.outerPosition();
          const scaleFactor = await win.scaleFactor();
          const oldX = pos.x / scaleFactor;
          const oldY = pos.y / scaleFactor;
          const offset = (oldPetSize - newPetSize) / 2;
          await win.setPosition(
            new LogicalPosition(Math.round(oldX + offset), Math.round(oldY + offset))
          );
        } catch {}
      }

      await win.setSize(new LogicalSize(newWinSize, newWinSize));
    } catch {}
  }

  /**
   * 切换菜单的展开/收起 + 同步调整窗口尺寸+位置，保持桌宠视觉位置不变。
   *
   * 关键时序：避免 React 渲染与 Tauri 窗口尺寸不同步导致桌宠"瞬间消失"
   *   - 打开：先扩 Tauri 窗口，再 setMenuOpen(true) 触发 React 渲染
   *   - 关闭：先 setMenuOpen(false) 触发 React 渲染，再缩 Tauri 窗口
   *
   * 打开时窗口左上角往左上偏移 FRAME_PADDING，关闭时往右下偏移
   */
  async function setMenuOpenAndAdjustWindow(open: boolean) {
    if (open === menuOpenRef.current) return;
    menuOpenRef.current = open;

    // 关键修复：菜单打开/关闭时都先停止 walk 动画
    // - 打开：避免 moveStep 覆写菜单 padding 位置导致 220px 跳变
    // - 关闭：避免「在菜单里切到 walk」时，walk 用还带 padding 偏移的坐标起跑，
    //   再和菜单关闭的位置调整互相覆写导致 220px 跳变
    // 关闭分支末尾会根据 state 重新启动 walk（用关闭后正确的位置作为起点）
    const wasWalking = stateMachineRef.current?.getState() === "walk";
    if (wasWalking) {
      stopWalkMovement();
    }

    // 立即（同步、绕过 React batching）通过 DOM 隐藏桌宠
    // 这样在 React 渲染下一帧（带新动作或新 padding）之前，浏览器先看到 visibility:hidden
    // 否则会闪一下「新动作旧位置」或「旧动作新位置」
    hidePetSync();

    const newPadding = open ? FRAME_PADDING : 0;
    // 用 ref 读最新的 petSize（避免 stale closure：handleSetSize 刚改了 size 立即关菜单时）
    const currentPetSize = petSizeRef.current;
    const newWinSize = currentPetSize + 2 * newPadding;
    const offset = open ? -FRAME_PADDING : FRAME_PADDING;

    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const sf = await win.scaleFactor();
      const oldX = pos.x / sf;
      const oldY = pos.y / sf;
      const newPos = new LogicalPosition(
        Math.round(oldX + offset),
        Math.round(oldY + offset)
      );
      const newSize = new LogicalSize(newWinSize, newWinSize);

      if (open) {
        // 打开：Tauri 窗口先扩大并移动到新位置，最后才触发 React 渲染
        await win.setSize(newSize);
        await win.setPosition(newPos);
        currentPaddingRef.current = newPadding;
        setMenuOpen(true);
      } else {
        // 关闭：React 先渲染（窗口内桌宠回到 (0,0)），等下一帧再缩 Tauri 窗口
        currentPaddingRef.current = newPadding;
        setMenuOpen(false);
        // 等两帧确保 React 已 commit + paint
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        );
        await win.setPosition(newPos);
        await win.setSize(newSize);

        // 关闭菜单后如果状态仍是 walk，从当前位置重新启动走路
        if (stateMachineRef.current?.getState() === "walk") {
          startWalkMovement();
        }
      }
    } catch {}

    // 不论成功失败，等一帧再淡入桌宠（让 Tauri 的位置/尺寸调整有时间生效）
    showPetFadeIn();
  }

  // ---- Frame Animation Loop ----
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const frames = getFramesForAction(currentAction);
    if (frames.length <= 1) return;

    const spec = DEFAULT_ACTION_SPECS[currentAction] ?? DEFAULT_ACTION_SPECS.idle;
    const interval = 1000 / spec.fps;

    timerRef.current = setInterval(() => {
      setFrameIndex((prev) => {
        const next = prev + 1;
        if (next >= frames.length) {
          if (spec.loop) {
            return 0;
          } else {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            setTimeout(() => {
              stateMachineRef.current?.dispatch({ type: "animation_complete" });
            }, 0);
            return prev;
          }
        }
        return next;
      });
    }, interval);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [currentAction, actionFrames]);

  // ---- Get frames with fallback ----
  function getFramesForAction(action: ActionState): string[] {
    const frames = actionFrames[action];
    if (frames && frames.length > 0) return frames;
    const idle = actionFrames["idle"];
    if (idle && idle.length > 0) return idle;
    return [];
  }

  // ---- Hit-zone canvas: 把当前帧画到隐藏 canvas，用于像素级 alpha 检测 ----
  useEffect(() => {
    const frames = getFramesForAction(currentAction);
    const currentFrame = frames[frameIndex] ?? frames[0];
    if (!currentFrame) return;

    if (!hitCanvasRef.current) {
      hitCanvasRef.current = document.createElement("canvas");
      hitCanvasRef.current.width = HIT_CANVAS_SIZE;
      hitCanvasRef.current.height = HIT_CANVAS_SIZE;
    }

    const img = new Image();
    img.onload = () => {
      const canvas = hitCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, HIT_CANVAS_SIZE, HIT_CANVAS_SIZE);
      ctx.drawImage(img, 0, 0, HIT_CANVAS_SIZE, HIT_CANVAS_SIZE);
    };
    img.src = currentFrame;
  }, [frameIndex, currentAction, actionFrames]);

  /**
   * 像素级热区检测：判断鼠标是否落在桌宠形象描边内
   * 透明区（alpha < 阈值）视为非热区，事件不响应
   */
  const isInHotZone = useCallback(
    (clientX: number, clientY: number): boolean => {
      const container = containerRef.current;
      const canvas = hitCanvasRef.current;
      if (!container || !canvas) return true;

      const rect = container.getBoundingClientRect();
      let localX = clientX - rect.left;
      const localY = clientY - rect.top;

      // 走路朝左时图像被镜像 → 坐标也要镜像
      if (facingLeft || (currentAction === "walk" && facingLeft)) {
        localX = rect.width - localX;
      }

      // 映射到 canvas 像素坐标
      const cx = Math.floor((localX / rect.width) * HIT_CANVAS_SIZE);
      const cy = Math.floor((localY / rect.height) * HIT_CANVAS_SIZE);
      if (cx < 0 || cx >= HIT_CANVAS_SIZE || cy < 0 || cy >= HIT_CANVAS_SIZE) {
        return false;
      }

      try {
        const ctx = canvas.getContext("2d");
        if (!ctx) return true;
        const alpha = ctx.getImageData(cx, cy, 1, 1).data[3];
        return alpha > HIT_ALPHA_THRESHOLD;
      } catch {
        return true;
      }
    },
    [facingLeft, currentAction]
  );

  // ---- 缩放：保存尺寸（防抖） ----
  const persistPetSize = useCallback((size: number) => {
    if (saveSizeTimerRef.current) clearTimeout(saveSizeTimerRef.current);
    saveSizeTimerRef.current = setTimeout(async () => {
      // 保存为自定义尺寸（数字）以便启动时恢复
      try {
        await saveConfig({ customPetSize: size } as Partial<AppConfig>);
      } catch {}
    }, 400);
  }, []);

  // ---- 滚轮缩放（原生监听器，避免 passive preventDefault 警告） ----
  const wheelDataRef = useRef({ petSize, isInHotZone });
  wheelDataRef.current = { petSize, isInHotZone };

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    function onWheel(e: WheelEvent) {
      const { petSize: curSize, isInHotZone: curHit } = wheelDataRef.current;
      // 只在桌宠形象描边内才响应
      if (!curHit(e.clientX, e.clientY)) return;
      // 菜单打开时不缩放（避免菜单和窗口尺寸打架）
      if (menuOpenRef.current) return;

      e.preventDefault();

      const direction = e.deltaY < 0 ? 1 : -1; // 向上滚=放大
      const factor = e.shiftKey || e.metaKey ? 2 : 1;
      const delta = direction * WHEEL_STEP * factor;
      const newSize = Math.round(
        Math.max(MIN_PET_SIZE, Math.min(MAX_PET_SIZE, curSize + delta))
      );
      if (newSize === curSize) return;

      setPetSize(newSize);
      petSizeRef.current = newSize;
      resizePetWindow(newSize, curSize);
      persistPetSize(newSize);
    }

    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [persistPetSize]);

  // ---- Interaction: left-click drag (自实现), right-click menu ----

  /**
   * 拖动状态。用 ref 存储以便 pointermove/pointerup 回调访问最新值。
   * 不用 win.startDragging() 是因为它会进入 OS 模态拖动循环，冻结 webview 的 JS/渲染线程，
   * 导致桌宠的 drag 动画来不及播放。
   *
   * 判定规则：
   *   - pointerdown 时仅记录起始位置，不立即触发 drag
   *   - pointermove 累计位移 > 3px 才视为拖动，dispatch drag_start
   *   - pointerup 时如果从未进入 drag 模式 → 视为单击，dispatch pet_clicked → happy
   */
  const dragStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    startWinLogicalX: number;
    startWinLogicalY: number;
    pointerId: number;
    isDragging: boolean; // 是否已超过点击阈值进入 drag
  } | null>(null);

  const DRAG_THRESHOLD = 3; // px

  const handlePointerDown = useCallback(
    async (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 透明区域不响应
      if (!isInHotZone(e.clientX, e.clientY)) return;

      // 菜单打开着 → 先关闭（桌宠会"瞬移"回贴左上，因为窗口要缩回去）
      // 同时也允许此次按下进入拖动状态：用户的预期是"按住桌宠就能拖"
      if (menuOpen) {
        await setMenuOpenAndAdjustWindow(false);
        // 菜单关闭后窗口位置已经变了，不能继续 dispatch drag_start，
        // 否则 startScreenX 和窗口新位置不匹配，松手时会跳回
        return;
      }

      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        const sf = await win.scaleFactor();

        dragStateRef.current = {
          startScreenX: e.screenX,
          startScreenY: e.screenY,
          startWinLogicalX: pos.x / sf,
          startWinLogicalY: pos.y / sf,
          pointerId: e.pointerId,
          isDragging: false,
        };

        // 捕获 pointer：即使鼠标移出 webview 也能继续收 move/up
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      } catch {}
    },
    [menuOpen, isInHotZone]
  );

  const handlePointerMove = useCallback(async (e: React.PointerEvent) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;

    const dx = e.screenX - state.startScreenX;
    const dy = e.screenY - state.startScreenY;

    // 第一次超过阈值 → 开始拖动
    if (!state.isDragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      state.isDragging = true;
      setIsDragging(true);
      stateMachineRef.current?.dispatch({ type: "drag_start" });
    }

    // 边界 clamp（用桌宠像素而非含 padding 的窗口尺寸做计算，菜单关时 padding=0）
    const clamped = clampToScreen(
      state.startWinLogicalX + dx,
      state.startWinLogicalY + dy,
      petSize
    );

    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { LogicalPosition } = await import("@tauri-apps/api/dpi");
      const win = getCurrentWindow();
      await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
    } catch {}
  }, [petSize]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;

    const wasDragging = state.isDragging;
    dragStateRef.current = null;

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    if (wasDragging) {
      setIsDragging(false);
      stateMachineRef.current?.dispatch({ type: "drag_end" });
      // 持久化位置（防抖）
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        const sf = await win.scaleFactor();
        persistPosition(pos.x / sf, pos.y / sf);
      } catch {}
    } else {
      // 单击：触发 happy 动作（不影响 baseAction）
      stateMachineRef.current?.dispatch({ type: "pet_clicked" });
    }
  }, []);

  // 防抖保存位置
  const persistPosition = useCallback((x: number, y: number) => {
    if (savePositionTimerRef.current) clearTimeout(savePositionTimerRef.current);
    savePositionTimerRef.current = setTimeout(async () => {
      try {
        await saveConfig({ lastPosition: { x: Math.round(x), y: Math.round(y) } });
      } catch {}
    }, 300);
  }, []);

  // ---- Right-click Context Menu ----
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // 透明区域不弹菜单
    if (!isInHotZone(e.clientX, e.clientY)) return;
    setMenuOpenAndAdjustWindow(true);
  }, [isInHotZone]);

  const closeContextMenu = useCallback(() => {
    setMenuOpenAndAdjustWindow(false);
  }, []);

  // ---- 用户手动切换动作（设为新的 baseAction） ----
  // 关键：在 setBaseAction 之前同步隐藏，避免「新动作旧位置」闪一下
  // ContextMenu 紧接着会调用 onClose → setMenuOpenAndAdjustWindow(false)，
  // 由它的关闭流程负责最终淡入（不在这里淡入，避免和菜单关闭流程互相覆盖造成"双闪"）
  const handleSetAction = useCallback((action: ActionState) => {
    hidePetSync();
    stateMachineRef.current?.setBaseAction(action);
    setFrameIndex(0);
    persistBaseAction(action);
  }, [hidePetSync]);

  // baseAction 持久化（防抖）
  const baseActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistBaseAction = useCallback((action: ActionState) => {
    if (baseActionTimerRef.current) clearTimeout(baseActionTimerRef.current);
    baseActionTimerRef.current = setTimeout(async () => {
      try {
        await saveConfig({ baseAction: action });
      } catch {}
    }, 300);
  }, []);

  // ---- Open Avatar Manager (former "重新生成") ----
  const handleOpenAvatarManager = useCallback(async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const mainWindow = await WebviewWindow.getByLabel("main");
      if (mainWindow) {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("app:show-avatar-manager");
        await mainWindow.show();
        await mainWindow.setFocus();
      }
    } catch {}
  }, []);

  // ---- Set size from context menu preset ----
  const handleSetSize = useCallback(
    async (size: number) => {
      const clamped = Math.round(
        Math.max(MIN_PET_SIZE, Math.min(MAX_PET_SIZE, size))
      );
      const oldSize = petSize;
      setPetSize(clamped);
      petSizeRef.current = clamped;
      await resizePetWindow(clamped, oldSize);
      persistPetSize(clamped);
    },
    [persistPetSize, petSize]
  );



  // ---- Render ----
  const frames = getFramesForAction(currentAction);
  const currentFrame = frames[frameIndex] ?? frames[0];

  const isWalking = currentAction === "walk";
  const shouldFlip = facingLeft || (isWalking && facingLeft);

  // 当前 padding 由 menuOpen 决定：菜单关闭时窗口紧贴桌宠像素，避免拦截其他应用
  const padding = menuOpen ? FRAME_PADDING : 0;
  const windowSize = petSize + 2 * padding;

  if (!currentFrame) {
    return (
      <div
        style={{
          width: windowSize,
          height: windowSize,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: padding,
            top: padding,
            width: petSize,
            height: petSize,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 4,
            cursor: "grab",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={handleContextMenu}
        >
          <div style={{ fontSize: 28, animation: "spin 2s linear infinite" }}>⏳</div>
          <span style={{ fontSize: 10, color: "#9333ea", opacity: 0.8 }}>加载中...</span>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: windowSize,
        height: windowSize,
        position: "relative",
        userSelect: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={handleContextMenu}
    >
      {/* 桌宠形象容器（菜单展开时居中，菜单关闭时贴左上）
          isWindowTransitioning 为 true 时短暂隐藏，避免 Tauri 窗口与 React padding
          状态不同步导致桌宠"闪到屏幕左上角" */}
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          left: padding,
          top: padding,
          width: petSize,
          height: petSize,
          cursor: isDragging ? "grabbing" : "grab",
          opacity: isWindowTransitioning ? 0 : 1,
          visibility: isWindowTransitioning ? "hidden" : "visible",
          transition: isWindowTransitioning ? "none" : "opacity 0.15s ease",
        }}
      >
        <img
          src={currentFrame}
          alt={currentAction}
          style={{
            width: "100%",
            height: "100%",
            imageRendering: "auto",
            pointerEvents: "none",
            transform: shouldFlip ? "scaleX(-1)" : undefined,
          }}
          draggable={false}
        />
      </div>

      {menuOpen && (
        <ContextMenu
          petSize={petSize}
          framePadding={padding}
          windowSize={windowSize}
          onClose={closeContextMenu}
          actionFrames={actionFrames}
          baseAction={stateMachineRef.current?.getBaseAction() ?? "idle"}
          onSetAction={handleSetAction}
          onOpenAvatarManager={handleOpenAvatarManager}
          onSetSize={handleSetSize}
        />
      )}
    </div>
  );
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    let binary = "";
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
    parts.push(binary);
  }
  return btoa(parts.join(""));
}
