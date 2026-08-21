import { describe, expect, it } from 'vitest';

import {
  transferExportProjectInputSchema,
  transferExportResultSchema,
  transferImportProjectInputSchema,
  transferImportResultSchema,
} from './transfer-api';

const requestId = 'request_transfer_001';
const projectId = 'project_transfer_001';

describe('transfer contracts', () => {
  it('accepts strict export and import DTOs', () => {
    expect(
      transferExportProjectInputSchema.parse({
        episodeId: 'episode_001',
        expectedVersionId: 'episode_version_001',
        projectId,
        requestId,
      }),
    ).toMatchObject({ overwriteConfirmed: false });
    expect(
      transferImportProjectInputSchema.parse({ importMode: 'NEW_PROJECT', requestId }),
    ).toEqual({ importMode: 'NEW_PROJECT', requestId });
  });

  it('rejects unknown fields, invalid mode and path-shaped output', () => {
    expect(() =>
      transferImportProjectInputSchema.parse({
        importMode: 'NEW_PROJECT',
        requestId,
        path: 'C:\\x',
      }),
    ).toThrow();
    expect(() =>
      transferImportProjectInputSchema.parse({ importMode: 'MERGE', requestId }),
    ).toThrow();
    expect(() =>
      transferExportResultSchema.parse({
        byteSize: 1,
        exportId: 'export_001',
        fileSha256: '0'.repeat(64),
        warningCodes: [],
        targetPath: 'C:\\secret\\bundle.json',
      }),
    ).toThrow();
    expect(() =>
      transferImportResultSchema.parse({
        importId: 'import_001',
        projectId,
        sourceProjectId: projectId,
        warningCodes: [],
        createdObjectCount: 1,
        sql: 'SELECT *',
      }),
    ).toThrow();
  });
});
