// project-transfer 审计留痕断言（Playwright runner 不支持 node:sqlite，spec 关闭应用
// 释放库句柄后以子进程运行本脚本，只读断言 export_records/import_records/audit_events）：
//   A. export_records：PROJECT_TRANSFER 恰 3 行全 SUCCEEDED（首导 REJECT / 数据通路覆盖
//      CONFIRMED_OVERWRITE / UI 覆盖 CONFIRMED_OVERWRITE），request_id 唯一非空，
//      payload_sha256 64 位十六进制，result_json.inputFingerprint 64 位十六进制，
//      error_code 全 NULL；refused/门禁拒绝不落行；
//   B. import_records：SUCCEEDED 恰 3（NEW/NEW/RTO），id_mapping_json 非空、result_json 含
//      importId/projectId/sourceProjectId/warningCodes；FAILED 恰 4
//      （IDEMPOTENCY_CONFLICT/BUNDLE_INVALID/REFERENCE_INVALID/PROJECT_CONFLICT），
//      validation_errors_json 逐行对应且 project_id 全 NULL（0016 唯一索引仅约束 SUCCEEDED
//      行，FAILED 证据行可与成功行同 request_id 并存）；
//   C. audit_events：PROJECT_IMPORTED 恰 2 + PROJECT_RESTORED_FROM_BUNDLE 恰 1，
//      actor=USER、after_sha256 64 位十六进制、metadata.importMode 与 action 对应；
//   D. 零残留：projects 恰 3 行（播种 + 两次 NEW_PROJECT；全部失败导入零项目）、
//      无软删除项目、schema_migrations 含 21（含 V2 配音时间线迁移）；
//   E. 路径红线：audit 列 + result_json/validation_errors_json 不含 .json/反斜杠/
//      incoming/exports 片段（export_records.target_path 与 import_records.source_path
//      按设计存 Main 内不透明路径代称，不在检查范围，也绝不回传 Renderer）。
// 用法：node verify-transfer-audit.mjs --db <jingxu.sqlite 路径>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : '';
if (dbPath === '') {
  console.error('usage: node verify-transfer-audit.mjs --db <sqlite path>');
  process.exit(2);
}

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const violations = [];
try {
  // A. export_records。
  const exports = database
    .prepare(
      `SELECT rowid, id, status, target_path, overwrite_policy, payload_sha256, byte_size,
              error_code, request_id, result_json
       FROM export_records WHERE export_type = 'PROJECT_TRANSFER' ORDER BY rowid ASC`,
    )
    .all();
  if (exports.length !== 3) violations.push(`EXPORT_ROWS:${String(exports.length)} != 3`);
  if (
    exports.map((row) => row.overwrite_policy).join(',') !==
    'REJECT,CONFIRMED_OVERWRITE,CONFIRMED_OVERWRITE'
  ) {
    violations.push(`EXPORT_POLICY:${exports.map((row) => row.overwrite_policy).join(',')}`);
  }
  const exportRequestIds = new Set();
  for (const row of exports) {
    if (row.status !== 'SUCCEEDED') violations.push(`export${String(row.rowid)}:status`);
    if (row.error_code !== null) violations.push(`export${String(row.rowid)}:error_code`);
    if (typeof row.request_id !== 'string' || row.request_id === '') {
      violations.push(`export${String(row.rowid)}:request_id`);
    } else if (exportRequestIds.has(row.request_id)) {
      violations.push(`export${String(row.rowid)}:request_id-dup`);
    }
    exportRequestIds.add(row.request_id);
    if (typeof row.payload_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.payload_sha256)) {
      violations.push(`export${String(row.rowid)}:payload_sha256`);
    }
    if (typeof row.byte_size !== 'number' || row.byte_size <= 0) {
      violations.push(`export${String(row.rowid)}:byte_size`);
    }
    let summary = null;
    try {
      summary = JSON.parse(String(row.result_json));
    } catch {
      violations.push(`export${String(row.rowid)}:result_json`);
    }
    if (
      summary === null ||
      typeof summary.inputFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(summary.inputFingerprint) ||
      !Array.isArray(summary.warningCodes)
    ) {
      violations.push(`export${String(row.rowid)}:fingerprint`);
    }
  }

  // B. import_records。
  const imports = database
    .prepare(
      `SELECT rowid, id, project_id, import_mode, source_sha256, status,
              validation_errors_json, id_mapping_json, request_id, result_json
       FROM import_records ORDER BY rowid ASC`,
    )
    .all();
  const succeeded = imports.filter((row) => row.status === 'SUCCEEDED');
  const failed = imports.filter((row) => row.status === 'FAILED');
  if (succeeded.length !== 3) violations.push(`IMPORT_OK:${String(succeeded.length)} != 3`);
  if (failed.length !== 4) violations.push(`IMPORT_FAILED:${String(failed.length)} != 4`);
  if (
    succeeded
      .map((row) => row.import_mode)
      .sort()
      .join(',') !== 'NEW_PROJECT,NEW_PROJECT,RETURN_TO_ORIGIN'
  ) {
    violations.push(`IMPORT_MODES:${succeeded.map((row) => row.import_mode).join(',')}`);
  }
  for (const row of succeeded) {
    if (row.id_mapping_json === null) violations.push(`import${String(row.rowid)}:id_mapping`);
    if (typeof row.request_id !== 'string' || row.request_id === '') {
      violations.push(`import${String(row.rowid)}:request_id`);
    }
    let summary = null;
    try {
      summary = JSON.parse(String(row.result_json));
    } catch {
      violations.push(`import${String(row.rowid)}:result_json`);
    }
    if (
      summary === null ||
      typeof summary.importId !== 'string' ||
      typeof summary.projectId !== 'string' ||
      typeof summary.sourceProjectId !== 'string' ||
      !Array.isArray(summary.warningCodes)
    ) {
      violations.push(`import${String(row.rowid)}:summary`);
    }
  }
  const expectedFailures = [
    'TRANSFER_IDEMPOTENCY_CONFLICT',
    'TRANSFER_BUNDLE_INVALID',
    'TRANSFER_REFERENCE_INVALID',
    'TRANSFER_PROJECT_CONFLICT',
  ];
  failed.forEach((row, index) => {
    let codes = null;
    try {
      codes = JSON.parse(String(row.validation_errors_json));
    } catch {
      violations.push(`failed${String(row.rowid)}:validation_errors`);
    }
    if (!Array.isArray(codes) || codes[0] !== expectedFailures[index]) {
      violations.push(`failed${String(row.rowid)}:code`);
    }
    if (row.project_id !== null) violations.push(`failed${String(row.rowid)}:project_id`);
  });

  // C. audit_events。
  const importedAudit = database
    .prepare(
      `SELECT rowid, actor, after_sha256, metadata_json FROM audit_events
       WHERE action = 'PROJECT_IMPORTED' ORDER BY rowid ASC`,
    )
    .all();
  const restoredAudit = database
    .prepare(
      `SELECT rowid, actor, after_sha256, metadata_json FROM audit_events
       WHERE action = 'PROJECT_RESTORED_FROM_BUNDLE' ORDER BY rowid ASC`,
    )
    .all();
  if (importedAudit.length !== 2)
    violations.push(`AUDIT_IMPORTED:${String(importedAudit.length)} != 2`);
  if (restoredAudit.length !== 1)
    violations.push(`AUDIT_RESTORED:${String(restoredAudit.length)} != 1`);
  for (const row of [...importedAudit, ...restoredAudit]) {
    if (row.actor !== 'USER') violations.push(`audit${String(row.rowid)}:actor`);
    if (typeof row.after_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.after_sha256)) {
      violations.push(`audit${String(row.rowid)}:after_sha256`);
    }
  }
  for (const row of importedAudit) {
    if (JSON.parse(String(row.metadata_json)).importMode !== 'NEW_PROJECT') {
      violations.push(`audit${String(row.rowid)}:importMode`);
    }
  }
  for (const row of restoredAudit) {
    if (JSON.parse(String(row.metadata_json)).importMode !== 'RETURN_TO_ORIGIN') {
      violations.push(`audit${String(row.rowid)}:importMode`);
    }
  }

  // D. 零残留：失败/冲突导入不产生项目。
  const projects = database.prepare('SELECT COUNT(*) AS total FROM projects').get();
  const deleted = database
    .prepare('SELECT COUNT(*) AS total FROM projects WHERE deleted_at IS NOT NULL')
    .get();
  if (projects?.total !== 3) violations.push(`PROJECTS:${String(projects?.total)} != 3`);
  if (deleted?.total !== 0) violations.push(`DELETED:${String(deleted?.total)} != 0`);
  const migrations = database.prepare('SELECT MAX(version) AS latest FROM schema_migrations').get();
  if (migrations?.latest !== 21) violations.push(`MIGRATIONS:${String(migrations?.latest)} != 21`);

  // E. 路径红线：审计列 + 回执/校验 JSON 不携带文件路径痕迹
  //    （target_path/source_path 按设计落库，不在检查范围）。
  const auditSerialized = [...importedAudit, ...restoredAudit]
    .map((row) => [row.actor, row.after_sha256, row.metadata_json].join(' '))
    .join('\n');
  const recordSerialized = imports
    .map((row) => [row.result_json, row.validation_errors_json].join(' '))
    .concat(exports.map((row) => String(row.result_json)))
    .join('\n');
  for (const [label, text] of [
    ['audit', auditSerialized],
    ['records', recordSerialized],
  ]) {
    if (text.includes('.json')) violations.push(`redline:${label}:.json`);
    if (text.includes('\\')) violations.push(`redline:${label}:backslash`);
    if (text.includes('incoming')) violations.push(`redline:${label}:incoming`);
    if (text.includes('exports')) violations.push(`redline:${label}:exports`);
  }

  if (violations.length > 0) {
    console.error(JSON.stringify({ ok: false, violations }));
    process.exit(1);
  }
  console.log(
    `TRANSFER_AUDIT_OK ${JSON.stringify({
      exportRows: exports.length,
      importSucceeded: succeeded.length,
      importFailed: failed.length,
      importedAudit: importedAudit.length,
      restoredAudit: restoredAudit.length,
      projects: projects?.total,
    })}`,
  );
} finally {
  database.close();
}
