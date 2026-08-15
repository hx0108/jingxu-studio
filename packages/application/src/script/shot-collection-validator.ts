/**
 * SHOT_CONTRACT 集合校验（design.md D3，EpisodeValidator 子集）。
 *
 * 逐镜头结构由注入后的 ShotContract 1.1.0 正式校验负责；本模块只校验
 * 跨镜头集合不变量：sequence 连续唯一、连续性引用合法、ID 源自冻结
 * STORY_BIBLE、整集时长预算。失败返回稳定错误码与有界明细（截断由
 * 候选契约管线统一执行），不创建任何业务版本。
 */

export interface ShotCollectionStoryBibleIds {
  /** 冻结 STORY_BIBLE 的角色键（char_*）。 */
  readonly characterIds: readonly string[];
  /** 冻结 STORY_BIBLE 的场景键（scene_*）。 */
  readonly sceneIds: readonly string[];
}

/**
 * 从冻结 STORY_BIBLE 版本文档（ScriptStageOutput 信封）提取集合校验所需的
 * char_/scene_ 键集合；形状不符返回 null（由调用方转为 STALE_INPUT 类失败）。
 */
export const extractShotCollectionBibleKeys = (
  document: unknown,
): ShotCollectionStoryBibleIds | null => {
  if (typeof document !== 'object' || document === null) return null;
  const data = (document as Readonly<{ data?: unknown }>).data;
  if (typeof data !== 'object' || data === null) return null;
  const { characters, scenes } = data as Readonly<{ characters?: unknown; scenes?: unknown }>;
  if (
    typeof characters !== 'object' ||
    characters === null ||
    typeof scenes !== 'object' ||
    scenes === null
  ) {
    return null;
  }
  return {
    characterIds: Object.keys(characters).filter((key) => key.startsWith('char_')),
    sceneIds: Object.keys(scenes).filter((key) => key.startsWith('scene_')),
  };
};

export type ShotCollectionValidation =
  | Readonly<{ valid: true }>
  | Readonly<{
      code:
        | 'SHOT_SET_SEQUENCE_INVALID'
        | 'SHOT_SET_PREVIOUS_SHOT_INVALID'
        | 'SHOT_SET_CHARACTER_UNKNOWN'
        | 'SHOT_SET_SCENE_UNKNOWN'
        | 'SHOT_SET_DURATION_OUT_OF_RANGE';
      details: readonly string[];
      valid: false;
    }>;

const EPISODE_DURATION_MIN = 30;
const EPISODE_DURATION_MAX = 180;

const numberValue = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const shotIdOf = (document: Readonly<Record<string, unknown>>): unknown => document.shot_id;

/**
 * 校验注入后的镜头文档集合。documents 为逐镜头 ShotContract 文档数组；
 * storyBible 为冻结输入提取的 ID 集合。
 */
export const validateShotSetCollection = (
  documents: unknown,
  storyBible: ShotCollectionStoryBibleIds,
): ShotCollectionValidation => {
  if (!Array.isArray(documents) || documents.length === 0) {
    return {
      code: 'SHOT_SET_SEQUENCE_INVALID',
      details: ['shots must be a non-empty array'],
      valid: false,
    };
  }
  // Array.isArray 将 unknown 收窄为 any[]；回到 unknown[] 避免绕过类型检查。
  const shotDocuments = documents as readonly unknown[];

  const sequenceInvalid: string[] = [];
  const bySequence = new Map<number, Readonly<Record<string, unknown>>>();
  for (const document of shotDocuments) {
    const record = document as Readonly<Record<string, unknown>>;
    const sequence = numberValue(record.sequence);
    if (sequence === null || sequence < 1 || sequence > documents.length) {
      sequenceInvalid.push(`sequence must be 1..${String(documents.length)}`);
    } else if (bySequence.has(sequence)) {
      sequenceInvalid.push(`sequence ${String(sequence)} duplicated`);
    } else {
      bySequence.set(sequence, record);
    }
  }
  if (bySequence.size !== documents.length) {
    sequenceInvalid.push('sequence set must cover every shot exactly once');
  }
  if (sequenceInvalid.length > 0) {
    return { code: 'SHOT_SET_SEQUENCE_INVALID', details: sequenceInvalid, valid: false };
  }

  const continuityInvalid: string[] = [];
  for (const [sequence, document] of bySequence) {
    const continuity = document.continuity as Readonly<Record<string, unknown>> | undefined;
    const mode = continuity?.continuity_mode;
    const previous = continuity?.previous_shot_id;
    if (mode === 'CONTINUOUS_ACTION' && (typeof previous !== 'string' || previous.length === 0)) {
      continuityInvalid.push(
        `shots[seq=${String(sequence)}] CONTINUOUS_ACTION requires a preceding shot`,
      );
      continue;
    }
    if (typeof previous === 'string' && previous.length > 0) {
      const targetEntry = [...bySequence.entries()].find(
        ([, candidate]) => shotIdOf(candidate) === previous,
      );
      if (targetEntry === undefined || targetEntry[0] >= sequence) {
        continuityInvalid.push(
          `shots[seq=${String(sequence)}] previous_shot_id must reference an earlier shot`,
        );
      }
    }
  }
  if (continuityInvalid.length > 0) {
    return { code: 'SHOT_SET_PREVIOUS_SHOT_INVALID', details: continuityInvalid, valid: false };
  }

  const characterUnknown: string[] = [];
  const sceneUnknown: string[] = [];
  for (const [sequence, document] of bySequence) {
    const content = document.content as Readonly<Record<string, unknown>> | undefined;
    const characterIds = Array.isArray(content?.character_ids) ? content.character_ids : [];
    for (const characterId of characterIds) {
      if (typeof characterId === 'string' && !storyBible.characterIds.includes(characterId)) {
        characterUnknown.push(`shots[seq=${String(sequence)}] character ${characterId} unknown`);
      }
    }
    const speaker = (document.dialogue as Readonly<Record<string, unknown>> | undefined)
      ?.speaker_id;
    if (
      typeof speaker === 'string' &&
      speaker !== 'narrator' &&
      !storyBible.characterIds.includes(speaker)
    ) {
      characterUnknown.push(`shots[seq=${String(sequence)}] speaker ${speaker} unknown`);
    }
    const sceneId = content?.scene_id;
    if (typeof sceneId === 'string' && !storyBible.sceneIds.includes(sceneId)) {
      sceneUnknown.push(`shots[seq=${String(sequence)}] scene ${sceneId} unknown`);
    }
  }
  if (characterUnknown.length > 0) {
    return { code: 'SHOT_SET_CHARACTER_UNKNOWN', details: characterUnknown, valid: false };
  }
  if (sceneUnknown.length > 0) {
    return { code: 'SHOT_SET_SCENE_UNKNOWN', details: sceneUnknown, valid: false };
  }

  const total = shotDocuments.reduce((sum: number, document: unknown) => {
    const duration = numberValue(
      (document as Readonly<Record<string, unknown>>).target_duration_sec,
    );
    return sum + (duration ?? 0);
  }, 0);
  if (total < EPISODE_DURATION_MIN || total > EPISODE_DURATION_MAX) {
    return {
      code: 'SHOT_SET_DURATION_OUT_OF_RANGE',
      details: [
        `sum(target_duration_sec)=${String(total)} must be within ${String(EPISODE_DURATION_MIN)}..${String(EPISODE_DURATION_MAX)}`,
      ],
      valid: false,
    };
  }
  return { valid: true };
};
