/**
 * 视频生成输入组装（shot-video-generation 任务 3.1，design A4）。
 *
 * 只读纯函数：视频参数指纹（seedance-v1 形态）、generationInputHash（不含资产绑定
 * ——i2v 输入=首帧+提示词）、时长档位就近映射（超上限如实标注）、镜头文档运镜/
 * 叙事字段提取与视频提示词组装。零 I/O；哈希函数沿图片侧同构注入。
 */

/** 视频提示词需要的镜头文档字段（ShotContract 1.1.0；系统字段一律不进入提示词）。 */
export interface VideoShotMotionFields {
  readonly action: string | null;
  readonly cameraMotion: string | null;
  readonly emotion: string | null;
  readonly narrativePurpose: string | null;
}

const stringOrNullOrUndefined = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const sectionOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

/**
 * 解析冻结镜头文档的视频字段；文档不是合法 JSON 对象或缺少 content/cinematography
 * 节时返回 null（READY 文档确认期已过校验，null 即行损坏，由调用方报稳定错误）。
 */
export const extractVideoShotFields = (document: string): VideoShotMotionFields | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  const shot = sectionOf(parsed);
  const content = sectionOf(shot?.content);
  const cinematography = sectionOf(shot?.cinematography);
  if (content === null || cinematography === null) return null;
  return {
    action: stringOrNullOrUndefined(content.action),
    cameraMotion: stringOrNullOrUndefined(cinematography.camera_motion),
    emotion: stringOrNullOrUndefined(content.emotion),
    narrativePurpose: stringOrNullOrUndefined(shot?.narrative_purpose),
  };
};

/** camera_motion 枚举（storyboard 摘要同源）→ 提示词运镜文本；未知值按缺失处理。 */
const CAMERA_MOTION_TEXT: Readonly<Record<string, string>> = Object.freeze({
  DOLLY: '推轨',
  HANDHELD: '手持',
  OTHER: '其他运镜',
  PAN: '横摇',
  STATIC: '固定机位',
  TILT: '纵摇',
  TRACK: '跟踪',
  ZOOM: '变焦',
});

/**
 * 组装视频提示词（确定性、纯函数；design A4：action/emotion + narrative_purpose +
 * camera_motion 运镜文本）。i2v 以已选首帧为画面起点，提示词只描述动态与叙事意图。
 */
export const buildVideoPrompt = (fields: VideoShotMotionFields): string => {
  const primary = [fields.action, fields.emotion]
    .filter((part): part is string => part !== null)
    .join('，');
  const lines: string[] = [];
  if (primary.length > 0) lines.push(primary);
  if (fields.narrativePurpose !== null) lines.push(`叙事目的：${fields.narrativePurpose}`);
  const motion =
    fields.cameraMotion === null ? null : (CAMERA_MOTION_TEXT[fields.cameraMotion] ?? null);
  if (motion !== null) lines.push(`运镜：${motion}`);
  return lines.join('\n');
};

/** 能力快照 request.duration_range（闭区间整数秒；Seedance 预期 [5,10]）。 */
export interface VideoDurationRange {
  readonly maxSec: number;
  readonly minSec: number;
}

/** 档位解析结果；exceededMax=true 即 target 超上限被压到最大档（如实标注，不续写不拆镜）。 */
export interface VideoDurationTier {
  readonly durationSec: number;
  readonly exceededMax: boolean;
}

/**
 * 时长档位就近映射（design A4 / PRD 10.3.1）：requested = 最小档 ≥ target_duration_sec
 * （闭区间整数档）；无则最大档并如实标注。快照形态非法抛稳定 message。
 */
export const resolveVideoDurationTier = (
  targetDurationSec: number,
  range: VideoDurationRange,
): VideoDurationTier => {
  if (
    !Number.isInteger(range.minSec) ||
    !Number.isInteger(range.maxSec) ||
    range.minSec <= 0 ||
    range.minSec > range.maxSec
  ) {
    throw new Error('VIDEO_DURATION_RANGE_INVALID');
  }
  if (targetDurationSec > range.maxSec) {
    return { durationSec: range.maxSec, exceededMax: true };
  }
  return { durationSec: Math.max(range.minSec, Math.ceil(targetDurationSec)), exceededMax: false };
};

export interface VideoParametersFingerprintInput {
  readonly durationSec: number;
  readonly firstFrameFileSha256: string;
  readonly modelId: string;
  readonly size: Readonly<{ height: number; width: number }>;
}

/**
 * 视频参数指纹（design A4）：`seedance-v1:{modelId}:{WxH}:{durationSec}:{firstFrameSha256
 * 前 12 位}`——首帧以截断哈希参与指纹（全量 sha 在 generationInputHash 侧承载）。
 */
export const buildVideoParametersFingerprint = (input: VideoParametersFingerprintInput): string =>
  [
    'seedance-v1',
    input.modelId,
    `${String(input.size.width)}x${String(input.size.height)}`,
    String(input.durationSec),
    input.firstFrameFileSha256.slice(0, 12),
  ].join(':');

/** generation_input_hash 的输入集（design A4：不含资产绑定，i2v 输入=首帧+提示词）。 */
export interface VideoGenerationInputDescriptor {
  readonly firstFrameFileSha256: string;
  readonly modelId: string;
  readonly parametersFingerprint: string;
  readonly shotContentHash: string;
  readonly shotVersionId: string;
}

/**
 * 计算 generation_input_hash = sha256(canonical JSON)；键序固定字母序（与契约 schema
 * 对齐），字段集与漂移由金样单测锁死。
 */
export const computeVideoGenerationInputHash = (
  descriptor: VideoGenerationInputDescriptor,
  hashPayload: (value: Readonly<Record<string, unknown>>) => string,
): string =>
  hashPayload({
    firstFrameFileSha256: descriptor.firstFrameFileSha256,
    modelId: descriptor.modelId,
    parametersFingerprint: descriptor.parametersFingerprint,
    shotContentHash: descriptor.shotContentHash,
    shotVersionId: descriptor.shotVersionId,
  });
