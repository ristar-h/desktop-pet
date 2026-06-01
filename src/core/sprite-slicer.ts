/**
 * 雪碧图裁剪引擎 v2
 *
 * 设计原则：
 * - 帧数由用户指定（不做自动猜测，猜不准）
 * - 所有帧排在一行（不支持多行，因为 AI 出的一般都是单行）
 * - 参考 TinyRoommate 的 refined_grid_edges：在理论切分线附近
 *   找"内容最稀疏的列"作为真正的切分位置，容忍 AI 出图的网格偏移
 * - 抠背景：flood-fill 从边缘开始，支持纯色背景和透明背景
 * - 对齐：所有帧底部对齐 + 水平居中 + 统一缩放
 */

// ============================================================
// 公共接口
// ============================================================

export interface SliceOptions {
  /** 总帧数（必须指定，默认 8） */
  frameCount?: number;
  /** 每行列数（默认 = frameCount，即单行） */
  cols?: number;
  /** 输出帧大小（正方形），默认 128 */
  targetSize?: number;
  /** HSV 背景判定的额外容差因子（内部自动推断，一般不需要设） */
  bgTolerance?: number;
}

export interface SliceResult {
  /** 各帧的 Data URL (image/png) */
  frames: string[];
  /** 去背景前的原始裁剪帧 Data URL（带绿幕） */
  rawCellFrames: string[];
  /** 裁边前的原始雪碧图 Data URL */
  rawSpriteSheet: string;
  /** 裁边后的雪碧图 Data URL */
  trimmedSpriteSheet: string;
  /** 总帧数 */
  frameCount: number;
  /** 列数 */
  cols: number;
  /** 行数 */
  rows: number;
  /** 原始帧宽（理论值） */
  sourceFrameWidth: number;
  /** 原始帧高（理论值） */
  sourceFrameHeight: number;
  /** 各帧的 content bounds 调试信息 */
  debugBounds?: FrameDebugInfo[];
}

/** 每帧的对齐调试数据 */
export interface FrameDebugInfo {
  /** 帧序号 */
  index: number;
  /** 去背景后 content bounds（相对于该帧的坐标系） */
  bounds: { top: number; bottom: number; left: number; right: number };
  /** content 宽高 */
  contentWidth: number;
  contentHeight: number;
  /** content 垂直中心 Y */
  centerY: number;
  /** content 底部 Y（用于底部对齐分析） */
  bottomY: number;
}

/** 最大允许的图片边长（超过此值会先缩放） */
const MAX_DIMENSION = 4096;

/**
 * 从雪碧图中裁剪出各帧
 * 支持单行（N×1）和多行网格（cols×rows），按行优先顺序输出
 */
export async function sliceSpriteSheet(
  imageSource: string | File,
  options: SliceOptions = {}
): Promise<SliceResult> {
  const img = await loadImage(imageSource);
  let sourceCanvas = imageToCanvas(img);

  // 尺寸上限检查：超大图片先缩放，避免内存爆炸
  const { width: origW, height: origH } = sourceCanvas;
  if (origW > MAX_DIMENSION || origH > MAX_DIMENSION) {
    console.warn(
      `[sprite-slicer] 图片尺寸 ${origW}×${origH} 超过上限 ${MAX_DIMENSION}px，自动缩放`
    );
    const scale = Math.min(MAX_DIMENSION / origW, MAX_DIMENSION / origH);
    const newW = Math.round(origW * scale);
    const newH = Math.round(origH * scale);
    const scaled = document.createElement("canvas");
    scaled.width = newW;
    scaled.height = newH;
    const ctx = scaled.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sourceCanvas, 0, 0, newW, newH);
    sourceCanvas = scaled;
  }

  const { width, height } = sourceCanvas;

  const frameCount = options.frameCount ?? 8;
  const targetSize = options.targetSize ?? 128;
  const bgTolerance = options.bgTolerance ?? 50;

  // 计算列数和行数
  const cols = options.cols ?? frameCount;
  const rows = Math.ceil(frameCount / cols);

  // 左右各裁掉边距（AI 出图两侧通常有额外留白，左右不对称）
  const TRIM_LEFT = 27;
  const TRIM_RIGHT = 20;
  const trimmedWidth = width - TRIM_LEFT - TRIM_RIGHT;

  // 保存裁边前的原始图用于调试
  const rawSpriteCanvas = cloneCanvas(sourceCanvas);

  // 裁边后的画布
  const trimmedCanvas = document.createElement("canvas");
  trimmedCanvas.width = trimmedWidth;
  trimmedCanvas.height = height;
  const trimCtx = trimmedCanvas.getContext("2d")!;
  trimCtx.drawImage(sourceCanvas, TRIM_LEFT, 0, trimmedWidth, height, 0, 0, trimmedWidth, height);

  console.log(`[sprite-slicer] 裁边: ${width}px → 去左${TRIM_LEFT}px 右${TRIM_RIGHT}px → ${trimmedWidth}px`);

  // 在裁边后的图上均分
  const cellW = trimmedWidth / cols;
  const cellH = height / rows;

  // 按行优先顺序裁切 + 抠背景
  const rawFrames: HTMLCanvasElement[] = [];
  const rawCellCanvases: HTMLCanvasElement[] = [];
  let count = 0;
  for (let row = 0; row < rows && count < frameCount; row++) {
    for (let col = 0; col < cols && count < frameCount; col++) {
      const x0 = Math.round(col * cellW);
      const x1 = Math.round((col + 1) * cellW);
      const y0 = Math.round(row * cellH);
      const y1 = Math.round((row + 1) * cellH);
      const frame = extractFrame(trimmedCanvas, x0, y0, x1 - x0, y1 - y0);
      // 保存去背景前的原始帧
      rawCellCanvases.push(cloneCanvas(frame));
      const cleaned = removeBackground(frame, bgTolerance);
      rawFrames.push(cleaned);
      count++;
    }
  }

  // 统一锚点对齐 + 缩放
  const { aligned, debugBounds } = alignAndResizeWithDebug(rawFrames, targetSize);

  const frames = aligned.map((c) => c.toDataURL("image/png"));
  const rawCellFrames = rawCellCanvases.map((c) => c.toDataURL("image/png"));
  const rawSpriteSheet = rawSpriteCanvas.toDataURL("image/png");
  const trimmedSpriteSheet = trimmedCanvas.toDataURL("image/png");

  return {
    frames,
    rawCellFrames,
    rawSpriteSheet,
    trimmedSpriteSheet,
    frameCount,
    cols,
    rows,
    sourceFrameWidth: cellW,
    sourceFrameHeight: cellH,
    debugBounds,
  };
}

// ============================================================
// 图片加载
// ============================================================

function loadImage(source: string | File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        reject(new Error("图片加载成功但尺寸为 0，可能是无效的图片格式"));
        return;
      }
      resolve(img);
    };
    img.onerror = (e) => {
      console.error("[sprite-slicer] 图片加载失败:", e);
      const hint = source instanceof File
        ? `文件 "${source.name}" (${source.type})`
        : `URL 长度 ${source.length} 字符`;
      reject(new Error(`图片加载失败: ${hint}`));
    };
    if (source instanceof File) {
      const reader = new FileReader();
      reader.onload = () => {
        img.src = reader.result as string;
      };
      reader.onerror = () => reject(new Error(`文件读取失败: ${source.name}`));
      reader.readAsDataURL(source);
    } else {
      img.src = source;
    }
  });
}

function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

// ============================================================
// HSV 色空间背景判定（参考 TinyRoommate magenta_hsv_mask）
//
// 为什么用 HSV 而不是 RGB：
// - RGB 距离在"角色有和背景接近颜色"时误判严重
// - HSV 把颜色拆成 色相/饱和度/亮度，可以精确锁定背景色的色相范围
// - 即使角色身上有浅绿色装饰，只要饱和度或色相差足够大就不会被误删
// ============================================================

/** HSV 表示 (h: 0~1, s: 0~1, v: 0~1) */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;

  let h = 0;
  if (delta > 1e-6) {
    if (max === rf) h = ((gf - bf) / delta) % 6;
    else if (max === gf) h = (bf - rf) / delta + 2;
    else h = (rf - gf) / delta + 4;
    h = ((h / 6) % 1 + 1) % 1; // 归一化到 0~1
  }

  const s = max > 1e-6 ? delta / max : 0;
  return [h, s, max];
}

/** 色相环距离（0~0.5） */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

/** 背景色参数（从采样点推断） */
interface BgColorKey {
  hueCenter: number;
  hueTolerance: number;
  minSaturation: number;
  minValue: number;
}

/**
 * 采样图片边缘，推断背景色的 HSV 色键参数
 */
function detectBackgroundKey(
  data: Uint8ClampedArray,
  width: number,
  height: number
): BgColorKey {
  // 8 个采样点：四角 + 四边中点
  const samplePoints = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
  ];

  const hues: number[] = [];
  const sats: number[] = [];
  const vals: number[] = [];

  for (const [cx, cy] of samplePoints) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.max(0, Math.min(width - 1, cx + dx));
        const y = Math.max(0, Math.min(height - 1, cy + dy));
        const idx = (y * width + x) * 4;
        if (data[idx + 3] < 30) continue; // 跳过透明
        const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
        if (s > 0.1 && v > 0.1) { // 只统计有色彩的像素
          hues.push(h);
          sats.push(s);
          vals.push(v);
        }
      }
    }
  }

  if (hues.length === 0) {
    // 全透明或全灰，回退到"灰色/白色背景"模式
    return { hueCenter: 0, hueTolerance: 1, minSaturation: 0, minValue: 0.85 };
  }

  // 色相中位数作为中心
  hues.sort((a, b) => a - b);
  const hueCenter = hues[Math.floor(hues.length / 2)];

  // 计算色相范围
  let maxHueDist = 0;
  for (const h of hues) {
    maxHueDist = Math.max(maxHueDist, hueDistance(h, hueCenter));
  }

  // 饱和度和亮度的最小值
  sats.sort((a, b) => a - b);
  vals.sort((a, b) => a - b);
  const minSat = sats[Math.floor(sats.length * 0.1)]; // 取 P10
  const minVal = vals[Math.floor(vals.length * 0.1)];

  return {
    hueCenter,
    hueTolerance: Math.max(0.08, maxHueDist + 0.05), // 留余量
    minSaturation: Math.max(0.15, minSat * 0.7),
    minValue: Math.max(0.15, minVal * 0.7),
  };
}

/**
 * HSV 色空间判定是否为背景像素
 */
function isBackgroundPixelHSV(
  data: Uint8ClampedArray,
  idx: number,
  bgKey: BgColorKey
): boolean {
  // 透明 = 背景
  if (data[idx + 3] < 30) return true;

  const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);

  // 低饱和度低亮度（接近黑色/灰色）→ 不是纯色背景
  if (s < 0.08 && v < 0.15) return false;

  // 色相在背景范围内 + 饱和度够高 + 亮度够高 → 是背景
  return (
    hueDistance(h, bgKey.hueCenter) <= bgKey.hueTolerance &&
    s >= bgKey.minSaturation &&
    v >= bgKey.minValue
  );
}



// ============================================================
// 帧裁切
// ============================================================

function extractFrame(
  source: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  return canvas;
}

// ============================================================
// 背景移除（HSV 色键 + 边缘连通 flood-fill + despill）
//
// 三步走（参考 TinyRoommate）：
// 1. flood-fill：从边缘开始，只删"连通到边缘的"背景色像素
//    → 保护角色内部可能存在的同色装饰
// 2. despill：角色轮廓边缘可能残留背景色污染（半混合像素）
//    → 检测前景边缘的 HSV 相似像素，降低其饱和度去色
// 3. alpha 清理：低 alpha 噪点全清零
// ============================================================

function removeBackground(
  frame: HTMLCanvasElement,
  _tolerance: number
): HTMLCanvasElement {
  const ctx = frame.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, frame.width, frame.height);
  const { data, width, height } = imageData;
  const totalPixels = width * height;

  // 检测是否已经大部分透明（AI 直接出了透明 PNG）
  let transparentCount = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 30) transparentCount++;
  }
  if (transparentCount > totalPixels * 0.15) {
    cleanAlphaEdges(data);
    ctx.putImageData(imageData, 0, 0);
    return frame;
  }

  // Step 1: 检测背景色键
  const bgKey = detectBackgroundKey(data, width, height);

  // Step 2: 边缘连通 flood-fill（只删从边缘可达的背景色）
  const isBg = new Uint8Array(totalPixels); // 0=未访问, 1=背景, 2=前景
  const queue: number[] = [];

  function tryEnqueue(x: number, y: number) {
    const pi = y * width + x;
    if (isBg[pi]) return;
    const idx = pi * 4;
    if (isBackgroundPixelHSV(data, idx, bgKey)) {
      isBg[pi] = 1;
      queue.push(pi);
    } else {
      isBg[pi] = 2; // 前景
    }
  }

  // 种子：四条边
  for (let x = 0; x < width; x++) {
    tryEnqueue(x, 0);
    tryEnqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    tryEnqueue(0, y);
    tryEnqueue(width - 1, y);
  }

  let head = 0;
  while (head < queue.length) {
    const pi = queue[head++];
    const x = pi % width;
    const y = Math.floor(pi / width);
    data[pi * 4 + 3] = 0; // 透明化

    if (x > 0) tryEnqueue(x - 1, y);
    if (x < width - 1) tryEnqueue(x + 1, y);
    if (y > 0) tryEnqueue(x, y - 1);
    if (y < height - 1) tryEnqueue(x, y + 1);
  }

  // Step 3: Despill — 去除前景边缘的背景色污染
  despillEdges(data, width, height, isBg, bgKey);

  // Step 4: 全局残留背景色清除（参考 TinyRoommate purge_remaining_magenta）
  // 处理 flood-fill 到不了的"被角色包围的背景色"（如头发缝隙里的绿色）
  // 因为 prompt 已禁止角色包含背景色，所以可以安全删除所有高饱和背景色像素
  purgeRemainingBgColor(data, width, height, bgKey);

  // Step 5: alpha 清理
  cleanAlphaEdges(data);

  ctx.putImageData(imageData, 0, 0);
  return frame;
}

/**
 * 边缘去色（despill）
 * 前景边缘像素如果色相接近背景色 → 把颜色往灰色方向拉，去掉色彩溢出
 *
 * 注意：只处理非常接近背景色且高饱和的边缘像素，避免误伤人物本身颜色
 */
function despillEdges(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  isBg: Uint8Array,
  bgKey: BgColorKey
) {
  const totalPixels = width * height;

  for (let pi = 0; pi < totalPixels; pi++) {
    // 只处理前景像素
    if (isBg[pi] !== 2) continue;

    const idx = pi * 4;
    if (data[idx + 3] < 30) continue;

    // 检查是否相邻背景
    const x = pi % width;
    const y = Math.floor(pi / width);
    let neighborBg = false;
    if (x > 0 && isBg[pi - 1] === 1) neighborBg = true;
    else if (x < width - 1 && isBg[pi + 1] === 1) neighborBg = true;
    else if (y > 0 && isBg[pi - width] === 1) neighborBg = true;
    else if (y < height - 1 && isBg[pi + width] === 1) neighborBg = true;

    if (!neighborBg) continue;

    // 这是边缘前景像素，检查色相是否非常接近背景色
    const [h, s] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
    const hueDist = hueDistance(h, bgKey.hueCenter);

    // 收紧条件：色相必须非常接近（0.8倍容差）且饱和度很高（>0.4）才去色
    if (hueDist <= bgKey.hueTolerance * 0.8 && s > 0.4) {
      const gray = Math.round(data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
      // 去色强度和饱和度成正比，但上限降到 0.5（之前是 0.8）
      const strength = Math.min(0.5, (s - 0.4) * 1.5);
      data[idx] = Math.round(data[idx] * (1 - strength) + gray * strength);
      data[idx + 1] = Math.round(data[idx + 1] * (1 - strength) + gray * strength);
      data[idx + 2] = Math.round(data[idx + 2] * (1 - strength) + gray * strength);

      // 只有极高饱和度（纯绿色溢出）才降 alpha
      if (s > 0.7 && hueDist <= bgKey.hueTolerance * 0.5) {
        data[idx + 3] = Math.round(data[idx + 3] * 0.7);
      }
    }
  }
}

/**
 * 全局残留背景色清除
 *
 * flood-fill 只能删从边缘连通的背景色，但头发缝隙、镂空区域里的背景色删不到。
 *
 * 收紧策略：只删非常纯的背景色（高饱和 + 色相极度接近），避免误删人物的黄绿/青色部分。
 */
function purgeRemainingBgColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bgKey: BgColorKey
) {
  const totalPixels = width * height;

  for (let pi = 0; pi < totalPixels; pi++) {
    const idx = pi * 4;
    if (data[idx + 3] < 10) continue; // 已经透明

    const [h, s, v] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2]);
    const hueDist = hueDistance(h, bgKey.hueCenter);

    // 色相必须非常接近背景色（用更紧的容差）
    if (hueDist > bgKey.hueTolerance * 0.7) continue;

    // 只有非常纯的背景色才删（高饱和 + 高亮度 + 色相极近）
    if (s >= 0.7 && v >= 0.5) {
      data[idx + 3] = 0;
      continue;
    }

    // 中高饱和 + 色相极近 → 轻微降 alpha（但不要太激进）
    if (s >= 0.5 && v >= 0.4 && hueDist <= bgKey.hueTolerance * 0.5) {
      data[idx + 3] = Math.min(data[idx + 3], Math.round(255 * (1 - s * 0.5)));
    }
  }
}

function cleanAlphaEdges(data: Uint8ClampedArray) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 15) data[i] = 0;
  }
}

// ============================================================
// 锚点对齐 + 缩放
// ============================================================

interface ContentBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function getContentBounds(canvas: HTMLCanvasElement): ContentBounds {
  const ctx = canvas.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // 用更高的 alpha 阈值（50），过滤去背景残留的半透明噪点
  const ALPHA_THRESHOLD = 50;
  // 一行/列至少要有这么多不透明像素才算"有内容"（过滤零星噪点）
  const MIN_PIXELS_PER_LINE = 3;

  let top = height,
    bottom = 0,
    left = width,
    right = 0;

  // 逐行扫描：只有该行有 >= MIN_PIXELS_PER_LINE 个不透明像素才计入
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) count++;
    }
    if (count >= MIN_PIXELS_PER_LINE) {
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  // 逐列扫描
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) count++;
    }
    if (count >= MIN_PIXELS_PER_LINE) {
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  if (top > bottom) {
    return { top: 0, bottom: height, left: 0, right: width };
  }
  return { top, bottom: bottom + 1, left, right: right + 1 };
}

function alignAndResizeWithDebug(
  frames: HTMLCanvasElement[],
  targetSize: number
): { aligned: HTMLCanvasElement[]; debugBounds: FrameDebugInfo[] } {
  if (frames.length === 0) return { aligned: [], debugBounds: [] };

  const allBounds = frames.map(getContentBounds);

  // 生成调试信息
  const debugBounds: FrameDebugInfo[] = allBounds.map((b, i) => ({
    index: i,
    bounds: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
    contentWidth: b.right - b.left,
    contentHeight: b.bottom - b.top,
    centerY: (b.top + b.bottom) / 2,
    bottomY: b.bottom,
  }));

  // 核心修复：取所有帧 bounds 的并集
  // 这样每帧的裁剪区域完全一致，人物位置锁死不抖动
  let unionLeft = Infinity,
    unionTop = Infinity,
    unionRight = 0,
    unionBottom = 0;
  for (const b of allBounds) {
    unionLeft = Math.min(unionLeft, b.left);
    unionTop = Math.min(unionTop, b.top);
    unionRight = Math.max(unionRight, b.right);
    unionBottom = Math.max(unionBottom, b.bottom);
  }

  const unionW = unionRight - unionLeft;
  const unionH = unionBottom - unionTop;

  if (unionW === 0 || unionH === 0) {
    return {
      aligned: frames.map(() => {
        const out = document.createElement("canvas");
        out.width = targetSize;
        out.height = targetSize;
        return out;
      }),
      debugBounds,
    };
  }

  // 统一缩放比例
  const padding = Math.ceil(targetSize * 0.06);
  const availableSize = targetSize - padding * 2;
  const scale = Math.min(availableSize / unionW, availableSize / unionH);

  const scaledW = unionW * scale;
  const scaledH = unionH * scale;
  // 统一的绘制位置（水平居中 + 底部对齐）
  const dx = (targetSize - scaledW) / 2;
  const dy = targetSize - padding - scaledH;

  const aligned = frames.map((frame) => {
    const out = document.createElement("canvas");
    out.width = targetSize;
    out.height = targetSize;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // 所有帧用同一个 source 区域（union bounds）
    ctx.drawImage(
      frame,
      unionLeft, unionTop, unionW, unionH,
      dx, dy, scaledW, scaledH
    );
    return out;
  });

  return { aligned, debugBounds };
}
