import { describe, expect, it } from 'vitest';

import {
  nextScriptStageLabel,
  workspaceStatusLabel,
  workspaceStatusTone,
} from './workspace-status';

describe('工作台中文状态策略', () => {
  it.each([
    ['DRAFT', '草稿'],
    ['READY', '已确认'],
    ['QUEUED', '排队中'],
    ['RUNNING', '生成中'],
    ['VALIDATING', '校验中'],
    ['SUCCEEDED', '已完成'],
    ['FAILED', '失败'],
    ['CANCELLED', '已取消'],
    ['STALE_INPUT', '输入已变化'],
    ['BLOCK', '必须处理'],
    ['WARN', '建议检查'],
  ])('%s 映射为 %s', (status, label) => {
    expect(workspaceStatusLabel(status)).toBe(label);
  });

  it('未知和空状态不直接泄露英文枚举', () => {
    expect(workspaceStatusLabel(null)).toBe('未开始');
    expect(workspaceStatusLabel('PROVIDER_SECRET_STATUS')).toBe('状态待确认');
  });

  it('阶段确认后给出确定的下一步', () => {
    expect(nextScriptStageLabel('CONCEPT')).toBe('故事圣经');
    expect(nextScriptStageLabel('SCENE_SCRIPT')).toBe('分镜设计');
  });

  it('状态色同时具有稳定语义名称', () => {
    expect(workspaceStatusTone('READY')).toBe('success');
    expect(workspaceStatusTone('RUNNING')).toBe('active');
    expect(workspaceStatusTone('STALE_INPUT')).toBe('warning');
    expect(workspaceStatusTone('FAILED')).toBe('danger');
  });
});
