/**
 * Settings — 主面板的设置页
 *
 * 功能：
 *  1. Evolink API 密钥（之前在 Onboarding 第 2 步，现在搬到这里 / 加新形象时才需要）
 *  2. 检查更新（手动触发；启动时也会自动跑一次，发现新版会在 App 顶部塞横幅）
 */

import { useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../utils/config-store";
import { checkForUpdate } from "../utils/check-update";

interface Props {
  onBack: () => void;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "error"; message: string }
  | { kind: "available"; version: string; install: () => Promise<void> };

export function Settings({ onBack }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [installing, setInstalling] = useState(false);

  // 加载已保存的 key
  useEffect(() => {
    loadConfig().then((config) => {
      if (config?.apiKey) setApiKey(config.apiKey);
    });
  }, []);

  async function handleSave() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setApiKeyError("请输入你的 API 密钥");
      return;
    }
    if (!trimmed.startsWith("sk-")) {
      setApiKeyError("API 密钥应以 'sk-' 开头");
      return;
    }
    setApiKeyError("");
    setSaving(true);
    try {
      await saveConfig({ apiKey: trimmed });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setApiKeyError(`保存失败：${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleCheckUpdate() {
    setCheck({ kind: "checking" });
    try {
      const result = await checkForUpdate();
      if (!result) {
        setCheck({ kind: "uptodate" });
      } else {
        setCheck({ kind: "available", version: result.version, install: result.install });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCheck({ kind: "error", message: msg });
    }
  }

  async function handleInstall() {
    if (check.kind !== "available") return;
    setInstalling(true);
    try {
      await check.install();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCheck({ kind: "error", message: msg });
      setInstalling(false);
    }
  }

  return (
    <div style={pageWrap}>
      {/* 顶栏：返回 + 标题 */}
      <div style={topBar}>
        <button
          onClick={onBack}
          style={backBtn}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--accent)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--ink-soft)";
          }}
        >
          ← 返回
        </button>
        <h1 style={pageTitle}>设 置</h1>
        <div style={{ width: 56 }} />
      </div>

      {/* 内容区域 */}
      <div style={content}>
        {/* ===== Section: API 密钥 ===== */}
        <section style={section}>
          <h2 style={sectionTitle}>Evolink API 密钥</h2>
          <p style={sectionDesc}>
            生成新形象时需要。
            <a
              href="#"
              onClick={async (e) => {
                e.preventDefault();
                try {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl("https://docs.evolink.ai/cn/quickstart");
                } catch {}
              }}
              style={inlineLink}
            >
              如何获取 →
            </a>
          </p>

          <input
            type="text"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && !saving && handleSave()}
            placeholder="sk-..."
            style={input}
            onFocus={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
            }}
            onBlur={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--ink-faint)";
            }}
          />
          {apiKeyError && <p style={errorText}>{apiKeyError}</p>}

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                ...primaryBtn,
                opacity: saving ? 0.5 : 1,
                cursor: saving ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => !saving && primaryBtnHover.enter(e)}
              onMouseLeave={(e) => !saving && primaryBtnHover.leave(e)}
            >
              {saving ? "保存中…" : "保 存"}
            </button>
            {saved && <span style={savedText}>✓ 已保存</span>}
          </div>
        </section>

        {/* ===== Section: 检查更新 ===== */}
        <section style={section}>
          <h2 style={sectionTitle}>检查更新</h2>
          <p style={sectionDesc}>
            桌宠会持续优化，发现新版本可以一键安装。
          </p>

          {check.kind === "idle" && (
            <button
              onClick={handleCheckUpdate}
              style={secondaryBtn}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
                (e.currentTarget as HTMLElement).style.color = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--ink-faint)";
                (e.currentTarget as HTMLElement).style.color = "var(--ink-soft)";
              }}
            >
              立即检查
            </button>
          )}

          {check.kind === "checking" && <p style={statusText}>正在检查…</p>}

          {check.kind === "uptodate" && (
            <p style={{ ...statusText, color: "var(--sage)" }}>
              ✓ 当前已是最新版本
            </p>
          )}

          {check.kind === "error" && (
            <p style={errorText}>检查失败：{check.message}</p>
          )}

          {check.kind === "available" && (
            <div>
              <p style={{ ...statusText, color: "var(--accent)", marginBottom: 12 }}>
                有新版本 v{check.version} 可用
              </p>
              <button
                onClick={handleInstall}
                disabled={installing}
                style={{
                  ...primaryBtn,
                  opacity: installing ? 0.5 : 1,
                  cursor: installing ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => !installing && primaryBtnHover.enter(e)}
                onMouseLeave={(e) => !installing && primaryBtnHover.leave(e)}
              >
                {installing ? "下载安装中…" : "立即更新"}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ============================================================
// 暖墨手账风样式
// ============================================================
const pageWrap: React.CSSProperties = {
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--paper-bg)",
  fontFamily: "var(--font-cn)",
  color: "var(--ink)",
};

const topBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 24px",
  borderBottom: "1px solid var(--ink-faint)",
};

const backBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--ink-soft)",
  fontSize: 13,
  fontFamily: "var(--font-cn)",
  cursor: "pointer",
  letterSpacing: 0.5,
  padding: "4px 8px",
  transition: "color 0.18s ease",
};

const pageTitle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  color: "var(--ink)",
  margin: 0,
  letterSpacing: 4,
  fontFamily: "var(--font-cn)",
};

const content: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "32px",
  maxWidth: 480,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
};

const section: React.CSSProperties = {
  marginBottom: 36,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  color: "var(--ink)",
  margin: "0 0 6px",
  letterSpacing: 1,
  fontFamily: "var(--font-cn)",
};

const sectionDesc: React.CSSProperties = {
  fontSize: 12,
  color: "var(--ink-soft)",
  margin: "0 0 14px",
  lineHeight: 1.7,
  letterSpacing: 0.3,
};

const inlineLink: React.CSSProperties = {
  color: "var(--accent)",
  textDecoration: "none",
  borderBottom: "1px dashed var(--accent-border)",
  marginLeft: 4,
  fontStyle: "italic",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "11px 14px",
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
};

const errorText: React.CSSProperties = {
  fontSize: 12,
  color: "var(--brick)",
  marginTop: 8,
  fontFamily: "var(--font-cn)",
};

const statusText: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-soft)",
  fontFamily: "var(--font-cn)",
  margin: 0,
  letterSpacing: 0.3,
};

const savedText: React.CSSProperties = {
  fontSize: 12,
  color: "var(--sage)",
  fontFamily: "var(--font-cn)",
  letterSpacing: 0.5,
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 28px",
  background: "var(--accent)",
  color: "var(--paper-elevated)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-md)",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "var(--font-cn)",
  letterSpacing: 1.5,
  cursor: "pointer",
  boxShadow: "0 2px 8px rgba(196, 112, 75, 0.18)",
  transition: "all 0.2s ease",
};

const secondaryBtn: React.CSSProperties = {
  padding: "10px 28px",
  background: "transparent",
  color: "var(--ink-soft)",
  border: "1px solid var(--ink-faint)",
  borderRadius: "var(--radius-md)",
  fontSize: 13,
  fontFamily: "var(--font-cn)",
  letterSpacing: 1.5,
  cursor: "pointer",
  transition: "all 0.2s ease",
};

const primaryBtnHover = {
  enter: (e: React.MouseEvent) => {
    (e.currentTarget as HTMLElement).style.background = "#a85c3a";
    (e.currentTarget as HTMLElement).style.borderColor = "#a85c3a";
    (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
  },
  leave: (e: React.MouseEvent) => {
    (e.currentTarget as HTMLElement).style.background = "var(--accent)";
    (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
    (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
  },
};
