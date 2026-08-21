import type { TransferJson } from '../ports/transfer';

/** staging/写入器稳定错误码（映射 AppResult ProjectErrorCode；不含路径/原始报文）。 */
export type TransferValidationErrorCode =
  | 'TRANSFER_BUNDLE_INVALID'
  | 'TRANSFER_BUNDLE_UNSUPPORTED'
  | 'TRANSFER_HASH_MISMATCH'
  | 'TRANSFER_REFERENCE_INVALID'
  | 'TRANSFER_PROJECT_CONFLICT'
  | 'TRANSFER_IDEMPOTENCY_CONFLICT';

export class TransferValidationError extends Error {
  public constructor(public readonly code: TransferValidationErrorCode) {
    super(code);
    this.name = 'TransferValidationError';
  }
}

/** 导入文件大小硬上限（32 MiB）：staging 先拒绝超限文件，再做 UTF-8/JSON 解码。 */
export const TRANSFER_MAX_BYTES = 32 * 1024 * 1024;

const BUNDLE_TOP_LEVEL_KEYS = [
  'bundle_id',
  'episode_storyboard',
  'exported_at',
  'project_snapshot',
  'schema_version',
  'script_stage_outputs',
  'story_bible',
] as const;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;
const PROJECT_ID_PATTERN = /^project_[A-Za-z0-9_-]+$/u;
const BUNDLE_ID_PATTERN = /^bundle_[A-Za-z0-9_-]+$/u;
const CREATION_MODES = new Set(['AI_ORIGINAL', 'AUTHORIZED_ADAPTATION', 'AI_OPTIMIZATION']);
const DIALOGUE_RENDER_MODES = new Set([
  'NARRATION_FIRST',
  'WEAK_LIP_SYNC',
  'PRECISE_LIP_SYNC',
  'SUBTITLE_ONLY',
]);
/** 四阶段输出必须恰好各出现一次（Bundle schema allOf/contains 镜像）。 */
const REQUIRED_STAGES = ['CONCEPT', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;

const isRecord = (value: unknown): value is TransferJson =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// 函数声明（非 const 箭头）：显式 never 返回类型使调用点之后获得类型收窄。
function invalid(code: TransferValidationErrorCode): never {
  throw new TransferValidationError(code);
}

/** staging 第 0/1 步：大小硬上限 + 严格 UTF-8 解码（BOM/非法字节均拒绝）。 */
export const decodeTransferBytes = (bytes: Uint8Array): string => {
  if (bytes.byteLength > TRANSFER_MAX_BYTES) invalid('TRANSFER_BUNDLE_INVALID');
  // 交换对 (BOM) 不是合法 Bundle 起点；TextDecoder 默认会剥离它，因此按字节检查。
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
};

/** staging 第 2 步：JSON 解析（必须是对象，非数组）。 */
export const parseTransferJson = (text: string): TransferJson => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  if (!isRecord(parsed)) invalid('TRANSFER_BUNDLE_INVALID');
  return parsed;
};

/**
 * staging 第 3 步：形状与版本头校验。
 * schema_version 为合法 semver 但 ≠1.0.0 → UNSUPPORTED（可提示重导）；其余缺键/多键/类型错 → INVALID。
 */
export const validateTransferBundleShape = (value: TransferJson): TransferJson => {
  const keys = new Set(Object.keys(value));
  for (const key of BUNDLE_TOP_LEVEL_KEYS) {
    if (!keys.has(key)) invalid('TRANSFER_BUNDLE_INVALID');
    keys.delete(key);
  }
  if (keys.size !== 0) invalid('TRANSFER_BUNDLE_INVALID');
  if (value.schema_version !== '1.0.0') {
    invalid(
      SEMVER_PATTERN.test(String(value.schema_version))
        ? 'TRANSFER_BUNDLE_UNSUPPORTED'
        : 'TRANSFER_BUNDLE_INVALID',
    );
  }
  if (
    typeof value.bundle_id !== 'string' ||
    !BUNDLE_ID_PATTERN.test(value.bundle_id) ||
    typeof value.exported_at !== 'string' ||
    value.exported_at === ''
  ) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  if (!Array.isArray(value.script_stage_outputs) || value.script_stage_outputs.length !== 4) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  return value;
};

/** staging 第 4 步：文件级 SHA-256（Main 文件 Port 计算，此处只比对）。 */
export type TransferSha256 = (content: string) => string;

export const validateTransferHash = (
  content: string,
  expectedSha256: string,
  hash: TransferSha256,
): void => {
  if (hash(content) !== expectedSha256) invalid('TRANSFER_HASH_MISMATCH');
};

/** staging 第 6 步：跨对象引用、版本头一致性与项目归属（Schema 之外的语义校验）。 */
export const validateTransferReferences = (bundle: TransferJson): void => {
  const snapshot = bundle.project_snapshot;
  const storyboard = bundle.episode_storyboard;
  const bible = bundle.story_bible;
  const stages = bundle.script_stage_outputs;
  if (!isRecord(snapshot) || !isRecord(storyboard) || !isRecord(bible) || !Array.isArray(stages)) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  // 项目归属：project_id 同源（storyboard 与 snapshot 必须指向同一项目）。
  const projectId = stringField(snapshot.project_id);
  if (
    projectId === null ||
    !PROJECT_ID_PATTERN.test(projectId) ||
    typeof snapshot.name !== 'string' ||
    snapshot.name.length === 0 ||
    snapshot.name.length > 200 ||
    !CREATION_MODES.has(String(snapshot.creation_mode)) ||
    !DIALOGUE_RENDER_MODES.has(String(snapshot.dialogue_render_mode))
  ) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  if (storyboard.project_id !== projectId) invalid('TRANSFER_REFERENCE_INVALID');
  // 版本头一致性：整集分镜引用的圣经版本必须就是 Bundle 携带的圣经版本。
  const bibleVersionId = stringField(bible.version_id);
  if (bibleVersionId === null || bibleVersionId === '') invalid('TRANSFER_BUNDLE_INVALID');
  if (storyboard.story_bible_version_id !== bibleVersionId) {
    invalid('TRANSFER_REFERENCE_INVALID');
  }
  if (stringField(storyboard.episode_id) === null || storyboard.episode_id === '') {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  // 四阶段恰好各一，且 output.stage 与声明一致。
  const seen = new Map<string, string>();
  for (const entry of stages) {
    if (!isRecord(entry)) invalid('TRANSFER_BUNDLE_INVALID');
    const versionId = stringField(entry.version_id);
    const output = isRecord(entry.output) ? entry.output : null;
    const stage = output === null ? null : stringField(output.stage);
    if (versionId === null || versionId === '' || stage === null) {
      invalid('TRANSFER_BUNDLE_INVALID');
    }
    if (seen.has(stage)) invalid('TRANSFER_REFERENCE_INVALID');
    seen.set(stage, versionId);
  }
  for (const stage of REQUIRED_STAGES) {
    if (!seen.has(stage)) invalid('TRANSFER_REFERENCE_INVALID');
  }
  // 镜头契约：≥1、shot_id/version_id 唯一、sequence 严格升序（集合校验由导入写入前的正式校验承担）。
  const shotContracts = storyboard.shot_contracts;
  if (!Array.isArray(shotContracts) || shotContracts.length === 0) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  const shotIds = new Set<string>();
  const shotVersionIds = new Set<string>();
  let previousSequence: number | null = null;
  for (const shot of shotContracts) {
    if (!isRecord(shot)) invalid('TRANSFER_BUNDLE_INVALID');
    const shotId = stringField(shot.shot_id);
    const shotVersionId = stringField(shot.version_id);
    const sequence = shot.sequence;
    if (shotId === null || shotVersionId === null) invalid('TRANSFER_BUNDLE_INVALID');
    if (shotIds.has(shotId) || shotVersionIds.has(shotVersionId)) {
      invalid('TRANSFER_REFERENCE_INVALID');
    }
    if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
      invalid('TRANSFER_BUNDLE_INVALID');
    }
    if (previousSequence !== null && sequence <= previousSequence) {
      invalid('TRANSFER_REFERENCE_INVALID');
    }
    previousSequence = sequence;
    shotIds.add(shotId);
    shotVersionIds.add(shotVersionId);
  }
};

/** Bundle 内全部需重写的源对象 ID（NEW_PROJECT 生成新 ID 的完整清单）。 */
export interface TransferSourceIds {
  readonly projectId: string;
  readonly episodeId: string;
  readonly formatProfileId: string;
  readonly storyBibleVersionId: string;
  readonly scriptVersionIds: readonly string[];
  readonly shotIds: readonly string[];
  readonly shotVersionIds: readonly string[];
  readonly totalCount: number;
}

export const collectTransferSourceIds = (bundle: TransferJson): TransferSourceIds => {
  const snapshot = bundle.project_snapshot;
  const storyboard = bundle.episode_storyboard;
  const bible = bundle.story_bible;
  const stages = bundle.script_stage_outputs;
  if (!isRecord(snapshot) || !isRecord(storyboard) || !isRecord(bible) || !Array.isArray(stages)) {
    invalid('TRANSFER_BUNDLE_INVALID');
  }
  const formatProfileId = stringField(
    isRecord(storyboard.format_profile) ? storyboard.format_profile.id : null,
  );
  if (formatProfileId === null) invalid('TRANSFER_BUNDLE_INVALID');
  const shotIds: string[] = [];
  const shotVersionIds: string[] = [];
  for (const shot of storyboard.shot_contracts as unknown[]) {
    if (!isRecord(shot)) invalid('TRANSFER_BUNDLE_INVALID');
    const shotId = stringField(shot.shot_id);
    const shotVersionId = stringField(shot.version_id);
    if (shotId === null || shotVersionId === null) invalid('TRANSFER_BUNDLE_INVALID');
    shotIds.push(shotId);
    shotVersionIds.push(shotVersionId);
  }
  const scriptVersionIds = stages.map((entry) => {
    if (!isRecord(entry)) invalid('TRANSFER_BUNDLE_INVALID');
    const versionId = stringField(entry.version_id);
    if (versionId === null) invalid('TRANSFER_BUNDLE_INVALID');
    return versionId;
  });
  const episodeId = stringField(storyboard.episode_id);
  const storyBibleVersionId = stringField(bible.version_id);
  if (episodeId === null || storyBibleVersionId === null) invalid('TRANSFER_BUNDLE_INVALID');
  return {
    episodeId,
    formatProfileId,
    projectId: stringField(snapshot.project_id) ?? '',
    scriptVersionIds,
    shotIds,
    shotVersionIds,
    storyBibleVersionId,
    totalCount:
      3 +
      scriptVersionIds.length +
      shotIds.length +
      shotVersionIds.length +
      (stringField(snapshot.project_id) === '' ? 0 : 1),
  };
};

/**
 * 确定性 ID Mapping：对 [project, episode, format profile, bible, 4×script, N×shot, N×shotVersion]
 * 全量生成新 ID。键序固定（collect 顺序），同一 Bundle 的重写结果只依赖注入的 idFactory。
 */
export const buildTransferIdMapping = (
  sourceIds: TransferSourceIds,
  newId: (kind: string) => string,
): Readonly<Record<string, string>> => {
  const entries: [string, string][] = [
    [sourceIds.projectId, `project_${newId('project')}`],
    [sourceIds.episodeId, `episode_${newId('episode')}`],
    [sourceIds.formatProfileId, `format_${newId('format')}`],
    [sourceIds.storyBibleVersionId, `sbv_${newId('storyBible')}`],
  ];
  for (const versionId of sourceIds.scriptVersionIds) {
    entries.push([versionId, `scv_${newId('script')}`]);
  }
  for (const shotId of sourceIds.shotIds) {
    entries.push([shotId, `shot_${newId('shot')}`]);
  }
  for (const shotVersionId of sourceIds.shotVersionIds) {
    entries.push([shotVersionId, `scv_${newId('shotVersion')}`]);
  }
  return Object.fromEntries(entries);
};

const replaceStrings = (value: unknown, mapping: Readonly<Record<string, string>>): unknown => {
  if (typeof value === 'string') {
    return mapping[value] ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, mapping));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, replaceStrings(nested, mapping)]),
  );
};

/**
 * NEW_PROJECT 文档引用重写：深度克隆并对**整串相等**的 ID 值替换（不子串替换，
 * 短语/提示词不受影响）。未列入 mapping 的外部引用（如历史 parent_version_id、
 * 未打包 asset_version_ids）原样保留——它们是 provenance/结构引用，Schema 合法且
 * 缺失语义由 TRANSFER_MEDIA_* 警告表达。
 */
export const rewriteTransferReferences = (
  bundle: TransferJson,
  mapping: Readonly<Record<string, string>>,
): TransferJson => replaceStrings(bundle, mapping) as TransferJson;
