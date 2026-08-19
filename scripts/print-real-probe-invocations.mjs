// 真实联调 D3 留证（临时脚本，随 real-seedream-probe 一同删除）：
// Playwright runner 的 loader 不支持 node:sqlite（2026-08-16 实录），探针 spec 只输出
// projectId/jobIds；本脚本以纯 node 只读查询生产库，输出本运行全部脚本作业的调用行
// （attempt_kind/transport_attempt/timeout_at/error_code），对比 2026-08-17 基线
// （SHOT_CONTRACT 120s 超时 5/8）。
// 用法：node scripts/print-real-probe-invocations.mjs --project <projectId>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
const projectId = projectIndex >= 0 ? (args[projectIndex + 1] ?? '') : '';
if (projectId === '') {
  console.error('usage: node scripts/print-real-probe-invocations.mjs --project <projectId>');
  process.exit(2);
}
const database = new DatabaseSync(
  path.join(process.env.LOCALAPPDATA ?? '', 'JingxuStudio', 'data', 'jingxu.sqlite'),
  { readOnly: true },
);
try {
  const jobs = database
    .prepare('SELECT id FROM script_stage_jobs WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId);
  if (jobs.length === 0) {
    console.error(`REAL_PROBE_EVIDENCE no jobs for project ${projectId}`);
    process.exit(3);
  }
  const placeholders = jobs.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT j.stage, j.status AS job_status, j.error_code AS job_error_code,
              j.transport_attempts AS job_transport_attempts, j.deadline_at,
              i.attempt_kind, i.transport_attempt, i.status AS invocation_status,
              i.error_code AS invocation_error_code, i.timeout_at,
              i.started_at, i.finished_at
       FROM script_stage_jobs j LEFT JOIN model_invocations i ON i.job_id = j.id
       WHERE j.id IN (${placeholders})
       ORDER BY j.created_at ASC, i.started_at ASC, i.id ASC`,
    )
    .all(...jobs.map((job) => job.id));
  console.log(`REAL_PROBE_EVIDENCE ${JSON.stringify(rows)}`);
} finally {
  database.close();
}
