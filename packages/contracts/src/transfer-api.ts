import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { projectIdSchema, requestIdSchema } from './project-dto';

const idSchema = z.string().min(1).max(128);

export const transferImportModeSchema = z.enum(['NEW_PROJECT', 'RETURN_TO_ORIGIN']);
export type TransferImportMode = z.infer<typeof transferImportModeSchema>;

export const transferWarningCodeSchema = z.enum([
  'TRANSFER_CURRENT_ONLY',
  'TRANSFER_MEDIA_NOT_PACKAGED',
  'TRANSFER_MEDIA_REFERENCE_MISSING',
  'TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE',
]);
export type TransferWarningCode = z.infer<typeof transferWarningCodeSchema>;

export const transferExportProjectInputSchema = z
  .object({
    episodeId: idSchema,
    expectedVersionId: idSchema,
    overwriteConfirmed: z.boolean().default(false),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();

export const transferImportProjectInputSchema = z
  .object({
    importMode: transferImportModeSchema,
    requestId: requestIdSchema,
  })
  .strict();

export const transferExportResultSchema = z
  .object({
    byteSize: z.number().int().nonnegative(),
    exportId: idSchema,
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    warningCodes: z.array(transferWarningCodeSchema),
  })
  .strict();

export const transferImportResultSchema = z
  .object({
    importId: idSchema,
    projectId: projectIdSchema,
    sourceProjectId: projectIdSchema,
    warningCodes: z.array(transferWarningCodeSchema),
    createdObjectCount: z.number().int().nonnegative(),
  })
  .strict();

export type TransferExportProjectInputDto = z.infer<typeof transferExportProjectInputSchema>;
export type TransferImportProjectInputDto = z.infer<typeof transferImportProjectInputSchema>;
export type TransferExportResultDto = z.infer<typeof transferExportResultSchema>;
export type TransferImportResultDto = z.infer<typeof transferImportResultSchema>;

export interface TransferApi {
  exportProject(
    input: TransferExportProjectInputDto,
  ): Promise<AppResultDto<TransferExportResultDto>>;
  importProject(
    input: TransferImportProjectInputDto,
  ): Promise<AppResultDto<TransferImportResultDto>>;
}

export const TRANSFER_IPC_CHANNELS = {
  exportProject: 'transfer.exportProject',
  importProject: 'transfer.importProject',
} as const;
