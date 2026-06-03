import { useState, useEffect, useRef } from "react";
import { Onboarding } from "./pages/Onboarding";
import { AvatarManager } from "./pages/AvatarManager";
import { Settings } from "./pages/Settings";
import { checkForUpdate } from "./utils/check-update";

import "./styles.css";

type AppView =
  // 首启动短暂态：等 Rust 那边初始化完默认形象 + config
  | "loading"
  // 形象列表（应用进来的默认页）
  | "avatar-manager"
  // Evolink + 检查更新
  | "settings"
  // 加新形象 / 重新生成（走 Onboarding 的 photo 步骤）
  | "redesign"
  // 主面板已被关闭（红叉），桌宠仍在桌面上
  | "hidden";

interface UpdateBanner {
  version: string;
  notes?: string;
  install: () => Promise<void>;
}

export default function App() {
  const [view, setView] = useState<AppView>("loading");
  const [updateBanner, setUpdateBanner] = useState<UpdateBanner | null>(null);
  const [installing, setInstalling] = useState(false);
  // 收集所有 Tauri event listener 的 unlisten 句柄，cleanup 时统一释放
  const unlistensRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    bootstrap();
    setupEventListeners();
    backgroundCheckUpdate();
    return () => {
      unlistensRef.current.forEach((u) => {
        try {
          u();
        } catch {}
      });
      unlistensRef.current = [];
    };
  }, []);

  /**
   * Rust setup 已经把默认形象 + config 安顿好，主窗口和桌宠都 show 了。
   * 这里就直接进 avatar-manager；如果出意外没读到 config，兜底也仍然进 avatar-manager
   * （AvatarManager 自己会 load 形象列表，看到默认形象目录就能渲染出来）。
   */
  async function bootstrap() {
    setView("avatar-manager");
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

  /**
   * 启动后悄悄检查一次更新；有新版就在主面板顶部塞一条横幅。
   * 失败静默（用户可在 设置 里手动检查看具体错误）。
   */
  async function backgroundCheckUpdate() {
    try {
      const result = await checkForUpdate();
      if (result) {
        setUpdateBanner({
          version: result.version,
          notes: result.notes,
          install: result.install,
        });
      }
    } catch {
      // 静默：dev 模式下 endpoint 没配会失败，不打扰用户
    }
  }

  async function handleInstallUpdate() {
    if (!updateBanner) return;
    setInstalling(true);
    try {
      await updateBanner.install();
    } catch (err) {
      console.error("[App] update install failed:", err);
      setInstalling(false);
    }
  }

  function handleOnboardingComplete() {
    // redesign 完成 → 回到管理面板（让用户看到刚生成的形象）
    setView("avatar-manager");
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

  // ---- Render ----
  const banner =
    updateBanner && (view === "avatar-manager" || view === "settings") ? (
      <div style={updateBannerStyle}>
        <span style={{ flex: 1 }}>
          ✨ 新版本 v{updateBanner.version} 已就绪
        </span>
        <button
          onClick={handleInstallUpdate}
          disabled={installing}
          style={{
            ...bannerBtn,
            opacity: installing ? 0.5 : 1,
            cursor: installing ? "not-allowed" : "pointer",
          }}
        >
          {installing ? "安装中…" : "立即更新"}
        </button>
      </div>
    ) : null;

  if (view === "loading") {
    return (
      <div style={loadingWrap}>
        <div style={loadingText}>加载中…</div>
      </div>
    );
  }

  if (view === "hidden") {
    return (
      <div style={loadingWrap}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--ink-soft)", margin: 0, fontSize: 14, letterSpacing: 0.5 }}>
            桌面宠物运行中
          </p>
          <p
            style={{
              fontSize: 12,
              color: "var(--ink-muted)",
              marginTop: 8,
              fontStyle: "italic",
            }}
          >
            右键点击桌宠可调整设置
          </p>
        </div>
      </div>
    );
  }

  if (view === "settings") {
    return (
      <>
        {banner}
        <Settings onBack={() => setView("avatar-manager")} />
      </>
    );
  }

  if (view === "avatar-manager") {
    return (
      <>
        {banner}
        <AvatarManager
          onAddAvatar={handleAddNewAvatar}
          onClose={handleCloseManager}
          onOpenSettings={() => setView("settings")}
        />
      </>
    );
  }

  // redesign：从 AvatarManager "+" 进来，给 Onboarding 的 photo 步骤
  return (
    <Onboarding
      onComplete={handleOnboardingComplete}
      skipToPhoto={true}
      onBack={() => setView("avatar-manager")}
    />
  );
}

// ============================================================
// 样式
// ============================================================
const loadingWrap: React.CSSProperties = {
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--paper-bg)",
  fontFamily: "var(--font-cn)",
};

const loadingText: React.CSSProperties = {
  fontSize: 14,
  color: "var(--ink-muted)",
  fontStyle: "italic",
  letterSpacing: 1,
  animation: "inkPulse 1.6s ease-in-out infinite",
};

const updateBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 18px",
  background: "linear-gradient(90deg, rgba(196, 112, 75, 0.12), rgba(196, 112, 75, 0.06))",
  borderBottom: "1px solid var(--accent-border)",
  fontSize: 13,
  color: "var(--ink)",
  fontFamily: "var(--font-cn)",
  letterSpacing: 0.3,
};

const bannerBtn: React.CSSProperties = {
  padding: "6px 16px",
  background: "var(--accent)",
  color: "var(--paper-elevated)",
  border: "none",
  borderRadius: "var(--radius-md)",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--font-cn)",
  letterSpacing: 1,
  transition: "all 0.18s ease",
};
