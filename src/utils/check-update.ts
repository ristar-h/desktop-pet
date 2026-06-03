/**
 * 检查应用更新
 *
 * 用 tauri-plugin-updater 直接拉 latest.json，验证签名后下载安装。
 * 失败时抛错，由调用方决定怎么提示。
 */

interface UpdateAvailable {
  version: string;
  notes?: string;
  install: () => Promise<void>;
}

/**
 * @returns 有新版返回 UpdateAvailable；已是最新返回 null
 */
export async function checkForUpdate(): Promise<UpdateAvailable | null> {
  // 动态 import：updater 插件只在打包应用里可用，dev 模式下也走同一条路
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body,
    install: async () => {
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
