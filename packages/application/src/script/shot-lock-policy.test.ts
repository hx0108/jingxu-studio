import { describe, expect, it } from 'vitest';

import {
  changedEditableRoots,
  checkLockPointer,
  parseLockPointer,
  pointerTokensConflict,
  validateLockPointer,
} from './shot-lock-policy';

const document = {
  acceptance: { must_include: ['雨天街道'], must_not_include: [] },
  cinematography: { camera_motion: 'STATIC', shot_size: 'MEDIUM' },
  content: {
    character_ids: ['char_lin'],
    spoken_text: '雨越下越大了。',
  },
  dialogue: { dialogue_render_mode: 'NARRATION_FIRST', speaker_id: 'narrator' },
  locked_paths: [],
  narrative_purpose: '建立雨夜氛围',
  provenance: { source_type: 'AI_GENERATED' },
  sequence: 1,
  shot_id: 'shot_0001',
  status: 'DRAFT',
  target_duration_sec: 12,
  version_id: 'scv_demo_v1',
};

describe('parseLockPointer（RFC 6901）', () => {
  it('合法指针与转义—~0 表示 ~、~1 表示 /', () => {
    expect(parseLockPointer('/dialogue/speaker_id')).toEqual(['dialogue', 'speaker_id']);
    expect(parseLockPointer('/acceptance/must~1include')).toEqual(['acceptance', 'must/include']);
    expect(parseLockPointer('/narrative_purpose')).toEqual(['narrative_purpose']);
    expect(parseLockPointer('/dialogue/speaker~0id')).toEqual(['dialogue', 'speaker~id']);
  });

  it('非法形态—空串、无前导斜杠、空 token、非法转义均拒绝', () => {
    expect(parseLockPointer('')).toBeNull();
    expect(parseLockPointer('dialogue')).toBeNull();
    expect(parseLockPointer('/dialogue//speaker_id')).toBeNull();
    expect(parseLockPointer('/dialogue/speaker~2id')).toBeNull();
    expect(parseLockPointer('/dialogue/speaker~')).toBeNull();
  });
});

describe('checkLockPointer（白名单与数组下标）', () => {
  it('七个一级根均可锁', () => {
    for (const root of [
      '/narrative_purpose',
      '/cinematography',
      '/content',
      '/dialogue',
      '/continuity',
      '/generation_constraints',
      '/acceptance',
    ]) {
      expect(checkLockPointer(root)).toEqual({ ok: true, tokens: [root.slice(1)] });
    }
  });

  it('元数据/ID/状态/provenance/时长根不可锁', () => {
    for (const pointer of [
      '/shot_id',
      '/version_id',
      '/sequence',
      '/status',
      '/provenance',
      '/contract_version',
      '/target_duration_sec',
      '/locked_paths',
    ]) {
      expect(checkLockPointer(pointer)).toMatchObject({
        code: 'LOCK_ROOT_NOT_LOCKABLE',
        ok: false,
      });
    }
  });

  it('数组下标 token 拒绝（根级属性本身可锁）', () => {
    expect(checkLockPointer('/content/character_ids/0')).toMatchObject({
      code: 'LOCK_ARRAY_INDEX_FORBIDDEN',
      ok: false,
    });
    expect(checkLockPointer('/acceptance/must_include/1')).toMatchObject({
      code: 'LOCK_ARRAY_INDEX_FORBIDDEN',
      ok: false,
    });
    expect(checkLockPointer('/content/character_ids')).toEqual({
      ok: true,
      tokens: ['content', 'character_ids'],
    });
  });

  it('合法子路径（含转义）通过静态校验', () => {
    expect(checkLockPointer('/dialogue/speaker_id')).toEqual({
      ok: true,
      tokens: ['dialogue', 'speaker_id'],
    });
    expect(checkLockPointer('/cinematography/camera_motion')).toEqual({
      ok: true,
      tokens: ['cinematography', 'camera_motion'],
    });
  });
});

describe('validateLockPointer（当前文档可解析性）', () => {
  it('已存在子路径解析通过、不存在路径拒绝', () => {
    expect(validateLockPointer('/dialogue/speaker_id', document)).toEqual({
      ok: true,
      tokens: ['dialogue', 'speaker_id'],
    });
    expect(validateLockPointer('/dialogue/nonexistent', document)).toMatchObject({
      code: 'LOCK_PATH_UNRESOLVED',
      ok: false,
    });
    expect(validateLockPointer('/cinematography/shot_size', document)).toEqual({
      ok: true,
      tokens: ['cinematography', 'shot_size'],
    });
  });

  it('静态违规先于可解析性返回（AC-V1-06 非法转义/下标/白名单外形态）', () => {
    expect(validateLockPointer('/dialogue/speaker~2id', document)).toMatchObject({
      code: 'LOCK_POINTER_MALFORMED',
      ok: false,
    });
    expect(validateLockPointer('/shot_id', document)).toMatchObject({
      code: 'LOCK_ROOT_NOT_LOCKABLE',
      ok: false,
    });
  });
});

describe('pointerTokensConflict（父子/相等冲突矩阵）', () => {
  const tokens = (pointer: string): readonly string[] => {
    const parsed = parseLockPointer(pointer);
    if (parsed === null) throw new Error(`bad pointer: ${pointer}`);
    return parsed;
  };

  it('同路径、锁为写之父、写为锁之父均冲突', () => {
    expect(pointerTokensConflict(tokens('/dialogue'), tokens('/dialogue'))).toBe(true);
    expect(pointerTokensConflict(tokens('/dialogue'), tokens('/dialogue/speaker_id'))).toBe(true);
    expect(pointerTokensConflict(tokens('/dialogue/speaker_id'), tokens('/dialogue'))).toBe(true);
    expect(
      pointerTokensConflict(tokens('/dialogue/speaker_id'), tokens('/dialogue/speaker_id')),
    ).toBe(true);
  });

  it('兄弟路径与更深无关路径不冲突', () => {
    expect(pointerTokensConflict(tokens('/dialogue'), tokens('/cinematography'))).toBe(false);
    expect(
      pointerTokensConflict(
        tokens('/dialogue/speaker_id'),
        tokens('/dialogue/dialogue_render_mode'),
      ),
    ).toBe(false);
    expect(
      pointerTokensConflict(
        tokens('/cinematography/camera_motion'),
        tokens('/cinematography/shot_size'),
      ),
    ).toBe(false);
  });

  it('转义解码后比较（~1 不被当作层级分隔）', () => {
    expect(
      pointerTokensConflict(
        tokens('/acceptance/must~1include'),
        tokens('/acceptance/must~1include/x'),
      ),
    ).toBe(true);
    expect(
      pointerTokensConflict(
        tokens('/acceptance/must~1include'),
        tokens('/acceptance/must_include'),
      ),
    ).toBe(false);
  });
});

describe('changedEditableRoots（编辑器写集推导）', () => {
  it('仅变化根计入；键序无关；系统字段差异忽略', () => {
    const edited = {
      ...document,
      content: { ...document.content, spoken_text: '改写后的台词。' },
      sequence: 99,
      shot_id: 'shot_hacked',
    };
    expect(changedEditableRoots(document, edited)).toEqual(['content']);
  });

  it('target_duration_sec 属可编辑根；无变化返回空集', () => {
    const edited = { ...document, target_duration_sec: 15 };
    expect(changedEditableRoots(document, edited)).toEqual(['target_duration_sec']);
    expect(changedEditableRoots(document, { ...document })).toEqual([]);
  });

  it('嵌套值等价但键序不同不视为变化', () => {
    const reordered = {
      ...document,
      dialogue: {
        speaker_id: document.dialogue.speaker_id,
        dialogue_render_mode: document.dialogue.dialogue_render_mode,
      },
    };
    expect(changedEditableRoots(document, reordered)).toEqual([]);
  });
});
