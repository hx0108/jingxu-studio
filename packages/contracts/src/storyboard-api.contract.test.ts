import { describe, expect, expectTypeOf, it } from 'vitest';

import { appErrorSchema, projectErrorCodeSchema } from './app-result';
import {
  STORYBOARD_IPC_CHANNELS,
  shotEditLockSummarySchema,
  storyboardEditShotInputSchema,
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
  it('频道白名单—三个逐方法接口—名称固定且 API 类型公开，script.* 白名单不受影响', () => {
    expect(Object.values(STORYBOARD_IPC_CHANNELS).sort()).toEqual([
      'storyboard.editShot',
      'storyboard.lockShot',
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
});
