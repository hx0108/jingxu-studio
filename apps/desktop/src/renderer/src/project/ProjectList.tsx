import type { ProjectListScope, ProjectSummaryDto } from '@jingxu/contracts';

import { PROTOTYPE_ASSETS, prototypeAssetAt } from '../assets/prototype/prototype-assets';

const DIALOGUE_MODE_LABELS: Readonly<Record<ProjectSummaryDto['dialogueRenderMode'], string>> = {
  NARRATION_FIRST: '旁白优先',
  PRECISE_LIP_SYNC: '精确口型',
  SUBTITLE_ONLY: '仅字幕',
  WEAK_LIP_SYNC: '弱口型',
};

const ASPECT_RATIO_LABELS: Readonly<Record<ProjectSummaryDto['aspectRatio'], string>> = {
  '16:9': '横屏',
  '9:16': '竖屏',
};

export interface ProjectListViewProps {
  readonly state: 'loading' | 'error' | 'ready';
  readonly projects?: readonly ProjectSummaryDto[];
  readonly scope?: ProjectListScope;
  readonly hasFilter?: boolean;
  readonly hasMore: boolean;
  readonly loadingMore?: boolean;
  readonly errorMessage?: string | undefined;
  readonly progressByProjectId?: Readonly<
    Record<string, { readonly percent: number | null; readonly stageLabel: string }>
  >;
  readonly onCreate: () => void;
  readonly onOpen: (project: ProjectSummaryDto) => void;
  readonly onRestore: (project: ProjectSummaryDto) => void;
  readonly onLoadMore: () => void;
}

export const ProjectListView = ({
  state,
  projects = [],
  scope = 'ACTIVE',
  hasFilter = false,
  hasMore,
  loadingMore = false,
  errorMessage,
  progressByProjectId = {},
  onCreate,
  onOpen,
  onRestore,
  onLoadMore,
}: ProjectListViewProps) => {
  if (state === 'loading') return <p aria-live="polite">正在加载项目…</p>;
  if (state === 'error') {
    return (
      <section className="notice error-notice" role="alert">
        <h2>项目列表暂不可用</h2>
        <p>{errorMessage ?? '加载失败，请重试'}</p>
      </section>
    );
  }
  if (projects.length === 0 && hasFilter) {
    return (
      <section className="notice" aria-live="polite">
        <h2>没有匹配的项目</h2>
        <p>尝试缩短关键词或清除筛选；项目数据没有被删除。</p>
      </section>
    );
  }
  if (projects.length === 0) {
    return (
      <section className="notice empty-notice">
        <h2>{scope === 'DELETED' ? '回收站为空' : '从第一个故事开始'}</h2>
        <p>{scope === 'DELETED' ? '软删除的项目会出现在这里。' : '创建项目并固定首个创作设定。'}</p>
        {scope === 'ACTIVE' && (
          <button data-primary-action onClick={onCreate} type="button">
            创建第一个项目
          </button>
        )}
      </section>
    );
  }
  return (
    <section aria-label={scope === 'DELETED' ? '回收站项目' : '活动项目'}>
      <div aria-hidden="true" className="project-list-head">
        <span>作品</span>
        <span>类型</span>
        <span>当前阶段</span>
        <span>完成进度</span>
        <span>最近编辑时间</span>
        <span>操作</span>
      </div>
      <ul className="project-grid">
        {projects.map((project, index) => {
          const progress = progressByProjectId[project.id];
          return (
            <li className="project-card" key={project.id}>
              <button
                className="project-card-main"
                onClick={() => {
                  onOpen(project);
                }}
                type="button"
              >
                <img
                  alt=""
                  aria-hidden="true"
                  className="project-card-cover"
                  src={prototypeAssetAt(PROTOTYPE_ASSETS.projects, index)}
                />
                <span className="project-card-copy">
                  <strong>《{project.name}》</strong>
                  <small>继续你的故事创作</small>
                </span>
                <span className="project-card-spec">
                  <strong>{project.style === '漫剧' ? '漫剧' : '短剧'}</strong>
                  <small>
                    {ASPECT_RATIO_LABELS[project.aspectRatio]} ·{' '}
                    {DIALOGUE_MODE_LABELS[project.dialogueRenderMode]}
                  </small>
                </span>
                <span className="project-card-stage">
                  {progress?.stageLabel ?? '正在读取阶段…'}
                </span>
                <span className="project-card-progress">
                  {progress?.percent === null || progress === undefined ? (
                    <small>暂不可用</small>
                  ) : (
                    <>
                      <strong>{String(progress.percent)}%</strong>
                      <progress max={100} value={progress.percent} />
                    </>
                  )}
                </span>
                <time dateTime={project.updatedAt}>
                  {new Date(project.updatedAt).toLocaleString('zh-CN')}
                </time>
                <span className="project-card-action">继续创作</span>
              </button>
              {scope === 'DELETED' && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    onRestore(project);
                  }}
                  type="button"
                >
                  恢复项目
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {(hasMore || loadingMore) && (
        <button className="load-more" disabled={loadingMore} onClick={onLoadMore} type="button">
          {loadingMore ? '正在加载更多…' : '加载更多项目'}
        </button>
      )}
    </section>
  );
};
