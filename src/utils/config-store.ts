/**
 * Configuration storage
 * Persists to $APPDATA/config.json via Tauri FS plugin
 */

export interface AppConfig {
  apiKey: string;
  petSize: "small" | "medium" | "large";
  /** 用户自定义连续尺寸（像素，由滚轮缩放产生）；存在时优先于 petSize 三档 */
  customPetSize?: number;
  /** 当前使用的形象 ID（每次重新生成会创建新 ID） */
  currentAvatarId?: string;
  /** 用户手动选定的"基线动作"（默认 idle）；状态机所有"回到默认"都回到这里 */
  baseAction?: string;
  positionLocked: boolean;
  lastPosition: { x: number; y: number };
  onboardingCompleted: boolean;
  referenceImageDataUrl: string; // stored as data URL
  createdAt: string;
}

const DEFAULT_CONFIG: AppConfig = {
  apiKey: "",
  petSize: "medium",
  customPetSize: undefined,
  currentAvatarId: undefined,
  baseAction: undefined,
  positionLocked: false,
  lastPosition: { x: 800, y: 500 },
  onboardingCompleted: false,
  referenceImageDataUrl: "",
  createdAt: "",
};

const CONFIG_FILE = "config.json";

async function getConfigPath(): Promise<string> {
  const path = await import("@tauri-apps/api/path");
  const appData = await path.appDataDir();
  return await path.join(appData, CONFIG_FILE);
}

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const configPath = await getConfigPath();

    const exists = await fs.exists(configPath);
    if (!exists) return null;

    const text = await fs.readTextFile(configPath);
    return { ...DEFAULT_CONFIG, ...JSON.parse(text) };
  } catch (err) {
    console.error("[config] loadConfig failed:", err);
    return null;
  }
}

export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  const path = await import("@tauri-apps/api/path");
  const appData = await path.appDataDir();

  // Ensure directory exists FIRST
  await fs.mkdir(appData, { recursive: true });

  // Merge with existing
  const existing = await loadConfig();
  const merged = { ...DEFAULT_CONFIG, ...existing, ...config };

  const configPath = await path.join(appData, CONFIG_FILE);
  await fs.writeTextFile(configPath, JSON.stringify(merged, null, 2));
  console.log("[config] Saved to:", configPath);
}

export async function getConfig(): Promise<AppConfig> {
  const config = await loadConfig();
  return config ?? DEFAULT_CONFIG;
}

export function getPetSizePx(size: AppConfig["petSize"]): number {
  switch (size) {
    case "small":
      return 120;
    case "medium":
      return 180;
    case "large":
      return 240;
  }
}
