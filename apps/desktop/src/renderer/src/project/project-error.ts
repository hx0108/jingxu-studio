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
  JOB_NOT_FOUND: ['找不到这个任务', '刷新任务列表后重试。'],
  JOB_VERSION_CONFLICT: ['任务已在其他操作中更新', '刷新最新任务状态后再操作。'],
  JOB_NOT_CANCELLABLE: ['当前任务状态不可取消', '刷新查看最新状态。'],
  JOB_PERSISTENCE_FAILED: ['任务保存失败', '请稍后重试。'],
  JOB_SUBMISSION_UNAVAILABLE: ['任务暂不可创建或重试', '请稍后重试。'],
  PROVIDER_PROFILE_NOT_FOUND: ['未配置 Provider', '先在设置中完成 Provider 配置。'],
  PROVIDER_CREDENTIAL_MISSING: ['尚未保存 API Key', '先在设置中保存 API Key。'],
  PROVIDER_CREDENTIAL_UNAVAILABLE: ['凭据安全存储不可用', '确认系统密钥串可用后重试。'],
  PROVIDER_CALL_FAILED: ['Provider 调用失败', '稍后重试；若持续失败请检查网络与凭据。'],
  MODEL_CREDENTIAL_INVALID: ['API Key 校验未通过', '重新粘贴 API Key 并保存后再次验证。'],
  MODEL_RATE_LIMITED: ['Provider 限流', '等待片刻后重试。'],
  MODEL_PROVIDER_ERROR: ['Provider 服务端错误', '稍后重试；若持续失败请查看 Provider 状态页。'],
  MODEL_NETWORK_ERROR: ['网络不可用或无法连接 Provider', '检查网络连接（含代理设置）后重试。'],
  MODEL_TIMEOUT: ['请求超时', '请重试；网络不佳时可稍后再试。'],
  MODEL_INVALID_RESPONSE: ['Provider 返回内容无法解析', '请重试。'],
  MODEL_CONTENT_REJECTED: ['请求内容被 Provider 安全策略拒绝', '调整输入内容后重试。'],
  MODEL_CONTEXT_LIMIT: ['上下文长度超出模型限制', '减少输入长度后重试。'],
  MODEL_INPUT_TOO_LARGE: ['请求体超出 Provider 大小限制', '减少输入长度后重试。'],
  MODEL_CANCELLED: ['请求已取消', '需要时请重新发起。'],
  MODEL_RESULT_UNAVAILABLE: ['生成结果已失效，无法下载', '请重新生成候选。'],
  MODEL_UNKNOWN: ['Provider 调用失败，原因未知', '请重试；若持续失败请检查 Provider 配置。'],
  STALE_INPUT: ['剧本输入版本已变化', '刷新剧本工作区后重新操作。'],
  SCRIPT_INPUT_LENGTH_INVALID: ['原创输入长度不符合要求', '请输入 20–2,000 个字符。'],
  SCRIPT_INPUT_CONSENT_REQUIRED: ['尚未确认数据处理说明', '阅读并确认后重新提交。'],
  SCRIPT_WORKSPACE_NOT_INITIALIZED: ['剧本工作区尚未初始化', '先提交原创创意。'],
  SCRIPT_STAGE_PREREQUISITE_MISSING: ['阶段前置内容未就绪', '先生成并确认所需上游阶段。'],
  SCRIPT_STAGE_NOT_READY: ['阶段尚未确认', '确认当前草稿后再继续。'],
  SCRIPT_VERSION_NOT_FOUND: ['找不到剧本版本', '刷新历史版本后重试。'],
  SCRIPT_VERSION_CONFLICT: ['剧本版本已变化', '刷新最新版本，再重新应用修改。'],
  SCRIPT_SCHEMA_INVALID: ['剧本结构校验失败', '根据字段错误修正内容后重试。'],
  SCRIPT_STAGE_UNSUPPORTED: ['当前阶段暂不支持', '使用已开放的五阶段剧本流程。'],
  MEDIA_STORYBOARD_NOT_READY: ['分镜尚未确认', '先在分镜阶段确认 READY 后再生成首帧。'],
  MEDIA_SHOT_NOT_IN_READY_SET: ['镜头不在当前分镜集合中', '刷新分镜工作区后重试。'],
  MEDIA_PERSISTENCE_FAILED: ['媒体数据暂时无法保存', '请稍后重试。'],
  MEDIA_TASK_NOT_FOUND: ['找不到这个生成任务', '刷新首帧面板后重试。'],
  MEDIA_CANDIDATE_NOT_FOUND: ['找不到这个候选图', '刷新首帧面板后重选。'],
  MEDIA_CANDIDATE_NOT_SELECTABLE: ['该候选不可设为当前首帧', '刷新后选择最新成功的候选。'],
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
