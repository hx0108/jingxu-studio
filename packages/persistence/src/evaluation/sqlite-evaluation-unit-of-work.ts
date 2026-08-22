import type { EvaluationRepositories, EvaluationUnitOfWorkPort } from '@jingxu/application';

import { SqliteProjectRepository } from '../project/sqlite-project-repository';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteScriptUnitOfWork } from '../script/sqlite-script-unit-of-work';
import {
  SqliteEvaluationAnnotationRepository,
  SqliteEvaluationSampleRepository,
} from './sqlite-evaluation-repositories';

/**
 * SQLite Evaluation UnitOfWork：复用 Script UoW 的仓储集合与同一事务边界
 * （audit/episodes/episodeVersions/shotContractVersions 只读投影），叠加
 * Project 投影与评测两表仓储；共用进程级 FIFO 事务协调器，
 * 与 Project/Script/Transfer UoW 互斥（禁止嵌套）。
 */
export class SqliteEvaluationUnitOfWork implements EvaluationUnitOfWorkPort {
  private readonly scriptUnitOfWork: SqliteScriptUnitOfWork;
  private readonly projectRepository: SqliteProjectRepository;
  private readonly sampleRepository: SqliteEvaluationSampleRepository;
  private readonly annotationRepository: SqliteEvaluationAnnotationRepository;

  public constructor(
    database: SqliteDatabase,
    coordinator: SqliteTransactionCoordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.scriptUnitOfWork = new SqliteScriptUnitOfWork(database, coordinator);
    this.projectRepository = new SqliteProjectRepository(database);
    this.sampleRepository = new SqliteEvaluationSampleRepository(database);
    this.annotationRepository = new SqliteEvaluationAnnotationRepository(database);
  }

  public run<T>(work: (repositories: EvaluationRepositories) => Promise<T>): Promise<T> {
    return this.scriptUnitOfWork.run((scriptRepositories) =>
      work({
        annotations: this.annotationRepository,
        audit: scriptRepositories.audit,
        episodes: scriptRepositories.episodes,
        episodeVersions: scriptRepositories.episodeVersions,
        projects: this.projectRepository,
        samples: this.sampleRepository,
        shotContractVersions: scriptRepositories.shotContractVersions,
        stageHeads: scriptRepositories.stageHeads,
      }),
    );
  }
}
