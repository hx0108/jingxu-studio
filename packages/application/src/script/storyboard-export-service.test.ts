import { describe, expect, it } from 'vitest';

import type { FormatProfile } from '@jingxu/domain';

import type { ScriptJobRepositories } from '../ports/script/index';
import {
  assembleStoryboardExport,
  createStoryboardExportService,
  type StoryboardExportFileSink,
  type StoryboardExportServiceDependencies,
} from './storyboard-export-service';

/**
 * 锁版 valid fixture（episode-storyboard-export.valid.json）的顶层键集快照。
 * 组装产物必须与其完全一致——多键（泄漏调试字段）或少键（缺必填）均失败。
 */
const EXPECTED_ENVELOPE_KEYS = [
  'episode_id',
  'episode_version',
  'export_id',
  'export_provenance',
  'exported_at',
  'format_profile',
  'lineage_completeness',
  'project_id',
  'schema_version',
  'shot_contracts',
  'story_bible_version_id',
  'target_duration_sec',
] as const;

const NOW = '2026-08-20T00:00:00.000Z';
const PROJECT_ID = 'project_export1';
const EPISODE_ID = 'episode_export1';

const formatProfile: FormatProfile = {
  createdAt: NOW,
  id: 'format_export1',
  isCurrent: true,
  parentId: null,
  projectId: PROJECT_ID,
  spec: {
    aspectRatio: '9:16',
    fps: 30,
    height: 1920,
    language: 'zh-CN',
    subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    width: 1080,
  },
  versionNo: 1,
};

const shotDocument = (
  shotId: string,
  sequence: number,
  durationSec: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  acceptance: { human_review_required: true, must_include: [], must_not_include: [] },
  cinematography: { camera_motion: 'STATIC', shot_size: 'MEDIUM' },
  content: {
    action: '主角避雨',
    character_ids: ['char_lin'],
    emotion: '紧张',
    prop_ids: [],
    scene_id: 'scene_street',
    spoken_text: '雨越下越大了。',
  },
  contract_version: 1,
  continuity: {
    asset_version_ids: [],
    continuity_mode: 'NONE',
    first_frame_requirement: null,
    last_frame_requirement: null,
    previous_shot_id: null,
  },
  derived_from_shot_ids: [],
  dialogue: {
    audio_required: true,
    dialogue_mode_source: 'PROJECT_DEFAULT',
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 2,
    lip_sync_required: false,
    override_reason: null,
    speaker_id: 'narrator',
  },
  format_profile_id: formatProfile.id,
  generation_constraints: {
    budget_estimate: null,
    capability_requirements: [],
    image_prompt: '雨夜街道',
    negative_constraints: [],
    video_prompt: null,
  },
  locked_paths: [],
  narrative_purpose: '建立雨夜氛围',
  parent_version_id: null,
  provenance: {
    last_edit_source: 'AI',
    source_invocation_id: 'inv-0001',
    source_type: 'AI_GENERATED',
  },
  schema_version: '1.1.0',
  sequence,
  shot_id: shotId,
  status: 'READY',
  target_duration_sec: durationSec,
  version_id: `scv_${shotId}_v1`,
  ...overrides,
});

interface SinkCall {
  readonly content: string;
  readonly defaultFileName: string;
}

interface HarnessOptions {
  /** 覆盖镜头文档集合（构造 sequence 断档等集合违例用）。 */
  readonly documentsOverride?: readonly Record<string, unknown>[];
  readonly durations?: readonly number[];
  readonly episodeStatus?: string;
  readonly failAudit?: boolean;
  readonly schemaInvalid?: boolean;
  readonly sinkOutcome?: 'written' | 'cancelled' | 'failed';
}

const createHarness = (options: HarnessOptions = {}) => {
  const durations = options.durations ?? [15, 15, 15, 15, 15, 15];
  const documents = (
    options.documentsOverride ??
    durations.map((duration, index) =>
      shotDocument(`shot_000${String(index + 1)}`, index + 1, duration),
    )
  ).map((document) => ({ ...document }));
  const shotVersions = new Map(
    documents.map((document) => [
      String(document.version_id),
      {
        createdAt: NOW,
        dialogueRenderMode: 'NARRATION_FIRST',
        document: JSON.stringify(document),
        documentSha256: `sha-${String(document.version_id)}`,
        externalParentVersionId: null,
        formatProfileId: formatProfile.id,
        id: String(document.version_id),
        lineageResolutionStatus: 'ROOT',
        parentId: null,
        sequence: Number(document.sequence),
        shotId: String(document.shot_id),
        sourceInvocationId: 'inv-0001',
        targetDurationSec: Number(document.target_duration_sec),
        versionNo: 1,
        versionStatus: 'READY',
      },
    ]),
  );
  const audits: Record<string, unknown>[] = [];
  const repositories = {
    audit: {
      record: (entry: Record<string, unknown>) => {
        if (options.failAudit) throw new Error('SQLITE_ERROR');
        audits.push(entry);
      },
    },
    episodeVersions: {
      findById: () => ({
        createdAt: NOW,
        episodeId: EPISODE_ID,
        formatProfileId: formatProfile.id,
        id: 'ev-0001',
        parentId: null,
        shotSetHash: 'hash-ev-0001',
        status: options.episodeStatus ?? 'READY',
        storyBibleVersionId: 'bible-0001',
        targetDurationSec: 90,
        versionNo: 3,
      }),
      listShotLinks: () =>
        documents.map((document) => ({
          sequence: Number(document.sequence),
          shotId: String(document.shot_id),
          shotVersionId: String(document.version_id),
        })),
    },
    shotContractVersions: { findById: (id: string) => shotVersions.get(id) ?? null },
    stageHeads: {
      find: () => ({
        currentVersionId: 'ev-0001',
        currentVersionType: 'EPISODE_VERSION',
        episodeId: EPISODE_ID,
        projectId: PROJECT_ID,
        stage: 'SHOT_CONTRACT',
        updatedAt: NOW,
      }),
    },
    storyBibleVersions: {
      findById: () => ({
        document: JSON.stringify({
          data: { characters: { char_lin: {} }, scenes: { scene_street: {} } },
        }),
        id: 'bible-0001',
      }),
    },
  } as unknown as ScriptJobRepositories;

  const sinkCalls: SinkCall[] = [];
  const sink: StoryboardExportFileSink = {
    write: (defaultFileName, content) => {
      sinkCalls.push({ content, defaultFileName });
      if (options.sinkOutcome === 'cancelled') return Promise.resolve({ outcome: 'cancelled' });
      if (options.sinkOutcome === 'failed') return Promise.resolve({ outcome: 'failed' });
      return Promise.resolve({
        byteSize: content.length,
        fileSha256: 'a'.repeat(64),
        outcome: 'written',
      });
    },
  };
  const validateCalls: unknown[] = [];
  const dependencies: StoryboardExportServiceDependencies = {
    appVersion: '0.1.0-test',
    formatProfiles: { findCurrent: () => Promise.resolve(formatProfile) },
    newId: (() => {
      let sequence = 0;
      return () => {
        sequence += 1;
        return `newid-${String(sequence)}`;
      };
    })(),
    now: () => NOW,
    sink,
    unitOfWork: {
      run: <T>(work: (repositories: ScriptJobRepositories) => Promise<T>) => work(repositories),
    },
    validateExportDocument: (document) => {
      validateCalls.push(document);
      return options.schemaInvalid
        ? { code: 'ENVELOPE_INVALID', details: ['/export_id:pattern'], valid: false }
        : { valid: true };
    },
  };
  const service = createStoryboardExportService(dependencies);
  return { audits, service, sinkCalls, validateCalls };
};

const baseInput = {
  episodeId: EPISODE_ID,
  expectedVersionId: 'ev-0001',
  projectId: PROJECT_ID,
  requestId: 'request-export-1',
};

describe('assembleStoryboardExport 组装纯函数（envelope 1.1.0 金样）', () => {
  const envelope = assembleStoryboardExport({
    appVersion: '0.1.0',
    episodeId: EPISODE_ID,
    episodeVersionNo: 3,
    exportedAt: NOW,
    exportId: 'export_newid-1',
    formatProfile,
    projectId: PROJECT_ID,
    shotDocuments: [shotDocument('shot_0001', 1, 15)],
    storyBibleVersionId: 'bible-0001',
    targetDurationSec: 90,
  });

  it('顶层键集与锁版 fixture 完全一致（多键/少键均失败）', () => {
    expect([...Object.keys(envelope)].sort()).toEqual([...EXPECTED_ENVELOPE_KEYS].sort());
  });

  it('format_profile 投影：subtitle_safe_area 四键改名 *_pct，数值不变', () => {
    expect(envelope.format_profile).toEqual({
      aspect_ratio: '9:16',
      fps: 30,
      height: 1920,
      id: formatProfile.id,
      language: 'zh-CN',
      subtitle_safe_area: { bottom_pct: 12, left_pct: 5, right_pct: 5, top_pct: 5 },
      width: 1080,
    });
  });

  it('provenance 派生：AI_GENERATED/AI_ASSISTED 均计 AI 参与，全 HUMAN_CREATED 才为 false', () => {
    expect(
      (envelope.export_provenance as Readonly<Record<string, unknown>>)
        .contains_ai_assisted_content,
    ).toBe(true);
    const humanOnly = assembleStoryboardExport({
      appVersion: '0.1.0',
      episodeId: EPISODE_ID,
      episodeVersionNo: 1,
      exportedAt: NOW,
      exportId: 'export_newid-2',
      formatProfile,
      projectId: PROJECT_ID,
      shotDocuments: [
        shotDocument('shot_0001', 1, 15, {
          provenance: { last_edit_source: 'HUMAN', source_type: 'HUMAN_CREATED' },
        }),
      ],
      storyBibleVersionId: 'bible-0001',
      targetDurationSec: 90,
    });
    expect(
      (humanOnly.export_provenance as Readonly<Record<string, unknown>>)
        .contains_ai_assisted_content,
    ).toBe(false);
  });

  it('shot_contracts 原样携带文档（含 locked_paths 投影）', () => {
    const locked = shotDocument('shot_0001', 1, 15, { locked_paths: ['/dialogue'] });
    const withLock = assembleStoryboardExport({
      appVersion: '0.1.0',
      episodeId: EPISODE_ID,
      episodeVersionNo: 1,
      exportedAt: NOW,
      exportId: 'export_newid-3',
      formatProfile,
      projectId: PROJECT_ID,
      shotDocuments: [locked],
      storyBibleVersionId: 'bible-0001',
      targetDurationSec: 90,
    });
    expect(withLock.shot_contracts).toEqual([locked]);
  });
});

describe('StoryboardExportService READY_EXPORT 门禁与三段式用例', () => {
  it('软带内 Σ=90：直接导出—sink 落盘—审计完整—回执无路径', async () => {
    const { audits, service, sinkCalls } = createHarness();
    const result = await service.exportEpisode(baseInput, 'trace-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalDurationSec).toBe(90);
    expect(result.data.fileSha256).toBe('a'.repeat(64));
    expect(result.data.exportId).toBe('export_newid-1');
    expect(JSON.stringify(result.data)).not.toContain('filePath');
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]?.defaultFileName).toBe(`export_${PROJECT_ID}_${EPISODE_ID}_v3.json`);
    const parsed = JSON.parse(sinkCalls[0]?.content ?? '{}') as Record<string, unknown>;
    expect(parsed.schema_version).toBe('1.1.0');
    expect(parsed.episode_version).toBe(3);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'STORYBOARD_EXPORTED',
      actor: 'USER',
      afterSha256: 'a'.repeat(64),
      metadata: {
        byteSize: sinkCalls[0]?.content.length,
        deviationReason: null,
        fileSha256: 'a'.repeat(64),
        totalDurationSec: 90,
      },
      objectId: EPISODE_ID,
      objectType: 'EPISODE_VERSION',
      objectVersionId: 'ev-0001',
      projectId: PROJECT_ID,
    });
    // metadata 红线：留痕不得携带镜头源内容。
    expect(JSON.stringify(audits[0])).not.toContain('雨越下越大了');
  });

  it('非 READY：EXPORT_NOT_READY，不触 sink 不留痕', async () => {
    const { audits, service, sinkCalls } = createHarness({ episodeStatus: 'DRAFT' });
    const result = await service.exportEpisode(baseInput, 'trace-2');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXPORT_NOT_READY');
    expect(sinkCalls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('集合校验失败（sequence 断档）：EXPORT_COLLECTION_INVALID 不留痕', async () => {
    const { audits, service, sinkCalls } = createHarness({
      documentsOverride: [shotDocument('shot_0001', 1, 15), shotDocument('shot_0002', 3, 15)],
    });
    const result = await service.exportEpisode(baseInput, 'trace-3');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXPORT_COLLECTION_INVALID');
    expect(result.error.fieldErrors?.details).toContain('SHOT_SET_SEQUENCE_INVALID');
    expect(sinkCalls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('软带外 Σ=30：缺确认 → EXPORT_DURATION_DEVIATION 携带实际 Σ；补确认+原因 → 成功且原因入留痕', async () => {
    const deviating = createHarness({ durations: [15, 15] });
    const rejected = await deviating.service.exportEpisode(baseInput, 'trace-4a');
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('EXPORT_DURATION_DEVIATION');
    expect(rejected.error.fieldErrors).toEqual({ totalDurationSec: '30' });
    expect(deviating.sinkCalls).toHaveLength(0);
    expect(deviating.audits).toHaveLength(0);

    const confirmed = await deviating.service.exportEpisode(
      {
        ...baseInput,
        deviationReason: '快闪风格整集',
        requestId: 'request-export-2',
        warnConfirmed: true,
      },
      'trace-4b',
    );
    expect(confirmed.ok).toBe(true);
    expect(deviating.audits).toHaveLength(1);
    expect(
      (deviating.audits[0]?.metadata as Readonly<Record<string, unknown>>).deviationReason,
    ).toBe('快闪风格整集');
  });

  it('软带内但 envelope 校验失败：EXPORT_SCHEMA_INVALID', async () => {
    const { audits, service } = createHarness({ schemaInvalid: true });
    const result = await service.exportEpisode(baseInput, 'trace-5');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXPORT_SCHEMA_INVALID');
    expect(result.error.fieldErrors?.details).toContain('/export_id:pattern');
    expect(audits).toHaveLength(0);
  });

  it('sink 取消：EXPORT_CANCELLED 平回执不留痕；写失败：EXPORT_FILE_WRITE_FAILED 不留痕', async () => {
    const cancelled = createHarness({ sinkOutcome: 'cancelled' });
    const cancelResult = await cancelled.service.exportEpisode(baseInput, 'trace-6a');
    expect(cancelResult.ok).toBe(false);
    if (!cancelResult.ok) expect(cancelResult.error.code).toBe('EXPORT_CANCELLED');
    expect(cancelled.audits).toHaveLength(0);

    const failed = createHarness({ sinkOutcome: 'failed' });
    const failResult = await failed.service.exportEpisode(baseInput, 'trace-6b');
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) expect(failResult.error.code).toBe('EXPORT_FILE_WRITE_FAILED');
    expect(failed.audits).toHaveLength(0);
  });

  it('审计写失败：EXPORT_AUDIT_FAILED 携带文件哈希（响亮回报，不静默）', async () => {
    const { audits, service, sinkCalls } = createHarness({ failAudit: true });
    const result = await service.exportEpisode(baseInput, 'trace-7');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXPORT_AUDIT_FAILED');
    expect(result.error.fieldErrors).toEqual({ fileSha256: 'a'.repeat(64) });
    expect(sinkCalls).toHaveLength(1);
    expect(audits).toHaveLength(0);
  });

  it('expectedVersionId 过期：SCRIPT_VERSION_CONFLICT', async () => {
    const { service } = createHarness();
    const result = await service.exportEpisode(
      { ...baseInput, expectedVersionId: 'ev-stale' },
      'trace-8',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SCRIPT_VERSION_CONFLICT');
  });

  it('FormatProfile 缺失：持久化失败回执', async () => {
    const dependencies = {
      appVersion: '0.1.0-test',
      formatProfiles: { findCurrent: () => Promise.resolve(null) },
      newId: () => 'newid-x',
      now: () => NOW,
      sink: {
        write: () => Promise.resolve({ outcome: 'cancelled' } as const),
      },
      unitOfWork: {
        run: <T>(work: (repositories: ScriptJobRepositories) => Promise<T>) =>
          work({} as ScriptJobRepositories),
      },
      validateExportDocument: () => ({ valid: true as const }),
    };
    const service = createStoryboardExportService(dependencies);
    const result = await service.exportEpisode(baseInput, 'trace-9');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROJECT_PERSISTENCE_FAILED');
  });

  it('format=MARKDOWN_TABLE：同门禁同回执—分镜表默认名/.md 渲染/审计 format 留痕（deliverables D1）', async () => {
    const { audits, service, sinkCalls } = createHarness();
    const result = await service.exportEpisode(
      { ...baseInput, format: 'MARKDOWN_TABLE' },
      'trace-10',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.exportId).toBe('export_newid-1');
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]?.defaultFileName).toBe(`storyboard_${PROJECT_ID}_${EPISODE_ID}_v3.md`);
    expect(sinkCalls[0]?.content).toContain('# 分镜表：');
    expect(sinkCalls[0]?.content).toContain('| 镜头号 | 景别 | 运镜 |');
    expect(sinkCalls[0]?.content).not.toContain('"schema_version"');
    expect((audits[0]?.metadata as Readonly<Record<string, unknown>>).format).toBe(
      'MARKDOWN_TABLE',
    );
  });

  it('format=PRODUCIBILITY_REPORT：报告默认名/规则版本随文/审计 format 留痕', async () => {
    const { audits, service, sinkCalls } = createHarness();
    const result = await service.exportEpisode(
      { ...baseInput, format: 'PRODUCIBILITY_REPORT' },
      'trace-11',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sinkCalls[0]?.defaultFileName).toBe(`report_${PROJECT_ID}_${EPISODE_ID}_v3.md`);
    expect(sinkCalls[0]?.content).toContain('# 可生产性报告：');
    expect(sinkCalls[0]?.content).toContain('jingxu-producibility-rules/1');
    expect((audits[0]?.metadata as Readonly<Record<string, unknown>>).format).toBe(
      'PRODUCIBILITY_REPORT',
    );
  });

  it('缺省 format：JSON 默认名与审计 format=EPISODE_JSON（向后兼容）', async () => {
    const { audits, service, sinkCalls } = createHarness();
    const result = await service.exportEpisode(baseInput, 'trace-12');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sinkCalls[0]?.defaultFileName).toBe(`export_${PROJECT_ID}_${EPISODE_ID}_v3.json`);
    expect((audits[0]?.metadata as Readonly<Record<string, unknown>>).format).toBe('EPISODE_JSON');
  });

  it('偏离确认 + format=PRODUCIBILITY_REPORT：Σ 判定与原因留痕对 Markdown 交付物同样生效', async () => {
    const deviating = createHarness({ durations: [15, 15] });
    const rejected = await deviating.service.exportEpisode(
      { ...baseInput, format: 'PRODUCIBILITY_REPORT' },
      'trace-13a',
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('EXPORT_DURATION_DEVIATION');
    expect(deviating.sinkCalls).toHaveLength(0);
    const confirmed = await deviating.service.exportEpisode(
      {
        ...baseInput,
        deviationReason: '快闪风格整集',
        format: 'PRODUCIBILITY_REPORT',
        requestId: 'request-export-13',
        warnConfirmed: true,
      },
      'trace-13b',
    );
    expect(confirmed.ok).toBe(true);
    const metadata = deviating.audits[0]?.metadata as Readonly<Record<string, unknown>>;
    expect(metadata.format).toBe('PRODUCIBILITY_REPORT');
    expect(metadata.deviationReason).toBe('快闪风格整集');
    expect(deviating.sinkCalls[0]?.content).toContain('- 偏离确认：已确认偏离，原因：快闪风格整集');
  });
});
