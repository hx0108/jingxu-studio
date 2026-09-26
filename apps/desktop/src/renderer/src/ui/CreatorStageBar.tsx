import { useState } from 'react';

export type CreatorStage = 'story' | 'script' | 'storyboard' | 'image' | 'video' | 'composition';

const STAGES: readonly [CreatorStage, string][] = [
  ['story', '故事构思'],
  ['script', '剧本完善'],
  ['storyboard', '分镜设计'],
  ['image', '画面生成'],
  ['video', '视频生成'],
  ['composition', '合成导出'],
];

export interface CreatorStageBarProps {
  readonly activeStage: CreatorStage;
  readonly projectName: string;
  readonly workType: '漫剧' | '短剧';
  readonly onBack: () => void;
  readonly onSelect: (stage: CreatorStage) => void;
  readonly onOpenHistory: () => void;
  readonly onOpenProjectSettings: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenEvaluation: () => void;
}

export const CreatorStageBar = ({
  activeStage,
  projectName,
  workType,
  onBack,
  onSelect,
  onOpenHistory,
  onOpenProjectSettings,
  onOpenSettings,
  onOpenEvaluation,
}: CreatorStageBarProps) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const activeIndex = STAGES.findIndex(([stage]) => stage === activeStage);

  return (
    <header className="creator-stage-bar">
      <div className="creator-project-context">
        <span aria-label="镜序" className="creator-stage-brand">
          镜序
        </span>
        <button className="creator-back-button" onClick={onBack} type="button">
          返回作品
        </button>
        <strong>《{projectName}》</strong>
        <span>{workType}</span>
      </div>
      <nav aria-label="六步创作流程" className="creator-stage-progress">
        {STAGES.map(([stage, label], index) => (
          <button
            aria-current={stage === activeStage ? 'step' : undefined}
            className={stage === activeStage ? 'active' : index < activeIndex ? 'done' : ''}
            key={stage}
            onClick={() => {
              onSelect(stage);
            }}
            type="button"
          >
            <span>{String(index + 1)}</span>
            <strong>{label}</strong>
          </button>
        ))}
      </nav>
      <div className="creator-more-wrap">
        <button
          aria-expanded={moreOpen}
          className="creator-more-button"
          onClick={() => {
            setMoreOpen((open) => !open);
          }}
          type="button"
        >
          更多
        </button>
        {moreOpen && (
          <div className="creator-more-menu" role="menu">
            <button
              onClick={() => {
                setMoreOpen(false);
                onOpenHistory();
              }}
              role="menuitem"
              type="button"
            >
              版本管理
            </button>
            <button
              onClick={() => {
                setMoreOpen(false);
                onOpenProjectSettings();
              }}
              role="menuitem"
              type="button"
            >
              作品设定
            </button>
            <button
              onClick={() => {
                setMoreOpen(false);
                onOpenSettings();
              }}
              role="menuitem"
              type="button"
            >
              设置
            </button>
            <button
              disabled
              role="menuitem"
              title="独立任务中心尚未实现；当前任务状态可在对应创作阶段查看"
              type="button"
            >
              生成任务（暂不可用）
            </button>
            <button
              onClick={() => {
                setMoreOpen(false);
                onOpenEvaluation();
              }}
              role="menuitem"
              type="button"
            >
              质量操作
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
