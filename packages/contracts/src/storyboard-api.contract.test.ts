import { describe, expect, expectTypeOf, it } from 'vitest';

import { appErrorSchema, projectErrorCodeSchema } from './app-result';
import {
  STORYBOARD_IPC_CHANNELS,
  shotEditLockSummarySchema,
  storyboardEditShotInputSchema,
  storyboardExportEpisodeInputSchema,
  storyboardExportResultSchema,
  storyboardLockShotInputSchema,
  storyboardUnlockShotInputSchema,
  type StoryboardApi,
} from './storyboard-api';

const projectId = 'project_12345678';
const episodeId = 'episode_12345678';
const versionId = 'version_12345678';
const shotId = 'shot_1234567890';
const shotVersionId = 'scv_1234567890';

describe('Storyboard IPC Contract（shot-edit-lock D4）', () => {
  it('频道白名单—结构化编辑逐方法接口—名称固定且 API 类型公开', () => {
    expect(Object.values(STORYBOARD_IPC_CHANNELS).sort()).toEqual([
      'storyboard.copyShot',
      'storyboard.deleteShot',
      'storyboard.editShot',
      'storyboard.exportEpisode',
      'storyboard.lockShot',
      'storyboard.mergeShots',
      'storyboard.reorderShots',
      'storyboard.restoreShot',
      'storyboard.splitShot',
      'storyboard.unlockShot',
    ]);
    expectTypeOf<StoryboardApi>().toBeObject();
  });

  it('编辑命令—完整文档与基线版本合法—strict 契约拒绝伪造系统字段', () => {
    const input = {
      document: {
        acceptance: { must_include: [] },
        content: { spoken_text: '改后台词' },
        narrative_purpose: '改写后的叙事目的',
        target_duration_sec: 12,
      },
      episodeId,
      expectedVersionId: versionId,
      projectId,
      requestId: 'request-123',
      shotId,
      shotVersionId,
    };
    expect(storyboardEditShotInputSchema.safeParse(input).success).toBe(true);
    // 系统字段不可由渲染层伪造：strict 契约拒绝未知键。
    expect(storyboardEditShotInputSchema.safeParse({ ...input, status: 'READY' }).success).toBe(
      false,
    );
    expect(
      storyboardEditShotInputSchema.safeParse({ ...input, schemaVersion: '1.1.0' }).success,
    ).toBe(false);
    // document 必须是对象；基线镜头版本缺失拒绝。
    expect(
      storyboardEditShotInputSchema.safeParse({ ...input, document: 'json-string' }).success,
    ).toBe(false);
    const { shotVersionId: _omit, ...withoutBaseline } = input;
    expect(storyboardEditShotInputSchema.safeParse(withoutBaseline).success).toBe(false);
  });

  it('锁定/解锁命令—指针粗校验与备注边界—空指针与伪造字段拒绝', () => {
    const lock = {
      episodeId,
      expectedVersionId: versionId,
      jsonPointer: '/dialogue',
      note: '台词定稿',
      projectId,
      requestId: 'request-123',
      shotId,
    };
    expect(storyboardLockShotInputSchema.safeParse(lock).success).toBe(true);
    expect(storyboardLockShotInputSchema.safeParse({ ...lock, note: null }).success).toBe(true);
    const { note: _omit, ...withoutNote } = lock;
    expect(storyboardLockShotInputSchema.safeParse(withoutNote).success).toBe(false);
    // 指针必须以 / 开头（RFC 6901 形态）；完整语义（转义/白名单/可解析）由服务层判定。
    expect(storyboardLockShotInputSchema.safeParse({ ...lock, jsonPointer: '' }).success).toBe(
      false,
    );
    expect(
      storyboardLockShotInputSchema.safeParse({ ...lock, jsonPointer: 'dialogue' }).success,
    ).toBe(false);
    expect(
      storyboardLockShotInputSchema.safeParse({ ...lock, note: 'x'.repeat(201) }).success,
    ).toBe(false);

    const unlock = {
      episodeId,
      expectedVersionId: versionId,
      jsonPointer: '/dialogue',
      projectId,
      requestId: 'request-123',
      shotId,
    };
    expect(storyboardUnlockShotInputSchema.safeParse(unlock).success).toBe(true);
    expect(storyboardUnlockShotInputSchema.safeParse({ ...unlock, note: 'forged' }).success).toBe(
      false,
    );
    expect(storyboardUnlockShotInputSchema.safeParse({ ...unlock, lockedBy: 'USER' }).success).toBe(
      false,
    );
  });

  it('命令输出—整集摘要 + 有效锁投影—完整正例通过，锁投影越界或跨集摘要拒绝', () => {
    const episode = {
      createdAt: '2026-08-20T00:00:00.000Z',
      episodeId,
      formatProfileId: 'format_12345678',
      id: versionId,
      parentId: null,
      shotCount: 2,
      shotSetHash: 'b'.repeat(64),
      status: 'DRAFT',
      storyBibleVersionId: 'bible_1234567',
      targetDurationSec: 30,
      versionNo: 2,
    };
    const summary = {
      episode,
      lockedPaths: ['/dialogue', '/content/spoken_text'],
      shotVersionId,
    };
    expect(shotEditLockSummarySchema.safeParse(summary).success).toBe(true);
    // 锁投影每项仍须为指针形态；debug 字段不得进入输出。
    expect(
      shotEditLockSummarySchema.safeParse({ ...summary, lockedPaths: ['', '/dialogue'] }).success,
    ).toBe(false);
    expect(shotEditLockSummarySchema.safeParse({ ...summary, lockRecords: [] }).success).toBe(
      false,
    );
    // 整集摘要沿用 storyboardVersionSummarySchema 形态：坏 hash 拒绝。
    expect(
      shotEditLockSummarySchema.safeParse({
        ...summary,
        episode: { ...episode, shotSetHash: 'not-a-hash' },
      }).success,
    ).toBe(false);
  });

  it('锁定错误形态—三个新稳定错误码属 ProjectErrorCode，fieldErrors 携带冲突路径且无调试字段', () => {
    for (const code of ['SHOT_EDIT_NO_CHANGE', 'SHOT_LOCK_CONFLICT', 'SHOT_LOCK_POINTER_INVALID']) {
      expect(projectErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(
      appErrorSchema.safeParse({
        code: 'SHOT_LOCK_CONFLICT',
        fieldErrors: { lockedPaths: '/dialogue' },
        message: '编辑路径已被锁定。',
        retryable: false,
        traceId: 'trace-1234',
        userAction: '先解锁相关字段，再重新应用修改。',
      }).success,
    ).toBe(true);
    // 调试字段不能进入错误输出。
    const withDebug = {
      code: 'SHOT_LOCK_POINTER_INVALID',
      fieldErrors: null,
      message: '锁定路径不可用。',
      retryable: false,
      traceId: 'trace-1234',
      userAction: '从七类创意字段的合法路径中选择后重试。',
      documentSnapshot: '{}',
    };
    expect(appErrorSchema.safeParse(withDebug).success).toBe(false);
  });

  it('导出命令—D5 确认字段可选—strict 契约拒绝路径等伪造字段', () => {
    const input = {
      episodeId,
      expectedVersionId: versionId,
      projectId,
      requestId: 'request-123',
    };
    expect(storyboardExportEpisodeInputSchema.safeParse(input).success).toBe(true);
    // D5 越带重发形态：warnConfirmed + deviationReason；reason 非空语义由服务层判定。
    expect(
      storyboardExportEpisodeInputSchema.safeParse({
        ...input,
        deviationReason: '节奏偏快的快闪风格',
        warnConfirmed: true,
      }).success,
    ).toBe(true);
    expect(
      storyboardExportEpisodeInputSchema.safeParse({ ...input, deviationReason: null }).success,
    ).toBe(true);
    // 路径红线从入参源头收口：输出路径/文件名字段不可进入命令。
    expect(
      storyboardExportEpisodeInputSchema.safeParse({ ...input, filePath: 'C:/x.json' }).success,
    ).toBe(false);
    expect(
      storyboardExportEpisodeInputSchema.safeParse({ ...input, fileName: 'x.json' }).success,
    ).toBe(false);
    expect(
      storyboardExportEpisodeInputSchema.safeParse({ ...input, deviationReason: 'x'.repeat(281) })
        .success,
    ).toBe(false);
  });

  it('导出命令—format 三值枚举缺省回填 EPISODE_JSON—非法形态拒绝（deliverables D1）', () => {
    const input = {
      episodeId,
      expectedVersionId: versionId,
      projectId,
      requestId: 'request-123',
    };
    // 缺省兼容：旧调用不带 format 解析后回填 EPISODE_JSON。
    const defaulted = storyboardExportEpisodeInputSchema.parse(input);
    expect(defaulted.format).toBe('EPISODE_JSON');
    for (const format of ['MARKDOWN_TABLE', 'PRODUCIBILITY_REPORT']) {
      expect(storyboardExportEpisodeInputSchema.safeParse({ ...input, format }).success).toBe(true);
    }
    // 枚举外值与伪造交付物字段拒绝（Markdown/报告是服务端派生文本，不由入参指定）。
    expect(
      storyboardExportEpisodeInputSchema.safeParse({ ...input, format: 'WORD_DOC' }).success,
    ).toBe(false);
    expect(storyboardExportEpisodeInputSchema.safeParse({ ...input, format: null }).success).toBe(
      false,
    );
  });

  it('导出回执—哈希与计数且无路径字段—坏哈希/路径字段拒绝', () => {
    const result = {
      byteSize: 20480,
      episodeVersionId: versionId,
      exportId: 'export_0198f7a4-7b0e-7c3a-9c8a-3a4b5c6d7e8f',
      fileSha256: 'a'.repeat(64),
      totalDurationSec: 90,
    };
    expect(storyboardExportResultSchema.safeParse(result).success).toBe(true);
    expect(
      storyboardExportResultSchema.safeParse({ ...result, fileSha256: 'NOT_HEX' }).success,
    ).toBe(false);
    expect(storyboardExportResultSchema.safeParse({ ...result, byteSize: -1 }).success).toBe(false);
    // 路径红线：回执携带任何路径字段即拒绝。
    expect(
      storyboardExportResultSchema.safeParse({ ...result, filePath: 'C:/export.json' }).success,
    ).toBe(false);
  });

  it('导出错误形态—七个稳定错误码属 ProjectErrorCode，偏离错误携带实际 Σ', () => {
    for (const code of [
      'EXPORT_NOT_READY',
      'EXPORT_COLLECTION_INVALID',
      'EXPORT_SCHEMA_INVALID',
      'EXPORT_DURATION_DEVIATION',
      'EXPORT_CANCELLED',
      'EXPORT_FILE_WRITE_FAILED',
      'EXPORT_AUDIT_FAILED',
    ]) {
      expect(projectErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(
      appErrorSchema.safeParse({
        code: 'EXPORT_DURATION_DEVIATION',
        fieldErrors: { totalDurationSec: '48' },
        message: '整集时长 48 秒偏离 60–120 秒目标区间。',
        retryable: false,
        traceId: 'trace-1234',
        userAction: '确认偏离并填写原因后重发导出。',
      }).success,
    ).toBe(true);
  });
});
