import { useState, type ReactNode } from 'react';

export type GlobalArea =
  'home' | 'projects' | 'workspace' | 'assets' | 'tasks' | 'exports' | 'evaluation' | 'settings';

export const MORE_AREAS: readonly [GlobalArea, string][] = [
  ['workspace', '创作工作台'],
  ['assets', '素材库'],
  ['tasks', '生成任务'],
  ['exports', '导出记录'],
];

export interface AppShellProps {
  readonly activeArea: GlobalArea;
  readonly children: ReactNode;
  readonly onNavigate: (area: GlobalArea) => void;
  readonly projectName?: string | null;
}

export const AppShell = ({ activeArea, children, onNavigate, projectName }: AppShellProps) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = (area: GlobalArea): void => {
    setMoreOpen(false);
    onNavigate(area);
  };
  return (
    <main className="app-shell" data-area={activeArea}>
      <header className="global-header">
        <button
          aria-label="返回镜序首页"
          className="brand-lockup"
          onClick={() => {
            navigate('home');
          }}
          type="button"
        >
          <span aria-hidden="true" className="brand-mark">
            镜
          </span>
          <span className="brand-copy">
            <strong>镜序</strong>
            <small>AI漫剧 / 短剧创作平台</small>
          </span>
        </button>
        <nav aria-label="全局导航" className="global-navigation">
          <button
            aria-current={activeArea === 'projects' ? 'page' : undefined}
            className="global-nav-item"
            onClick={() => {
              navigate('projects');
            }}
            type="button"
          >
            我的作品
          </button>
          <button
            aria-current={activeArea === 'evaluation' ? 'page' : undefined}
            className="global-nav-item"
            onClick={() => {
              navigate('evaluation');
            }}
            type="button"
          >
            质量评测
          </button>
          <button
            aria-current={activeArea === 'settings' ? 'page' : undefined}
            className="global-nav-item"
            onClick={() => {
              navigate('settings');
            }}
            type="button"
          >
            设置
          </button>
          <div className="global-more-wrap">
            <button
              aria-current={MORE_AREAS.some(([area]) => area === activeArea) ? 'page' : undefined}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className="global-nav-item"
              onClick={() => {
                setMoreOpen(!moreOpen);
              }}
              type="button"
            >
              更多
            </button>
            {moreOpen && (
              <div className="global-more-menu" role="menu">
                {MORE_AREAS.map(([area, label]) => (
                  <button
                    key={area}
                    onClick={() => {
                      navigate(area);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {label}
                  </button>
                ))}
                {projectName && <p>当前作品：{projectName}</p>}
              </div>
            )}
          </div>
        </nav>
      </header>
      <section aria-label="页面内容" className="app-content" tabIndex={0}>
        {children}
      </section>
    </main>
  );
};

export const ComingSoonPanel = ({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) => (
  <section className="empty-state-panel" aria-labelledby="coming-soon-title">
    <span aria-hidden="true" className="empty-state-icon">
      ◇
    </span>
    <h1 id="coming-soon-title">{title}</h1>
    <p>{description}</p>
    <p className="action-hint">当前页面只说明真实建设状态，不会生成或展示模拟业务数据。</p>
  </section>
);
