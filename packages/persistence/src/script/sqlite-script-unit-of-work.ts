import type { ScriptJobRepositories, ScriptUnitOfWorkPort } from '@jingxu/application';

import { SqliteJobRepository } from '../job/sqlite-job-repository';
import { SqliteModelInvocationRepository } from '../model-invocation/sqlite-model-invocation-repository';
import { SqliteFormatProfileRepository } from '../project/sqlite-format-profile-repository';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import {
  SqliteConsentRepository,
  SqliteEpisodeRepository,
  SqliteEpisodeVersionRepository,
  SqliteScriptAuditRepository,
  SqliteScriptCommandReceiptRepository,
  SqliteScriptDependencyRepository,
  SqliteScriptVersionRepository,
  SqliteShotContractVersionRepository,
  SqliteShotLockRepository,
  SqliteShotRepository,
  SqliteSourceInputRepository,
  SqliteStageHeadRepository,
  SqliteStoryBibleVersionRepository,
} from './sqlite-script-repositories';

export class SqliteScriptUnitOfWork implements ScriptUnitOfWorkPort {
  private readonly repositories: ScriptJobRepositories;

  public constructor(
    database: SqliteDatabase,
    private readonly coordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.repositories = {
      audit: new SqliteScriptAuditRepository(database),
      consents: new SqliteConsentRepository(database),
      dependencies: new SqliteScriptDependencyRepository(database),
      episodes: new SqliteEpisodeRepository(database),
      episodeVersions: new SqliteEpisodeVersionRepository(database),
      formatProfiles: new SqliteFormatProfileRepository(database),
      invocations: new SqliteModelInvocationRepository(database),
      jobs: new SqliteJobRepository(database),
      locks: new SqliteShotLockRepository(database),
      receipts: new SqliteScriptCommandReceiptRepository(database),
      scriptVersions: new SqliteScriptVersionRepository(database),
      shotContractVersions: new SqliteShotContractVersionRepository(database),
      shots: new SqliteShotRepository(database),
      sourceInputs: new SqliteSourceInputRepository(database),
      stageHeads: new SqliteStageHeadRepository(database),
      storyBibleVersions: new SqliteStoryBibleVersionRepository(database),
    };
  }

  public run<T>(work: (repositories: ScriptJobRepositories) => Promise<T>): Promise<T> {
    return this.coordinator.run(() => work(this.repositories));
  }
}
