/**
 * 图片预处理工具
 *
 * 解决两个常见问题：
 *   1. iPhone 默认拍出来是 HEIC 格式，Evolink/GPT-Image-2 不接受
 *   2. 高像素照片 base64 后超过 ~10MB 会触发 base64_upload_error
 *
 * 解决方案：
 *   - 用 <img> + canvas 把任何浏览器能解码的图（包括 macOS WebKit 的 HEIC）
 *     重新画到 canvas 上，统一导出为 JPEG
 *   - 同时按最大边长 1024px 等比缩放（参考图够清晰、文件够小）
 *   - 解码失败 → 给出清晰的错误信息
 */

const MAX_DIMENSION = 1024; // 长边最大像素
const JPEG_QUALITY = 0.92; // JPEG 质量
const MAX_INPUT_BYTES = 50 * 1024 * 1024; // 输入文件最大 50MB（防止异常巨大文件直接吃光内存）

export interface ProcessedImage {
  /** 处理后的 File，可直接喂给 image-gen 流水线 */
  file: File;
  /** 处理前后的简单元信息，用于 UI 反馈 */
  meta: {
    originalName: string;
    originalSize: number;
    originalType: string;
    finalWidth: number;
    finalHeight: number;
    finalSize: number;
  };
}

export async function processImageForUpload(input: File): Promise<ProcessedImage> {
  // 0. 早期校验
  if (input.size > MAX_INPUT_BYTES) {
    throw new Error(
      `图片太大（${formatBytes(input.size)}），请选小于 ${formatBytes(
        MAX_INPUT_BYTES
      )} 的图片`
    );
  }

  // 1. 解码（用 <img> 让浏览器自己识别格式；macOS WebKit 原生支持 HEIC）
  const img = await decodeImage(input);

  // 2. 计算目标尺寸（等比缩放，长边不超过 MAX_DIMENSION）
  let { naturalWidth: width, naturalHeight: height } = img;
  if (!width || !height) {
    throw new Error("图片尺寸无效，请换一张");
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const ratio = width > height ? MAX_DIMENSION / width : MAX_DIMENSION / height;
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  // 3. 画到 canvas + 导出 JPEG
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 绘图上下文");

  // 给 JPEG 兜白底（避免透明 PNG 转 JPEG 后变成纯黑）
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出 JPEG 失败"))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });

  // 用稳定文件名（避免一些奇怪的扩展名干扰）
  const cleanName = sanitizeName(input.name) + ".jpg";
  const file = new File([blob], cleanName, { type: "image/jpeg" });

  return {
    file,
    meta: {
      originalName: input.name,
      originalSize: input.size,
      originalType: input.type || "unknown",
      finalWidth: width,
      finalHeight: height,
      finalSize: blob.size,
    },
  };
}

/**
 * 用 <img> 解码 File。macOS Tauri 的 WebKit 内核能原生解码 HEIC/HEIF。
 * 解码失败说明格式真的不被支持（比如 RAW），抛友好错误。
 */
function decodeImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          `无法读取这张图（${file.type || "未知格式"}），请换一张 JPG / PNG / WebP / HEIC 格式的照片`
        )
      );
    };
    img.src = url;
  });
}

function sanitizeName(name: string): string {
  // 去掉扩展名，把奇怪字符换成 _
  const stem = name.replace(/\.[^.]+$/, "");
  return stem.replace(/[^\w一-龥\-_]/g, "_") || "photo";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { formatBytes };
