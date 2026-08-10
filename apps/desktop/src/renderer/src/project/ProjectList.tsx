import type { ProjectListScope, ProjectSummaryDto } from '@jingxu/contracts';

export interface ProjectListViewProps {
  readonly state: 'loading' | 'error' | 'ready';
  readonly projects?: readonly ProjectSummaryDto[];
  readonly scope?: ProjectListScope;
  readonly hasFilter?: boolean;
  readonly hasMore: boolean;
  readonly loadingMore?: boolean;
  readonly errorMessage?: string | undefined;
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
      <ul className="project-grid">
        {projects.map((project) => (
          <li className="project-card" key={project.id}>
            <button
              className="project-card-main"
              onClick={() => {
                onOpen(project);
              }}
              type="button"
            >
              <strong>{project.name}</strong>
              <span>
                {project.aspectRatio} · {project.dialogueRenderMode}
              </span>
              <small>更新于 {new Date(project.updatedAt).toLocaleString('zh-CN')}</small>
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
        ))}
      </ul>
      {(hasMore || loadingMore) && (
        <button className="load-more" disabled={loadingMore} onClick={onLoadMore} type="button">
          {loadingMore ? '正在加载更多…' : '加载更多项目'}
        </button>
      )}
    </section>
  );
};
