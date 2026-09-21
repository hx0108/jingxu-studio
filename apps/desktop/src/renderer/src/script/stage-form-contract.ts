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
