// E2E mock 档证据断言（media-invocation-evidence 任务 3.1）：
// Playwright runner 的 loader 不支持 node:sqlite（2026-08-16 实录），spec 关闭
// 应用释放库句柄后以子进程运行本脚本，只读断言 media_model_invocations：
//   A. SUBMIT 行数 = 候选数（每候选一条）；DOWNLOAD 行数 = 成功候选数；
//   B. 终态候选 invocation_evidence_ref 逐行可 JOIN 到 SUBMIT 行；
//   C. SUBMIT SUCCEEDED：blob 非空、usage 图片数=1、provider_request_id 非空；
//   D. SUBMIT FAILED：error_code 非空且错误原文落 blob（Mock 确定性 JSON）；
//   E. DOWNLOAD SUCCEEDED：blob 恒 NULL（字节只在内容寻址存储）、sha256=候选落盘哈希。
// 用法：node verify-media-evidence.mjs --db <jingxu.sqlite 路径>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : '';
if (dbPath === '') {
  console.error('usage: node verify-media-evidence.mjs --db <sqlite path>');
  process.exit(2);
}

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const violations = [];
const decoder = new TextDecoder();
try {
  const candidates = database
    .prepare(
      `SELECT c.id, c.status, c.invocation_evidence_ref, c.file_sha256
       FROM image_candidates c ORDER BY c.shot_id ASC, c.round_no ASC, c.index_in_round ASC`,
    )
    .all();
  const submitRows = database
    .prepare(
      `SELECT id, candidate_id, status, error_code, provider_request_id,
              provider_reported_generated_images, raw_response_blob, raw_response_sha256
       FROM media_model_invocations WHERE segment_kind = 'SUBMIT'`,
    )
    .all();
  const downloadRows = database
    .prepare(
      `SELECT candidate_id, status, raw_response_blob, raw_response_sha256
       FROM media_model_invocations WHERE segment_kind = 'DOWNLOAD'`,
    )
    .all();

  const terminal = candidates.filter(
    (candidate) => candidate.status === 'SUCCEEDED' || candidate.status === 'FAILED',
  );
  const succeeded = candidates.filter((candidate) => candidate.status === 'SUCCEEDED');

  // A. 行数 = 候选数（SUBMIT+DOWNLOAD 各按其口径）。
  if (submitRows.length !== candidates.length) {
    violations.push(`SUBMIT_ROWS:${submitRows.length} != CANDIDATES:${candidates.length}`);
  }
  if (downloadRows.length !== succeeded.length) {
    violations.push(`DOWNLOAD_ROWS:${downloadRows.length} != SUCCEEDED:${succeeded.length}`);
  }

  // B. 终态候选 ref 逐行可 JOIN 到 SUBMIT 行（消灭悬空引用）。
  const submitIds = new Set(submitRows.map((row) => row.id));
  for (const candidate of terminal) {
    if (typeof candidate.invocation_evidence_ref !== 'string') {
      violations.push(`CANDIDATE_REF_NULL:${candidate.id}`);
    } else if (!submitIds.has(candidate.invocation_evidence_ref)) {
      violations.push(
        `CANDIDATE_REF_DANGLING:${candidate.id}->${candidate.invocation_evidence_ref}`,
      );
    }
  }

  // C/D. SUBMIT 行终态内容。
  for (const row of submitRows) {
    if (row.status === 'SUCCEEDED') {
      if (row.raw_response_blob === null) violations.push(`SUBMIT_NO_BLOB:${row.id}`);
      if (row.provider_reported_generated_images !== 1) {
        violations.push(`SUBMIT_USAGE:${row.id}:${row.provider_reported_generated_images}`);
      }
      if (row.provider_request_id === null) violations.push(`SUBMIT_NO_REQUEST_ID:${row.id}`);
    } else if (row.status === 'FAILED') {
      if (row.error_code === null) violations.push(`SUBMIT_NO_ERROR_CODE:${row.id}`);
      if (row.raw_response_blob === null) {
        violations.push(`SUBMIT_FAILURE_NO_BLOB:${row.id}`);
      } else {
        // Mock 确定性错误原文：{"error":{"code":"…","invocation":"…"}}。
        const bodyText = decoder.decode(row.raw_response_blob);
        if (!bodyText.includes('"error"') || !bodyText.includes('"invocation"')) {
          violations.push(`SUBMIT_FAILURE_BODY_NOT_MOCK_JSON:${row.id}`);
        }
      }
    } else {
      violations.push(`SUBMIT_NOT_TERMINAL:${row.id}:${row.status}`);
    }
  }

  // E. DOWNLOAD 轻量行：blob 恒 NULL，sha256 与候选落盘哈希一致。
  const fileShaOf = new Map(succeeded.map((candidate) => [candidate.id, candidate.file_sha256]));
  for (const row of downloadRows) {
    if (row.raw_response_blob !== null)
      violations.push(`DOWNLOAD_BLOB_NOT_NULL:${row.candidate_id}`);
    if (row.raw_response_sha256 !== fileShaOf.get(row.candidate_id)) {
      violations.push(`DOWNLOAD_SHA_MISMATCH:${row.candidate_id}`);
    }
  }

  const summary = {
    candidates: candidates.length,
    downloadRows: downloadRows.length,
    failedSubmits: submitRows.filter((row) => row.status === 'FAILED').length,
    succeededCandidates: succeeded.length,
    submitRows: submitRows.length,
  };
  if (violations.length > 0) {
    console.error(`MEDIA_EVIDENCE_VIOLATIONS ${JSON.stringify({ summary, violations })}`);
    process.exit(1);
  }
  console.log(`MEDIA_EVIDENCE_OK ${JSON.stringify(summary)}`);
} finally {
  database.close();
}
