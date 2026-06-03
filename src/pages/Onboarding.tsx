/**
 * Onboarding Flow — First-time user setup
 *
 * Steps:
 * 1. Welcome
 * 2. Enter API Key (with validation)
 * 3. Upload photo
 * 4. Generate all actions (with progress)
 */

import { useState, useRef, useEffect } from "react";
import { saveConfig, loadConfig } from "../utils/config-store";
import { generateSpriteSheet, SPRITE_PROMPTS } from "../core/image-gen";
import type { GenerateProgress } from "../core/image-gen";
import { sliceSpriteSheet } from "../core/sprite-slicer";
import {
  saveActionFrames,
  saveManifest,
  createDefaultManifest,
  buildActionConfig,
  clearAvatarPack,
} from "../core/avatar-store";
import { ALL_ACTIONS, DEFAULT_ACTION_SPECS } from "../core/types";
import type { ActionState } from "../core/types";
import { toast } from "../utils/toast";
import { processImageForUpload, formatBytes } from "../utils/image-process";

/** 把错误对象/消息转换成对用户友好的中文 */
function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // 常见错误关键词识别
  if (/401|unauthor|invalid api key|api[_ ]?key/i.test(msg))
    return "API 密钥无效或已过期";
  if (/403|forbidden/i.test(msg)) return "API 拒绝访问，请检查密钥权限";
  if (/429|too many|rate limit/i.test(msg))
    return "API 调用太频繁，请稍后再试";
  if (/timeout|timed out/i.test(msg)) return "请求超时，可能是网络较慢";
  if (/network|fetch|ECONN|ENOTFOUND/i.test(msg))
    return "网络问题，请检查连接";
  if (/quota|insufficient|余额/i.test(msg))
    return "API 余额不足或额度用尽";
  if (/500|internal server/i.test(msg)) return "服务器内部错误，请稍后再试";
  // 兜底：截断超长 message
  return msg.length > 80 ? msg.slice(0, 80) + "..." : msg || "未知错误";
}

interface Props {
  onComplete: () => void;
  /** 跳过 welcome/apikey 步骤，直接进入 photo 步骤（重新生成模式） */
  skipToPhoto?: boolean;
  /** 返回回调（重新生成模式下，返回形象管理面板） */
  onBack?: () => void;
}

type Step = "welcome" | "apikey" | "photo" | "generating" | "done";

export function Onboarding({ onComplete, skipToPhoto, onBack }: Props) {
  const [step, setStep] = useState<Step>(skipToPhoto ? "photo" : "welcome");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [validating, setValidating] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  // 图片预处理：HEIC 自动转 JPEG + 压缩到长边 1024
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [photoMeta, setPhotoMeta] = useState<{ originalSize: number; finalSize: number; finalWidth: number; finalHeight: number } | null>(null);
  const [currentGenAction, setCurrentGenAction] = useState<ActionState | null>(null);
  const [genProgress, setGenProgress] = useState<GenerateProgress | null>(null);
  const [completedActions, setCompletedActions] = useState<ActionState[]>([]);
  const [error, setError] = useState("");
  const [debugInfo, setDebugInfo] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const generatingAvatarIdRef = useRef<string | null>(null);
  // 进入 generateAll 前的 currentAvatarId，用于取消时回滚（避免 config 指向已删目录导致桌宠卡加载中）
  const previousAvatarIdRef = useRef<string | null>(null);

  // 重新生成模式下，从已有配置读取 API Key
  useEffect(() => {
    if (skipToPhoto) {
      loadConfig().then((config) => {
        if (config?.apiKey) {
          setApiKey(config.apiKey);
        }
      });
    }
  }, [skipToPhoto]);

  // ---- API Key validation (defined at component level, not inside if block) ----
  async function handleContinueApiKey() {
    setDebugInfo("Button clicked, validating...");

    const trimmed = apiKey.trim();
    if (!trimmed) {
      setApiKeyError("请输入你的 API 密钥");
      setDebugInfo("Error: empty key");
      return;
    }
    if (!trimmed.startsWith("sk-")) {
      setApiKeyError(`API 密钥应以 'sk-' 开头。Got: "${trimmed.substring(0, 5)}..."`);
      setDebugInfo(`Error: bad prefix, length=${trimmed.length}`);
      return;
    }

    setValidating(true);
    setApiKeyError("");
    setDebugInfo(`Saving key (length=${trimmed.length})...`);

    try {
      await saveConfig({ apiKey: trimmed });
      setDebugInfo("Save OK, moving to photo step");
      setStep("photo");
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : JSON.stringify(err);
      setApiKeyError(`保存失败：${msg}`);
      setDebugInfo(`Save error: ${msg}`);
    } finally {
      setValidating(false);
    }
  }

  // ---- Step 1: Welcome ----
  if (step === "welcome") {
    return (
      <div style={pageWrap}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ fontSize: 56, marginBottom: 18, lineHeight: 1 }}>🐾</div>
          <h1
            style={{
              fontSize: 26,
              fontWeight: 500,
              color: "var(--ink)",
              margin: "0 0 12px",
              letterSpacing: 2,
              fontFamily: "var(--font-cn)",
            }}
          >
            桌面宠物
          </h1>
          <p
            style={{
              fontSize: 13,
              color: "var(--ink-soft)",
              margin: "0 0 32px",
              lineHeight: 1.8,
              fontFamily: "var(--font-cn)",
            }}
          >
            上传一张照片，<br />
            生成属于你的可爱桌面陪伴
          </p>
          <button
            onClick={() => setStep("apikey")}
            style={primaryBtn}
            onMouseEnter={primaryBtnHover.enter}
            onMouseLeave={primaryBtnHover.leave}
          >
            开 始
          </button>
        </div>
      </div>
    );
  }

  // ---- Step 2: API Key ----
  if (step === "apikey") {
    return (
      <div style={pageWrap}>
        <div style={{ width: "100%", maxWidth: 380 }}>
          <h2 style={pageTitle}>API 密钥</h2>
          <p style={pageDesc}>
            输入你的 Evolink API 密钥，用来生成桌宠形象。
          </p>
          <a
            href="#"
            onClick={async (e) => {
              e.preventDefault();
              try {
                const { openUrl } = await import("@tauri-apps/plugin-opener");
                await openUrl("https://docs.evolink.ai/cn/quickstart");
              } catch {}
            }}
            style={{
              fontSize: 12,
              color: "var(--accent)",
              textDecoration: "none",
              display: "inline-block",
              marginBottom: 18,
              fontStyle: "italic",
              fontFamily: "var(--font-cn)",
              letterSpacing: 0.3,
              borderBottom: "1px dashed var(--accent-border)",
              paddingBottom: 1,
            }}
          >
            如何获取 API 密钥 → evolink.ai
          </a>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleContinueApiKey()}
            placeholder="sk-..."
            style={{
              width: "100%",
              padding: "12px 14px",
              border: "1px solid var(--ink-faint)",
              borderRadius: "var(--radius-md)",
              outline: "none",
              background: "var(--paper-elevated)",
              fontFamily: "var(--font-num)",
              fontSize: 13,
              color: "var(--ink)",
              letterSpacing: 0.5,
              transition: "border-color 0.18s ease",
              boxSizing: "border-box",
            }}
            onFocus={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
            }}
            onBlur={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--ink-faint)";
            }}
          />
          {apiKeyError && (
            <p style={{ fontSize: 12, color: "var(--brick)", marginTop: 8, fontFamily: "var(--font-cn)" }}>
              {apiKeyError}
            </p>
          )}
          {debugInfo && (
            <p style={{ fontSize: 11, color: "var(--accent)", marginTop: 4, fontFamily: "var(--font-num)" }}>
              [debug] {debugInfo}
            </p>
          )}
          <button
            onClick={() => handleContinueApiKey()}
            disabled={validating}
            style={{
              ...primaryBtnFull,
              marginTop: 18,
              opacity: validating ? 0.5 : 1,
              cursor: validating ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => {
              if (!validating) primaryBtnHover.enter(e);
            }}
            onMouseLeave={(e) => {
              if (!validating) primaryBtnHover.leave(e);
            }}
          >
            {validating ? "保存中…" : "继 续"}
          </button>
          <p
            style={{
              fontSize: 11,
              color: "var(--ink-muted)",
              marginTop: 10,
              fontFamily: "var(--font-num)",
              fontStyle: "italic",
              letterSpacing: 0.3,
            }}
          >
            length: {apiKey.length} · step: {step}
          </p>
        </div>
      </div>
    );
  }

  // ---- Step 3: Photo Upload ----
  if (step === "photo") {
    async function handlePhotoSelect(file: File) {
      // 预处理：自动转 HEIC → JPEG，压缩到长边 1024，避免 base64_upload_error
      setPhotoProcessing(true);
      setPhotoError("");
      setPhotoMeta(null);
      try {
        const { file: processed, meta } = await processImageForUpload(file);
        setPhoto(processed);
        setPhotoMeta({
          originalSize: meta.originalSize,
          finalSize: meta.finalSize,
          finalWidth: meta.finalWidth,
          finalHeight: meta.finalHeight,
        });
        const reader = new FileReader();
        reader.onload = () => setPhotoPreview(reader.result as string);
        reader.readAsDataURL(processed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "图片处理失败";
        setPhotoError(msg);
        setPhoto(null);
        setPhotoPreview("");
        setPhotoMeta(null);
      } finally {
        setPhotoProcessing(false);
      }
    }

    async function startGeneration() {
      if (!photo) return;

      // Save reference image
      const reader = new FileReader();
      reader.onload = async () => {
        await saveConfig({ referenceImageDataUrl: reader.result as string });
      };
      reader.readAsDataURL(photo);

      setStep("generating");
      await generateAll();
    }

    return (
      <div style={pageWrap}>
        <div style={{ width: "100%", maxWidth: 380 }}>
          {/* 返回按钮（重新生成模式下显示） */}
          {onBack && (
            <button
              onClick={onBack}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--ink-soft)",
                padding: "4px 0",
                marginBottom: 16,
                fontFamily: "var(--font-cn)",
                letterSpacing: 0.3,
                transition: "color 0.18s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--ink-soft)";
              }}
            >
              <span style={{ fontFamily: "var(--font-en)", fontSize: 14 }}>←</span>
              返回形象管理
            </button>
          )}
          <h2 style={pageTitle}>上传照片</h2>
          <p style={pageDesc}>
            选一张清晰的照片，让我们为你绘制一个 Q 版的小伙伴。
          </p>

          {!photoPreview ? (
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                height: 200,
                border: "1.5px dashed var(--ink-faint)",
                borderRadius: "var(--radius-lg)",
                cursor: photoProcessing ? "wait" : "pointer",
                background: "var(--paper-elevated)",
                transition: "all 0.2s ease",
                fontFamily: "var(--font-cn)",
                opacity: photoProcessing ? 0.7 : 1,
              }}
              onMouseEnter={(e) => {
                if (photoProcessing) return;
                (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
                (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)";
              }}
              onMouseLeave={(e) => {
                if (photoProcessing) return;
                (e.currentTarget as HTMLElement).style.borderColor = "var(--ink-faint)";
                (e.currentTarget as HTMLElement).style.background = "var(--paper-elevated)";
              }}
            >
              {photoProcessing ? (
                <>
                  <div style={{ fontSize: 30, marginBottom: 10, animation: "inkPulse 1.4s ease-in-out infinite" }}>⏳</div>
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: 0, letterSpacing: 0.5 }}>
                    正在处理图片…
                  </p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 36, marginBottom: 10 }}>📷</div>
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: 0, letterSpacing: 0.3 }}>
                    点击或拖拽上传
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--ink-muted)",
                      margin: "4px 0 0",
                      fontStyle: "italic",
                      fontFamily: "var(--font-en)",
                    }}
                  >
                    jpg / png / webp / heic
                  </p>
                </>
              )}
              <input
                type="file"
                accept="image/*,.heic,.heif"
                style={{ display: "none" }}
                disabled={photoProcessing}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handlePhotoSelect(f);
                }}
              />
            </label>
          ) : (
            <div style={{ position: "relative" }}>
              <img
                src={photoPreview}
                alt="Preview"
                style={{
                  width: "100%",
                  maxHeight: 280,
                  objectFit: "contain",
                  borderRadius: "var(--radius-lg)",
                  background: "var(--paper-card)",
                  border: "1px solid rgba(168, 155, 145, 0.25)",
                }}
              />
              <button
                onClick={() => {
                  setPhoto(null);
                  setPhotoPreview("");
                  setPhotoMeta(null);
                  setPhotoError("");
                }}
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  width: 28,
                  height: 28,
                  border: "1px solid var(--ink-faint)",
                  borderRadius: "50%",
                  background: "var(--paper-elevated)",
                  color: "var(--ink-soft)",
                  fontSize: 14,
                  fontFamily: "var(--font-en)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "var(--shadow-soft)",
                  padding: 0,
                  lineHeight: 1,
                  transition: "all 0.18s ease",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color = "var(--brick)";
                  (e.currentTarget as HTMLElement).style.borderColor = "var(--brick)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color = "var(--ink-soft)";
                  (e.currentTarget as HTMLElement).style.borderColor = "var(--ink-faint)";
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* 错误提示 */}
          {photoError && (
            <p
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "var(--brick)",
                fontFamily: "var(--font-cn)",
                lineHeight: 1.6,
                letterSpacing: 0.3,
              }}
            >
              {photoError}
            </p>
          )}

          {/* 压缩信息（小字，悄悄提示已经处理过了） */}
          {photoMeta && !photoError && (
            <p
              style={{
                marginTop: 8,
                fontSize: 11,
                color: "var(--ink-muted)",
                fontFamily: "var(--font-en)",
                fontStyle: "italic",
                letterSpacing: 0.3,
                textAlign: "center",
              }}
            >
              已优化 · {photoMeta.finalWidth}×{photoMeta.finalHeight} · {formatBytes(photoMeta.finalSize)}
              {photoMeta.originalSize > photoMeta.finalSize * 1.2 && (
                <span> · 原 {formatBytes(photoMeta.originalSize)}</span>
              )}
            </p>
          )}

          <button
            onClick={startGeneration}
            disabled={!photo}
            style={{
              ...primaryBtnFull,
              marginTop: 22,
              opacity: !photo ? 0.4 : 1,
              cursor: !photo ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => {
              if (photo) primaryBtnHover.enter(e);
            }}
            onMouseLeave={(e) => {
              if (photo) primaryBtnHover.leave(e);
            }}
          >
            生成我的桌宠
          </button>
        </div>
      </div>
    );
  }

  // ---- Step 4: Generating ----
  async function generateAll() {
    const controller = new AbortController();
    abortRef.current = controller;

    // 重置上次跑剩下的状态——否则用户重试时会顶着旧的失败提示 / 旧的 ✓ 列表 / 旧的进度条
    // （取消重试 / 换照片重试 / 完整重跑都走这里，统一清一遍）
    setError("");
    setDebugInfo("");
    setCompletedActions([]);
    setCurrentGenAction(null);
    setGenProgress(null);

    // 确保有 API Key（重新生成模式下可能还没同步到 state）
    let effectiveApiKey = apiKey.trim();
    if (!effectiveApiKey) {
      const config = await loadConfig();
      effectiveApiKey = config?.apiKey?.trim() ?? "";
    }
    if (!effectiveApiKey) {
      setError("API 密钥未配置，请先在设置中配置");
      return;
    }

    try {
      // 每次生成都创建新 avatarId（保留历史形象，可在右键菜单中切换）
      // 首次生成（onboarding）使用 "default" 作为 ID
      const existing = await loadConfig();
      const isFirstTime = !existing?.onboardingCompleted;
      const newAvatarId = isFirstTime
        ? "default"
        : `pet_${Date.now()}`;

      // 暴露给取消按钮（中途取消时清理未完成的目录）
      generatingAvatarIdRef.current = newAvatarId;
      // 记录"开始生成前"的 currentAvatarId：取消时回滚，避免 config 指向已删目录
      previousAvatarIdRef.current = existing?.currentAvatarId ?? null;

      // 用更友好的名字
      const avatarName = isFirstTime
        ? "我的桌宠"
        : `形象 ${new Date().toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}`;

      // 仅在首次生成时清空（覆盖之前残留），重新生成不清空旧的
      if (isFirstTime) {
        await clearAvatarPack(newAvatarId);
      }

      const manifest = createDefaultManifest(newAvatarId, avatarName);
      let firstActionDone = false;
      // 收集失败的动作，循环结束后用于决定是否标记 onboardingCompleted
      const failedActions: ActionState[] = [];

      for (const action of ALL_ACTIONS) {
        if (controller.signal.aborted) break;

        setCurrentGenAction(action);
        setGenProgress({ status: "preparing", progress: 0, message: "Preparing..." });

        const prompt = SPRITE_PROMPTS[action as keyof typeof SPRITE_PROMPTS];
        if (!prompt) continue;

        const spec = DEFAULT_ACTION_SPECS[action];
        let retries = 0;
        const maxRetries = 3;
        let success = false;

        while (retries < maxRetries && !success && !controller.signal.aborted) {
          try {
            // Generate sprite sheet
            const spriteDataUrl = await generateSpriteSheet(
              {
                prompt,
                referenceImage: photo!,
                apiKey: effectiveApiKey,
                size: "3840x1280",
                quality: "medium",
              },
              (p) => setGenProgress(p),
              controller.signal
            );

            // Slice into frames
            const sliceResult = await sliceSpriteSheet(spriteDataUrl, {
              frameCount: spec.defaultFrames,
              targetSize: 256,
            });

            // Save frames to disk under new avatar ID
            await saveActionFrames(newAvatarId, action, sliceResult.frames);

            // Update manifest
            manifest.actions[action] = buildActionConfig(action, sliceResult.frames.length);

            // 第一个动作（idle）生成完后立即切换 + 显示桌宠
            if (!firstActionDone) {
              firstActionDone = true;

              // 把当前形象记到 config（这样 PetWindow reload 时会读取新 ID）
              try {
                await saveConfig({ currentAvatarId: newAvatarId });
              } catch {}

              try {
                const { emit } = await import("@tauri-apps/api/event");
                // 通知 pet 窗口切换到新形象
                await emit("pet:switch-avatar", { avatarId: newAvatarId });
              } catch {}

              try {
                const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                const petWindow = await WebviewWindow.getByLabel("pet");
                if (petWindow) await petWindow.show();
              } catch {}
            } else {
              // 后续动作：通知 pet 窗口刷新对应动作的帧
              try {
                const { emit } = await import("@tauri-apps/api/event");
                await emit("pet:update-frames", {
                  frames: sliceResult.frames,
                  action,
                });
              } catch {}
            }

            setCompletedActions((prev) => [...prev, action]);
            success = true;
          } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") break;
            retries++;
            if (retries < maxRetries) {
              // Wait before retry
              await new Promise((r) => setTimeout(r, 10_000 * retries));
            } else {
              console.error(`[Gen] Failed ${action} after ${maxRetries} retries:`, err);
              const friendly = humanizeError(err);
              setError(`「${action}」生成失败：${friendly}`);
              toast.error(`「${action}」动作生成失败：${friendly}`);
              failedActions.push(action);
            }
          }
        }
      }

      // 用户取消则不进入"标记完成"流程
      if (controller.signal.aborted) return;

      // Save manifest（即使有失败动作，也保存已完成动作的配置）
      await saveManifest(newAvatarId, manifest);

      if (failedActions.length > 0) {
        // 有动作失败：不标记 onboardingCompleted，留在 generating 视图让用户看到错误
        // 用户可点"取消"回到 photo 步骤重试，或在已有动作上凑合（首次生成至少有 idle 才有意义）
        const failedLabel = failedActions.join("、");
        const msg = `${failedActions.length} 个动作生成失败：${failedLabel}。请检查网络/API Key 后取消并重试。`;
        setError(msg);
        toast.error(msg);
        return;
      }

      // 全部成功才标记 onboarding 完成 + 记录当前形象 ID
      await saveConfig({
        onboardingCompleted: true,
        currentAvatarId: newAvatarId,
        createdAt: new Date().toISOString(),
      });

      // Notify pet window to reload
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("pet:switch-avatar", { avatarId: newAvatarId });
      } catch {}

      generatingAvatarIdRef.current = null;
      setStep("done");
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        const friendly = humanizeError(err);
        setError(friendly);
        toast.error(friendly);
      }
    }
  }

  if (step === "generating") {
    const totalActions = ALL_ACTIONS.length;
    const doneCount = completedActions.length;
    const overallProgress = Math.round((doneCount / totalActions) * 100);

    return (
      <div style={pageWrap}>
        <div style={{ width: "100%", maxWidth: 380 }}>
          <h2 style={pageTitle}>正在生成…</h2>
          <p style={pageDesc}>
            大约 3-5 分钟。第一个动作完成后，桌宠就会出现。
          </p>

          {/* Overall progress */}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--ink-soft)",
                marginBottom: 6,
                fontFamily: "var(--font-num)",
                letterSpacing: 0.5,
              }}
            >
              <span>{doneCount}/{totalActions} actions</span>
              <span>{overallProgress}%</span>
            </div>
            <div
              style={{
                height: 6,
                background: "var(--paper-card)",
                borderRadius: 999,
                overflow: "hidden",
                border: "1px solid rgba(168, 155, 145, 0.2)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  background: "var(--accent)",
                  borderRadius: 999,
                  width: `${overallProgress}%`,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>

          {/* Current action */}
          {currentGenAction && (
            <div
              style={{
                background: "var(--paper-elevated)",
                borderRadius: "var(--radius-lg)",
                padding: 16,
                boxShadow: "var(--shadow-soft)",
                marginBottom: 14,
                border: "1px solid rgba(168, 155, 145, 0.2)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    background: "var(--accent)",
                    borderRadius: "50%",
                    animation: "inkPulse 1.4s ease-in-out infinite",
                  }}
                />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--ink)",
                    fontFamily: "var(--font-cn)",
                    letterSpacing: 0.5,
                  }}
                >
                  {currentGenAction}
                </span>
              </div>
              {genProgress && (
                <>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--ink-soft)",
                      margin: "0 0 6px",
                      fontFamily: "var(--font-cn)",
                      fontStyle: "italic",
                    }}
                  >
                    {genProgress.message}
                  </p>
                  <div
                    style={{
                      height: 3,
                      background: "var(--paper-card)",
                      borderRadius: 999,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        background: "var(--accent-soft)",
                        borderRadius: 999,
                        width: `${genProgress.progress}%`,
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Completed actions */}
          {completedActions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {completedActions.map((a) => (
                <span
                  key={a}
                  style={{
                    padding: "3px 10px",
                    background: "var(--sage-bg)",
                    color: "var(--sage)",
                    fontSize: 11,
                    borderRadius: 999,
                    border: "1px solid rgba(143, 174, 139, 0.3)",
                    fontFamily: "var(--font-cn)",
                    letterSpacing: 0.3,
                  }}
                >
                  {a} ✓
                </span>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              style={{
                background: "var(--brick-bg)",
                border: "1px solid rgba(184, 84, 80, 0.2)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                marginBottom: 14,
              }}
            >
              <p
                style={{
                  fontSize: 12,
                  color: "var(--brick)",
                  margin: 0,
                  fontFamily: "var(--font-cn)",
                  lineHeight: 1.6,
                }}
              >
                {error}
              </p>
            </div>
          )}

          {/* Cancel button */}
          <button
            onClick={async () => {
              abortRef.current?.abort();
              // 清理已经写入磁盘的部分文件（避免半成品形象出现在切换列表）
              const idToCleanup = generatingAvatarIdRef.current;
              if (idToCleanup) {
                // 关键顺序：先把 currentAvatarId 回滚到生成前的值，并通知桌宠切回老形象，
                // 再删除新建目录。否则 config.currentAvatarId 仍指向被删目录，
                // 重启后 PetWindow 加载会找不到帧 → 卡在"加载中..."
                const prevId = previousAvatarIdRef.current;
                if (prevId && prevId !== idToCleanup) {
                  try {
                    await saveConfig({ currentAvatarId: prevId });
                  } catch {}
                  try {
                    const { emit } = await import("@tauri-apps/api/event");
                    await emit("pet:switch-avatar", { avatarId: prevId });
                  } catch {}
                }
                try {
                  await clearAvatarPack(idToCleanup);
                } catch {}
                generatingAvatarIdRef.current = null;
                previousAvatarIdRef.current = null;
              }
              setStep("photo");
              setCompletedActions([]);
              setCurrentGenAction(null);
              setGenProgress(null);
            }}
            style={{
              width: "100%",
              padding: "10px 16px",
              fontSize: 13,
              color: "var(--ink-soft)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-cn)",
              letterSpacing: 0.3,
              transition: "color 0.18s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--brick)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--ink-soft)";
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  // ---- Step 5: Done ----
  return (
    <div style={pageWrap}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ fontSize: 56, marginBottom: 18, lineHeight: 1 }}>🎉</div>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 500,
            color: "var(--ink)",
            margin: "0 0 12px",
            letterSpacing: 1.5,
            fontFamily: "var(--font-cn)",
          }}
        >
          桌宠已就位
        </h2>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-soft)",
            margin: "0 0 32px",
            lineHeight: 1.8,
            fontFamily: "var(--font-cn)",
          }}
        >
          它会安静地陪你工作，<br />
          右键点它就能调整设置。
        </p>
        <button
          onClick={onComplete}
          style={primaryBtn}
          onMouseEnter={primaryBtnHover.enter}
          onMouseLeave={primaryBtnHover.leave}
        >
          完 成
        </button>
      </div>
    </div>
  );
}

// ============================================================
// 共享样式（暖墨手账风）
// ============================================================
const pageWrap: React.CSSProperties = {
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--paper-bg)",
  padding: "32px",
  fontFamily: "var(--font-cn)",
  color: "var(--ink)",
};

const pageTitle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 500,
  color: "var(--ink)",
  margin: "0 0 8px",
  letterSpacing: 1.5,
  fontFamily: "var(--font-cn)",
};

const pageDesc: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-soft)",
  margin: "0 0 22px",
  lineHeight: 1.7,
  fontFamily: "var(--font-cn)",
  letterSpacing: 0.3,
};

const primaryBtn: React.CSSProperties = {
  padding: "11px 36px",
  background: "var(--accent)",
  color: "var(--paper-elevated)",
  border: "1px solid var(--accent)",
  borderRadius: 999,
  fontSize: 14,
  fontWeight: 500,
  fontFamily: "var(--font-cn)",
  letterSpacing: 2,
  cursor: "pointer",
  boxShadow: "0 4px 14px rgba(196, 112, 75, 0.25)",
  transition: "all 0.2s ease",
};

const primaryBtnFull: React.CSSProperties = {
  ...primaryBtn,
  width: "100%",
  borderRadius: "var(--radius-md)",
  letterSpacing: 1,
  padding: "12px 16px",
};

const primaryBtnHover = {
  enter: (e: React.MouseEvent) => {
    (e.currentTarget as HTMLElement).style.background = "#a85c3a";
    (e.currentTarget as HTMLElement).style.borderColor = "#a85c3a";
    (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
    (e.currentTarget as HTMLElement).style.boxShadow = "0 6px 18px rgba(196, 112, 75, 0.3)";
  },
  leave: (e: React.MouseEvent) => {
    (e.currentTarget as HTMLElement).style.background = "var(--accent)";
    (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
    (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
    (e.currentTarget as HTMLElement).style.boxShadow = "0 4px 14px rgba(196, 112, 75, 0.25)";
  },
};
