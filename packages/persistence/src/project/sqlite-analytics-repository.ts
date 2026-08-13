import { randomUUID } from 'node:crypto';

import type { AnalyticsEvent, AnalyticsRepository } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';

/** Stores local-only, allowlisted Project analytics properties. */
export class SqliteAnalyticsRepository implements AnalyticsRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public record(event: AnalyticsEvent): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO analytics_events (
            id, project_id, event_name, session_id, properties_json, occurred_at
          ) VALUES (?, ?, ?, 'local-project-session', ?, ?)`,
        )
        .run(
          randomUUID(),
          event.projectId,
          event.eventName,
          JSON.stringify(event.properties),
          event.occurredAt,
        );
    });
  }
}
