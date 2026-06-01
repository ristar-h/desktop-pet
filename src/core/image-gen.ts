/**
 * 桌宠形象生成管线
 *
 * 流程：
 * 1. 用户上传参考图 → 转为 base64 data URI（本地处理，不上传第三方）
 * 2. 调用 Evolink API (gpt-image-2) 生成雪碧图
 * 3. 轮询任务状态直到完成（支持取消 + 错误退出）
 * 4. 下载结果图片 → 返回 Data URL
 *
 * 环境变量（在 .env 中配置）：
 * - EVOLINK_API_KEY: Evolink API Key
 */

// ============================================================
// 类型
// ============================================================

export interface GenerateOptions {
  /** 参考图文件（File 对象或 Data URL） */
  referenceImage?: File | string;
  /** 生图 prompt */
  prompt: string;
  /** 输出尺寸，默认 "3840x1280" */
  size?: string;
  /** 质量，默认 "medium" */
  quality?: "low" | "medium" | "high";
  /** Evolink API Key */
  apiKey: string;
}

export interface GenerateProgress {
  status: "preparing" | "generating" | "polling" | "downloading" | "completed" | "failed";
  progress: number; // 0-100
  message: string;
  result?: string; // 完成时的图片 Data URL
  error?: string;
}

type ProgressCallback = (progress: GenerateProgress) => void;

// ============================================================
// 主函数
// ============================================================

/**
 * 完整的形象生成管线
 *
 * @param options - 生成选项
 * @param onProgress - 进度回调
 * @param signal - AbortSignal，用于取消整个流程
 */
export async function generateSpriteSheet(
  options: GenerateOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<string> {
  const { prompt, size = "3840x1280", quality = "medium", apiKey } = options;

  // 检查是否已取消
  throwIfAborted(signal);

  // Step 1: 准备参考图（本地转 base64，不上传第三方）
  let imageUrls: string[] | undefined;
  if (options.referenceImage) {
    onProgress?.({
      status: "preparing",
      progress: 5,
      message: "正在准备参考图...",
    });

    const dataUri = await imageToDataUri(options.referenceImage);
    imageUrls = [dataUri];

    onProgress?.({
      status: "preparing",
      progress: 10,
      message: "参考图准备完成",
    });
  }

  throwIfAborted(signal);

  // Step 2: 提交生成任务
  onProgress?.({
    status: "generating",
    progress: 15,
    message: "正在提交生成任务...",
  });

  const submitResult = await submitGenerationTask({
    prompt,
    imageUrls,
    size,
    quality,
    apiKey,
    signal,
  });

  let resultUrl: string;

  if (submitResult.type === "direct") {
    // 同步模式：API 直接返回了结果
    resultUrl = submitResult.value;
    onProgress?.({
      status: "polling",
      progress: 85,
      message: "图片已生成",
    });
  } else {
    // 异步模式：需要轮询任务状态
    onProgress?.({
      status: "polling",
      progress: 20,
      message: "正在生成图片，请稍候...",
    });

    resultUrl = await pollTask(submitResult.value, apiKey, signal, (progress) => {
      onProgress?.({
        status: "polling",
        progress: 20 + Math.floor(progress * 0.65), // 20-85
        message: `生成中... ${progress}%`,
      });
    });
  }

  throwIfAborted(signal);

  // Step 4: 下载结果（如果已经是 data URL 则跳过下载）
  let dataUrl: string;
  if (resultUrl.startsWith("data:")) {
    dataUrl = resultUrl;
  } else {
    onProgress?.({
      status: "downloading",
      progress: 90,
      message: "正在下载生成结果...",
    });
    dataUrl = await downloadAsDataUrl(resultUrl, signal);
  }

  onProgress?.({
    status: "completed",
    progress: 100,
    message: "生成完成！",
    result: dataUrl,
  });

  return dataUrl;
}

// ============================================================
// Step 1: 参考图转 Data URI（本地处理）
// ============================================================

async function imageToDataUri(image: File | string): Promise<string> {
  if (typeof image === "string") {
    // 已经是 data URL 或者 http URL，直接使用
    return image;
  }

  // File → Data URL
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.readAsDataURL(image);
  });
}

// ============================================================
// Step 2: 提交 Evolink 生成任务
// ============================================================

interface SubmitOptions {
  prompt: string;
  imageUrls?: string[];
  size: string;
  quality: string;
  apiKey: string;
  signal?: AbortSignal;
}

/** 提交结果：要么直接拿到图片 URL，要么拿到异步任务 ID */
interface SubmitResult {
  type: "direct" | "async";
  /** type=direct 时为图片 URL，type=async 时为任务 ID */
  value: string;
}

async function submitGenerationTask(options: SubmitOptions): Promise<SubmitResult> {
  const body: Record<string, unknown> = {
    model: "gpt-image-2",
    prompt: options.prompt,
    size: options.size,
    quality: options.quality,
  };

  if (options.imageUrls && options.imageUrls.length > 0) {
    body.image_urls = options.imageUrls;
  }

  console.log("[image-gen] 提交生成任务, prompt 长度:", options.prompt.length);

  const response = await fetch("https://api.evolink.ai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("[image-gen] API 请求失败:", response.status, text);
    throw new Error(`API 请求失败 (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  console.log("[image-gen] API 响应:", JSON.stringify(data).slice(0, 500));

  if (data.error) {
    throw new Error(`API 错误: ${data.error.message || JSON.stringify(data.error)}`);
  }

  // 模式 1: API 直接返回图片结果（同步模式）
  // 常见格式: { data: [{ url: "..." }] } 或 { data: [{ b64_json: "..." }] }
  if (data.data && Array.isArray(data.data) && data.data.length > 0) {
    const first = data.data[0];
    if (first.url) {
      console.log("[image-gen] 同步模式 - 直接拿到图片 URL");
      return { type: "direct", value: first.url };
    }
    if (first.b64_json) {
      console.log("[image-gen] 同步模式 - 直接拿到 base64 图片");
      return { type: "direct", value: `data:image/png;base64,${first.b64_json}` };
    }
  }

  // 模式 2: API 返回异步任务 ID
  if (data.id) {
    console.log("[image-gen] 异步模式 - 任务 ID:", data.id);
    return { type: "async", value: data.id };
  }

  // 模式 3: 其他格式 - 尝试从 results 字段获取
  if (data.results && Array.isArray(data.results) && data.results.length > 0) {
    console.log("[image-gen] 同步模式 - results 字段");
    return { type: "direct", value: data.results[0] };
  }

  // 未知响应格式
  console.error("[image-gen] 未知的 API 响应格式:", JSON.stringify(data));
  throw new Error(`API 返回了未知格式的响应，请查看控制台日志`);
}

// ============================================================
// Step 3: 轮询任务状态（支持取消 + 智能错误退出）
// ============================================================

async function pollTask(
  taskId: string,
  apiKey: string,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void
): Promise<string> {
  const maxAttempts = 120; // 最多轮询 120 次（约 10 分钟）
  const interval = 5000; // 每 5 秒查一次
  const maxConsecutiveErrors = 5;

  let consecutiveErrors = 0;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval, signal);
    throwIfAborted(signal);

    let response: Response;
    try {
      response = await fetch(
        `https://api.evolink.ai/v1/tasks/${taskId}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        }
      );
    } catch (err: unknown) {
      // 网络错误（非取消）
      if (err instanceof Error && err.name === "AbortError") throw err;
      consecutiveErrors++;
      console.warn(`[image-gen] 轮询网络错误 (${consecutiveErrors}/${maxConsecutiveErrors}):`, err);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(`连续 ${maxConsecutiveErrors} 次网络错误，放弃轮询`);
      }
      continue;
    }

    // 非 200 响应分类处理
    if (!response.ok) {
      const status = response.status;
      // 鉴权错误或客户端错误 → 直接退出
      if (status === 401 || status === 403) {
        throw new Error(`API 鉴权失败 (${status})，请检查 API Key`);
      }
      if (status === 404) {
        throw new Error(`任务不存在 (${status})，ID: ${taskId}`);
      }
      if (status === 429) {
        // 限流，加长等待后重试
        consecutiveErrors++;
        console.warn(
          `[image-gen] API 限流 (429) (${consecutiveErrors}/${maxConsecutiveErrors})，等待后重试`
        );
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(`连续 ${maxConsecutiveErrors} 次 API 限流 (429)，放弃轮询`);
        }
        await sleep(10000, signal);
        continue;
      }
      // 其他服务端错误
      consecutiveErrors++;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(`连续 ${maxConsecutiveErrors} 次请求失败 (最后状态: ${status})`);
      }
      continue;
    }

    // 请求成功，重置错误计数
    consecutiveErrors = 0;

    const data = await response.json();

    if (data.progress !== undefined) {
      onProgress?.(data.progress);
    }

    if (data.status === "completed") {
      const results = data.results || data.result_data?.map((d: { url: string }) => d.url);
      if (results && results.length > 0) {
        return results[0];
      }
      throw new Error("任务完成但未返回结果 URL");
    }

    if (data.status === "failed") {
      const errMsg = data.error?.message || "未知错误";
      throw new Error(`生成失败: ${errMsg}`);
    }
  }

  throw new Error("任务超时（超过 10 分钟）");
}

// ============================================================
// Step 4: 下载图片为 Data URL
// ============================================================

async function downloadAsDataUrl(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`下载失败: ${response.status}`);
  }

  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("图片数据读取失败"));
    reader.readAsDataURL(blob);
  });
}

// ============================================================
// 工具函数
// ============================================================

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

// ============================================================
// Prompt 模板
// ============================================================

/**
 * 参考图一致性前缀 — 插入到每个 prompt 最前面
 */
const REFERENCE_IMAGE_CONSTRAINT = `CRITICAL RULE — CHARACTER FIDELITY:
The character in EVERY frame MUST be IDENTICAL to the reference image provided.
Same face shape, same eye shape and color, same hair style and color, same skin tone, same clothing, same accessories.
DO NOT reinterpret, simplify, or change any aspect of the character's appearance.
The reference image is the SOLE source of truth for character design.

`;

/** 统一的角色描述 */
const CHARACTER_DESC = `CHARACTER: Based on the reference image, create a cute chibi/Q-version of this person with head-to-body ratio 1:1.5 (big head, small body).`;

/** 统一的风格描述 */
const STYLE_DESC = `STYLE: Cute 2D digital illustration, soft rounded outlines with slightly thick dark linework, warm muted colors, flat or softly blended fills, minimal gentle shading, clean silhouette. Desktop pet aesthetic — like a small illustrated character from a cozy casual game. NOT pixel art, NOT 3D, NOT realistic.`;

/** 绿幕背景 */
const BG_DESC = `BACKGROUND: Solid pure green #00FF00 everywhere outside the character. No gradients, shadows, textures. Character must NOT contain any green (#00FF00) color.`;

/** 帧对齐约束 — 这是防止抖动的关键 */
const ALIGNMENT_CONSTRAINT = `ALIGNMENT RULE (CRITICAL — prevents jitter in animation):
- The character's ANCHOR POINT (center of feet / bottom center) MUST be at the EXACT SAME pixel position in EVERY frame.
- Draw an imaginary vertical center line down each grid cell — the character's spine must align to this line in ALL frames.
- The character's feet/bottom must touch the EXACT SAME horizontal baseline in ALL frames.
- DO NOT let the character drift left/right or up/down between frames. Only the intended body parts (arms, head tilt, etc.) should move.
- Think of the character as pinned to the ground at their feet — the pin point never moves.`;

/** 8帧布局描述 */
const LAYOUT_8 = `FRAME COUNT: 8 frames arranged in a SINGLE horizontal row (8 columns x 1 row).
LAYOUT: 8 columns x 1 row. All 8 frames side by side in ONE row, filling the entire canvas left to right. Every cell exactly same width and height, no margins, no gaps.
SPACING RULE: The gap between adjacent characters must be exactly 2x the margin from the first character's left edge to the left canvas border, and 2x the margin from the last character's right edge to the right canvas border. This ensures uniform, evenly-spaced layout that can be precisely split into equal cells.`;

/** 6帧布局描述 */
const LAYOUT_6 = `FRAME COUNT: 6 frames arranged in a SINGLE horizontal row (6 columns x 1 row).
LAYOUT: 6 columns x 1 row. All 6 frames side by side in ONE row, filling the entire canvas left to right. Every cell exactly same width and height, no margins, no gaps.
SPACING RULE: The gap between adjacent characters must be exactly 2x the margin from the first character's left edge to the left canvas border, and 2x the margin from the last character's right edge to the right canvas border. This ensures uniform, evenly-spaced layout that can be precisely split into equal cells.`;

export const SPRITE_PROMPTS = {
  idle: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet idle breathing animation.
${CHARACTER_DESC}
ACTION: idle breathing — gentle body rise and fall with one slow blink cycle.
${LAYOUT_8}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (8-frame loop): Frame 1: neutral standing, eyes open, soft smile. Frame 2: gentle inhale, chest rises 2px. Frame 3: mid-rise. Frame 4: peak inhale, eyes begin slow blink. Frame 5: exhale, eyes half-closed. Frame 6: eyes fully closed (blink). Frame 7: eyes reopening. Frame 8: back to baseline, matches Frame 1.
CRITICAL: Character IDENTICAL all 8 frames. Same position each cell. Feet same Y. Only chest rise/fall and blink.
${STYLE_DESC}`,

  walk: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet walking animation.
${CHARACTER_DESC}
ACTION: walking to the right, cute bouncy walk cycle.
${LAYOUT_8}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (8-frame walk loop): Frame 1: right foot forward, left foot back, arms in opposite swing. Frame 2: weight shifting forward, slight bounce up. Frame 3: left foot forward, right foot back. Frame 4: mid-stride highest point, both feet near center. Frame 5: right foot forward again, slight lean forward. Frame 6: push off, body bounces. Frame 7: left foot forward, arms swinging. Frame 8: completing cycle, returning to Frame 1 pose.
CRITICAL: Character same size all frames. Body center (spine) stays at exact same X in every cell. Feet baseline same Y in every cell. Only limbs move for walk cycle. Head bobs slightly up/down 2-3px max.
${STYLE_DESC}`,

  sleep: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet sleeping animation.
${CHARACTER_DESC}
ACTION: sleeping peacefully while sitting, very slow breathing with "Zzz".
${LAYOUT_6}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (6-frame sleep loop): Frame 1: sitting with head drooped, eyes closed, small "z" near head. Frame 2: very slight chest rise (inhale), "z" slightly bigger. Frame 3: peak inhale, "Z" appears above. Frame 4: exhale begins, head droops a tiny bit more. Frame 5: minimal exhale, "z" fading. Frame 6: back to baseline like Frame 1.
CRITICAL: Extremely minimal motion. Eyes stay closed throughout. Character body center stays at EXACT same position in every frame. Only visible change is tiny chest movement and floating "z/Z" letters.
${STYLE_DESC}`,

  happy: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet happy celebration animation.
${CHARACTER_DESC}
ACTION: happy jumping celebration with sparkles, plays once.
${LAYOUT_8}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (8-frame, play once): Frame 1: neutral standing, slight smile. Frame 2: eyes widen with excitement, fists clench. Frame 3: crouch down preparing to jump. Frame 4: JUMP up, arms raised high, huge smile, sparkle effects. Frame 5: peak of jump, star/sparkle particles around. Frame 6: beginning descent, still smiling. Frame 7: landing with slight squash, arms still up. Frame 8: standing tall with proud smile, one arm up in victory pose.
CRITICAL: Character's horizontal center (spine) stays at EXACT same X in every frame. Vertical movement only for jump (frames 3-7). Sparkle/star effects appear frames 4-6.
${STYLE_DESC}`,

  sad: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet sad/dejected animation.
${CHARACTER_DESC}
ACTION: looking sad and dejected, slumping down, plays once then holds.
${LAYOUT_6}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (6-frame, play once): Frame 1: neutral standing. Frame 2: expression changes to worried, eyebrows furrow. Frame 3: shoulders slump, head droops slightly, sad eyes. Frame 4: full slump, looking down, tiny sweat drop. Frame 5: sighs (mouth open small "o"), body deflates. Frame 6: standing with dejected posture, looking aside with sorry expression.
CRITICAL: Character's feet stay at EXACT same position all frames. Body center stays at same X. Only upper body droops gradually. No lateral drift. Keep it cute, not depressing.
${STYLE_DESC}`,

  stretch: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet stretching/waking up animation.
${CHARACTER_DESC}
ACTION: waking up and stretching, transitioning from sleepy to alert. Plays once.
${LAYOUT_8}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (8-frame, play once): Frame 1: sitting slumped (sleeping pose), eyes closed. Frame 2: eyes flutter, tiny movement. Frame 3: one eye opens, yawning (mouth open). Frame 4: both arms raise up in big stretch, eyes squinting. Frame 5: peak stretch, arms fully extended up, back arched. Frame 6: arms come down, eyes opening wider. Frame 7: shaking head slightly, becoming alert. Frame 8: standing upright, bright eyes, ready pose with smile.
CRITICAL: Character's bottom/seat stays at EXACT same position frames 1-6. Transition to standing (7-8) keeps horizontal center aligned. No lateral drift in any frame.
${STYLE_DESC}`,

  looking_around: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet looking around curiously animation.
${CHARACTER_DESC}
ACTION: standing and looking around curiously in different directions.
${LAYOUT_8}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (8-frame loop): Frame 1: facing forward, neutral. Frame 2: head turns slightly left, eyes look left. Frame 3: head turned left, curious expression, one hand up near chin. Frame 4: head returning to center. Frame 5: head turns slightly right, eyes look right. Frame 6: head turned right, tilted slightly, wondering expression. Frame 7: head returning to center, blinking. Frame 8: back to forward, slight smile.
CRITICAL: Body and feet stay at EXACT same position in ALL frames. Only head turns and tilts. Body NEVER shifts left or right. Feet pinned to ground.
${STYLE_DESC}`,

  drag: `${REFERENCE_IMAGE_CONSTRAINT}Generate a sprite sheet of a desktop pet being picked up/held animation.
${CHARACTER_DESC}
ACTION: being picked up and dangling, surprised then amused expression.
${LAYOUT_6}
${BG_DESC}
${ALIGNMENT_CONSTRAINT}
MOTION PLAN (6-frame loop): Frame 1: surprised face, arms up, legs dangling. Frame 2: legs swing left, "!" expression. Frame 3: legs swing right, eyes wide. Frame 4: settling down, starting to smile. Frame 5: happy dangling, legs kicking playfully. Frame 6: content smile, gentle sway, arms relaxed.
CRITICAL: Character's HEAD/TORSO center stays at EXACT same position in all frames. Only legs swing side to side. Held from above — no ground contact. Head position pinned.
${STYLE_DESC}`,
} as const;

export type SpriteAction = keyof typeof SPRITE_PROMPTS;
