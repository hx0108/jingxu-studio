import { describe, expect, it } from 'vitest';

import type { ProjectErrorCode } from '@jingxu/contracts';
import { describeProjectError } from './project-error';

describe('时间线稳定错误中文映射', () => {
  it.each([
    ['VIDEO_TIMELINE_CLIP_LIMIT', '片段数量已达上限'],
    ['VIDEO_TIMELINE_CLIP_DUPLICATE', '片段身份或顺序重复'],
    ['VIDEO_TIMELINE_CLIP_NOT_FOUND', '找不到这个时间线片段'],
    ['VIDEO_TIMELINE_EMPTY', '画面轨为空'],
    ['VIDEO_TIMELINE_OVERLAP', '画面片段发生重叠'],
    ['VIDEO_TIMELINE_START_INVALID', '片段起点无效'],
    ['VIDEO_AUDIO_FADE_INVALID', '配乐淡入淡出时长无效'],
  ] satisfies readonly (readonly [ProjectErrorCode, string])[])(
    '%s 只展示中文摘要和可执行下一步',
    (code, summary) => {
      const view = describeProjectError({
        code,
        fieldErrors: null,
        message: '内部错误不得直接展示',
        retryable: false,
        traceId: 'trace_12345678',
        userAction: null,
      });
      expect(view.summary).toBe(summary);
      expect(view.nextAction.length).toBeGreaterThan(0);
      expect(JSON.stringify(view)).not.toContain('内部错误');
    },
  );
});
