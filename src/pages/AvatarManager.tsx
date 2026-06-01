/**
 * Avatar Manager — 形象管理面板
 *
 * 双行布局：
 *   第一行：所有已生成的形象（横向滚动，末尾 + 按钮新增）
 *   第二行：当前选中形象的所有动作（点击可让桌宠切换到该动作）
 */

import { useState, useEffect, useCallback } from "react";
import type { ActionState } from "../core/types";
import { ALL_ACTIONS } from "../core/types";
import { listAvatarPacks } from "../core/avatar-store";
import { loadConfig, saveConfig } from "../utils/config-store";

interface AvatarMeta {
  id: string;
  name: string;
  thumbnail?: string;
  createdAt?: number;
}

const ACTION_LABELS: Record<ActionState, string> = {
  idle: "待机",
  walk: "散步",
  sleep: "睡觉",
  happy: "开心",
  sad: "难过",
  stretch: "伸懒腰",
  looking_around: "张望",
  drag: "被拖拽",
};

interface Props {
  onAddAvatar: () => void;
  onClose: () => void;
}

export function AvatarManager({ onAddAvatar, onClose }: Props) {
  const [avatars, setAvatars] = useState<AvatarMeta[]>([]);
  const [currentAvatarId, setCurrentAvatarId] = useState<string>("");
  const [actionFrames, setActionFrames] = useState<
    Partial<Record<ActionState, string[]>>
  >({});
  const [selectedAction, setSelectedAction] = useState<ActionState | null>(null);
  const [loading, setLoading] = useState(true);
  // 删除确认弹窗状态
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  // ---- 加载所有形象（含缩略图）和当前选中形象 ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const config = await loadConfig();
      const ids = await listAvatarPacks();

      const metas: AvatarMeta[] = [];
      for (const id of ids) {
        try {
          const fs = await import("@tauri-apps/plugin-fs");
          const path = await import("@tauri-apps/api/path");
          const appData = await path.appDataDir();
          const dir = await path.join(appData, "avatars", id);

          let name = id;
          let createdAt: number | undefined;
          try {
            const manifestPath = await path.join(dir, "manifest.json");
            const text = await fs.readTextFile(manifestPath);
            const manifest = JSON.parse(text);
            if (manifest.name) name = manifest.name;
            if (manifest.createdAt) createdAt = Number(manifest.createdAt);
          } catch {}

          let thumbnail: string | undefined;
          try {
            const thumbPath = await path.join(dir, "idle", "01.png");
            const bin = await fs.readFile(thumbPath);
            thumbnail = "data:image/png;base64," + uint8ToBase64(bin);
          } catch {}

          metas.push({ id, name, thumbnail, createdAt });
        } catch {
          metas.push({ id, name: id });
        }
      }

      metas.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

      if (cancelled) return;
      setAvatars(metas);

      // 设置当前形象
      const defaultId = config?.currentAvatarId ?? metas[0]?.id ?? "";
      if (defaultId) {
        setCurrentAvatarId(defaultId);
        await loadActionFrames(defaultId);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 加载某形象的所有动作帧 ----
  const loadActionFrames = useCallback(async (avatarId: string) => {
    try {
      const fs = await import("@tauri-apps/plugin-fs");
      const path = await import("@tauri-apps/api/path");
      const appData = await path.appDataDir();
      const avatarDir = await path.join(appData, "avatars", avatarId);

      const result: Partial<Record<ActionState, string[]>> = {};
      for (const action of ALL_ACTIONS) {
        try {
          const actionDir = await path.join(avatarDir, action);
          const exists = await fs.exists(actionDir);
          if (!exists) continue;
          const entries = await fs.readDir(actionDir);
          const pngs = entries
            .filter((e) => e.name?.endsWith(".png"))
            .map((e) => e.name!)
            .sort();
          const dataUrls: string[] = [];
          for (const p of pngs) {
            const filePath = await path.join(actionDir, p);
            const bin = await fs.readFile(filePath);
            dataUrls.push("data:image/png;base64," + uint8ToBase64(bin));
          }
          if (dataUrls.length > 0) result[action] = dataUrls;
        } catch {}
      }
      setActionFrames(result);
    } catch (err) {
      console.error("[AvatarManager] load frames failed:", err);
    }
  }, []);

  // ---- 切换形象 ----
  async function handleSwitchAvatar(id: string) {
    if (id === currentAvatarId) return;
    setCurrentAvatarId(id);
    setSelectedAction(null);
    await loadActionFrames(id);
    try {
      await saveConfig({ currentAvatarId: id });
      const { emit } = await import("@tauri-apps/api/event");
      await emit("pet:switch-avatar", { avatarId: id });
    } catch {}
  }

  // ---- 删除形象（由确认弹窗触发） ----
  async function handleDeleteAvatar(id: string) {
    // 至少保留一个形象
    if (avatars.length <= 1) {
      // 用 deleteConfirm 的特殊形式来展示提示（复用弹窗）
      return;
    }
    const target = avatars.find((a) => a.id === id);
    const name = target?.name ?? id;
    // 弹出确认弹窗
    setDeleteConfirm({ id, name });
  }

  // 确认删除
  async function confirmDelete() {
    if (!deleteConfirm) return;
    const id = deleteConfirm.id;
    setDeleteConfirm(null);

    try {
      const { clearAvatarPack } = await import("../core/avatar-store");
      await clearAvatarPack(id);
    } catch (err) {
      console.error("[AvatarManager] delete failed:", err);
      return;
    }

    // 更新列表
    const remaining = avatars.filter((a) => a.id !== id);
    setAvatars(remaining);

    // 如果删的是当前形象，自动切到第一个剩余形象
    if (id === currentAvatarId && remaining.length > 0) {
      const next = remaining[0];
      setCurrentAvatarId(next.id);
      setSelectedAction(null);
      await loadActionFrames(next.id);
      try {
        await saveConfig({ currentAvatarId: next.id });
        const { emit } = await import("@tauri-apps/api/event");
        await emit("pet:switch-avatar", { avatarId: next.id });
      } catch {}
    }
  }

  // ---- 重命名形象 ----
  async function handleRename(id: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const target = avatars.find((a) => a.id === id);
    if (!target || target.name === trimmed) return;

    // 立即更新 UI（乐观）
    setAvatars((prev) =>
      prev.map((a) => (a.id === id ? { ...a, name: trimmed } : a))
    );

    // 写入 manifest.json
    try {
      const fs = await import("@tauri-apps/plugin-fs");
      const path = await import("@tauri-apps/api/path");
      const appData = await path.appDataDir();
      const manifestPath = await path.join(
        appData,
        "avatars",
        id,
        "manifest.json"
      );
      const exists = await fs.exists(manifestPath);
      if (!exists) return;
      const text = await fs.readTextFile(manifestPath);
      const m = JSON.parse(text);
      m.name = trimmed;
      await fs.writeTextFile(manifestPath, JSON.stringify(m, null, 2));
    } catch (err) {
      console.error("[AvatarManager] rename failed:", err);
      // 写入失败：回滚 UI
      setAvatars((prev) =>
        prev.map((a) => (a.id === id ? { ...a, name: target.name } : a))
      );
      alert("重命名失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ---- 让桌宠播放某动作 ----
  async function handlePlayAction(action: ActionState) {
    setSelectedAction(action);
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("pet:force-action", { action });
    } catch {}
  }

  return (
    <div
      style={{
        height: "100vh",
        background: "linear-gradient(135deg, #f5f3ff 0%, #fdf4ff 100%)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 顶栏 */}
      <div
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid rgba(0,0,0,0.05)",
          background: "rgba(255,255,255,0.6)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1f2937" }}>
            形象管理
          </h2>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
            选择一个形象，点击下方动作让桌宠表演
          </p>
        </div>
        <button
          onClick={onClose}
          style={{
            border: "none",
            background: "rgba(0,0,0,0.04)",
            width: 32,
            height: 32,
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 14,
            color: "#6b7280",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.08)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.04)";
          }}
        >
          ✕
        </button>
      </div>

      {/* 内容 */}
      {loading ? (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
          <SkeletonSection title="形象" count={3} />
          <SkeletonSection title="动作" count={6} />
          <style>{`
            @keyframes skeleton-pulse {
              0%, 100% { opacity: 0.55; }
              50% { opacity: 0.85; }
            }
          `}</style>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
          {/* ===== 第一行：形象列表 ===== */}
          <Section title="形象" subtitle={`共 ${avatars.length} 个`}>
            <ScrollRow>
              {avatars.map((a) => {
                const active = a.id === currentAvatarId;
                return (
                  <div
                    key={a.id}
                    style={{ position: "relative", flexShrink: 0 }}
                    onMouseEnter={(e) => {
                      const btn = (e.currentTarget as HTMLElement).querySelector(
                        ".avatar-delete-btn"
                      ) as HTMLElement | null;
                      if (btn) btn.style.opacity = "1";
                    }}
                    onMouseLeave={(e) => {
                      const btn = (e.currentTarget as HTMLElement).querySelector(
                        ".avatar-delete-btn"
                      ) as HTMLElement | null;
                      if (btn) btn.style.opacity = "0";
                    }}
                  >
                    <Card
                      active={active}
                      onClick={() => handleSwitchAvatar(a.id)}
                      label={a.name}
                      labelNode={
                        <EditableLabel
                          value={a.name}
                          active={active}
                          onCommit={(newName) => handleRename(a.id, newName)}
                        />
                      }
                      badge={active ? "使用中" : undefined}
                    >
                      {a.thumbnail ? (
                        <img
                          src={a.thumbnail}
                          alt={a.name}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 32,
                          }}
                        >
                          🐾
                        </div>
                      )}
                    </Card>
                    {/* 删除按钮（hover 显示）。注意位置必须在 Card 内右上角，
                        不能溢出（top: -6 会被外层 ScrollRow 的 overflowY: hidden 截断） */}
                    {avatars.length > 1 && (
                      <button
                        className="avatar-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteAvatar(a.id);
                        }}
                        title="删除形象"
                        style={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          border: "none",
                          background: "#ef4444",
                          color: "white",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                          opacity: 0,
                          transition: "opacity 0.15s",
                          boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                          lineHeight: 1,
                          zIndex: 2,
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}

              {/* + 按钮：新增形象（与 Card 同尺寸：96x96 图区 + 下方 label） */}
              <button
                onClick={onAddAvatar}
                style={{
                  flexShrink: 0,
                  width: 96,
                  border: "none",
                  padding: 0,
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 4,
                }}
                onMouseEnter={(e) => {
                  const tile = (e.currentTarget as HTMLElement).querySelector(
                    ".add-avatar-tile"
                  ) as HTMLElement | null;
                  if (tile) {
                    tile.style.background = "rgba(147, 51, 234, 0.08)";
                    tile.style.borderColor = "rgba(147, 51, 234, 0.5)";
                    tile.style.transform = "translateY(-2px)";
                  }
                }}
                onMouseLeave={(e) => {
                  const tile = (e.currentTarget as HTMLElement).querySelector(
                    ".add-avatar-tile"
                  ) as HTMLElement | null;
                  if (tile) {
                    tile.style.background = "rgba(147, 51, 234, 0.04)";
                    tile.style.borderColor = "rgba(147, 51, 234, 0.3)";
                    tile.style.transform = "translateY(0)";
                  }
                }}
              >
                <div
                  className="add-avatar-tile"
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 12,
                    border: "2px dashed rgba(147, 51, 234, 0.3)",
                    background: "rgba(147, 51, 234, 0.04)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#7c3aed",
                    fontSize: 32,
                    lineHeight: 1,
                    transition: "all 0.18s",
                  }}
                >
                  +
                </div>
                <span
                  style={{
                    fontSize: 11,
                    color: "#7c3aed",
                    fontWeight: 500,
                    textAlign: "center",
                    whiteSpace: "nowrap",
                  }}
                >
                  新增形象
                </span>
              </button>
            </ScrollRow>
          </Section>

          {/* ===== 第二行：当前形象的动作 ===== */}
          <Section
            title="动作"
            subtitle="点击让桌宠表演（成为新的默认动作）"
          >
            <ScrollRow>
              {ALL_ACTIONS.map((action) => {
                const frames = actionFrames[action];
                const thumbnail = frames?.[0];
                const active = action === selectedAction;
                return (
                  <Card
                    key={action}
                    active={active}
                    disabled={!thumbnail}
                    onClick={() => thumbnail && handlePlayAction(action)}
                    label={ACTION_LABELS[action]}
                  >
                    {thumbnail ? (
                      <img
                        src={thumbnail}
                        alt={action}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          color: "#d1d5db",
                          fontSize: 11,
                          textAlign: "center",
                        }}
                      >
                        无
                      </div>
                    )}
                  </Card>
                );
              })}
            </ScrollRow>
          </Section>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(4px)",
          }}
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 16,
              padding: "24px 28px",
              width: 300,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 600, color: "#1f2937" }}>
              确认删除
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 14, color: "#6b7280", lineHeight: 1.5 }}>
              确定删除「{deleteConfirm.name}」？此操作不可恢复。
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteConfirm(null)}
                style={{
                  padding: "8px 16px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  background: "white",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#374151",
                  cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                onClick={confirmDelete}
                style={{
                  padding: "8px 16px",
                  border: "none",
                  borderRadius: 8,
                  background: "#ef4444",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "white",
                  cursor: "pointer",
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 小组件
// ============================================================

function SkeletonSection({ title, count }: { title: string; count: number }) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "#374151",
          }}
        >
          {title}
        </h3>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>加载中...</span>
      </div>
      <div style={{ display: "flex", gap: 10, overflowX: "hidden" }}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            style={{
              width: 96,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              animation: "skeleton-pulse 1.4s ease-in-out infinite",
              animationDelay: `${i * 0.1}s`,
            }}
          >
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 12,
                background:
                  "linear-gradient(135deg, rgba(0,0,0,0.06), rgba(0,0,0,0.03))",
              }}
            />
            <div
              style={{
                width: "70%",
                height: 10,
                borderRadius: 4,
                background: "rgba(0,0,0,0.06)",
                margin: "0 auto",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "#374151",
          }}
        >
          {title}
        </h3>
        {subtitle && (
          <span style={{ fontSize: 12, color: "#9ca3af" }}>{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function ScrollRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        overflowX: "auto",
        overflowY: "hidden",
        // 给上方留出 hover translateY(-2px) 和"使用中/✕"徽章的呼吸空间
        // （overflowY: hidden 会裁掉超出 paddingBox 的部分，所以必须用 padding 而不是 margin）
        paddingTop: 8,
        paddingBottom: 8,
        scrollbarWidth: "thin",
      }}
    >
      {children}
    </div>
  );
}

function Card({
  children,
  active,
  disabled,
  onClick,
  label,
  labelNode,
  badge,
  badgeColor,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  label: string;
  /** 自定义 label 区域（用于可编辑名字等场景），若提供则替代默认 span */
  labelNode?: React.ReactNode;
  badge?: string;
  badgeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flexShrink: 0,
        width: 96,
        border: "none",
        padding: 0,
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 4,
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: 12,
          border: active
            ? "2px solid #7c3aed"
            : "1px solid rgba(0,0,0,0.06)",
          background: active ? "rgba(147,51,234,0.06)" : "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
          boxShadow: active
            ? "0 4px 12px rgba(147,51,234,0.15)"
            : "0 1px 3px rgba(0,0,0,0.04)",
          transition: "all 0.18s",
        }}
        onMouseEnter={(e) => {
          if (!disabled && !active) {
            (e.currentTarget as HTMLElement).style.borderColor =
              "rgba(147,51,234,0.4)";
            (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            (e.currentTarget as HTMLElement).style.borderColor =
              "rgba(0,0,0,0.06)";
            (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
          }
        }}
      >
        {children}
        {badge && (
          <span
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              padding: "1px 6px",
              fontSize: 9,
              fontWeight: 600,
              borderRadius: 4,
              background: badgeColor ?? "rgba(147,51,234,0.9)",
              color: "white",
              letterSpacing: 0.3,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {labelNode ?? (
        <span
          style={{
            fontSize: 11,
            color: active ? "#7c3aed" : "#6b7280",
            fontWeight: active ? 600 : 500,
            textAlign: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      )}
    </button>
  );
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 可编辑的形象名 label：
 *   - 默认显示文本，hover 提示可点击
 *   - 点击进入编辑态（input），Enter / blur 提交，Esc 取消
 *   - 阻止冒泡到 Card 的 button onClick（避免点 label 切换形象）
 */
function EditableLabel({
  value,
  active,
  onCommit,
}: {
  value: string;
  active?: boolean;
  onCommit: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // 外部 value 变化时（如刚切换形象、命名失败回滚）同步 draft
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commonStyle: React.CSSProperties = {
    fontSize: 11,
    color: active ? "#7c3aed" : "#6b7280",
    fontWeight: active ? 600 : 500,
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onBlur={() => {
          setEditing(false);
          const t = draft.trim();
          if (t && t !== value) onCommit(t);
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        maxLength={40}
        style={{
          ...commonStyle,
          width: "100%",
          boxSizing: "border-box",
          padding: "1px 4px",
          margin: 0,
          border: "1px solid #7c3aed",
          borderRadius: 4,
          outline: "none",
          background: "white",
        }}
      />
    );
  }

  return (
    <span
      title="点击重命名"
      onClick={(e) => {
        // 阻止 Card button 的 onClick 切换形象
        e.stopPropagation();
        setEditing(true);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        ...commonStyle,
        cursor: "text",
        padding: "1px 4px",
        borderRadius: 4,
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background =
          "rgba(124, 58, 237, 0.06)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {value}
    </span>
  );
}

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
