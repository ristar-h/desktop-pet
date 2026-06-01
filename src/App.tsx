import { useState, useEffect, useRef } from "react";
import { Onboarding } from "./pages/Onboarding";
import { AvatarManager } from "./pages/AvatarManager";
import { loadConfig } from "./utils/config-store";

import "./styles.css";

type AppView =
  | "loading"
  | "onboarding"
  | "redesign"
  | "avatar-manager"
  | "hidden";

export default function App() {
  const [view, setView] = useState<AppView>("loading");
  // 收集所有 Tauri event listener 的 unlisten 句柄，cleanup 时统一释放
  // （StrictMode dev 下 useEffect 双调用会注册两份回调，必须能移除避免重复响应）
  const unlistensRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    checkFirstLaunch();
    setupEventListeners();
    return () => {
      unlistensRef.current.forEach((u) => {
        try {
          u();
        } catch {}
      });
      unlistensRef.current = [];
    };
  }, []);

  async function checkFirstLaunch() {
    try {
      const config = await loadConfig();
      if (config && config.onboardingCompleted) {
        // 老用户：Rust setup 已经 show pet 窗口；这里把 main 窗口隐藏
        setView("hidden");
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().hide();
        } catch {}
        // 兜底：万一 Rust 端没 show（read_onboarding_completed 失败等），这里再 show 一次 pet
        try {
          const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          const petWindow = await WebviewWindow.getByLabel("pet");
          if (petWindow) await petWindow.show();
        } catch {}
      } else {
        // 首次启动：Rust setup 已经 show main 窗口，这里只切 view
        setView("onboarding");
      }
    } catch {
      setView("onboarding");
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().show();
      } catch {}
    }
  }

  async function setupEventListeners() {
    try {
      const { listen } = await import("@tauri-apps/api/event");

      // 从右键菜单"切换形象"触发 → 打开形象管理面板（同时显示 main 窗口）
      const u1 = await listen("app:show-avatar-manager", async () => {
        setView("avatar-manager");
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } catch {}
      });
      unlistensRef.current.push(u1);
    } catch {}
  }

  async function showPetWindow() {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const petWindow = await WebviewWindow.getByLabel("pet");
      if (petWindow) {
        await petWindow.show();
      }
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const mainWindow = getCurrentWindow();
      await mainWindow.hide();
    } catch (err) {
      console.error("Failed to show pet window:", err);
    }
  }

  function handleOnboardingComplete() {
    // 首次完成 → 隐藏主窗口，回到桌宠模式（用户可右键唤起菜单）
    // 重新生成完成 → 回到形象管理面板（让用户能看到刚生成的形象）
    if (view === "onboarding") {
      setView("hidden");
      showPetWindow();
    } else {
      // view === "redesign"，回到管理面板
      setView("avatar-manager");
    }
  }

  async function handleCloseManager() {
    setView("hidden");
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {}
  }

  function handleAddNewAvatar() {
    setView("redesign");
  }

  if (view === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50">
        <div className="text-lg text-gray-500 animate-pulse">加载中...</div>
      </div>
    );
  }

  if (view === "hidden") {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50">
        <div className="text-center">
          <p className="text-gray-500">桌面宠物运行中！</p>
          <p className="text-sm text-gray-400 mt-2">右键点击桌宠可调整设置。</p>
        </div>
      </div>
    );
  }

  if (view === "avatar-manager") {
    return (
      <AvatarManager
        onAddAvatar={handleAddNewAvatar}
        onClose={handleCloseManager}
      />
    );
  }

  // "重新生成"模式（含 AvatarManager 的 + 按钮入口）
  if (view === "redesign") {
    return (
      <Onboarding
        onComplete={handleOnboardingComplete}
        skipToPhoto={true}
        onBack={() => setView("avatar-manager")}
      />
    );
  }

  return <Onboarding onComplete={handleOnboardingComplete} />;
}
