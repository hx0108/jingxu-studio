import type { MediaRepositories, MediaUnitOfWorkPort } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteMediaInvocationRepository } from './sqlite-media-invocation-repository';
import { SqliteMediaRepository } from './sqlite-media-repository';

/**
 * 媒体读写事务边界（沿 SqliteProjectUnitOfWork 语义）：单一 `BEGIN IMMEDIATE`，
 * work 抛出即 ROLLBACK；FIFO 队列防止同一连接上嵌套事务。
 * 事务内暴露 { media, invocations } 两仓储（沿 JobRepositories 先例）——
 * 证据收尾与候选终态同事务原子提交（media-invocation-evidence design D4）。
 */
export class SqliteMediaUnitOfWork implements MediaUnitOfWorkPort {
  private readonly coordinator: SqliteTransactionCoordinator;
  private readonly repositories: MediaRepositories;

  public constructor(
    database: SqliteDatabase,
    clock: () => string,
    coordinator: SqliteTransactionCoordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.coordinator = coordinator;
    this.repositories = {
      invocations: new SqliteMediaInvocationRepository(database, clock),
      media: new SqliteMediaRepository(database, clock),
    };
  }

  public run<T>(work: (repos: MediaRepositories) => Promise<T>): Promise<T> {
    return this.coordinator.run(() => work(this.repositories));
  }
}
