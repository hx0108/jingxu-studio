import type { ScriptStage } from '@jingxu/contracts';

export const SCRIPT_DATA_SYSTEM_FIELDS = new Set([
  'schema_version',
  'project_id',
  'episode_id',
  'source_invocation_id',
  'stage',
  'status',
  'version_id',
  'locked_paths',
  'audit',
]);

/** 与 ScriptStageOutput 1.0.0 data 字段逐项对应；用于表单覆盖和审查，不替代正式 Schema。 */
export const STAGE_FIELD_COVERAGE = {
  CONCEPT: ['title', 'genre', 'target_audience', 'core_conflict', 'theme', 'synopsis'],
  STORY_BIBLE: [
    'characters.*.name',
    'characters.*.appearance',
    'characters.*.personality',
    'characters.*.motivation',
    'world_rules.*',
    'scenes.*.name',
    'scenes.*.description',
    'props.*.name',
    'props.*.description',
  ],
  EPISODE_OUTLINE: [
    'episode_goal',
    'opening',
    'midpoint',
    'climax',
    'ending_hook',
    'target_duration_sec',
  ],
  BEAT_SHEET: [
    'beats.*.beat_id',
    'beats.*.sequence',
    'beats.*.purpose',
    'beats.*.description',
    'beats.*.estimated_duration_sec',
  ],
  SCENE_SCRIPT: [
    'scenes.*.script_scene_id',
    'scenes.*.sequence',
    'scenes.*.scene_id',
    'scenes.*.character_ids.*',
    'scenes.*.action',
    'scenes.*.spoken_lines.*.speaker_id',
    'scenes.*.spoken_lines.*.line_type',
    'scenes.*.spoken_lines.*.text',
    'scenes.*.estimated_duration_sec',
  ],
} as const satisfies Record<Exclude<ScriptStage, 'SHOT_CONTRACT'>, readonly string[]>;

const decodePointerSegment = (segment: string): string =>
  segment.replaceAll('~1', '/').replaceAll('~0', '~');

export const pointerToStageFieldId = (pointer: string): string | null => {
  if (!pointer.startsWith('/data/')) return null;
  const segments = pointer
    .slice('/data/'.length)
    .split('/')
    .filter(Boolean)
    .map(decodePointerSegment)
    .map((segment) =>
      /^\d+$/u.test(segment) || /^(?:char|scene|prop|beat)_/u.test(segment) ? '*' : segment,
    );
  return segments.length === 0 ? null : segments.join('.');
};

export const findEditableSystemFields = (data: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(data)
    .filter((key) => SCRIPT_DATA_SYSTEM_FIELDS.has(key))
    .sort();

export type StageData = Readonly<Record<string, unknown>>;

/** 高级编辑回表单的唯一解析入口；非法 JSON、数组和系统字段均不得覆盖当前草稿。 */
export const parseAdvancedStageData = (
  text: string,
):
  | { readonly data: StageData; readonly ok: true }
  | { readonly message: string; readonly ok: false } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { message: '高级内容格式无效，请修正后再返回表单。', ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { message: '阶段内容必须是一个结构化对象。', ok: false };
  }
  const data = parsed as Readonly<Record<string, unknown>>;
  const systemFields = findEditableSystemFields(data);
  if (systemFields.length > 0) {
    return { message: `不能编辑系统字段：${systemFields.join('、')}`, ok: false };
  }
  return { data, ok: true };
};

export const serializeStageData = (data: StageData): string => JSON.stringify(data, null, 2);

/** 重复项业务键不依赖数组位置；取当前集合内第一个可用的稳定递增键。 */
export const createStableBusinessKey = (
  prefix: 'char' | 'scene' | 'prop' | 'beat' | 'script_scene',
  existing: readonly string[],
): string => {
  const used = new Set(existing);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${prefix}_${String(index).padStart(3, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('STAGE_BUSINESS_KEY_EXHAUSTED');
};
