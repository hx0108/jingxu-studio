import type { ReactNode } from 'react';

export type GlobalArea =
  'home' | 'projects' | 'workspace' | 'assets' | 'tasks' | 'exports' | 'evaluation' | 'settings';

const GLOBAL_AREAS: readonly [GlobalArea, string, string][] = [
  ['home', '首页', '⌂'],
  ['projects', '我的项目', '▦'],
  ['workspace', '创作工作台', '✦'],
  ['assets', '素材库', '◇'],
  ['tasks', '生成任务', '◌'],
  ['exports', '导出记录', '⇩'],
  ['evaluation', '质量与评测', '✓'],
  ['settings', '设置', '⚙'],
];

export interface AppShellProps {
  readonly activeArea: GlobalArea;
  readonly children: ReactNode;
  readonly onNavigate: (area: GlobalArea) => void;
  readonly projectName?: string | null;
}

export const AppShell = ({ activeArea, children, onNavigate, projectName }: AppShellProps) => (
  <main className="app-shell">
    <aside className="global-sidebar">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">
          镜
        </span>
        <div>
          <strong>镜序 Studio</strong>
          <small>AI 漫剧工作台</small>
        </div>
      </div>
      <nav aria-label="全局导航" className="global-navigation">
        {GLOBAL_AREAS.map(([area, label, icon]) => (
          <button
            aria-current={activeArea === area ? 'page' : undefined}
            className={activeArea === area ? 'global-nav-item active' : 'global-nav-item'}
            key={area}
            onClick={() => {
              onNavigate(area);
            }}
            type="button"
          >
            <span aria-hidden="true" className="global-nav-icon">
              {icon}
            </span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-project-context">
        <small>当前项目</small>
        <strong>{projectName ?? '尚未选择项目'}</strong>
      </div>
    </aside>
    <section className="app-content">{children}</section>
  </main>
);

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
