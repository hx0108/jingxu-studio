import { z } from 'zod';

import type { ProjectApi } from './project-api';
import type { EventsApi, JobApi, ProviderApi } from './job-provider-api';
import type { ScriptApi } from './script-api';

export const startupStateSchema = z.enum([
  'BOOTING',
  'CHECKING',
  'READY',
  'READ_ONLY_FAULT',
  'RESTORING',
]);

export const startupPhaseSchema = z.enum([
  'DATABASE_OPEN',
  'CONNECTION_BASELINE',
  'MIGRATION',
  'DATABASE_AUDIT',
  'RECOVERY_GATE',
  'SCHEMA_REGISTRY',
]);

export const startupErrorCodeSchema = z.enum([
  'DATABASE_OPEN_FAILED',
  'DATABASE_PRAGMA_FAILED',
  'MIGRATION_SEQUENCE_INVALID',
  'MIGRATION_CHECKSUM_MISMATCH',
  'DATABASE_UNVERSIONED_SCHEMA',
  'DATABASE_VERSION_TOO_NEW',
  'DATABASE_BACKUP_FAILED',
  'MIGRATION_APPLY_FAILED',
  'DATABASE_INVARIANT_FAILED',
  'BACKUP_NOT_ALLOWED',
  'DATABASE_RESTORE_FAILED',
  'SCHEMA_RESOURCE_MISSING',
  'SCHEMA_RESOURCE_INVALID_JSON',
  'SCHEMA_HASH_MISMATCH',
  'SCHEMA_ID_MISMATCH',
  'SCHEMA_DRAFT_MISMATCH',
  'SCHEMA_VERSION_MISMATCH',
  'SCHEMA_MANIFEST_INVALID',
  'SCHEMA_REFERENCE_UNRESOLVED',
  'SCHEMA_COMPILE_FAILED',
  'SCHEMA_EVIDENCE_WRITE_FAILED',
  'STARTUP_STATE_CONFLICT',
]);

export const startupActionSchema = z.enum(['RETRY', 'RESTORE']);

export const backupSummarySchema = z
  .object({
    backupId: z.string().regex(/^backup_[A-Za-z0-9_-]{8,128}$/u),
    createdAt: z.iso.datetime({ offset: true }),
    schemaVersion: z.number().int().nonnegative(),
    summary: z.string().min(1).max(240),
  })
  .strict();

export const startupStatusSchema = z
  .object({
    allowedActions: z.array(startupActionSchema),
    backups: z.array(backupSummarySchema),
    completedPhases: z.array(startupPhaseSchema),
    currentPhase: startupPhaseSchema.nullable(),
    errorCode: startupErrorCodeSchema.nullable(),
    retryable: z.boolean(),
    revision: z.number().int().nonnegative(),
    state: startupStateSchema,
    summary: z.string().min(1).max(240).nullable(),
    writeEnabled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.writeEnabled !== (value.state === 'READY')) {
      context.addIssue({
        code: 'custom',
        message: 'writeEnabled 只能在 READY 状态为 true。',
        path: ['writeEnabled'],
      });
    }
  });

export const startupCommandSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    requestId: z.string().min(8).max(128),
  })
  .strict();

export const restoreBackupCommandSchema = startupCommandSchema
  .extend({
    backupId: backupSummarySchema.shape.backupId,
  })
  .strict();

export type BackupSummaryDto = z.infer<typeof backupSummarySchema>;
export type RestoreBackupCommandDto = z.infer<typeof restoreBackupCommandSchema>;
export type StartupAction = z.infer<typeof startupActionSchema>;
export type StartupCommandDto = z.infer<typeof startupCommandSchema>;
export type StartupErrorCode = z.infer<typeof startupErrorCodeSchema>;
export type StartupPhase = z.infer<typeof startupPhaseSchema>;
export type StartupState = z.infer<typeof startupStateSchema>;
export type StartupStatusDto = z.infer<typeof startupStatusSchema>;

export interface RuntimeApi {
  /** 返回当前脱敏启动状态。 */
  getStartupStatus: () => Promise<StartupStatusDto>;
  /** 从数据库打开阶段重新执行完整自检。 */
  retryStartup: (command: StartupCommandDto) => Promise<StartupStatusDto>;
  /** 仅使用 Main 登记的 opaque backup id 执行受控恢复。 */
  restoreBackup: (command: RestoreBackupCommandDto) => Promise<StartupStatusDto>;
}

export const RUNTIME_IPC_CHANNELS = {
  getStartupStatus: 'runtime.getStartupStatus',
  restoreBackup: 'runtime.restoreBackup',
  retryStartup: 'runtime.retryStartup',
} as const;

export * from './app-result';
export * from './job-provider-api';
export * from './project-api';
export * from './project-command';
export * from './project-dto';
export * from './script-api';
export * from './stage';

export interface JingxuApi {
  readonly events: EventsApi;
  readonly job: JobApi;
  readonly project: ProjectApi;
  readonly provider: ProviderApi;
  readonly runtime: RuntimeApi;
  readonly script: ScriptApi;
}

declare global {
  interface Window {
    readonly jingxu: JingxuApi;
  }
}
