/**
 * Settings page — accessible from right-click menu
 */

import { useState, useEffect } from "react";
import { loadConfig, saveConfig, getPetSizePx } from "../utils/config-store";
import type { AppConfig } from "../utils/config-store";

interface Props {
  onBack: () => void;
}

export function Settings({ onBack }: Props) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c) {
        setConfig(c);
        setApiKey(c.apiKey);
      }
    });
  }, []);

  async function handleSave() {
    await saveConfig({ apiKey: apiKey.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleSizeChange(size: AppConfig["petSize"]) {
    await saveConfig({ petSize: size });
    setConfig((prev) => prev ? { ...prev, petSize: size } : null);

    // Notify pet window
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("pet:resize", { size: getPetSizePx(size) });
    } catch {}
  }

  async function handleHide() {
    onBack();
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {}
  }

  if (!config) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50">
        <div className="animate-pulse text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gradient-to-br from-purple-50 to-pink-50 p-8">
      <div className="max-w-sm mx-auto">
        <h2 className="text-xl font-bold text-gray-800 mb-6">设置</h2>

        {/* API Key */}
        <div className="mb-6">
          <label className="text-sm font-medium text-gray-700 block mb-1">
            API 密钥
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
          />
          <button
            onClick={handleSave}
            className="mt-2 px-4 py-1.5 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition-colors"
          >
            {saved ? "已保存 ✓" : "保存"}
          </button>
        </div>

        {/* Pet Size */}
        <div className="mb-6">
          <label className="text-sm font-medium text-gray-700 block mb-2">
            桌宠大小
          </label>
          <div className="flex gap-2">
            {(["small", "medium", "large"] as const).map((size) => (
              <button
                key={size}
                onClick={() => handleSizeChange(size)}
                className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                  config.petSize === size
                    ? "bg-purple-600 text-white"
                    : "bg-white text-gray-700 border border-gray-200 hover:bg-gray-50"
                }`}
              >
                {size === "small" ? "小 (120px)" : size === "medium" ? "中 (180px)" : "大 (240px)"}
              </button>
            ))}
          </div>
        </div>

        {/* Reference Image */}
        {config.referenceImageDataUrl && (
          <div className="mb-6">
            <label className="text-sm font-medium text-gray-700 block mb-2">
              参考照片
            </label>
            <img
              src={config.referenceImageDataUrl}
              alt="Reference"
              className="w-20 h-20 rounded-lg object-cover border border-gray-200"
            />
          </div>
        )}

        {/* Close button */}
        <button
          onClick={handleHide}
          className="w-full mt-4 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-white transition-colors"
        >
          关闭设置
        </button>
      </div>
    </div>
  );
}
