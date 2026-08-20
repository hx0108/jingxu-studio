import { z } from 'zod';

/**
 * 应用级 IPC 的稳定错误码（TECH_DESIGN v1.1 §11 / Design §2）。
 *
 * 全部业务/字段/IPC/启动错误统一归一为这些 code；Renderer 据此分支，
 * 永不依赖 thrown Error 的 message。历史命名 `projectErrorCodeSchema` 沿用；
 * 实际为 Job/Provider/Project 共用的 AppError code 枚举。
 */
export const projectErrorCodeSchema = z.enum([
  'PROJECT_NOT_FOUND',
  'PROJECT_NAME_CONFLICT',
  'PROJECT_DIRECTORY_UNAVAILABLE',
  'PROJECT_VERSION_CONFLICT',
  'PROJECT_ALREADY_DELETED',
  'PROJECT_NOT_DELETED',
  'FORMAT_PROFILE_INVALID',
  'FORMAT_PROFILE_DEPENDENCY_BLOCKED',
  'REQUEST_ID_REUSED',
  'STARTUP_WRITE_BLOCKED',
  'IPC_INVALID_REQUEST',
  'IPC_SENDER_NOT_ALLOWED',
  'PROJECT_PERSISTENCE_FAILED',
  'JOB_NOT_FOUND',
  'JOB_VERSION_CONFLICT',
  'JOB_NOT_CANCELLABLE',
  'JOB_PERSISTENCE_FAILED',
  'JOB_SUBMISSION_UNAVAILABLE',
  'PROVIDER_PROFILE_NOT_FOUND',
  'PROVIDER_CREDENTIAL_MISSING',
  'PROVIDER_CREDENTIAL_UNAVAILABLE',
  'PROVIDER_CALL_FAILED',
  // 模型端口 NormalizedModelError.code 的 1:1 透传（凭据测试等 IPC 直查场景）。
  // 与 application ports 的 ModelErrorCode 联合保持一致，避免第二套命名。
  'MODEL_CREDENTIAL_INVALID',
  'MODEL_RATE_LIMITED',
  'MODEL_PROVIDER_ERROR',
  'MODEL_NETWORK_ERROR',
  'MODEL_TIMEOUT',
  'MODEL_INVALID_RESPONSE',
  'MODEL_CONTENT_REJECTED',
  'MODEL_CONTEXT_LIMIT',
  'MODEL_INPUT_TOO_LARGE',
  'MODEL_CANCELLED',
  'MODEL_RESULT_UNAVAILABLE',
  'MODEL_UNKNOWN',
  'STALE_INPUT',
  'SCRIPT_INPUT_LENGTH_INVALID',
  'SCRIPT_INPUT_CONSENT_REQUIRED',
  'SCRIPT_WORKSPACE_NOT_INITIALIZED',
  'SCRIPT_STAGE_PREREQUISITE_MISSING',
  'SCRIPT_STAGE_NOT_READY',
  'SCRIPT_VERSION_NOT_FOUND',
  'SCRIPT_VERSION_CONFLICT',
  'SCRIPT_SCHEMA_INVALID',
  'SCRIPT_STAGE_UNSUPPORTED',
  // V2 分镜编辑/锁定切片（shot-edit-lock）。
  'SHOT_EDIT_NO_CHANGE',
  'SHOT_LOCK_CONFLICT',
  'SHOT_LOCK_POINTER_INVALID',
  // V2 图片切片（shot-first-frame-image-generation §4.1/§5.1）。
  'MEDIA_STORYBOARD_NOT_READY',
  'MEDIA_SHOT_NOT_IN_READY_SET',
  'MEDIA_PERSISTENCE_FAILED',
  'MEDIA_TASK_NOT_FOUND',
  'MEDIA_CANDIDATE_NOT_FOUND',
  'MEDIA_CANDIDATE_NOT_SELECTABLE',
  // V2 批量首帧（batch-first-frame-generation §5.1 批次编排稳定码）。
  'MEDIA_BATCH_NOT_FOUND',
  'MEDIA_BATCH_ALREADY_RUNNING',
  'MEDIA_BATCH_NO_PENDING_SHOTS',
]);
export type ProjectErrorCode = z.infer<typeof projectErrorCodeSchema>;

/**
 * 用户可见错误。遵循 TECH_DESIGN v1.1 §11：只含稳定 code、脱敏 message、
 * retryable、可选 userAction/fieldErrors 与 traceId。严禁携带 SQL、堆栈、
 * 绝对路径、name/genre/style 或内部对象。
 */
export const appErrorSchema = z
  .object({
    code: projectErrorCodeSchema,
    message: z.string().min(1).max(280),
    retryable: z.boolean(),
    userAction: z.string().min(1).max(280).nullable(),
    fieldErrors: z.record(z.string(), z.string()).nullable(),
    traceId: z.string().min(1).max(128),
  })
  .strict();
export type AppErrorDto = z.infer<typeof appErrorSchema>;

/**
 * 显式 Result Envelope（Design §2）。
 *
 * 避免依赖 Electron 对 thrown Error 的不稳定序列化；受信 sender 的字段/业务
 * 错误走 Result，非受信 sender 在 Main 边界直接拒绝。
 */
export const appResultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
  ]);

export type AppResultDto<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: AppErrorDto }>;
