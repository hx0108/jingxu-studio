// 视频 ASYNC 证据断言（shot-video-generation §6.2-T3）。必须在 Electron 关闭后
// 以 node:sqlite 只读运行：SUBMIT/POLL/DOWNLOAD 三段齐备，下载字节绝不进 SQLite。
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : '';
if (dbPath === '') {
  console.error('usage: node verify-video-evidence.mjs --db <jingxu.sqlite>');
  process.exit(2);
}

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const violations = [];
try {
  const candidates = database
    .prepare(
      `SELECT id, status, invocation_evidence_ref, file_sha256
       FROM video_candidates ORDER BY shot_id, round_no, index_in_round`,
    )
    .all();
  const ids = candidates.map((candidate) => candidate.id);
  if (ids.length === 0) violations.push('VIDEO_CANDIDATES_EMPTY');
  const placeholders = ids.map(() => '?').join(',');
  const rows =
    ids.length === 0
      ? []
      : database
          .prepare(
            `SELECT id, candidate_id, segment_kind, status, raw_response_blob, raw_response_sha256
             FROM media_model_invocations WHERE candidate_id IN (${placeholders})`,
          )
          .all(...ids);
  const submits = rows.filter((row) => row.segment_kind === 'SUBMIT');
  const polls = rows.filter((row) => row.segment_kind === 'POLL');
  const downloads = rows.filter((row) => row.segment_kind === 'DOWNLOAD');
  const succeeded = candidates.filter((candidate) => candidate.status === 'SUCCEEDED');
  if (submits.length !== candidates.length) {
    violations.push(`SUBMIT_ROWS:${submits.length} != CANDIDATES:${candidates.length}`);
  }
  if (polls.length < succeeded.length) {
    violations.push(`POLL_ROWS:${polls.length} < SUCCEEDED:${succeeded.length}`);
  }
  if (downloads.length !== succeeded.length) {
    violations.push(`DOWNLOAD_ROWS:${downloads.length} != SUCCEEDED:${succeeded.length}`);
  }
  const submitIds = new Set(submits.map((row) => row.id));
  for (const candidate of candidates) {
    if (
      (candidate.status === 'SUCCEEDED' || candidate.status === 'FAILED') &&
      !submitIds.has(candidate.invocation_evidence_ref)
    ) {
      violations.push(`CANDIDATE_REF_DANGLING:${candidate.id}`);
    }
  }
  const shaByCandidate = new Map(
    succeeded.map((candidate) => [candidate.id, candidate.file_sha256]),
  );
  for (const row of downloads) {
    if (row.status !== 'SUCCEEDED') violations.push(`DOWNLOAD_NOT_SUCCEEDED:${row.candidate_id}`);
    if (row.raw_response_blob !== null)
      violations.push(`DOWNLOAD_BLOB_NOT_NULL:${row.candidate_id}`);
    if (row.raw_response_sha256 !== shaByCandidate.get(row.candidate_id)) {
      violations.push(`DOWNLOAD_SHA_MISMATCH:${row.candidate_id}`);
    }
  }
  const summary = {
    candidates: candidates.length,
    downloadRows: downloads.length,
    pollRows: polls.length,
    submitRows: submits.length,
  };
  if (violations.length > 0) {
    console.error(`VIDEO_EVIDENCE_VIOLATIONS ${JSON.stringify({ summary, violations })}`);
    process.exit(1);
  }
  console.log(`VIDEO_EVIDENCE_OK ${JSON.stringify(summary)}`);
} finally {
  database.close();
}
