// storyboard-export-deliverables 审计留痕断言（spec 落盘留痕 MODIFIED：metadata.format）：
// Playwright runner 的 loader 不支持 node:sqlite，spec 关闭应用释放库句柄后以子进程
// 运行本脚本，只读断言 audit_events：
//   A. STORYBOARD_EXPORTED 恰好 4 行（v1 分镜表 / v1 报告 / v2 报告(WARN) / v2 UI 分镜表）；
//   B. metadata.format 顺序 = MARKDOWN_TABLE,PRODUCIBILITY_REPORT,PRODUCIBILITY_REPORT,MARKDOWN_TABLE
//      且每行 format ∈ 三值枚举；totalDurationSec 恒 90、deviationReason 恒 null；
//   C. actor=USER、object_type=EPISODE_VERSION、before_sha256 NULL、
//      after_sha256 64 位十六进制且与 metadata.fileSha256 逐行一致；
//   D. 路径红线：审计行任何列（含 metadata_json）不含 .md/.json/反斜杠/exports 片段。
// 用法：node verify-storyboard-deliverables.mjs --db <jingxu.sqlite 路径>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : '';
if (dbPath === '') {
  console.error('usage: node verify-storyboard-deliverables.mjs --db <sqlite path>');
  process.exit(2);
}

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const violations = [];
try {
  const rows = database
    .prepare(
      `SELECT rowid, id, project_id, actor, action, object_type, object_id, object_version_id,
              before_sha256, after_sha256, metadata_json, trace_id, created_at
       FROM audit_events WHERE action = 'STORYBOARD_EXPORTED' ORDER BY rowid ASC`,
    )
    .all();

  // A. 行数 = 4（多则泄留痕、少则漏留痕都不允许）。
  if (rows.length !== 4) violations.push(`ROWS:${String(rows.length)} != 4`);

  const metadata = rows.map((row) => {
    try {
      return JSON.parse(String(row.metadata_json));
    } catch {
      return null;
    }
  });
  if (metadata.some((entry) => entry === null)) violations.push('metadata:unparsable');

  // B. format 语义（顺序 = rowid 插入顺序；deliverables D1 三值枚举）。
  const FORMATS = [
    'MARKDOWN_TABLE',
    'PRODUCIBILITY_REPORT',
    'PRODUCIBILITY_REPORT',
    'MARKDOWN_TABLE',
  ];
  if (metadata.length === 4) {
    const formats = metadata.map((entry) => entry?.format);
    if (formats.join(',') !== FORMATS.join(',')) {
      violations.push(`formats:${formats.join(',')}`);
    }
    const totals = metadata.map((entry) => entry?.totalDurationSec);
    if (totals.join(',') !== '90,90,90,90') violations.push(`totals:${totals.join(',')}`);
    const reasons = metadata.map((entry) => entry?.deviationReason ?? null);
    if (reasons.some((reason) => reason !== null)) violations.push('reasons:expected-null');
    for (let index = 0; index < 4; index += 1) {
      const entry = metadata[index];
      if (typeof entry?.byteSize !== 'number' || entry.byteSize <= 0) {
        violations.push(`row${String(index + 1)}:byteSize`);
      }
      if (entry?.fileSha256 !== rows[index]?.after_sha256) {
        violations.push(`row${String(index + 1)}:fileSha256-mismatch`);
      }
    }
  }

  // C. 结构一致性。
  for (const row of rows) {
    if (row.actor !== 'USER') violations.push(`row${String(row.rowid)}:actor`);
    if (row.object_type !== 'EPISODE_VERSION')
      violations.push(`row${String(row.rowid)}:object_type`);
    if (row.before_sha256 !== null) violations.push(`row${String(row.rowid)}:before_sha256`);
    if (typeof row.after_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.after_sha256)) {
      violations.push(`row${String(row.rowid)}:after_sha256`);
    }
    if (row.trace_id === null || row.trace_id === '')
      violations.push(`row${String(row.rowid)}:trace_id`);
  }

  // D. 路径红线：任何列都不携带文件路径痕迹（含 .md/.json 扩展名）。
  const serialized = rows
    .map((row) =>
      [row.id, row.object_id, row.object_version_id, row.after_sha256, row.metadata_json].join(' '),
    )
    .join('\n');
  if (serialized.includes('.md')) violations.push('redline:.md');
  if (serialized.includes('.json')) violations.push('redline:.json');
  if (serialized.includes('\\')) violations.push('redline:backslash');
  if (serialized.includes('exports')) violations.push('redline:exportDir');

  if (violations.length > 0) {
    console.error(JSON.stringify({ ok: false, violations }));
    process.exit(1);
  }
  console.log(`STORYBOARD_DELIVERABLES_AUDIT_OK ${JSON.stringify({ rows: rows.length })}`);
} finally {
  database.close();
}
