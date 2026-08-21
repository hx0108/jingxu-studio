import type { TransferRepositories, TransferUnitOfWorkPort } from '@jingxu/application';

import { SqliteFormatProfileRepository } from '../project/sqlite-format-profile-repository';
import { SqliteProjectRepository } from '../project/sqlite-project-repository';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteScriptUnitOfWork } from '../script/sqlite-script-unit-of-work';
import { SqliteTransferRecordRepository } from './sqlite-transfer-record-repository';

/**
 * SQLite Transfer UnitOfWork：Script/Job 全量仓储 + Project/FormatProfile 投影 +
 * Transfer 记录，共用进程级 FIFO 事务协调器（design.md D4：导入的版本、阶段头、依赖、
 * 审计、回执与 import_records 在同一事务提交，禁止嵌套 Project/Script UoW）。
 */
export class SqliteTransferUnitOfWork implements TransferUnitOfWorkPort {
  private readonly scriptUnitOfWork: SqliteScriptUnitOfWork;
  private readonly projectRepository: SqliteProjectRepository;
  private readonly formatProfileRepository: SqliteFormatProfileRepository;
  private readonly transferRepository: SqliteTransferRecordRepository;

  public constructor(
    database: SqliteDatabase,
    coordinator: SqliteTransactionCoordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.scriptUnitOfWork = new SqliteScriptUnitOfWork(database, coordinator);
    this.projectRepository = new SqliteProjectRepository(database);
    // ScriptJobRepositories.formatProfiles 是窄投影；Transfer 导入需要完整版仓储。
    this.formatProfileRepository = new SqliteFormatProfileRepository(database);
    this.transferRepository = new SqliteTransferRecordRepository(database);
  }

  public run<T>(work: (repositories: TransferRepositories) => Promise<T>): Promise<T> {
    // 复用 Script UoW 的仓储集合与同一事务边界，叠加 Transfer 聚合所需的投影。
    return this.scriptUnitOfWork.run((scriptRepositories) =>
      work({
        ...scriptRepositories,
        formatProfiles: this.formatProfileRepository,
        projects: this.projectRepository,
        transfer: this.transferRepository,
      }),
    );
  }
}
