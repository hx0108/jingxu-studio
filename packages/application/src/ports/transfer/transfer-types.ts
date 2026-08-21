import type {
  TransferImportMode,
  TransferImportResultDto,
  TransferWarningCode,
} from '@jingxu/contracts';

export type TransferJson = Readonly<Record<string, unknown>>;

/** export_records.result_json：requestId 重放所需的输入指纹与警告码。 */
export interface TransferExportResultSummary {
  readonly inputFingerprint: string;
  readonly warningCodes: readonly TransferWarningCode[];
}

/**
 * Main 文件 Port 产生的不透明引用（导出目标/导入来源的代称）。
 * Application 只原样落库、绝不解读/拼接/回传 Renderer（design.md D3：路径只在 Main/Adapter 内部）。
 */
export type TransferFileRef = string;

export interface TransferFileSnapshot {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sourceRef: TransferFileRef;
}

export type TransferFileWriteOutcome =
  | Readonly<{ readonly outcome: 'written'; readonly byteSize: number; readonly sha256: string; readonly targetRef: TransferFileRef }>
  | Readonly<{ readonly outcome: 'cancelled' }>
  /** 目标已存在且未显式确认覆盖（默认拒绝；非 I/O 故障）。 */
  | Readonly<{ readonly outcome: 'refused' }>
  | Readonly<{ readonly outcome: 'failed' }>;

/** export_records 行（0001 DDL + 0016 request_id/result_json 投影）。 */
export interface TransferExportRecord {
  readonly id: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly episodeId: string;
  readonly episodeVersionId: string;
  readonly status: 'PREPARING' | 'FILE_READY' | 'SUCCEEDED' | 'FAILED';
  readonly payloadSha256: string;
  readonly byteSize: number;
  readonly targetRef: TransferFileRef;
  readonly overwritePolicy: 'REJECT' | 'CONFIRMED_OVERWRITE';
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** SUCCEEDED 时的回放摘要（result_json；requestId 重放原样返回）。 */
  readonly resultSummary: TransferExportResultSummary | null;
}

/** import_records 行（0001 DDL + 0016 request_id/result_json 投影）。 */
export interface TransferImportRecord {
  readonly id: string;
  readonly requestId: string;
  readonly projectId: string | null;
  readonly importMode: TransferImportMode;
  readonly sourceSha256: string;
  readonly sourceRef: TransferFileRef;
  readonly status: 'STAGING' | 'VALIDATING' | 'SUCCEEDED' | 'FAILED';
  readonly validationErrors: readonly string[];
  readonly idMapping: TransferJson | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** SUCCEEDED 时的回放摘要（result_json；requestId 重放原样返回）。 */
  readonly resultSummary: TransferImportResultDto | null;
}
