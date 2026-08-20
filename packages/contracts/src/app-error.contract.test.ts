import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { appErrorSchema, appResultSchema, projectErrorCodeSchema } from './index';

describe('AppError / AppResult Contract', () => {
  describe('projectErrorCodeSchema—全部业务错误码', () => {
    it('登记错误码均接受（Project 13 + Job/Provider 9）', () => {
      const codes = [
        'PROJECT_NOT_FOUND',
        'PROJECT_NAME_CONFLICT',
        'PROJECT_DIRECTORY_UNAVAILABLE',
        'PROJECT_VERSION_CONFLICT',
        'PROJECT_ALREADY_DELETED',
        'PROJECT_NOT_DELETED',
        'FORMAT_PROFILE_INVALID',
        'FORMAT_PROFILE_DEPENDENCY_BLOCKED',
        'REQUEST_ID_REUSED',
        'STARTUP_WRITE_BLOCKED',
        'IPC_INVALID_REQUEST',
        'IPC_SENDER_NOT_ALLOWED',
        'PROJECT_PERSISTENCE_FAILED',
        'JOB_NOT_FOUND',
        'JOB_VERSION_CONFLICT',
        'JOB_NOT_CANCELLABLE',
        'JOB_PERSISTENCE_FAILED',
        'JOB_SUBMISSION_UNAVAILABLE',
        'PROVIDER_PROFILE_NOT_FOUND',
        'PROVIDER_CREDENTIAL_MISSING',
        'PROVIDER_CREDENTIAL_UNAVAILABLE',
        'PROVIDER_CALL_FAILED',
        'MEDIA_FIRST_FRAME_NOT_SELECTED',
      ];
      for (const code of codes) {
        expect(projectErrorCodeSchema.parse(code)).toBe(code);
      }
    });

    it('未登记 code—拒绝', () => {
      expect(() => projectErrorCodeSchema.parse('UNKNOWN_ERROR')).toThrow();
    });
  });

  describe('appErrorSchema—脱敏与稳定性', () => {
    const baseError = () => ({
      code: 'PROJECT_NAME_CONFLICT' as const,
      fieldErrors: { name: '名称冲突' },
      message: '项目名称已被占用，请更换后重试。',
      retryable: true,
      traceId: 'trc_abc12345',
      userAction: 'CHANGE_NAME',
    });

    it('合法错误含 fieldErrors—解析通过并回等', () => {
      const e = baseError();
      expect(appErrorSchema.parse(e)).toEqual(e);
    });

    it('userAction/fieldErrors 为 null—接受', () => {
      const e = { ...baseError(), fieldErrors: null, userAction: null };
      expect(appErrorSchema.parse(e)).toEqual(e);
    });

    it('错误携带 SQL—严格拒绝', () => {
      expect(() =>
        appErrorSchema.parse({ ...baseError(), sql: 'SELECT * FROM projects' }),
      ).toThrow();
    });
    it('错误携带堆栈—严格拒绝', () => {
      expect(() =>
        appErrorSchema.parse({ ...baseError(), stack: 'at Object.<anonymous>' }),
      ).toThrow();
    });
    it('错误携带绝对路径—严格拒绝', () => {
      expect(() =>
        appErrorSchema.parse({ ...baseError(), path: 'C:\\Users\\proj\\db.sqlite' }),
      ).toThrow();
    });
    it('错误携带项目名—严格拒绝（不泄漏用户内容）', () => {
      expect(() => appErrorSchema.parse({ ...baseError(), projectName: '我的项目' })).toThrow();
    });
  });

  describe('appResultSchema—判别联合', () => {
    const dataSchema = z.object({ revision: z.number() });
    const okData = { revision: 1 };
    const errorPayload = {
      code: 'PROJECT_NOT_FOUND',
      fieldErrors: null,
      message: '未找到项目。',
      retryable: false,
      traceId: 'trc_x',
      userAction: null,
    };

    it('ok:true + data—解析为成功分支', () => {
      expect(appResultSchema(dataSchema).parse({ ok: true, data: okData })).toEqual({
        ok: true,
        data: okData,
      });
    });

    it('ok:false + error—解析为失败分支', () => {
      expect(appResultSchema(dataSchema).parse({ ok: false, error: errorPayload })).toEqual({
        ok: false,
        error: errorPayload,
      });
    });

    it('ok 分支携带多余字段—严格拒绝', () => {
      expect(() =>
        appResultSchema(dataSchema).parse({ ok: true, data: okData, leaked: 'x' }),
      ).toThrow();
    });
  });
});
