import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createProjectInputSchema,
  formatProfileSchema,
  PROJECT_IPC_CHANNELS,
  projectIdSchema,
  projectDetailSchema,
  projectListInputSchema,
  projectSummarySchema,
  type ProjectApi,
} from './index';

const projectId = 'prj_0123456789abcdef';
const formatProfileId = 'fp_0123456789abcdef';
const requestId = 'req_0123456789abcdef';
const isoTime = '2026-08-09T12:00:00+08:00';
const subtitleSafeArea = { bottom: 12, left: 5, right: 5, top: 5 };

const formatProfileFixture = () => ({
  aspectRatio: '9:16' as const,
  createdAt: isoTime,
  fps: 30,
  height: 1920,
  id: formatProfileId,
  isCurrent: true,
  language: 'zh-CN',
  parentId: null,
  projectId,
  subtitleSafeArea,
  versionNo: 1,
  width: 1080,
});

const summaryFixture = () => ({
  aspectRatio: '9:16' as const,
  creationMode: 'AI_ORIGINAL' as const,
  deletedAt: null,
  dialogueRenderMode: 'NARRATION_FIRST' as const,
  genre: null,
  id: projectId,
  name: '我的第一个漫剧',
  style: null,
  updatedAt: isoTime,
});

const detailFixture = () => ({
  createdAt: isoTime,
  creationMode: 'AI_ORIGINAL' as const,
  currentFormatProfile: formatProfileFixture(),
  deletedAt: null,
  deploymentMode: 'LOCAL_DEMO' as const,
  dialogueRenderMode: 'NARRATION_FIRST' as const,
  formatProfileHistory: [],
  genre: null,
  id: projectId,
  name: '我的第一个漫剧',
  style: null,
  updatedAt: isoTime,
});

describe('Project/FormatProfile DTO Contract', () => {
  describe('formatProfileSchema', () => {
    it('合法完整 FormatProfile—解析通过并回等', () => {
      const fp = formatProfileFixture();
      expect(formatProfileSchema.parse(fp)).toEqual(fp);
    });

    it('两种画幅—9:16 与 16:9 均接受，1:1 不在枚举', () => {
      expect(formatProfileSchema.parse(formatProfileFixture()).aspectRatio).toBe('9:16');
      const landscape = {
        ...formatProfileFixture(),
        aspectRatio: '16:9' as const,
        height: 1080,
        width: 1920,
      };
      expect(formatProfileSchema.parse(landscape).aspectRatio).toBe('16:9');
      expect(() =>
        formatProfileSchema.parse({ ...formatProfileFixture(), aspectRatio: '1:1' as never }),
      ).toThrow();
    });

    it('未知字段 dataRootRel—严格拒绝', () => {
      expect(() =>
        formatProfileSchema.parse({ ...formatProfileFixture(), dataRootRel: 'projects/x' }),
      ).toThrow();
    });
  });

  describe('projectSummarySchema / projectDetailSchema', () => {
    it('合法 Summary—解析通过', () => {
      const s = summaryFixture();
      expect(projectSummarySchema.parse(s)).toEqual(s);
    });

    it('合法 Detail 含 current + history—解析通过', () => {
      const d = detailFixture();
      expect(projectDetailSchema.parse(d)).toEqual(d);
    });

    it('Detail 携带绝对路径—严格拒绝', () => {
      expect(() =>
        projectDetailSchema.parse({ ...detailFixture(), absolutePath: 'C:\\Users\\proj' }),
      ).toThrow();
    });

    it('Summary 携带 SQL 内部字段—严格拒绝', () => {
      expect(() =>
        projectSummarySchema.parse({ ...summaryFixture(), sql: 'SELECT * FROM projects' }),
      ).toThrow();
    });
  });

  describe('ID 安全集—拒绝路径分隔符与 SQL 字符', () => {
    it('projectId 含 ../ 路径逃逸—拒绝', () => {
      expect(() => projectIdSchema.parse('prj_../etc')).toThrow();
    });
    it('projectId 含引号分号—拒绝', () => {
      expect(() => projectIdSchema.parse("prj';DROP--")).toThrow();
    });
    it('projectId 过短（<12）—拒绝', () => {
      expect(() => projectIdSchema.parse('short')).toThrow();
    });
  });

  describe('projectListInputSchema—limit/scope/cursor 边界', () => {
    const base = { cursor: null, limit: 50, scope: 'ACTIVE' as const, search: null };

    it('limit 边界 1 与 100—通过', () => {
      expect(projectListInputSchema.parse({ ...base, limit: 1 }).limit).toBe(1);
      expect(projectListInputSchema.parse({ ...base, limit: 100 }).limit).toBe(100);
    });
    it('limit 越界 0 与 101—拒绝', () => {
      expect(() => projectListInputSchema.parse({ ...base, limit: 0 })).toThrow();
      expect(() => projectListInputSchema.parse({ ...base, limit: 101 })).toThrow();
    });
    it('scope ACTIVE/DELETED—通过；ARCHIVED—拒绝', () => {
      expect(projectListInputSchema.parse({ ...base, scope: 'DELETED' as const }).scope).toBe(
        'DELETED',
      );
      expect(() => projectListInputSchema.parse({ ...base, scope: 'ARCHIVED' as const })).toThrow();
    });
    it('cursor 不透明字符串与 null—均通过', () => {
      expect(projectListInputSchema.parse({ ...base, cursor: 'eyJ2IjoxfQ' }).cursor).toBe(
        'eyJ2IjoxfQ',
      );
      expect(projectListInputSchema.parse({ ...base, cursor: null }).cursor).toBeNull();
    });
  });

  describe('createProjectInputSchema—四种对白模式 + 防伪造机器字段', () => {
    const baseCreate = {
      aspectRatio: '9:16' as const,
      creationMode: 'AI_ORIGINAL' as const,
      dialogueRenderMode: 'NARRATION_FIRST' as const,
      genre: null,
      name: '项目',
      requestId,
      style: null,
      subtitleSafeArea,
    };

    it('四种 DialogueRenderMode 均接受', () => {
      const modes = [
        'NARRATION_FIRST',
        'WEAK_LIP_SYNC',
        'PRECISE_LIP_SYNC',
        'SUBTITLE_ONLY',
      ] as const;
      for (const mode of modes) {
        expect(
          createProjectInputSchema.parse({ ...baseCreate, dialogueRenderMode: mode })
            .dialogueRenderMode,
        ).toBe(mode);
      }
    });
    it('伪造 width—严格拒绝', () => {
      expect(() => createProjectInputSchema.parse({ ...baseCreate, width: 9999 })).toThrow();
    });
    it('伪造 deploymentMode—严格拒绝', () => {
      expect(() =>
        createProjectInputSchema.parse({
          ...baseCreate,
          deploymentMode: 'CONTROLLED_EXTERNAL_TEST',
        }),
      ).toThrow();
    });
    it('伪造 dataRootRel—严格拒绝', () => {
      expect(() =>
        createProjectInputSchema.parse({ ...baseCreate, dataRootRel: 'projects/x' }),
      ).toThrow();
    });
  });

  describe('ProjectApi 类型—六个逐方法白名单', () => {
    it('ProjectApi—检查白名单—恰有 list/get/create/update/delete/restore', () => {
      expectTypeOf<ProjectApi>().toHaveProperty('list');
      expectTypeOf<ProjectApi>().toHaveProperty('get');
      expectTypeOf<ProjectApi>().toHaveProperty('create');
      expectTypeOf<ProjectApi>().toHaveProperty('update');
      expectTypeOf<ProjectApi>().toHaveProperty('delete');
      expectTypeOf<ProjectApi>().toHaveProperty('restore');
    });

    it('PROJECT_IPC_CHANNELS—六个固定 channel 名', () => {
      expect(PROJECT_IPC_CHANNELS).toEqual({
        create: 'project.create',
        delete: 'project.delete',
        get: 'project.get',
        list: 'project.list',
        restore: 'project.restore',
        update: 'project.update',
      });
    });
  });
});
