import type { CreatorNextActionResultDto } from '@jingxu/contracts';

export interface CreatorHomeProps {
  readonly action: CreatorNextActionResultDto | null;
  readonly error: string | null;
  readonly onContinue: () => void;
  readonly onCreate: () => void;
  readonly onRetry: () => void;
  readonly pending: boolean;
  readonly showStartChoice: boolean;
}

export const CreatorHome = ({
  action,
  error,
  onContinue,
  onCreate,
  onRetry,
  pending,
  showStartChoice,
}: CreatorHomeProps) => (
  <section className="home-dashboard">
    <div className="hero-card creator-home-hero">
      <div>
        <p className="eyebrow">本集制作</p>
        <h2>{action?.title ?? '从一个故事开始你的 AI 漫剧'}</h2>
        <p>{action?.reason ?? '镜序会根据作品进度，直接带你到当前需要完成的一步。'}</p>
      </div>
      <button data-primary-action disabled={pending} onClick={onContinue} type="button">
        {pending ? '正在确认当前进度…' : '继续制作本集'}
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
          <p>可以创建自己的作品；5 分钟示例将在下一步接入。</p>
        </div>
        <div className="start-choice-actions">
          <button data-primary-action onClick={onCreate} type="button">
            创建我的作品
          </button>
          <button disabled title="演示项目正在接入" type="button">
            5 分钟体验（即将可用）
          </button>
        </div>
      </section>
    )}
    <div className="home-card-grid" aria-label="本集制作流程">
      <article>
        <span>01</span>
        <h3>讲清故事</h3>
        <p>从创意到场景剧本，按步确认。</p>
      </article>
      <article>
        <span>02</span>
        <h3>设计镜头</h3>
        <p>生成整集分镜，再聚焦需要调整的镜头。</p>
      </article>
      <article>
        <span>03</span>
        <h3>完成成片</h3>
        <p>准备画面、视频和配音，最后检查导出。</p>
      </article>
    </div>
  </section>
);
