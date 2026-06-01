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
      <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 p-8">
        <div className="text-6xl mb-6">🐾</div>
        <h1 className="text-2xl font-bold text-gray-800 mb-3">桌面宠物</h1>
        <p className="text-gray-600 text-center max-w-xs mb-8">
          上传你的照片，生成一个可爱的 Q 版桌面宠物陪伴你！
        </p>
        <button
          onClick={() => setStep("apikey")}
          className="px-8 py-3 bg-purple-600 text-white rounded-full font-medium hover:bg-purple-700 transition-colors shadow-lg shadow-purple-200"
        >
          开始
        </button>
      </div>
    );
  }

  // ---- Step 2: API Key ----
  if (step === "apikey") {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 p-8">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-bold text-gray-800 mb-2">API 密钥</h2>
          <p className="text-sm text-gray-500 mb-4">
            输入你的 Evolink API 密钥来生成你的桌宠。
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
            className="text-xs text-purple-600 hover:underline mb-4 block"
          >
            如何获取 API 密钥 → (evolink.ai)
          </a>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleContinueApiKey()}
            placeholder="sk-..."
            className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white font-mono text-sm"
          />
          {apiKeyError && (
            <p className="text-sm text-red-500 mt-2">{apiKeyError}</p>
          )}
          {debugInfo && (
            <p className="text-xs text-blue-500 mt-1 font-mono">[debug] {debugInfo}</p>
          )}
          <button
            onClick={() => handleContinueApiKey()}
            disabled={validating}
            className="w-full mt-4 px-4 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 transition-colors disabled:opacity-50"
          >
            {validating ? "保存中..." : "继续"}
          </button>
          <p className="text-xs text-gray-400 mt-2">
            密钥长度：{apiKey.length} | 步骤：{step}
          </p>
        </div>
      </div>
    );
  }

  // ---- Step 3: Photo Upload ----
  if (step === "photo") {
    function handlePhotoSelect(file: File) {
      setPhoto(file);
      const reader = new FileReader();
      reader.onload = () => setPhotoPreview(reader.result as string);
      reader.readAsDataURL(file);
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
      <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 p-8">
        <div className="w-full max-w-sm">
          {/* 返回按钮（重新生成模式下显示） */}
          {onBack && (
            <button
              onClick={onBack}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: 13,
                color: "#6b7280",
                padding: "4px 0",
                marginBottom: 12,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#7c3aed"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#6b7280"; }}
            >
              ← 返回形象管理
            </button>
          )}
          <h2 className="text-xl font-bold text-gray-800 mb-2">你的照片</h2>
          <p className="text-sm text-gray-500 mb-6">
            上传一张清晰的照片，我们会生成一个可爱的 Q 版形象！
          </p>

          {!photoPreview ? (
            <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-purple-400 transition-colors bg-white">
              <div className="text-4xl mb-2">📷</div>
              <p className="text-sm text-gray-500">点击或拖拽上传</p>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handlePhotoSelect(f);
                }}
              />
            </label>
          ) : (
            <div className="relative">
              <img
                src={photoPreview}
                alt="Preview"
                className="w-full max-h-64 object-contain rounded-xl bg-gray-100"
              />
              <button
                onClick={() => {
                  setPhoto(null);
                  setPhotoPreview("");
                }}
                className="absolute top-2 right-2 w-8 h-8 bg-black/50 text-white rounded-full flex items-center justify-center text-sm hover:bg-black/70"
              >
                ×
              </button>
            </div>
          )}

          <button
            onClick={startGeneration}
            disabled={!photo}
            className="w-full mt-6 px-4 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 transition-colors disabled:opacity-50"
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
      <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 p-8">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-bold text-gray-800 mb-2">正在生成你的桌宠</h2>
          <p className="text-sm text-gray-500 mb-6">
            大约需要 3-5 分钟。第一个动作生成完后桌宠就会出现！
          </p>

          {/* Overall progress */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{doneCount}/{totalActions} 个动作</span>
              <span>{overallProgress}%</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>

          {/* Current action */}
          {currentGenAction && (
            <div className="bg-white rounded-lg p-4 shadow-sm mb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium text-gray-700">
                  {currentGenAction}
                </span>
              </div>
              {genProgress && (
                <>
                  <p className="text-xs text-gray-500 mb-1">{genProgress.message}</p>
                  <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-300 rounded-full transition-all"
                      style={{ width: `${genProgress.progress}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Completed actions */}
          {completedActions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {completedActions.map((a) => (
                <span
                  key={a}
                  className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full"
                >
                  {a} ✓
                </span>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-100 rounded-lg p-3 mb-4">
              <p className="text-xs text-red-600">{error}</p>
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
            className="w-full px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  // ---- Step 5: Done ----
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 p-8">
      <div className="text-6xl mb-6">🎉</div>
      <h2 className="text-xl font-bold text-gray-800 mb-2">你的桌宠准备好了！</h2>
      <p className="text-sm text-gray-500 text-center max-w-xs mb-8">
        桌宠已经在运行了。右键点击它可以调整设置。
      </p>
      <button
        onClick={onComplete}
        className="px-8 py-3 bg-purple-600 text-white rounded-full font-medium hover:bg-purple-700 transition-colors shadow-lg shadow-purple-200"
      >
        完成！
      </button>
    </div>
  );
}
