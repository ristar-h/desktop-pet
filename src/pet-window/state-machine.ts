/**
 * Desktop Pet State Machine (Standalone Version)
 *
 * No agent events. Pure idle behavior + user interaction.
 *
 * States:
 * - idle: Default (user active or just returned)
 * - walk: Roaming (AFK 60-120s, random)
 * - sleep: Sleeping (AFK >= 5min)
 * - happy: Clicked (one-shot)
 * - sad: Neglected (sleep > 30min, random trigger)
 * - stretch: Waking up from sleep (one-shot)
 * - looking_around: Curious (after walk, 30% chance)
 * - drag: Being dragged
 */

import type { ActionState } from "../core/types";

// ============================================================
// Configuration
// ============================================================

export interface PetStateMachineConfig {
  /** Min AFK time to enter walk (ms), default 60s */
  walkThresholdMin?: number;
  /** Max AFK time to enter walk (ms), default 120s */
  walkThresholdMax?: number;
  /** AFK time to enter sleep (ms), default 300s */
  sleepThreshold?: number;
  /** Walk duration min (ms) */
  walkDurationMin?: number;
  /** Walk duration max (ms) */
  walkDurationMax?: number;
  /** Sleep time before sad can trigger (ms), default 30min */
  sadThreshold?: number;
  /** Tick interval (ms) */
  tickInterval?: number;
}

const DEFAULT_CONFIG: Required<PetStateMachineConfig> = {
  walkThresholdMin: 60_000,    // 1 min
  walkThresholdMax: 120_000,   // 2 min
  sleepThreshold: 300_000,     // 5 min
  walkDurationMin: 15_000,     // 15s
  walkDurationMax: 25_000,     // 25s
  sadThreshold: 1_800_000,     // 30 min
  tickInterval: 3_000,         // 3s
};

// ============================================================
// Events
// ============================================================

export type PetEvent =
  | { type: "user_active" }
  | { type: "pet_clicked" }
  | { type: "drag_start" }
  | { type: "drag_end" }
  | { type: "animation_complete" }
  | { type: "walk_timeout" };

// ============================================================
// State Machine
// ============================================================

export type StateChangeCallback = (
  newState: ActionState,
  prevState: ActionState
) => void;

export class PetStateMachine {
  private state: ActionState = "idle";
  /**
   * 用户手动设置的"基线动作"。状态机所有"回到默认"的地方都回到 baseAction。
   * 默认 idle；用户可通过右键菜单切换为其他动作（如 sleep/walk/happy 等）。
   *
   * 行为：
   *   - loop 动作（idle/walk/sleep/drag）：作为 baseAction 时会持续循环播放
   *   - once 动作（happy/sad/stretch/looking_around）：播完后停在最后一帧（不会反复抽搐）
   */
  private baseAction: ActionState = "idle";
  private lastActivityTime: number = Date.now();
  private sleepStartTime: number = 0;
  private walkStartTime: number = 0;
  private walkDuration: number = 0;
  private walkThreshold: number = 0; // Randomized each cycle
  private config: Required<PetStateMachineConfig>;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private onStateChange: StateChangeCallback | null = null;

  constructor(config?: PetStateMachineConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.randomizeWalkThreshold();
  }

  getState(): ActionState {
    return this.state;
  }

  getBaseAction(): ActionState {
    return this.baseAction;
  }

  /**
   * 设置基线动作（用户手动切换动作时调用）
   * 立即切换到该动作，且后续所有"回到默认"的转换都会回到该动作。
   */
  setBaseAction(action: ActionState): void {
    this.baseAction = action;
    this.lastActivityTime = Date.now(); // 重置计时器
    this.transition(action);
  }

  onChange(cb: StateChangeCallback): void {
    this.onStateChange = cb;
  }

  start(): void {
    if (this.tickTimer) {
      console.warn("[StateMachine] Already started");
      return;
    }
    this.lastActivityTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), this.config.tickInterval);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Update idle time from system (called by Rust poller) */
  updateIdleTime(idleSeconds: number): void {
    // If system reports user was recently active
    if (idleSeconds < 3) {
      this.lastActivityTime = Date.now();
      this.handleUserActive();
    }
  }

  dispatch(event: PetEvent): void {
    switch (event.type) {
      case "user_active":
        this.lastActivityTime = Date.now();
        this.handleUserActive();
        break;

      case "pet_clicked":
        // From any non-drag state → happy
        if (this.state !== "drag") {
          this.transition("happy");
        }
        break;

      case "drag_start":
        this.transition("drag");
        break;

      case "drag_end":
        this.transition(this.baseAction);
        this.lastActivityTime = Date.now();
        break;

      case "animation_complete":
        this.handleAnimationComplete();
        break;

      case "walk_timeout":
        this.handleWalkEnd();
        break;
    }
  }

  // ---- Internal Logic ----

  private handleUserActive(): void {
    // 如果当前状态本身就是用户选的 baseAction，不要打扰用户的主动选择
    // （否则用户选 sleep/sad 等会被立即覆盖为 stretch 等过渡动作）
    if (this.state === this.baseAction) return;

    if (this.state === "sleep") {
      this.transition("stretch");
    } else if (this.state === "walk" || this.state === "looking_around") {
      this.transition(this.baseAction);
      this.randomizeWalkThreshold();
    } else if (this.state === "sad") {
      // User came back while sad animation playing → stretch
      this.transition("stretch");
    }
  }

  private handleAnimationComplete(): void {
    // 如果当前 state 就是 baseAction（once 动作被设为 baseAction 的情况），
    // 播完后留在最后一帧，不做转换
    if (this.state === this.baseAction) return;

    switch (this.state) {
      case "happy":
      case "stretch":
      case "looking_around":
        this.transition(this.baseAction);
        this.randomizeWalkThreshold();
        break;
      case "sad":
        // Sad finishes → back to sleep
        this.transition("sleep");
        break;
    }
  }

  private handleWalkEnd(): void {
    if (this.state !== "walk") return;

    const idleTime = Date.now() - this.lastActivityTime;
    if (idleTime >= this.config.sleepThreshold) {
      this.transition("sleep");
      this.sleepStartTime = Date.now();
    } else if (Math.random() < 0.3) {
      // 30% chance → looking_around
      this.transition("looking_around");
    } else {
      // 70% → back to baseAction
      this.transition(this.baseAction);
      this.randomizeWalkThreshold();
    }
  }

  /** Periodic tick: check AFK for state transitions */
  private tick(): void {
    const now = Date.now();
    const idleTime = now - this.lastActivityTime;

    // 仅当处于 baseAction 状态时才考虑自动 AFK 转换
    if (this.state === this.baseAction) {
      // 已经在 sleep（如 baseAction=sleep）就不再触发 sleep
      if (this.state !== "sleep" && idleTime >= this.config.sleepThreshold) {
        this.transition("sleep");
        this.sleepStartTime = now;
      } else if (this.state !== "walk" && idleTime >= this.walkThreshold) {
        this.startWalk();
      }
    } else if (this.state === "walk") {
      // Check if walk duration exceeded
      if (now - this.walkStartTime >= this.walkDuration) {
        this.handleWalkEnd();
      }
    } else if (this.state === "sleep") {
      // Check if sad should trigger
      const sleepDuration = now - this.sleepStartTime;
      if (sleepDuration >= this.config.sadThreshold) {
        // 5% chance per tick (every 3s) ≈ once per minute on average
        if (Math.random() < 0.05) {
          this.transition("sad");
        }
      }
    }
  }

  private startWalk(): void {
    this.walkStartTime = Date.now();
    this.walkDuration = randomBetween(
      this.config.walkDurationMin,
      this.config.walkDurationMax
    );
    this.transition("walk");
  }

  private randomizeWalkThreshold(): void {
    this.walkThreshold = randomBetween(
      this.config.walkThresholdMin,
      this.config.walkThresholdMax
    );
  }

  private transition(newState: ActionState): void {
    const prev = this.state;
    if (prev === newState) return;
    this.state = newState;

    // Track sleep start
    if (newState === "sleep" && prev !== "sad") {
      this.sleepStartTime = Date.now();
    }

    this.onStateChange?.(newState, prev);
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
