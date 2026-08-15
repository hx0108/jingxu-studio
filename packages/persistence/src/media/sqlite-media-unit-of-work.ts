import type { MediaRepository, MediaUnitOfWorkPort } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteMediaRepository } from './sqlite-media-repository';

/**
 * 媒体读写事务边界（沿 SqliteProjectUnitOfWork 语义）：单一 `BEGIN IMMEDIATE`，
 * work 抛出即 ROLLBACK；FIFO 队列防止同一连接上嵌套事务。
 * 媒体域当前只有一个仓储，故契约收窄为单一 repository 参数。
 */
export class SqliteMediaUnitOfWork implements MediaUnitOfWorkPort {
  private readonly coordinator: SqliteTransactionCoordinator;
  private readonly repository: SqliteMediaRepository;

  public constructor(
    database: SqliteDatabase,
    clock: () => string,
    coordinator: SqliteTransactionCoordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.coordinator = coordinator;
    this.repository = new SqliteMediaRepository(database, clock);
  }

  public run<T>(work: (media: MediaRepository) => Promise<T>): Promise<T> {
    return this.coordinator.run(() => work(this.repository));
  }
}
