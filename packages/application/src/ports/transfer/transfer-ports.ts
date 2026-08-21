import type { FormatProfileRepository } from '../project/format-profile-repository';
import type { ProjectRepository } from '../project/project-repository';
import type { ScriptJobRepositories } from '../script/script-unit-of-work-port';
import type {
  TransferExportRecord,
  TransferFileSnapshot,
  TransferFileWriteOutcome,
  TransferImportRecord,
} from './transfer-types';

/**
 * Main 侧文件 Port（design.md D3）：导入走系统 Open Dialog + 受管理读取；
 * 导出走 Save Dialog + 同目录临时文件 + flush 后原子 rename，默认拒绝覆盖。
 * 路径只在本 Port 实现内部存在，向 Application 仅暴露字节、Hash 与不透明 ref。
 */
export interface TransferFilePort {
  readSelectedJson(): Promise<TransferFileSnapshot | null>;
  writeJsonAtomically(
    defaultFileName: string,
    bytes: Uint8Array,
    overwriteConfirmed: boolean,
  ): Promise<TransferFileWriteOutcome>;
}

/**
 * Transfer 记录仓储（export_records/import_records，0001 + 0016 request_id）。
 * requestId 幂等：SUCCEEDED 行按 request_id 唯一（0016 部分唯一索引兜底并发）。
 */
export interface TransferRecordRepositoryPort {
  findExportByRequestId(requestId: string): Promise<TransferExportRecord | null>;
  insertExport(record: TransferExportRecord): Promise<void>;
  findImportByRequestId(requestId: string): Promise<TransferImportRecord | null>;
  insertImport(record: TransferImportRecord): Promise<void>;
}

/**
 * Transfer 事务内可用的仓储聚合：复用 Script/Job 全量端口 + Project/FormatProfile
 * 最小投影 + Transfer 记录。导入的版本、阶段头、依赖、审计、回执与 import_records
 * 在同一事务提交（design.md D4；禁止嵌套 Project/Script UoW）。
 */
export interface TransferRepositories extends ScriptJobRepositories {
  readonly formatProfiles: Pick<
    FormatProfileRepository,
    'findCurrent' | 'findMaxVersionNo' | 'insert' | 'unsetCurrent'
  >;
  readonly projects: Pick<ProjectRepository, 'findById' | 'insert'>;
  readonly transfer: TransferRecordRepositoryPort;
}

/** runtime 级 FIFO 单连接事务边界（与 Project/Script UoW 同一 coordinator）。 */
export interface TransferUnitOfWorkPort {
  run<T>(work: (repositories: TransferRepositories) => Promise<T>): Promise<T>;
}
