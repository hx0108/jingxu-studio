import type {
  FindingOverrideRecord,
  ProducibilityFindingRecord,
  ProducibilityReportRecord,
  ProducibilityReportSnapshot,
  ProducibilityRepositoryPort,
} from '@jingxu/application';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';

interface ReportRow {
  id: string;
  project_id: string;
  episode_id: string;
  episode_version_id: string | null;
  shot_version_id: string | null;
  scope: 'EPISODE' | 'SHOT';
  rule_set_version: string;
  capability_snapshot_id: string;
  reference_price_snapshot_id: string | null;
  status: 'PASS' | 'WARN' | 'BLOCK';
  disclaimer: string;
  created_at: string;
}
interface FindingRow {
  id: string;
  report_id: string;
  rule_id: string;
  rule_version: string;
  severity: 'INFO' | 'WARN' | 'BLOCK';
  json_pointer: string;
  observation: string;
  recommendation: string;
  evidence_json: string;
  source_type: 'RULE' | 'LLM';
  created_at: string;
}
interface OverrideRow {
  id: string;
  finding_id: string;
  decision: 'ACCEPT_RISK' | 'DISMISS';
  reason: string;
  actor: 'USER' | 'SYSTEM';
  created_at: string;
}
const mapReport = (row: ReportRow): ProducibilityReportRecord => ({
  capabilitySnapshotId: row.capability_snapshot_id,
  createdAt: row.created_at,
  disclaimer: row.disclaimer,
  episodeId: row.episode_id,
  episodeVersionId: row.episode_version_id ?? '',
  id: row.id,
  projectId: row.project_id,
  referencePriceSnapshotId: row.reference_price_snapshot_id,
  ruleSetVersion: row.rule_set_version as 'jingxu-producibility-rules/1',
  scope: row.scope,
  shotVersionId: row.shot_version_id,
  status: row.status,
});
const mapFinding = (row: FindingRow): ProducibilityFindingRecord => ({
  createdAt: row.created_at,
  evidenceJson: row.evidence_json,
  id: row.id,
  jsonPointer: row.json_pointer,
  observation: row.observation,
  recommendation: row.recommendation,
  reportId: row.report_id,
  ruleId: row.rule_id,
  ruleVersion: row.rule_version,
  severity: row.severity,
  sourceType: row.source_type,
});
const mapOverride = (row: OverrideRow): FindingOverrideRecord => ({
  actor: row.actor,
  createdAt: row.created_at,
  decision: row.decision,
  findingId: row.finding_id,
  id: row.id,
  reason: row.reason,
});

export class SqliteProducibilityRepository implements ProducibilityRepositoryPort {
  public constructor(private readonly db: SqliteDatabase) {}
  public insertReport(value: ProducibilityReportRecord): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          `INSERT INTO producibility_reports (id, project_id, episode_id, episode_version_id, shot_version_id, scope, rule_set_version, capability_snapshot_id, reference_price_snapshot_id, status, disclaimer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.projectId,
          value.episodeId,
          value.episodeVersionId || null,
          value.shotVersionId,
          value.scope,
          value.ruleSetVersion,
          value.capabilitySnapshotId,
          value.referencePriceSnapshotId,
          value.status,
          value.disclaimer,
          value.createdAt,
        );
    });
  }
  public insertFindings(values: readonly ProducibilityFindingRecord[]): Promise<void> {
    return syncToPromise(() => {
      const statement = this.db.prepare(
        `INSERT INTO producibility_findings (id, report_id, rule_id, rule_version, severity, json_pointer, observation, recommendation, evidence_json, source_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const value of values)
        statement.run(
          value.id,
          value.reportId,
          value.ruleId,
          value.ruleVersion,
          value.severity,
          value.jsonPointer,
          value.observation,
          value.recommendation,
          value.evidenceJson,
          value.sourceType,
          value.createdAt,
        );
    });
  }
  public insertOverride(value: FindingOverrideRecord): Promise<void> {
    return syncToPromise(() => {
      this.db
        .prepare(
          'INSERT INTO finding_overrides (id, finding_id, decision, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(value.id, value.findingId, value.decision, value.reason, value.actor, value.createdAt);
    });
  }
  public findReport(id: string): Promise<ProducibilityReportSnapshot | null> {
    return syncToPromise(() => {
      const report = this.db
        .prepare(
          `SELECT id, project_id, episode_id, episode_version_id, shot_version_id, scope, rule_set_version, capability_snapshot_id, reference_price_snapshot_id, status, disclaimer, created_at FROM producibility_reports WHERE id = ?`,
        )
        .get(id) as ReportRow | undefined;
      if (report === undefined) return null;
      const findings = this.db
        .prepare(
          `SELECT id, report_id, rule_id, rule_version, severity, json_pointer, observation, recommendation, evidence_json, source_type, created_at FROM producibility_findings WHERE report_id = ? ORDER BY created_at, id`,
        )
        .all(id) as unknown as FindingRow[];
      const ids = findings.map((finding) => finding.id);
      const overrides =
        ids.length === 0
          ? []
          : (this.db
              .prepare(
                `SELECT id, finding_id, decision, reason, actor, created_at FROM finding_overrides WHERE finding_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`,
              )
              .all(...ids) as unknown as OverrideRow[]);
      return {
        findings: findings.map(mapFinding),
        overrides: overrides.map(mapOverride),
        report: mapReport(report),
      };
    });
  }
  public findFinding(id: string): Promise<{
    readonly finding: ProducibilityFindingRecord;
    readonly report: ProducibilityReportRecord;
    readonly overrides: readonly FindingOverrideRecord[];
  } | null> {
    return syncToPromise(() => {
      const finding = this.db
        .prepare(
          `SELECT id, report_id, rule_id, rule_version, severity, json_pointer, observation, recommendation, evidence_json, source_type, created_at FROM producibility_findings WHERE id = ?`,
        )
        .get(id) as FindingRow | undefined;
      if (finding === undefined) return null;
      const report = this.db
        .prepare(
          `SELECT id, project_id, episode_id, episode_version_id, shot_version_id, scope, rule_set_version, capability_snapshot_id, reference_price_snapshot_id, status, disclaimer, created_at FROM producibility_reports WHERE id = ?`,
        )
        .get(finding.report_id) as ReportRow | undefined;
      if (report === undefined) return null;
      const overrides = this.db
        .prepare(
          'SELECT id, finding_id, decision, reason, actor, created_at FROM finding_overrides WHERE finding_id = ? ORDER BY created_at, id',
        )
        .all(id) as unknown as OverrideRow[];
      return {
        finding: mapFinding(finding),
        overrides: overrides.map(mapOverride),
        report: mapReport(report),
      };
    });
  }
  public findLatestCapabilitySnapshotId(): Promise<string | null> {
    return syncToPromise(() => {
      const row = this.db
        .prepare(
          `SELECT id FROM provider_capability_snapshots WHERE expires_at > CURRENT_TIMESTAMP ORDER BY valid_from DESC, id DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      return row?.id ?? null;
    });
  }
  public findLatestReferencePriceSnapshotId(): Promise<string | null> {
    return syncToPromise(() => {
      const row = this.db
        .prepare(
          `SELECT id FROM reference_price_snapshots WHERE capability_type = 'SHOT_PACKAGE' AND billing_unit = 'PER_SHOT' AND enabled = 1 ORDER BY effective_at DESC, id DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      return row?.id ?? null;
    });
  }
}
