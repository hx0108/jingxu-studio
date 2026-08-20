// storyboard-export 审计留痕断言（spec §Σ 偏离确认留痕 / 落盘留痕场景）：
// Playwright runner 的 loader 不支持 node:sqlite（2026-08-16 实录），spec 关闭
// 应用释放库句柄后以子进程运行本脚本，只读断言 audit_events：
//   A. STORYBOARD_EXPORTED 恰好 3 行（v1 UI 顺利导出 / v1 数据通路导出 / 偏离确认重发）；
//   B. actor=USER、object_type=EPISODE_VERSION、before_sha256 为 NULL、
//      after_sha256 为 64 位十六进制且与 metadata.fileSha256 逐行一致；
//   C. metadata 完整：byteSize 与 totalDurationSec 顺序 [90,90,48]、
//      deviationReason 顺序 [null,null,'快闪节奏整集']（D5 留痕语义）；
//   D. 路径红线：审计行任何列（含 metadata_json）不含 .json / 反斜杠 / exportDir 片段。
// 用法：node verify-storyboard-export.mjs --db <jingxu.sqlite 路径>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : '';
if (dbPath === '') {
  console.error('usage: node verify-storyboard-export.mjs --db <sqlite path>');
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

  // A. 行数 = 3（多则泄留痕、少则漏留痕都不允许）。
  if (rows.length !== 3) violations.push(`ROWS:${String(rows.length)} != 3`);

  // B. 结构与哈希一致性。
  for (const row of rows) {
    if (row.actor !== 'USER') violations.push(`row${String(row.rowid)}:actor`);
    if (row.object_type !== 'EPISODE_VERSION') violations.push(`row${String(row.rowid)}:object_type`);
    if (row.before_sha256 !== null) violations.push(`row${String(row.rowid)}:before_sha256`);
    if (typeof row.after_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.after_sha256)) {
      violations.push(`row${String(row.rowid)}:after_sha256`);
    }
    if (row.trace_id === null || row.trace_id === '') violations.push(`row${String(row.rowid)}:trace_id`);
  }

  // C. metadata 语义（顺序 = rowid 插入顺序）。
  const metadata = rows.map((row) => {
    try {
      return JSON.parse(String(row.metadata_json));
    } catch {
      return null;
    }
  });
  if (metadata.some((entry) => entry === null)) violations.push('metadata:unparsable');
  if (metadata.length === 3) {
    const totals = metadata.map((entry) => entry?.totalDurationSec);
    const reasons = metadata.map((entry) => entry?.deviationReason ?? null);
    if (totals.join(',') !== '90,90,48') violations.push(`totals:${totals.join(',')}`);
    if (reasons.join(',') !== ',,快闪节奏整集') violations.push(`reasons:${reasons.join(',')}`);
    for (let index = 0; index < 3; index += 1) {
      const entry = metadata[index];
      if (typeof entry?.byteSize !== 'number' || entry.byteSize <= 0) {
        violations.push(`row${String(index + 1)}:byteSize`);
      }
      if (entry?.fileSha256 !== rows[index]?.after_sha256) {
        violations.push(`row${String(index + 1)}:fileSha256-mismatch`);
      }
    }
  }

  // D. 路径红线：任何列都不携带文件路径痕迹。
  const serialized = rows
    .map((row) =>
      [row.id, row.object_id, row.object_version_id, row.after_sha256, row.metadata_json].join(' '),
    )
    .join('\n');
  if (serialized.includes('.json')) violations.push('redline:.json');
  if (serialized.includes('\\')) violations.push('redline:backslash');
  if (serialized.includes('exports')) violations.push('redline:exportDir');
  if (serialized.includes('path')) violations.push('redline:path-key');

  if (violations.length > 0) {
    console.error(JSON.stringify({ ok: false, violations }));
    process.exit(1);
  }
  console.log(`STORYBOARD_EXPORT_AUDIT_OK ${JSON.stringify({ rows: rows.length })}`);
} finally {
  database.close();
}
