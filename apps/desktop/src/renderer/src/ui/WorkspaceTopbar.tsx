export interface WorkspaceTopbarProps {
  readonly area: string;
  readonly context?: string | undefined;
}

/** 项目内只负责定位，不重复展示保存状态或业务证据。 */
export const WorkspaceTopbar = ({ area, context }: WorkspaceTopbarProps) => (
  <header className="workspace-topbar">
    <nav aria-label="当前位置" className="workspace-breadcrumbs">
      <span>创作工作台</span>
      <i aria-hidden="true" />
      <strong>{area}</strong>
      {context === undefined ? null : (
        <>
          <i aria-hidden="true" />
          <span>{context}</span>
        </>
      )}
    </nav>
  </header>
);
