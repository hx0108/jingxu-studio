import type { ProjectDetailDto } from '@jingxu/contracts';

export interface ProjectDetailViewProps {
  readonly detail: ProjectDetailDto;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onRestore: () => void;
  readonly onOpenScript?: () => void;
  readonly onOpenEvaluation?: () => void;
}

const ProfileCard = ({
  label,
  profile,
}: {
  readonly label: string;
  readonly profile: ProjectDetailDto['currentFormatProfile'];
}) => (
  <article className="profile-card">
    <h3>
      {label} v{profile.versionNo}
    </h3>
    <dl>
      <div>
        <dt>画幅</dt>
        <dd>{profile.aspectRatio}</dd>
      </div>
      <div>
        <dt>分辨率</dt>
        <dd>
          {profile.width}×{profile.height}
        </dd>
      </div>
      <div>
        <dt>帧率</dt>
        <dd>{profile.fps} fps</dd>
      </div>
      <div>
        <dt>语言</dt>
        <dd>{profile.language}</dd>
      </div>
    </dl>
  </article>
);

export const ProjectDetailView = ({
  detail,
  onEdit,
  onDelete,
  onRestore,
  onOpenScript = () => undefined,
  onOpenEvaluation = () => undefined,
}: ProjectDetailViewProps) => (
  <section className="detail-panel" aria-labelledby="detail-title">
    <header className="detail-header">
      <div>
        <p className="eyebrow">PROJECT</p>
        <h2 id="detail-title">{detail.name}</h2>
        <p>
          {detail.genre ?? '未填写题材'} · {detail.style ?? '未填写风格'}
        </p>
      </div>
      <button onClick={onEdit} type="button">
        编辑创作设定
      </button>
    </header>
    <div className="capability-grid" aria-label="后续创作能力">
      <button onClick={onOpenScript} type="button">
        进入剧本工作区
      </button>
      <button onClick={onOpenEvaluation} type="button">
        当前项目评测集
      </button>
      <button aria-describedby="storyboard-disabled-reason" disabled type="button">
        分镜工作台
      </button>
      <p id="storyboard-disabled-reason">分镜能力在剧本工作区内提供：请先进入剧本工作区。</p>
    </div>
    <section aria-labelledby="profile-title">
      <h3 id="profile-title">FormatProfile 版本链</h3>
      <ProfileCard label="当前版本" profile={detail.currentFormatProfile} />
      {detail.formatProfileHistory.map((profile) => (
        <ProfileCard key={profile.id} label="历史版本" profile={profile} />
      ))}
    </section>
    <section className="danger-zone" aria-labelledby="danger-title">
      <h3 id="danger-title">项目状态</h3>
      {detail.deletedAt === null ? (
        <button className="danger-button" onClick={onDelete} type="button">
          移入回收站
        </button>
      ) : (
        <button onClick={onRestore} type="button">
          恢复项目
        </button>
      )}
    </section>
  </section>
);
