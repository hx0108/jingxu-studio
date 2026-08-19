// 真实联调 D3 留证（临时脚本，随 real-*-probe 一同删除）：
// Playwright runner 的 loader 不支持 node:sqlite（2026-08-16 实录），探针 spec 只输出
// projectId/jobIds；本脚本以纯 node 只读查询生产库，输出本运行全部脚本作业的调用行
// （attempt_kind/transport_attempt/timeout_at/error_code），对比 2026-08-17 基线
// （SHOT_CONTRACT 120s 超时 5/8）；media-invocation-evidence 后增媒体域段
// （media_model_invocations × media_generation_tasks 联查：model/segment/status/
// http/error_code/usage/耗时）。
// 用法：node scripts/print-real-probe-invocations.mjs [--project <projectId>] [--db <sqlite 路径>]
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
const projectId = projectIndex >= 0 ? (args[projectIndex + 1] ?? '') : '';
const dbIndex = args.indexOf('--db');
const dbPath =
  dbIndex >= 0
    ? (args[dbIndex + 1] ?? '')
    : path.join(process.env.LOCALAPPDATA ?? '', 'JingxuStudio', 'data', 'jingxu.sqlite');
if (projectId === '' && dbIndex < 0) {
  console.error(
    'usage: node scripts/print-real-probe-invocations.mjs [--project <projectId>] [--db <sqlite path>]',
  );
  process.exit(2);
}

const durationMsOf = (startedAt, finishedAt) => {
  if (typeof finishedAt !== 'string' || typeof startedAt !== 'string') return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
};

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
try {
  if (projectId !== '') {
    const jobs = database
      .prepare('SELECT id FROM script_stage_jobs WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId);
    if (jobs.length === 0) {
      console.error(`REAL_PROBE_EVIDENCE no jobs for project ${projectId}`);
    } else {
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
    }
  }

  // 媒体域联查（design D6）：全库或按 project 过滤；耗时 = finished_at - created_at。
  const mediaRows =
    projectId === ''
      ? database
          .prepare(
            `SELECT t.id AS task_id, t.project_id, t.shot_id, t.round_no, t.phase AS task_phase,
                    i.model_id, i.segment_kind, i.status, i.response_http_status, i.error_code,
                    i.provider_reported_generated_images, i.provider_reported_output_tokens,
                    i.raw_response_blob IS NOT NULL AS has_blob, i.raw_response_truncated,
                    i.provider_request_id, i.created_at, i.finished_at
             FROM media_generation_tasks t
             LEFT JOIN media_model_invocations i ON i.media_task_id = t.id
             ORDER BY t.created_at ASC, i.created_at ASC, i.id ASC`,
          )
          .all()
      : database
          .prepare(
            `SELECT t.id AS task_id, t.project_id, t.shot_id, t.round_no, t.phase AS task_phase,
                    i.model_id, i.segment_kind, i.status, i.response_http_status, i.error_code,
                    i.provider_reported_generated_images, i.provider_reported_output_tokens,
                    i.raw_response_blob IS NOT NULL AS has_blob, i.raw_response_truncated,
                    i.provider_request_id, i.created_at, i.finished_at
             FROM media_generation_tasks t
             LEFT JOIN media_model_invocations i ON i.media_task_id = t.id
             WHERE t.project_id = ?
             ORDER BY t.created_at ASC, i.created_at ASC, i.id ASC`,
          )
          .all(projectId);
  console.log(
    `REAL_PROBE_MEDIA_EVIDENCE ${JSON.stringify(
      mediaRows.map((row) => ({
        ...row,
        duration_ms: durationMsOf(row.created_at, row.finished_at),
      })),
    )}`,
  );
} finally {
  database.close();
}
