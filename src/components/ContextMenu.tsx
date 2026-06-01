/**
 * Right-click context menu — 气泡框风格
 *
 * 选项：
 *   切换动作（二级展开当前形象的所有动作 + 缩略图）
 *   大小（二级展开三档）
 *   切换形象（点击打开 main 窗口的 AvatarManager）
 *   关闭
 */

import { useEffect, useRef, useState } from "react";
import type { ActionState } from "../core/types";
import { ALL_ACTIONS, DEFAULT_ACTION_SPECS } from "../core/types";

interface ContextMenuProps {
  petSize: number;
  framePadding: number;
  windowSize: number;
  /** 当前形象的所有动作帧（key=action, value=帧 dataUrl 数组） */
  actionFrames: Partial<Record<ActionState, string[]>>;
  /** 当前 baseAction（用户手动选择的"基线动作"） */
  baseAction: ActionState;
  onClose: () => void;
  onSetAction: (action: ActionState) => void;
  onOpenAvatarManager: () => void;
  onSetSize: (size: number) => void | Promise<void>;
}

const SIZE_PRESETS: { label: string; px: number }[] = [
  { label: "小", px: 120 },
  { label: "中", px: 180 },
  { label: "大", px: 240 },
];

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

export function ContextMenu({
  petSize,
  framePadding,
  windowSize,
  actionFrames,
  baseAction,
  onClose,
  onSetAction,
  onOpenAvatarManager,
  onSetSize,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [showActionList, setShowActionList] = useState(true);
  const [showSizeList, setShowSizeList] = useState(false);

  // ---- 进入动画 + 关闭外部点击监听 ----
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));

    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleOutside, true);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleOutside, true);
    };
  }, [onClose]);

  function handleClickAction(action: ActionState) {
    onSetAction(action);
    onClose();
  }

  async function handleSetSizePreset(px: number) {
    await onSetSize(px);
    onClose();
  }

  function handleClickSwitchAvatar() {
    onOpenAvatarManager();
    onClose();
  }

  async function handleQuit() {
    onClose();
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const sf = await win.scaleFactor();
      const { saveConfig } = await import("../utils/config-store");
      // outerPosition 是物理像素，需转为逻辑像素再持久化（与 setPosition 单位一致）
      await saveConfig({
        lastPosition: { x: Math.round(pos.x / sf), y: Math.round(pos.y / sf) },
      });
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    } catch {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch {}
    }
  }

  // ---- 菜单定位 ----
  const menuLeft = framePadding + petSize + 8;
  const menuTop = framePadding;
  const menuMaxWidth = windowSize - menuLeft - 8;
  const menuMaxHeight = windowSize - menuTop - 8;

  return (
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: menuLeft,
        top: menuTop,
        width: Math.max(180, Math.min(menuMaxWidth, 200)),
        maxHeight: menuMaxHeight,
        overflowY: "auto",
        zIndex: 9999,
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.92)",
        transformOrigin: "left top",
        transition: "all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)",
        background: "rgba(255, 255, 255, 0.97)",
        backdropFilter: "blur(12px)",
        borderRadius: 14,
        padding: 6,
        boxShadow: "0 12px 36px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
        border: "1px solid rgba(0,0,0,0.06)",
      }}
    >
      {/* ===== 切换动作 ===== */}
      <MenuRow
        icon="🎭"
        label="切换动作"
        active={showActionList}
        rightSlot={<Chevron rotated={showActionList} />}
        onClick={() => setShowActionList(!showActionList)}
      />
      {showActionList && (
        <div style={subListStyle}>
          {ALL_ACTIONS.map((action) => {
            const frames = actionFrames[action];
            const thumbnail = frames?.[0];
            const isCurrent = action === baseAction;
            const spec = DEFAULT_ACTION_SPECS[action];
            return (
              <button
                key={action}
                onClick={() => handleClickAction(action)}
                disabled={!thumbnail}
                style={{
                  ...subItemStyle,
                  background: isCurrent
                    ? "rgba(147, 51, 234, 0.1)"
                    : "transparent",
                  color: isCurrent ? "#7c3aed" : "#4b5563",
                  fontWeight: isCurrent ? 600 : 400,
                  opacity: thumbnail ? 1 : 0.4,
                  cursor: thumbnail ? "pointer" : "not-allowed",
                }}
                onMouseEnter={(e) => {
                  if (!isCurrent && thumbnail) {
                    (e.currentTarget as HTMLElement).style.background =
                      "rgba(0,0,0,0.04)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isCurrent) {
                    (e.currentTarget as HTMLElement).style.background =
                      "transparent";
                  }
                }}
              >
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt=""
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      objectFit: "contain",
                      background: isCurrent
                        ? "rgba(147,51,234,0.08)"
                        : "rgba(0,0,0,0.03)",
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      background: "rgba(0,0,0,0.05)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      fontSize: 14,
                    }}
                  >
                    -
                  </span>
                )}
                <span style={{ flex: 1, textAlign: "left" }}>
                  {ACTION_LABELS[action]}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: spec.loop ? "#10b981" : "#f59e0b",
                  }}
                >
                  {spec.loop ? "循环" : "一次"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <Divider />

      {/* ===== 大小 ===== */}
      <MenuRow
        icon="📏"
        label="大小"
        active={showSizeList}
        rightSlot={
          <>
            <span style={{ fontSize: 11, color: "#9ca3af", marginRight: 4 }}>
              {petSize}px
            </span>
            <Chevron rotated={showSizeList} />
          </>
        }
        onClick={() => setShowSizeList(!showSizeList)}
      />
      {showSizeList && (
        <div style={subListStyle}>
          {SIZE_PRESETS.map((preset) => {
            const active = Math.abs(petSize - preset.px) < 5;
            return (
              <button
                key={preset.label}
                onClick={() => handleSetSizePreset(preset.px)}
                style={{
                  ...subItemStyle,
                  background: active
                    ? "rgba(147, 51, 234, 0.1)"
                    : "transparent",
                  color: active ? "#7c3aed" : "#4b5563",
                  fontWeight: active ? 600 : 400,
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    (e.currentTarget as HTMLElement).style.background =
                      "rgba(0,0,0,0.04)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    (e.currentTarget as HTMLElement).style.background =
                      "transparent";
                  }
                }}
              >
                <span style={{ fontSize: 13, width: 16, textAlign: "center" }}>
                  {active ? "●" : "○"}
                </span>
                <span style={{ flex: 1, textAlign: "left" }}>{preset.label}</span>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>
                  {preset.px}px
                </span>
              </button>
            );
          })}
          <div style={hintStyle}>💡 在桌宠上滚动滚轮可微调</div>
        </div>
      )}

      <Divider />

      {/* ===== 切换形象（打开管理面板） ===== */}
      <MenuRow
        icon="🎨"
        label="切换形象"
        rightSlot={
          <span style={{ fontSize: 10, color: "#9ca3af" }}>...</span>
        }
        onClick={handleClickSwitchAvatar}
      />

      {/* ===== 关闭 ===== */}
      <MenuRow icon="✕" label="关闭" danger onClick={handleQuit} />
    </div>
  );
}

// ============================================================
// 小组件 / 样式
// ============================================================

function MenuRow({
  icon,
  label,
  active,
  danger,
  rightSlot,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  rightSlot?: React.ReactNode;
  onClick: () => void;
}) {
  const baseColor = danger ? "#dc2626" : "#374151";
  const hoverBg = danger ? "rgba(220,38,38,0.08)" : "rgba(0,0,0,0.04)";

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 12px",
        border: "none",
        background: active ? "rgba(147, 51, 234, 0.08)" : "transparent",
        borderRadius: 8,
        cursor: "pointer",
        fontSize: 13,
        color: baseColor,
        fontWeight: 500,
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLElement).style.background = hoverBg;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }
      }}
    >
      <span style={{ fontSize: 15, width: 18, textAlign: "center" }}>{icon}</span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      {rightSlot}
    </button>
  );
}

function Chevron({ rotated }: { rotated?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10,
        color: "#9ca3af",
        transform: rotated ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.2s",
      }}
    >
      ▶
    </span>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "rgba(0,0,0,0.06)",
        margin: "4px 8px",
      }}
    />
  );
}

const subListStyle: React.CSSProperties = {
  padding: "2px 4px 4px 4px",
  borderTop: "1px solid rgba(0,0,0,0.04)",
  marginTop: 2,
};

const subItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  transition: "background 0.15s",
};

const hintStyle: React.CSSProperties = {
  padding: "6px 10px 2px 10px",
  fontSize: 11,
  color: "#9ca3af",
  lineHeight: 1.4,
};
