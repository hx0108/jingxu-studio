import type {
  EvaluationAnnotationRecord,
  EvaluationAnnotationRepositoryPort,
  EvaluationSampleFilter,
  EvaluationSampleRecord,
  EvaluationSampleRepositoryPort,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';
import {
  mapEvaluationAnnotationRow,
  mapEvaluationSampleRow,
  type EvaluationRow,
} from './evaluation-row-mappers';

type Input = null | number | bigint | string | NodeJS.ArrayBufferView;
interface RunResult {
  readonly changes: number;
}

const SAMPLE_COLUMNS = `id, project_id, sample_type, input_json, expected_json,
                        authorization_status, dedup_key, dataset_split, rule_hits_json,
                        rule_version, created_at`;

/**
 * SQLite evaluation_samples 仓储（0001 表 + 0017 rule_hits_json/rule_version）。
 * 0001 之前无写入路径，rule_hits/rule_version 仅对新写入非空；NULL 行映射为 null
 * （迁移前语义，读侧不虚构命中）。
 */
export class SqliteEvaluationSampleRepository implements EvaluationSampleRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}

  public list(filter: EvaluationSampleFilter): Promise<readonly EvaluationSampleRecord[]> {
    return syncToPromise(() => {
      const conditions: string[] = [];
      const args: Input[] = [];
      if (filter.scope === 'GLOBAL') {
        conditions.push('project_id IS NULL');
      } else if (filter.scope === 'PROJECT') {
        // `IS ?` 使 projectId 缺省时的 NULL 归属与内存实现保持一致（等价 GLOBAL）。
        conditions.push('project_id IS ?');
        args.push(filter.projectId ?? null);
      }
      if (filter.sampleType != null) {
        conditions.push('sample_type = ?');
        args.push(filter.sampleType);
      }
      if (filter.datasetSplit != null) {
        conditions.push('dataset_split = ?');
        args.push(filter.datasetSplit);
      }
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      return (
        this.db
          .prepare(
            `SELECT ${SAMPLE_COLUMNS} FROM evaluation_samples ${where}
             ORDER BY created_at DESC, id DESC`,
          )
          .all(...args) as EvaluationRow[]
      ).map(mapEvaluationSampleRow);
    });
  }

  public findById(id: string): Promise<EvaluationSampleRecord | null> {
    return syncToPromise(() => {
      const row = this.db
        .prepare(`SELECT ${SAMPLE_COLUMNS} FROM evaluation_samples WHERE id = ?`)
        .get(id) as EvaluationRow | undefined;
      return row === undefined ? null : mapEvaluationSampleRow(row);
    });
  }

  public findByDedupKey(dedupKey: string): Promise<EvaluationSampleRecord | null> {
    return syncToPromise(() => {
      const row = this.db
        .prepare(`SELECT ${SAMPLE_COLUMNS} FROM evaluation_samples WHERE dedup_key = ?`)
        .get(dedupKey) as EvaluationRow | undefined;
      return row === undefined ? null : mapEvaluationSampleRow(row);
    });
  }

  public insert(record: EvaluationSampleRecord): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          `INSERT INTO evaluation_samples (
             id, project_id, sample_type, input_json, expected_json,
             authorization_status, dedup_key, dataset_split, rule_hits_json,
             rule_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.sampleType,
          JSON.stringify(record.input),
          JSON.stringify(record.expected),
          record.authorization,
          record.dedupKey,
          record.datasetSplit,
          record.ruleHits === null ? null : JSON.stringify(record.ruleHits),
          record.ruleVersion,
          record.createdAt,
        );
    });
  }

  public deleteById(id: string): Promise<number | null> {
    return syncToPromise(() => {
      const existing = this.db.prepare('SELECT id FROM evaluation_samples WHERE id = ?').get(id);
      if (existing === undefined) return null;
      const annotations = this.db
        .prepare('DELETE FROM evaluation_annotations WHERE sample_id = ?')
        .run(id) as RunResult;
      this.db.prepare('DELETE FROM evaluation_samples WHERE id = ?').run(id);
      return annotations.changes;
    });
  }
}

/** SQLite evaluation_annotations 仓储（追加式；无 UPDATE 方法即历史不可变）。 */
export class SqliteEvaluationAnnotationRepository implements EvaluationAnnotationRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}

  public listBySampleId(sampleId: string): Promise<readonly EvaluationAnnotationRecord[]> {
    return syncToPromise(() =>
      (
        this.db
          .prepare(
            `SELECT id, sample_id, guideline_version, label_json, rationale, annotator, created_at
             FROM evaluation_annotations WHERE sample_id = ?
             ORDER BY created_at, id`,
          )
          .all(sampleId) as EvaluationRow[]
      ).map(mapEvaluationAnnotationRow),
    );
  }

  public insert(record: EvaluationAnnotationRecord): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          `INSERT INTO evaluation_annotations (
             id, sample_id, guideline_version, label_json, rationale, annotator, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sampleId,
          record.guidelineVersion,
          JSON.stringify(record.label),
          record.rationale,
          record.annotator,
          record.createdAt,
        );
    });
  }

  public deleteBySampleId(sampleId: string): Promise<number> {
    return syncToPromise(() => {
      const result = this.db
        .prepare('DELETE FROM evaluation_annotations WHERE sample_id = ?')
        .run(sampleId) as RunResult;
      return result.changes;
    });
  }
}
