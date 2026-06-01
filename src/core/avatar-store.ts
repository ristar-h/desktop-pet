/**
 * Avatar 资源包存储层
 *
 * 存储路径：$APPDATA/avatars/{avatar_id}/
 * ├── manifest.json
 * ├── idle/01.png ...
 * ├── walk/01.png ...
 * └── ...
 */

import type {
  AvatarManifest,
  AvatarPack,
  ActionState,
  ActionConfig,
} from "./types";
import { DEFAULT_ACTION_SPECS, ALL_ACTIONS } from "./types";

const AVATARS_DIR = "avatars";

// ============================================================
// 安全校验
// ============================================================

/**
 * 校验 avatarId 是否合法（防止路径遍历）
 */
function validateAvatarId(id: string): void {
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(
      `Invalid avatar ID: "${id}". Only letters, digits, hyphens and underscores allowed (1-64 chars).`
    );
  }
}

/**
 * 校验 action 名称
 */
function validateAction(action: string): void {
  if (!ALL_ACTIONS.includes(action as ActionState)) {
    throw new Error(`Invalid action: "${action}". Must be one of: ${ALL_ACTIONS.join(", ")}`);
  }
}

// ============================================================
// Tauri FS 动态导入（避免白屏）
// ============================================================

async function getTauriFs() {
  const fs = await import("@tauri-apps/plugin-fs");
  return fs;
}

async function getTauriPath() {
  const path = await import("@tauri-apps/api/path");
  return path;
}

async function getAvatarsRoot(): Promise<string> {
  const path = await getTauriPath();
  const appData = await path.appDataDir();
  return await path.join(appData, AVATARS_DIR);
}

// ============================================================
// 写入资源包（原子性写入）
// ============================================================

/**
 * 保存帧图片到指定动作目录（原子写入）
 *
 * 策略：先写到 `{action}.tmp/`，全部成功后删除旧 `{action}/` 再 rename `.tmp` → `{action}/`。
 * 写入中途 crash 不会留下"半套帧"导致 PetWindow 加载到混合分辨率/造型的奇怪动画。
 *
 * @param avatarId - 资源包 ID
 * @param action - 动作名称
 * @param frameDataUrls - 各帧的 Data URL
 */
export async function saveActionFrames(
  avatarId: string,
  action: ActionState,
  frameDataUrls: string[]
): Promise<void> {
  validateAvatarId(avatarId);
  validateAction(action);

  if (frameDataUrls.length === 0) {
    throw new Error("至少需要 1 帧图片");
  }

  const fs = await getTauriFs();
  const path = await getTauriPath();
  const root = await getAvatarsRoot();
  const finalDir = await path.join(root, avatarId, action);
  const tmpDir = await path.join(root, avatarId, `${action}.tmp`);

  console.log("[Avatar] 原子保存帧到:", finalDir, "帧数:", frameDataUrls.length);

  // 1. 清理可能存在的残留 .tmp（来自前一次 crash）
  try {
    if (await fs.exists(tmpDir)) {
      await fs.remove(tmpDir, { recursive: true });
    }
  } catch {}

  // 2. 写入到 .tmp
  await fs.mkdir(tmpDir, { recursive: true });
  for (let i = 0; i < frameDataUrls.length; i++) {
    const fileName = String(i + 1).padStart(2, "0") + ".png";
    const filePath = await path.join(tmpDir, fileName);
    const base64 = frameDataUrls[i].replace(/^data:image\/\w+;base64,/, "");
    const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    await fs.writeFile(filePath, binary);
  }

  // 3. 删旧目录 + rename（这一步是非原子的小窗口，但比"写一半 crash"小得多）
  try {
    if (await fs.exists(finalDir)) {
      await fs.remove(finalDir, { recursive: true });
    }
  } catch (err) {
    // 删除失败：清掉 tmp 避免残留，再抛出
    try {
      await fs.remove(tmpDir, { recursive: true });
    } catch {}
    throw err;
  }
  await fs.rename(tmpDir, finalDir);

  console.log("[Avatar] 帧保存完成");
}

/**
 * 清空一个 avatar 的所有动作数据（重新生成前调用）
 */
export async function clearAvatarPack(avatarId: string): Promise<void> {
  validateAvatarId(avatarId);

  const fs = await getTauriFs();
  const path = await getTauriPath();
  const root = await getAvatarsRoot();
  const avatarDir = await path.join(root, avatarId);

  try {
    const exists = await fs.exists(avatarDir);
    if (exists) {
      await fs.remove(avatarDir, { recursive: true });
      console.log("[Avatar] 已清空资源包:", avatarId);
    }
  } catch (err) {
    console.warn("[Avatar] 清空资源包失败:", err);
  }
}

/**
 * 保存 / 更新 manifest.json
 */
export async function saveManifest(
  avatarId: string,
  manifest: AvatarManifest
): Promise<void> {
  validateAvatarId(avatarId);

  const fs = await getTauriFs();
  const path = await getTauriPath();
  const root = await getAvatarsRoot();
  const dir = await path.join(root, avatarId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = await path.join(dir, "manifest.json");
  await fs.writeTextFile(filePath, JSON.stringify(manifest, null, 2));
  console.log("[Avatar] manifest 已保存:", filePath);
}

// ============================================================
// 读取资源包
// ============================================================

/**
 * 加载一个资源包
 */
export async function loadAvatarPack(
  avatarId: string
): Promise<AvatarPack | null> {
  validateAvatarId(avatarId);

  try {
    const fs = await getTauriFs();
    const path = await getTauriPath();
    const root = await getAvatarsRoot();
    const dir = await path.join(root, avatarId);

    // 读取 manifest
    const manifestPath = await path.join(dir, "manifest.json");
    const manifestExists = await fs.exists(manifestPath);
    if (!manifestExists) {
      console.warn(`[Avatar] manifest 不存在: ${manifestPath}`);
      return null;
    }

    const manifestText = await fs.readTextFile(manifestPath);
    const manifest: AvatarManifest = JSON.parse(manifestText);

    // 扫描各动作文件夹，加载帧
    const frameCache: Partial<Record<ActionState, string[]>> = {};
    for (const action of ALL_ACTIONS) {
      const actionDir = await path.join(dir, action);
      try {
        const exists = await fs.exists(actionDir);
        if (!exists) continue;

        const entries = await fs.readDir(actionDir);
        const pngFiles = entries
          .filter((e) => e.name?.endsWith(".png"))
          .map((e) => e.name!)
          .sort();

        if (pngFiles.length === 0) continue;

        // 读取为 Data URL
        const dataUrls: string[] = [];
        for (const fileName of pngFiles) {
          const filePath = await path.join(actionDir, fileName);
          const binary = await fs.readFile(filePath);
          const base64 = uint8ToBase64(binary);
          dataUrls.push(`data:image/png;base64,${base64}`);
        }
        frameCache[action] = dataUrls;
      } catch (err) {
        console.warn(`[Avatar] 动作 ${action} 加载失败:`, err);
      }
    }

    return {
      manifest,
      rootPath: dir,
      frameCache,
    };
  } catch (err) {
    console.error(`[Avatar] 加载资源包失败 (${avatarId}):`, err);
    return null;
  }
}

/**
 * 列出所有已安装的资源包
 */
export async function listAvatarPacks(): Promise<string[]> {
  try {
    const fs = await getTauriFs();
    const root = await getAvatarsRoot();
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readDir(root);
    return entries
      .filter((e) => e.isDirectory)
      .map((e) => e.name!)
      .sort();
  } catch (err) {
    console.error("[Avatar] 列出资源包失败:", err);
    return [];
  }
}

/**
 * 创建默认 manifest
 */
export function createDefaultManifest(
  avatarId: string,
  name: string
): AvatarManifest {
  validateAvatarId(avatarId);

  const actions: Partial<Record<ActionState, ActionConfig>> = {};
  return {
    id: avatarId,
    name,
    canvasWidth: 128,
    canvasHeight: 128,
    anchor: { x: 0.5, y: 0.88 },
    actions,
    createdAt: Date.now(),
  };
}

/**
 * 从已有帧自动生成动作配置
 */
export function buildActionConfig(
  action: ActionState,
  frameCount: number
): ActionConfig {
  const spec = DEFAULT_ACTION_SPECS[action];
  return {
    fps: spec.fps,
    loop: spec.loop,
    frames: Array.from(
      { length: frameCount },
      (_, i) => `${String(i + 1).padStart(2, "0")}.png`
    ),
  };
}

// ============================================================
// 工具函数
// ============================================================

/**
 * Uint8Array → Base64 字符串
 * 使用分块处理避免 O(n²) 字符串拼接
 */
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
