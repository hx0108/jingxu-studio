import { useState } from 'react';

import type { CreatorNextActionResultDto } from '@jingxu/contracts';

import comicImage from '../assets/prototype/home-comic.webp';
import dramaImage from '../assets/prototype/home-drama.webp';
import continueImage from '../assets/prototype/continue-drama.webp';

export interface CreatorHomeProps {
  readonly action: CreatorNextActionResultDto | null;
  readonly demoPending: boolean;
  readonly error: string | null;
  readonly onContinue: () => void;
  readonly onCreate: () => void;
  readonly onSelectType?: ((type: '漫剧' | '短剧') => void) | undefined;
  readonly onDemo: () => void;
  readonly onRetry: () => void;
  readonly pending: boolean;
  readonly projectName?: string | null | undefined;
  readonly showStartChoice: boolean;
}

export const CreatorHome = ({
  action,
  demoPending,
  error,
  onContinue,
  onCreate,
  onSelectType,
  onDemo,
  onRetry,
  pending,
  projectName,
  showStartChoice,
}: CreatorHomeProps) => {
  const [selectedType, setSelectedType] = useState<'漫剧' | '短剧'>('短剧');
  const chooseType = (type: '漫剧' | '短剧'): void => {
    setSelectedType(type);
    onSelectType?.(type);
  };
  return (
    <section className="home-dashboard prototype-home">
      <div className="prototype-home-title">
        <p className="eyebrow">镜序创作工作台</p>
        <h1>
          把一个想法，变成一部<span>好故事</span>
        </h1>
        <p>选择作品形式，我们会用对应的节奏、画面与质量检查陪你完成创作。</p>
      </div>
      <div aria-label="选择作品形式" className="prototype-type-choice">
        <button
          aria-pressed={selectedType === '漫剧'}
          className={`prototype-type-card ${selectedType === '漫剧' ? 'selected' : ''}`}
          onClick={() => {
            chooseType('漫剧');
          }}
          type="button"
        >
          <img alt="动漫风格女孩在列车窗边" src={comicImage} />
          <span className="prototype-type-copy">
            <span aria-hidden="true" className="prototype-radio-mark" />
            <strong>AI漫剧</strong>
            <span>用连续画面、角色对白和镜头节奏，呈现富有想象力的故事。</span>
          </span>
        </button>
        <button
          aria-pressed={selectedType === '短剧'}
          className={`prototype-type-card ${selectedType === '短剧' ? 'selected' : ''}`}
          onClick={() => {
            chooseType('短剧');
          }}
          type="button"
        >
          <img alt="真人风格女孩在列车窗边" src={dramaImage} />
          <span className="prototype-type-copy">
            <span aria-hidden="true" className="prototype-radio-mark" />
            <strong>AI短剧</strong>
            <span>以真人表演逻辑和镜头连续性，快速完成一集短剧。</span>
          </span>
        </button>
      </div>
      <div className="prototype-home-actions">
        <button
          data-primary-action={showStartChoice ? undefined : ''}
          disabled={pending}
          onClick={action?.projectId ? onCreate : onContinue}
          type="button"
        >
          {pending ? '正在确认当前进度…' : '开始创作'}
        </button>
        <button className="secondary-button" onClick={onCreate} type="button">
          导入已有故事
        </button>
      </div>
      {error !== null && (
        <section className="notice error-notice" role="alert">
          <h3>暂时无法确认下一步</h3>
          <p>{error}</p>
          <button className="secondary-button" onClick={onRetry} type="button">
            重新检查
          </button>
        </section>
      )}
      {showStartChoice && (
        <section aria-labelledby="start-choice-title" className="start-choice-panel" role="dialog">
          <div>
            <p className="eyebrow">选择开始方式</p>
            <h3 id="start-choice-title">你想怎样开始？</h3>
            <p>可以先体验完整流程，也可以直接创建自己的作品。</p>
          </div>
          <div className="start-choice-actions">
            <button onClick={onCreate} type="button">
              创建我的作品
            </button>
            <button
              data-primary-action
              disabled={demoPending || pending}
              onClick={onDemo}
              type="button"
            >
              {demoPending ? '正在准备示例…' : '5 分钟体验（免配置·零费用）'}
            </button>
          </div>
        </section>
      )}
      {action?.projectId && (
        <article className="prototype-continue-panel">
          <img alt="作品画面" src={continueImage} />
          <div>
            <p className="eyebrow">继续创作</p>
            <h2>{projectName ?? '当前作品'}</h2>
            <p>当前任务：{action.title}</p>
          </div>
          <button disabled={pending} onClick={onContinue} type="button">
            继续
          </button>
        </article>
      )}
      {!action?.projectId && (
        <article className="prototype-continue-panel">
          <img alt="午后列车演示画面" src={continueImage} />
          <div>
            <p className="eyebrow">体验示例</p>
            <h2>《午后列车》</h2>
            <p>内置演示作品 · 可体验创作流程，不产生真实费用</p>
          </div>
          <button disabled={demoPending || pending} onClick={onDemo} type="button">
            {demoPending ? '正在准备…' : '体验'}
          </button>
        </article>
      )}
      <div aria-label="创作流程" className="prototype-route-line">
        <div>
          <span>1</span>
          <strong>写故事</strong>
          <small>从想法到完整剧本</small>
        </div>
        <div>
          <span>2</span>
          <strong>做分镜</strong>
          <small>把故事变成镜头</small>
        </div>
        <div>
          <span>3</span>
          <strong>出成片</strong>
          <small>生成、合成并导出</small>
        </div>
      </div>
    </section>
  );
};
