import type { AppErrorDto, ProjectErrorCode } from '@jingxu/contracts';

export interface ProjectErrorView {
  readonly summary: string;
  readonly nextAction: string;
  readonly fieldErrors: Readonly<Record<string, string>> | null;
  readonly traceId: string;
}

const ERROR_COPY: Record<ProjectErrorCode, readonly [string, string]> = {
  PROJECT_NOT_FOUND: ['找不到这个项目', '返回项目列表并刷新后重试。'],
  PROJECT_NAME_CONFLICT: ['项目名称已被占用', '请修改项目名称后重试。'],
  PROJECT_DIRECTORY_UNAVAILABLE: ['无法准备本地项目目录', '检查磁盘可写空间后重试。'],
  PROJECT_VERSION_CONFLICT: ['项目已在其他操作中更新', '刷新最新内容，再重新应用你的修改。'],
  PROJECT_ALREADY_DELETED: ['项目已经在回收站中', '刷新列表查看最新状态。'],
  PROJECT_NOT_DELETED: ['项目不在回收站中', '返回活动项目列表查看。'],
  FORMAT_PROFILE_INVALID: ['创作设定不符合 V1 规则', '检查画幅和字幕安全区。'],
  FORMAT_PROFILE_DEPENDENCY_BLOCKED: [
    '已有分镜引用当前画幅',
    '保持当前画幅，或等待后续 Change 支持依赖失效处理。',
  ],
  REQUEST_ID_REUSED: ['本次操作标识已被其他请求使用', '重新发起操作。'],
  STARTUP_WRITE_BLOCKED: ['应用当前处于只读故障状态', '先在故障页完成恢复或重新检查。'],
  IPC_INVALID_REQUEST: ['提交内容无法验证', '检查标记字段并重新提交。'],
  IPC_SENDER_NOT_ALLOWED: ['操作来源不受信任', '关闭应用后从官方入口重新启动。'],
  PROJECT_PERSISTENCE_FAILED: ['本地保存失败', '你的输入仍已保留，请稍后重试。'],
};

/** 只按稳定 code 映射文案，绝不展示来自基础设施的 message。 */
export const describeProjectError = (error: AppErrorDto): ProjectErrorView => {
  const [summary, fallbackAction] = ERROR_COPY[error.code];
  return {
    summary,
    nextAction: error.userAction ?? fallbackAction,
    fieldErrors: error.fieldErrors,
    traceId: error.traceId,
  };
};
