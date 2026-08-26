import { describe, expect, it } from 'vitest';

import type { ScriptWorkspaceSnapshot } from '../ports/script/script-types';
import type {
  VoiceMappingRecord,
  VoiceMappingRepositoryPort,
} from '../ports/voice/voice-mapping-repository';
import {
  collectMappingGaps,
  createVoiceMappingService,
  voiceMappingGapFailure,
  type VoiceMappingServiceDependencies,
} from './voice-mapping-service';

const NOW = '2026-08-27T00:00:00Z';
const NARRATOR_VOICE = 'Neil';
const ALLOWED_VOICES = ['Neil', 'Elias', 'Mochi', 'Stella'];

function hash64(seed: string): string {
  let hash = '';
  while (hash.length < 64) hash += (seed.length + hash.length).toString(16);
  return hash.slice(0, 64).padEnd(64, '0');
}

/** STORY_BIBLE 版本文档（ScriptStageOutput 信封；角色键集决定 char_* 合法域）。 */
const bibleDocument = (characterIds: readonly string[]): string =>
  JSON.stringify({
    data: {
      characters: Object.fromEntries(characterIds.map((id) => [id, { name: id }])),
      scenes: { scene_1: {} },
    },
  });

const workspaceOf = (characterIds: readonly string[]): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: 'project_00000001',
  sourceInput: null,
  storyboard: {
    current: null,
    currentShots: [],
    history: [],
    historyTruncated: false,
  },
  stages: [
    {
      current: {
        createdAt: NOW,
        document: bibleDocument(characterIds),
        documentSha256: hash64('bible'),
        id: 'sbv_0000001',
        parentId: null,
        projectId: 'project_00000001',
        source: 'AI',
        sourceInvocationId: null,
        status: 'READY',
        versionNo: 1,
      },
      episodeId: null,
      head: null,
      history: [],
      historyTruncated: false,
      stage: 'STORY_BIBLE',
    },
  ],
});

/** 内存映射仓库：记录 replaceAll 调用以便断言「非法值不写入」。 */
const createMemoryMappings = (
  initial: readonly VoiceMappingRecord[] = [],
): VoiceMappingRepositoryPort & { written: VoiceMappingRecord[][] } => {
  let rows = [...initial];
  const written: VoiceMappingRecord[][] = [];
  return {
    listByProject: (projectId) =>
      Promise.resolve(rows.filter((row) => row.projectId === projectId)),
    replaceAll: (projectId, mappings) => {
      written.push(mappings.map((mapping) => ({ ...mapping, projectId })));
      rows = [...rows.filter((row) => row.projectId !== projectId), ...mappings];
      return Promise.resolve(mappings.map((mapping) => ({ ...mapping, projectId })));
    },
    written,
  };
};

const createDependencies = (
  overrides: Partial<VoiceMappingServiceDependencies> = {},
): VoiceMappingServiceDependencies => ({
  allowedVoiceIds: ALLOWED_VOICES,
  clock: () => NOW,
  mappings: createMemoryMappings(),
  narratorDefaultVoiceId: NARRATOR_VOICE,
  workspaceQuery: {
    getWorkspace: () => Promise.resolve(workspaceOf(['char_hero', 'char_side'])),
    getVersionDocument: () => Promise.resolve(null),
  },
  ...overrides,
});

describe('VoiceMappingService（tasks 3.2 / spec R3）', () => {
  it('空库读取—narrator 固定行恒在列且为注册表旁白默认音色', async () => {
    const service = createVoiceMappingService(createDependencies());
    const result = await service.getMappings({ projectId: 'project_00000001' }, 'trace_1');
    expect(result).toEqual({
      data: [{ speakerId: 'narrator', updatedAt: NOW, voiceId: NARRATOR_VOICE }],
      ok: true,
    });
  });

  it('读取过滤已被故事圣经移除的角色行—行保留但不外显', async () => {
    const mappings = createMemoryMappings([
      {
        projectId: 'project_00000001',
        speakerId: 'char_ghost',
        updatedAt: '2026-08-01T00:00:00Z',
        voiceId: 'Mochi',
      },
      {
        projectId: 'project_00000001',
        speakerId: 'char_hero',
        updatedAt: '2026-08-01T00:00:00Z',
        voiceId: 'Stella',
      },
    ]);
    const service = createVoiceMappingService(createDependencies({ mappings }));
    const result = await service.getMappings({ projectId: 'project_00000001' }, 'trace_1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((entry) => entry.speakerId)).toEqual(['narrator', 'char_hero']);
  });

  it('合法集合保存—整体替换（narrator 固定行+char 行）并回读一致', async () => {
    const mappings = createMemoryMappings();
    const service = createVoiceMappingService(createDependencies({ mappings }));
    const result = await service.saveMapping(
      {
        mappings: [
          { speakerId: 'char_hero', voiceId: 'Stella' },
          { speakerId: 'narrator', voiceId: NARRATOR_VOICE },
        ],
        projectId: 'project_00000001',
        requestId: 'request_voice_map_0001',
      },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { speakerId: 'narrator', updatedAt: NOW, voiceId: NARRATOR_VOICE },
      { speakerId: 'char_hero', updatedAt: NOW, voiceId: 'Stella' },
    ]);
    expect(mappings.written).toHaveLength(1);
  });

  it.each([
    [
      'narrator 改音色',
      [{ speakerId: 'narrator', voiceId: 'Elias' }],
      'narrator 固定使用旁白默认音色',
    ],
    ['注册表外音色', [{ speakerId: 'char_hero', voiceId: 'Cherry' }], '不在注册表内'],
    ['故事圣经外角色', [{ speakerId: 'char_unknown', voiceId: 'Mochi' }], '不在当前故事圣经角色中'],
    ['非法 speakerId', [{ speakerId: 'hero', voiceId: 'Mochi' }], '非法或重复的说话人'],
  ])('非法值稳定拒绝—%s—不写入任何行', async (_, invalid, messagePart) => {
    const mappings = createMemoryMappings();
    const service = createVoiceMappingService(createDependencies({ mappings }));
    const result = await service.saveMapping(
      {
        mappings: invalid,
        projectId: 'project_00000001',
        requestId: 'request_voice_map_0002',
      },
      'trace_1',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IPC_INVALID_REQUEST');
    expect(result.error.message).toContain(messagePart);
    expect(mappings.written).toHaveLength(0);
  });

  it('工作区未初始化—读取与保存均稳定拒绝', async () => {
    const service = createVoiceMappingService(
      createDependencies({
        workspaceQuery: {
          getWorkspace: () => Promise.resolve(null),
          getVersionDocument: () => Promise.resolve(null),
        },
      }),
    );
    const read = await service.getMappings({ projectId: 'project_00000001' }, 'trace_1');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('SCRIPT_WORKSPACE_NOT_INITIALIZED');
    const saved = await service.saveMapping(
      {
        mappings: [{ speakerId: 'char_hero', voiceId: 'Mochi' }],
        projectId: 'project_00000001',
        requestId: 'request_voice_map_0003',
      },
      'trace_1',
    );
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('SCRIPT_WORKSPACE_NOT_INITIALIZED');
  });

  it('resolveEffectiveMappings—历史 narrator 行被外部写歪仍防御归一为固定音色', async () => {
    const mappings = createMemoryMappings([
      {
        projectId: 'project_00000001',
        speakerId: 'narrator',
        updatedAt: '2026-08-01T00:00:00Z',
        voiceId: 'Elias',
      },
    ]);
    const service = createVoiceMappingService(createDependencies({ mappings }));
    const effective = await service.resolveEffectiveMappings('project_00000001');
    expect(effective.get('narrator')).toBe(NARRATOR_VOICE);
  });

  it('buildMappingSnapshot—narrator 前置、其余按 speakerId 排序（导出冻结形状）', async () => {
    const mappings = createMemoryMappings([
      {
        projectId: 'project_00000001',
        speakerId: 'char_side',
        updatedAt: '2026-08-01T00:00:00Z',
        voiceId: 'Mochi',
      },
      {
        projectId: 'project_00000001',
        speakerId: 'char_hero',
        updatedAt: '2026-08-01T00:00:00Z',
        voiceId: 'Stella',
      },
    ]);
    const service = createVoiceMappingService(createDependencies({ mappings }));
    const snapshot = await service.buildMappingSnapshot('project_00000001');
    expect(snapshot.map((entry) => entry.speakerId)).toEqual([
      'narrator',
      'char_hero',
      'char_side',
    ]);
    expect(snapshot[0]?.voiceId).toBe(NARRATOR_VOICE);
  });

  it('缺口计算与阻断错误—清单保持输入顺序、上限截断、稳定码 VOICE_MAPPING_MISSING', () => {
    const effective = new Map([
      ['narrator', NARRATOR_VOICE],
      ['char_hero', 'Stella'],
    ]);
    expect(collectMappingGaps(['narrator', 'char_hero'], effective)).toEqual([]);
    expect(collectMappingGaps(['char_side', 'char_ghost'], effective)).toEqual([
      'char_side',
      'char_ghost',
    ]);

    const few = voiceMappingGapFailure<{ value: number }>(['char_side'], 'trace_gap');
    expect(few.ok).toBe(false);
    if (few.ok) return;
    expect(few.error.code).toBe('VOICE_MAPPING_MISSING');
    expect(few.error.message).toContain('char_side');

    const many = voiceMappingGapFailure<unknown>(
      Array.from({ length: 10 }, (_, index) => `char_${String(index).padStart(2, '0')}`),
      'trace_gap',
    );
    expect(many.ok).toBe(false);
    if (many.ok) return;
    expect(many.error.message).toContain('等 10 个说话人');
    expect(many.error.message).not.toContain('char_09');
  });
});
