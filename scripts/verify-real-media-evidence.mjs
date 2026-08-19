// 真实联调 D6 留证断言（临时脚本，随 real-*-probe 一同删除）：
// 探针收敛后以纯 node 只读查询生产库，按 --project 过滤断言 media_model_invocations：
//   A. 每媒体任务 SUBMIT 行数 = 该任务候选数（全新整集跑=每任务 4 条）；
//   B. 终态候选 invocation_evidence_ref 逐行可 JOIN 到 SUBMIT 行（无悬空）；
//   C. SUBMIT SUCCEEDED：blob 非空、generated_images=1（provider_request_id 可空：
//      真实 Seedream 同步响应无顶层 id，非空数进 summary）；
//   D. SUBMIT FAILED：error_code 非空；原文落 blob——传输级错误（MODEL_NETWORK_ERROR/
//      MODEL_TIMEOUT，请求未获响应）无原文可落，blob NULL 属实，计入 summary；
//   E. DOWNLOAD 行：SUCCEEDED 者 blob 恒 NULL、raw_response_sha256=候选落盘 file_sha256；
//      FAILED 者（结果 URL 拉取失败）须带 error_code 且 blob 恒 NULL；
//   F. 全部行终态（豁免：在飞/中断任务的崩溃窗口残留；修复前「下载段失败未收尾
//      SUBMIT 行」的历史行——模式=SUBMIT STARTED+候选终态 FAILED+同候选 DOWNLOAD
//      FAILED 行，修复后不可能再现，计入 summary.downloadFailureResidue）。
// 用法：node scripts/verify-real-media-evidence.mjs --project <projectId> [--db <sqlite 路径>]
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
if (projectId === '') {
  console.error(
    'usage: node scripts/verify-real-media-evidence.mjs --project <projectId> [--db <sqlite path>]',
  );
  process.exit(2);
}

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const violations = [];
const decoder = new TextDecoder();
try {
  const tasks = database
    .prepare(
      `SELECT id, shot_id, round_no, phase, error_code FROM media_generation_tasks WHERE project_id = ? ORDER BY created_at ASC`,
    )
    .all(projectId);
  const taskIds = tasks.map((task) => task.id);
  if (taskIds.length === 0) {
    console.error(`REAL_MEDIA_EVIDENCE_VIOLATIONS no media tasks for project`);
    process.exit(1);
  }
  const placeholders = taskIds.map(() => '?').join(', ');
  // 候选表无 media_task_id 列：经 (shot_id, round_no) 对齐到任务（调度器同键位过滤）。
  const taskOfCandidate = new Map(
    tasks.map((task) => [`${task.shot_id}#${String(task.round_no)}`, task.id]),
  );

  const candidates = database
    .prepare(
      `SELECT c.id, c.shot_id, c.round_no, c.status, c.invocation_evidence_ref, c.file_sha256
       FROM image_candidates c
       WHERE c.project_id = ?
       ORDER BY c.shot_id ASC, c.round_no ASC, c.index_in_round ASC`,
    )
    .all(projectId)
    .map((candidate) => ({
      ...candidate,
      media_task_id: taskOfCandidate.get(`${candidate.shot_id}#${String(candidate.round_no)}`),
    }))
    .filter((candidate) => candidate.media_task_id !== undefined);
  const submitRows = database
    .prepare(
      `SELECT id, media_task_id, candidate_id, status, error_code, provider_request_id,
              provider_reported_generated_images, raw_response_blob, raw_response_sha256
       FROM media_model_invocations
       WHERE segment_kind = 'SUBMIT' AND media_task_id IN (${placeholders})
       ORDER BY media_task_id ASC, id ASC`,
    )
    .all(...taskIds);
  const downloadRows = database
    .prepare(
      `SELECT candidate_id, status, error_code, raw_response_blob, raw_response_sha256
       FROM media_model_invocations
       WHERE segment_kind = 'DOWNLOAD' AND media_task_id IN (${placeholders})`,
    )
    .all(...taskIds);

  // 中断任务（MEDIA_TASK_INTERRUPTED）与仍在飞任务（SUBMITTED/POLLING/DOWNLOADING，
  // 含等待下次启动 recover() 的崩溃残留）：候选行数与证据行数不对齐 + STARTED 残留是
  // 设计内事实（spec 崩溃窗口场景），计入 summary 不判违规。
  const activePhases = new Set(['SUBMITTED', 'POLLING', 'DOWNLOADING']);
  const interruptedTaskIds = new Set(
    tasks.filter((task) => task.error_code === 'MEDIA_TASK_INTERRUPTED').map((task) => task.id),
  );
  const activeTaskIds = new Set(
    tasks.filter((task) => activePhases.has(task.phase)).map((task) => task.id),
  );
  const exemptTaskIds = (taskId) => interruptedTaskIds.has(taskId) || activeTaskIds.has(taskId);

  // A. 每任务 SUBMIT 行数 = 候选数（全新跑候选=4/任务 → SUBMIT 4/任务）。
  const submitsByTask = new Map();
  for (const row of submitRows) {
    submitsByTask.set(row.media_task_id, (submitsByTask.get(row.media_task_id) ?? 0) + 1);
  }
  const candidatesByTask = new Map();
  for (const candidate of candidates) {
    candidatesByTask.set(
      candidate.media_task_id,
      (candidatesByTask.get(candidate.media_task_id) ?? 0) + 1,
    );
  }
  for (const [taskId, count] of candidatesByTask) {
    if (exemptTaskIds(taskId)) continue;
    if (submitsByTask.get(taskId) !== count) {
      violations.push(`TASK_SUBMIT_ROWS:${taskId}:${submitsByTask.get(taskId) ?? 0}!=${count}`);
    }
  }

  // B. 终态候选 ref 逐行可 JOIN 到 SUBMIT 行。
  const submitIds = new Set(submitRows.map((row) => row.id));
  for (const candidate of candidates) {
    if (candidate.status !== 'SUCCEEDED' && candidate.status !== 'FAILED') continue;
    if (typeof candidate.invocation_evidence_ref !== 'string') {
      violations.push(`CANDIDATE_REF_NULL:${candidate.id}`);
    } else if (!submitIds.has(candidate.invocation_evidence_ref)) {
      violations.push(
        `CANDIDATE_REF_DANGLING:${candidate.id}->${candidate.invocation_evidence_ref}`,
      );
    }
  }

  // C/D/F. SUBMIT 行终态内容。provider_request_id 以 Provider 实际返回为准：真实
  // Seedream 图片同步接口响应无顶层 id（2026-08-20 实录 top keys=model/created/data/
  // usage），该列记 null 属实，非空数计入 summary。
  const noBodyErrorCodes = new Set(['MODEL_NETWORK_ERROR', 'MODEL_TIMEOUT']);
  const downloadFailedCandidates = new Set(
    downloadRows.filter((row) => row.status === 'FAILED').map((row) => row.candidate_id),
  );
  const terminalFailedCandidates = new Set(
    candidates
      .filter((candidate) => candidate.status === 'FAILED')
      .map((candidate) => candidate.id),
  );
  let downloadFailureResidue = 0;
  let noBodyFailures = 0;
  let startedResidue = 0;
  for (const row of submitRows) {
    if (row.status === 'SUCCEEDED') {
      if (row.raw_response_blob === null) violations.push(`SUBMIT_NO_BLOB:${row.id}`);
      if (row.provider_reported_generated_images !== 1) {
        violations.push(`SUBMIT_USAGE:${row.id}:${row.provider_reported_generated_images}`);
      }
    } else if (row.status === 'FAILED') {
      if (row.error_code === null) {
        violations.push(`SUBMIT_NO_ERROR_CODE:${row.id}`);
      } else if (row.raw_response_blob === null && noBodyErrorCodes.has(row.error_code)) {
        noBodyFailures += 1;
      } else if (row.raw_response_blob === null) {
        violations.push(`SUBMIT_FAILURE_NO_BLOB:${row.id}:${row.error_code}`);
      }
    } else if (
      downloadFailedCandidates.has(row.candidate_id) &&
      terminalFailedCandidates.has(row.candidate_id)
    ) {
      // 修复前「下载段失败未收尾 SUBMIT 行」历史行（design D4 2026-08-20 修订前的
      // 真实产物）：候选已因下载失败终态、SUBMIT 行停留 STARTED——如实保留不判违规。
      downloadFailureResidue += 1;
    } else if (exemptTaskIds(row.media_task_id)) {
      startedResidue += 1;
    } else {
      violations.push(`SUBMIT_NOT_TERMINAL:${row.id}:${row.status}`);
    }
  }

  // E. DOWNLOAD 轻量行：blob 恒 NULL；SUCCEEDED 者 sha256 与候选落盘哈希一致，
  // FAILED 者（结果 URL 拉取失败）须带 error_code。
  const fileShaOf = new Map(candidates.map((candidate) => [candidate.id, candidate.file_sha256]));
  for (const row of downloadRows) {
    if (row.raw_response_blob !== null)
      violations.push(`DOWNLOAD_BLOB_NOT_NULL:${row.candidate_id}`);
    if (row.status === 'FAILED') {
      if (row.error_code === null) violations.push(`DOWNLOAD_NO_ERROR_CODE:${row.candidate_id}`);
    } else if (row.status === 'SUCCEEDED') {
      if (row.raw_response_sha256 !== fileShaOf.get(row.candidate_id)) {
        violations.push(`DOWNLOAD_SHA_MISMATCH:${row.candidate_id}`);
      }
    } else {
      violations.push(`DOWNLOAD_NOT_TERMINAL:${row.candidate_id}:${row.status}`);
    }
  }

  const summary = {
    activeTasks: activeTaskIds.size,
    candidates: candidates.length,
    downloadFailureResidue,
    downloadRows: downloadRows.length,
    failedDownloads: downloadRows.filter((row) => row.status === 'FAILED').length,
    failedSubmits: submitRows.filter((row) => row.status === 'FAILED').length,
    interruptedTasks: interruptedTaskIds.size,
    noBodyFailures,
    providerRequestIds: submitRows.filter((row) => row.provider_request_id !== null).length,
    startedResidue,
    succeededCandidates: candidates.filter((candidate) => candidate.status === 'SUCCEEDED').length,
    submitRows: submitRows.length,
    tasks: taskIds.length,
  };
  if (violations.length > 0) {
    console.error(`REAL_MEDIA_EVIDENCE_VIOLATIONS ${JSON.stringify({ summary, violations })}`);
    process.exit(1);
  }
  console.log(`REAL_MEDIA_EVIDENCE_OK ${JSON.stringify(summary)}`);
} finally {
  database.close();
}
