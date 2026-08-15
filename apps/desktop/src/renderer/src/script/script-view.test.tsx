import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  StoryboardShotSummaryDto,
  StoryboardVersionSummaryDto,
  StoryboardWorkspaceDto,
} from '@jingxu/contracts';

import { OriginalInput } from './OriginalInput';
import { ProviderSettings } from './ProviderSettings';
import { StoryboardPanel } from './StoryboardPanel';

describe('Staged Script Renderer 可观察基线', () => {
  it('原创初始化—显示字符边界、数据处理确认与明确非目标', () => {
    const html = renderToStaticMarkup(
      <OriginalInput
        onDirtyChange={vi.fn()}
        onInitialized={vi.fn()}
        projectId="project_12345678"
      />,
    );
    expect(html).toContain('0/2,000 个 Unicode 字符');
    expect(html).toContain('最少 20 个');
    expect(html).toContain('第三方 Qwen Provider');
    expect(html).toContain('文件导入、授权改编和 AI 优化尚未开放');
    expect(html).toContain('disabled=""');
  });

  it('Provider 设置—首次加载不回显 Key 或伪装已验证', () => {
    const html = renderToStaticMarkup(<ProviderSettings onReadyChange={vi.fn()} />);
    expect(html).toContain('正在加载 Qwen 设置');
    expect(html).not.toContain('sk-');
    expect(html).not.toContain('已验证');
  });
});

const storyboardVersion = (overrides: {
  readonly id: string;
  readonly shotCount: number;
  readonly status: StoryboardVersionSummaryDto['status'];
  readonly versionNo: number;
}): StoryboardVersionSummaryDto => ({
  createdAt: '2026-08-14T00:00:00.000Z',
  episodeId: 'episode_12345678',
  formatProfileId: 'format_12345678',
  id: overrides.id,
  parentId: null,
  shotCount: overrides.shotCount,
  shotSetHash: 'b'.repeat(64),
  status: overrides.status,
  storyBibleVersionId: 'version_12345678',
  targetDurationSec: 90,
  versionNo: overrides.versionNo,
});

const shotSummary = (overrides: {
  readonly narrativePurpose: string;
  readonly sequence: number;
  readonly shotId: string;
  readonly targetDurationSec: number;
}): StoryboardShotSummaryDto => ({
  cameraMotion: overrides.sequence === 1 ? 'STATIC' : 'PAN',
  dialogueRenderMode: overrides.sequence === 1 ? 'NARRATION_FIRST' : 'SUBTITLE_ONLY',
  narrativePurpose: overrides.narrativePurpose,
  sequence: overrides.sequence,
  shotId: overrides.shotId,
  shotSize: overrides.sequence === 1 ? 'EXTREME_LONG' : 'CLOSE_UP',
  targetDurationSec: overrides.targetDurationSec,
  versionId: `shotver_00${String(overrides.sequence)}`,
});

describe('Storyboard Panel 可观察基线（shot-contract-generation §5.4）', () => {
  it('存在 DRAFT 整集与镜头集合—展示徽标、卡片、时长汇总与默认详情，只读声明可见', () => {
    const storyboard: StoryboardWorkspaceDto = {
      current: storyboardVersion({
        id: 'episodever_0001',
        shotCount: 2,
        status: 'DRAFT',
        versionNo: 2,
      }),
      history: [
        storyboardVersion({ id: 'episodever_0002', shotCount: 2, status: 'READY', versionNo: 1 }),
      ],
      shots: [
        shotSummary({
          narrativePurpose: '雨夜车厢大远景开场',
          sequence: 1,
          shotId: 'shot_00000001',
          targetDurationSec: 12,
        }),
        shotSummary({
          narrativePurpose: '林夜攥紧怀表起身',
          sequence: 2,
          shotId: 'shot_00000002',
          targetDurationSec: 8,
        }),
      ],
      totalDurationSec: 20,
    };
    const html = renderToStaticMarkup(
      <StoryboardPanel
        episodeTargetDurationSec={90}
        generateHint={null}
        job={null}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        storyboard={storyboard}
      />,
    );
    expect(html).toContain('分镜工作台');
    expect(html).toContain('● DRAFT');
    expect(html).toContain('合计 20s / 目标 90s');
    expect(html).toContain('2 个镜头');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('大远景');
    expect(html).toContain('固定');
    expect(html).toContain('横摇');
    expect(html).toContain('旁白优先');
    expect(html).toContain('仅字幕');
    // 默认详情：首个镜头的摘要字段全量展示（含枚举原码便于排障）。
    expect(html).toContain('镜头 #1 详情');
    expect(html).toContain('雨夜车厢大远景开场');
    expect(html).toContain('shot_00000001');
    expect(html).toContain('12s');
    expect(html).toContain('EXTREME_LONG');
    // 只读边界与历史恢复入口。
    expect(html).toContain('不支持编辑、拆分、合并、排序或删除');
    expect(html).toContain('v1 · READY · 2 个镜头');
    expect(html).toContain('恢复为新草稿');
    expect(html).not.toContain('disabled=""');
  });

  it('尚未生成分镜—空态提示、未生成徽标且无镜头卡片', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        episodeTargetDurationSec={90}
        generateHint="前置阶段尚未确认 READY：需先确认场景剧本。"
        job={null}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        storyboard={{ current: null, history: [], shots: [], totalDurationSec: 0 }}
      />,
    );
    expect(html).toContain('○ 未生成');
    expect(html).toContain('尚未生成分镜');
    expect(html).toContain('需先确认场景剧本');
    expect(html).toContain('生成整集分镜');
    expect(html).not.toContain('#1');
  });

  it('任务 FAILED（集合校验）—展示脱敏稳定文案，不出现明细或模型输出通道', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        episodeTargetDurationSec={90}
        generateHint={null}
        job={{
          errorCode: 'CONTRACT_VALIDATION_FAILED',
          id: 'job_00000001',
          projectId: 'project_12345678',
          status: 'FAILED',
          versionId: 'jobver_0000001',
        }}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        storyboard={{ current: null, history: [], shots: [], totalDurationSec: 0 }}
      />,
    );
    expect(html).toContain('任务状态：FAILED · CONTRACT_VALIDATION_FAILED');
    expect(html).toContain('结构或集合校验');
    // 脱敏红线：JSON Pointer 明细与模型原文永不进入 Renderer。
    expect(html).not.toContain('/shots/0');
    expect(html).not.toContain('details');
  });

  it('镜头总时长超出单集目标—汇总条越限告警可见', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        episodeTargetDurationSec={90}
        generateHint={null}
        job={null}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        storyboard={{
          current: storyboardVersion({
            id: 'episodever_0003',
            shotCount: 5,
            status: 'DRAFT',
            versionNo: 1,
          }),
          history: [],
          shots: [1, 2, 3, 4, 5].map((sequence) =>
            shotSummary({
              narrativePurpose: `超限镜头 ${String(sequence)}`,
              sequence,
              shotId: `shot_0000000${String(sequence)}`,
              targetDurationSec: 20,
            }),
          ),
          totalDurationSec: 100,
        }}
      />,
    );
    expect(html).toContain('合计 100s / 目标 90s');
    expect(html).toContain('已超过单集目标时长');
    expect(html).toContain('duration-over');
  });
});
