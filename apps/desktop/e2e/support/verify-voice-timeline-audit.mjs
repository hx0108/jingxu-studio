// §8.1 Mock 全链审计验证脚本（v2-voice-audio-timeline）：
// Playwright runner 的 loader 不支持 node:sqlite（2026-08-16 实录），spec 关闭
// 应用释放库句柄后以子进程运行本脚本，只读断言配音→对齐→导出留痕：
//   A. voice_generation_jobs：批次终态、跳过原因白名单、两段式证据只含
//      {at,candidateId,outcome,shotId} 且不含台词明文；
//   B. voice_candidates：每目标镜头恰一候选；SUCCEEDED 四元组齐全且
//      storage 落在 projects/<pid>/audio/ 下 .wav；台词只有 sha256 无明文列；
//   C. 每目标镜头至多一条已选中候选（ux_voice_candidate_selected 应用侧镜像）；
//   D. 最新时间线版本：配音轨/字幕轨/对齐记录三表镜头集合一致；
//   E. 对齐行 rules_version 非空、类别/策略落在 DB 白名单（迁移 CHECK 兜底）；
//   F. 导出 Job SUCCEEDED：sha256 + byte_size 落库，与规格回执同源；
//   G. 红线扫描：voice_/video_timeline/video_export_jobs 各 TEXT 列不出现
//      台词明文与本地盘符路径。
// 用法：node verify-voice-timeline-audit.mjs --db <jingxu.sqlite 路径>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] ?? '') : '';
if (dbPath === '') {
  console.error('usage: node verify-voice-timeline-audit.mjs --db <sqlite path>');
  process.exit(2);
}

const PLAINTEXT_FORBIDDEN = ['这趟列车', 'C:', 'D:\\'];
const evidenceDecoder = new TextDecoder();

const database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const violations = [];
const summary = { candidates: 0, exportJobs: 0, jobs: 0, selectedCount: 0, targets: 0 };

try {
  const jobRows = database
    .prepare(
      `SELECT id, status, target_shot_ids_json, skipped_shots_json, evidence_json, error_code
       FROM voice_generation_jobs ORDER BY created_at ASC`,
    )
    .all();
  summary.jobs = jobRows.length;
  if (jobRows.length === 0) violations.push('NO_VOICE_JOBS');

  // A. 批次终态与证据形状。
  const targetShotIds = new Set();
  for (const row of jobRows) {
    if (!['COMPLETED', 'PARTIAL_COMPLETED'].includes(row.status)) {
      violations.push(`JOB_NOT_TERMINAL:${row.id}:${row.status}`);
    }
    const targets = JSON.parse(row.target_shot_ids_json);
    for (const shotId of targets) targetShotIds.add(shotId);
    for (const skip of JSON.parse(row.skipped_shots_json)) {
      if (!['NOT_VOICE_TARGET', 'ALREADY_GENERATED'].includes(skip.reason)) {
        violations.push(`SKIP_REASON_UNKNOWN:${row.id}:${String(skip.reason)}`);
      }
    }
    if (targets.length === 0) violations.push(`JOB_EMPTY_TARGETS:${row.id}`);
    for (const entry of JSON.parse(row.evidence_json)) {
      const keys = Object.keys(entry).sort().join(',');
      if (keys !== 'at,candidateId,outcome,shotId') {
        violations.push(`EVIDENCE_SHAPE:${row.id}:${keys}`);
      }
      const serialized = JSON.stringify(entry);
      for (const forbidden of PLAINTEXT_FORBIDDEN) {
        if (serialized.includes(forbidden)) violations.push(`EVIDENCE_PLAINTEXT:${row.id}`);
      }
    }
  }
  summary.targets = targetShotIds.size;

  // B. 候选四元组与红线。
  const candidateRows = database
    .prepare(
      `SELECT id, shot_id, status, spoken_text_sha256, model_id, duration_ms, file_sha256,
              byte_size, mime_type, storage_rel_path, error_code, selected_at
       FROM voice_candidates ORDER BY shot_id ASC, round_no ASC`,
    )
    .all();
  summary.candidates = candidateRows.length;
  if (candidateRows.length !== targetShotIds.size) {
    violations.push(`CANDIDATE_COUNT:${candidateRows.length} != TARGETS:${targetShotIds.size}`);
  }
  for (const row of candidateRows) {
    if (row.spoken_text_sha256?.length !== 64) violations.push(`HASH_SHAPE:${row.id}`);
    if (/^[a-f0-9]{64}$/u.test(row.spoken_text_sha256 ?? '') === false) {
      violations.push(`HASH_HEX:${row.id}`);
    }
    if (row.model_id === null || row.model_id.length === 0) {
      violations.push(`MODEL_MISSING:${row.id}`);
    }
    if (row.error_code !== null && row.status !== 'FAILED') {
      violations.push(`ERROR_CODE_ON_NON_FAILED:${row.id}`);
    }
    if (row.status === 'SUCCEEDED') {
      if (
        row.duration_ms === null ||
        !(Number(row.duration_ms) > 0) ||
        row.file_sha256?.length !== 64 ||
        row.byte_size === null ||
        Number(row.byte_size) <= 0
      ) {
        violations.push(`SUCCESS_TUPLE_INCOMPLETE:${row.id}`);
      }
      if (
        typeof row.storage_rel_path !== 'string' ||
        /^projects\/[^/]+\/audio\/.+\.wav$/u.test(row.storage_rel_path) === false
      ) {
        violations.push(`STORAGE_PATH:${row.id}:${String(row.storage_rel_path)}`);
      }
    } else if (row.storage_rel_path !== null) {
      violations.push(`NON_SUCCESS_HAS_STORAGE:${row.id}`);
    }
  }

  // C. 已选中候选每个目标镜头至多一条。
  const selected = candidateRows.filter((row) => row.selected_at !== null);
  summary.selectedCount = selected.length;
  const selectedShots = new Set(selected.map((row) => row.shot_id));
  if (selected.length !== selectedShots.size) violations.push('MULTI_SELECTED_PER_SHOT');
  if (selected.length !== targetShotIds.size) {
    violations.push(`SELECTED:${selected.length} != TARGETS:${targetShotIds.size}`);
  }

  // D/E. 最新时间线版本的三表镜头集合一致 + 规则版本非空。
  const latestVersion = database
    .prepare(
      `SELECT id FROM video_timeline_versions ORDER BY created_at DESC, version_no DESC LIMIT 1`,
    )
    .get();
  if (latestVersion === undefined) {
    violations.push('NO_TIMELINE_VERSION');
  } else {
    const timelineId = latestVersion.id;
    const readShots = (sql) =>
      new Set(
        database
          .prepare(sql)
          .all(timelineId)
          .map((r) => r.shot_id),
      );
    const voiceShots = readShots(
      'SELECT shot_id FROM video_timeline_voice_items WHERE timeline_version_id = ?',
    );
    const subtitleShots = readShots(
      'SELECT shot_id FROM video_timeline_subtitle_items WHERE timeline_version_id = ?',
    );
    const alignmentRows = database
      .prepare(
        `SELECT shot_id, category, strategy, manual_override, dialogue_complete,
                storyboard_fallback, rules_version
         FROM video_timeline_alignment_items WHERE timeline_version_id = ?`,
      )
      .all(timelineId);
    const alignmentShots = new Set(alignmentRows.map((row) => row.shot_id));
    const sameSet =
      voiceShots.size === subtitleShots.size &&
      subtitleShots.size === alignmentShots.size &&
      [...voiceShots].every((shotId) => subtitleShots.has(shotId) && alignmentShots.has(shotId));
    if (sameSet === false) {
      violations.push(
        `TRACK_SET_MISMATCH:v${voiceShots.size}/s${subtitleShots.size}/a${alignmentShots.size}`,
      );
    }
    if (voiceShots.size !== targetShotIds.size) {
      violations.push(`VOICE_TRACK_COUNT:${voiceShots.size} != TARGETS:${targetShotIds.size}`);
    }
    // 声乐轨道全启用为全链口径（启停编辑是显式动作）。
    const enabledVoice = database
      .prepare(
        'SELECT COUNT(*) AS n FROM video_timeline_voice_items WHERE timeline_version_id = ? AND enabled = 1',
      )
      .get(timelineId);
    if (Number(enabledVoice.n) !== voiceShots.size) {
      violations.push(`VOICE_DISABLED_ROWS:${String(enabledVoice.n)}/${String(voiceShots.size)}`);
    }
    for (const row of alignmentRows) {
      if (typeof row.rules_version !== 'string' || row.rules_version.length === 0) {
        violations.push(`RULES_VERSION_EMPTY:${row.shot_id}`);
      }
      if (row.manual_override !== null && row.storyboard_fallback !== 1) {
        // FORCE_TRIM 是唯一覆盖回退行的合法出口；人工覆盖必须伴随解除阻断。
        if (Number(row.dialogue_complete) !== 0) {
          violations.push(`OVERRIDE_WITHOUT_BLOCK_RELIEF:${row.shot_id}`);
        }
      }
    }
  }

  // F. 导出 Job 终态。
  const exportRows = database
    .prepare(
      `SELECT id, status, file_sha256, byte_size, error_code, total_duration_ms
       FROM video_export_jobs ORDER BY created_at DESC LIMIT 5`,
    )
    .all();
  summary.exportJobs = exportRows.length;
  if (exportRows.length === 0) violations.push('NO_EXPORT_JOBS');
  for (const row of exportRows) {
    if (row.status !== 'SUCCEEDED') violations.push(`EXPORT_NOT_SUCCEEDED:${row.id}:${row.status}`);
    if (row.file_sha256?.length !== 64) violations.push(`EXPORT_SHA_MISSING:${row.id}`);
    if (!(Number(row.byte_size) > 0)) violations.push(`EXPORT_BYTES_MISSING:${row.id}`);
    if (!(Number(row.total_duration_ms) > 0)) violations.push(`EXPORT_DURATION_MISSING:${row.id}`);
  }

  // G. 红线全表扫描（voice_ / video_timeline / video_export_jobs）。
  const tables = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((row) => row.name)
    .filter(
      (name) =>
        name.startsWith('voice_') ||
        name.startsWith('video_timeline') ||
        name === 'video_export_jobs',
    );
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    const textColumns = columns
      .filter((column) => ['TEXT', 'BLOB'].includes(column.type))
      .map((column) => column.name);
    for (const column of textColumns) {
      const rows = database.prepare(`SELECT ${column} AS value FROM ${table}`).all();
      for (const row of rows) {
        if (typeof row.value !== 'string' && !(row.value instanceof Uint8Array)) continue;
        const text = typeof row.value === 'string' ? row.value : evidenceDecoder.decode(row.value);
        for (const forbidden of PLAINTEXT_FORBIDDEN) {
          if (text.includes(forbidden)) {
            violations.push(`RED_LINE:${table}.${column}:${forbidden}`);
          }
        }
      }
    }
  }
} finally {
  database.close();
}

if (violations.length > 0) {
  console.log(JSON.stringify({ result: 'VOICE_AUDIT_VIOLATIONS', violations }, null, 2));
  process.exit(1);
}
console.log(
  JSON.stringify({
    candidates: summary.candidates,
    exportJobs: summary.exportJobs,
    jobs: summary.jobs,
    result: 'VOICE_AUDIT_OK',
    selected: summary.selectedCount,
    targets: summary.targets,
  }),
);
