/**
 * 简单的 toast 通知（无依赖）
 *
 * 使用：
 *   import { toast } from "../utils/toast";
 *   toast.error("生成失败：网络问题");
 *   toast.info("已保存");
 */

type ToastKind = "error" | "info" | "success";

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 100000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  `;
  document.body.appendChild(container);
  return container;
}

function show(kind: ToastKind, message: string, duration = 4000) {
  const root = ensureContainer();
  const node = document.createElement("div");

  const palette: Record<ToastKind, { bg: string; border: string; color: string; icon: string }> = {
    error: {
      bg: "rgba(254, 242, 242, 0.98)",
      border: "rgba(239, 68, 68, 0.3)",
      color: "#991b1b",
      icon: "⚠️",
    },
    info: {
      bg: "rgba(243, 232, 255, 0.98)",
      border: "rgba(147, 51, 234, 0.3)",
      color: "#5b21b6",
      icon: "ℹ️",
    },
    success: {
      bg: "rgba(220, 252, 231, 0.98)",
      border: "rgba(34, 197, 94, 0.3)",
      color: "#166534",
      icon: "✓",
    },
  };
  const p = palette[kind];

  node.style.cssText = `
    pointer-events: auto;
    min-width: 240px;
    max-width: 360px;
    padding: 12px 14px;
    border-radius: 10px;
    background: ${p.bg};
    border: 1px solid ${p.border};
    color: ${p.color};
    font-size: 13px;
    line-height: 1.5;
    box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    backdrop-filter: blur(10px);
    display: flex;
    gap: 8px;
    align-items: flex-start;
    transform: translateX(20px);
    opacity: 0;
    transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  `;
  node.innerHTML = `
    <span style="font-size: 16px; flex-shrink: 0;">${p.icon}</span>
    <span style="flex: 1; word-break: break-word;"></span>
    <span style="cursor: pointer; opacity: 0.5; flex-shrink: 0;" data-close>✕</span>
  `;
  // 安全地设置文本内容（防止 XSS）
  const textSpan = node.querySelector("span:nth-child(2)") as HTMLSpanElement;
  if (textSpan) textSpan.textContent = message;

  const closeBtn = node.querySelector("[data-close]") as HTMLSpanElement;
  function dismiss() {
    node.style.transform = "translateX(20px)";
    node.style.opacity = "0";
    setTimeout(() => {
      node.remove();
    }, 250);
  }
  if (closeBtn) closeBtn.addEventListener("click", dismiss);

  root.appendChild(node);
  // 入场动画
  requestAnimationFrame(() => {
    node.style.transform = "translateX(0)";
    node.style.opacity = "1";
  });

  setTimeout(dismiss, duration);
}

export const toast = {
  error: (message: string, duration?: number) => show("error", message, duration),
  info: (message: string, duration?: number) => show("info", message, duration),
  success: (message: string, duration?: number) => show("success", message, duration),
};
