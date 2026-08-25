export type WorkspaceProgressState = 'NOT_STARTED' | 'IN_PROGRESS' | 'READY' | 'BLOCKED' | 'FAILED';

const STATUS_LABELS: Readonly<Record<string, string>> = {
  BLOCK: '必须处理',
  CANCELLED: '已取消',
  CANCEL_REQUESTED: '正在取消',
  COMPLETED: '已完成',
  DRAFT: '草稿',
  FAILED: '失败',
  INFO: '提示',
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  POLLING: '生成中',
  PREPARING: '准备中',
  QUEUED: '排队中',
  READY: '已确认',
  RUNNING: '生成中',
  STALE_INPUT: '输入已变化',
  SUCCEEDED: '已完成',
  SUBMITTING: '正在提交',
  UPLOADING: '上传中',
  VALIDATING: '校验中',
  WARN: '建议检查',
  BLOCKED: '前置条件未满足',
};

export const workspaceStatusLabel = (status: string | null | undefined): string =>
  status === null || status === undefined ? '未开始' : (STATUS_LABELS[status] ?? '状态待确认');

export const workspaceStatusTone = (
  status: string | null | undefined,
): 'neutral' | 'active' | 'success' | 'warning' | 'danger' => {
  if (status === 'READY' || status === 'SUCCEEDED') return 'success';
  if (status === 'RUNNING' || status === 'QUEUED' || status === 'VALIDATING') return 'active';
  if (status === 'DRAFT' || status === 'STALE_INPUT' || status === 'WARN') return 'warning';
  if (status === 'FAILED' || status === 'BLOCK') return 'danger';
  return 'neutral';
};

export const nextScriptStageLabel = (stage: string): string | null => {
  const next: Readonly<Record<string, string>> = {
    CONCEPT: '故事圣经',
    STORY_BIBLE: '单集大纲',
    EPISODE_OUTLINE: '节拍表',
    BEAT_SHEET: '场景剧本',
    SCENE_SCRIPT: '分镜设计',
  };
  return next[stage] ?? null;
};
