// 0027 逆操作：把 head-27 库的时间线相关四表降回 v26 形状，构造"旧版应用创建的库"。
// 仅用于旧项目兼容 E2E：先由当前版本应用创建真实项目，再降级，最后由应用重新迁移 0027。
// 前提：每个 (时间线版本, 镜头) 只有一个画面片段——旧应用 createTimeline 的唯一形态。
// 用法：node downgrade-timeline-to-v26.mjs <databasePath>；成功输出 JSON 摘要。
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2];
if (databasePath === undefined) throw new Error('USAGE: node downgrade-timeline-to-v26.mjs <db>');
const database = new DatabaseSync(databasePath);

const headRow = database.prepare('SELECT MAX(version) AS head FROM schema_migrations').get();
if (headRow?.head !== 27)
  throw new Error(`EXPECTED_MIGRATION_HEAD_27_GOT_${String(headRow?.head)}`);

const fragmented = database
  .prepare(
    `SELECT timeline_version_id, shot_id, COUNT(*) AS fragments
     FROM video_timeline_items GROUP BY timeline_version_id, shot_id
     HAVING COUNT(*) > 1 LIMIT 1`,
  )
  .get();
if (fragmented !== undefined) {
  throw new Error(`MULTI_FRAGMENT_PER_SHOT_UNSUPPORTED:${JSON.stringify(fragmented)}`);
}

// 外键关闭期间执行表重建；结束前必须通过 foreign_key_check 才视为成功。
database.exec('PRAGMA foreign_keys = OFF');

// 结构哨兵：head-27 四表列集必须与预期逐一相符；发现漂移立即失败，绝不静默错拷。
const expectedColumns = {
  command_receipts: [
    'request_id',
    'command_name',
    'payload_sha256',
    'project_id',
    'result_ref_json',
    'trace_id',
    'committed_at',
  ],
  video_timeline_items: [
    'timeline_version_id',
    'clip_id',
    'shot_id',
    'candidate_id',
    'file_sha256',
    'generation_input_hash',
    'position',
    'target_start_ms',
    'enabled',
    'trim_in_ms',
    'trim_out_ms',
  ],
  video_timeline_versions: [
    'id',
    'timeline_id',
    'episode_version_id',
    'format_profile_id',
    'version_no',
    'parent_version_id',
    'input_hash',
    'audio_asset_id',
    'total_duration_ms',
    'audio_volume',
    'voice_track_muted',
    'bgm_start_ms',
    'bgm_trim_in_ms',
    'bgm_trim_out_ms',
    'bgm_muted',
    'bgm_fade_in_ms',
    'bgm_fade_out_ms',
    'created_at',
  ],
  video_timeline_voice_items: [
    'timeline_version_id',
    'clip_id',
    'shot_id',
    'candidate_id',
    'file_sha256',
    'generation_input_hash',
    'offset_ms',
    'target_start_ms',
    'volume',
    'trim_in_ms',
    'trim_out_ms',
    'enabled',
  ],
};
for (const [table, expected] of Object.entries(expectedColumns)) {
  const actual = database
    .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY name`)
    .all(table)
    .map((row) => row.name)
    .sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `SCHEMA_DRIFT_${table}:expected=${JSON.stringify(expectedSorted)},actual=${JSON.stringify(actual)}`,
    );
  }
}

// 1) 对白子表先行：还原 offset_ms 需要画面子表尚未重建（双方都还保有 target_start_ms）。
//    去掉 clip_id，offset_ms = 对白绝对起点 − 所属画面片段起点（0027 的反向回填）。
database.exec(`
CREATE TABLE video_timeline_voice_items_v26 (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  candidate_id TEXT NOT NULL REFERENCES voice_candidates(id),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  offset_ms INTEGER NOT NULL CHECK (offset_ms >= 0),
  volume REAL NOT NULL CHECK (volume >= 0 AND volume <= 1),
  trim_in_ms INTEGER NOT NULL CHECK (trim_in_ms >= 0),
  trim_out_ms INTEGER NOT NULL CHECK (trim_out_ms > trim_in_ms),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (timeline_version_id, shot_id)
);
INSERT INTO video_timeline_voice_items_v26
  (timeline_version_id, shot_id, candidate_id, file_sha256, generation_input_hash,
   offset_ms, volume, trim_in_ms, trim_out_ms, enabled)
SELECT v.timeline_version_id, v.shot_id, v.candidate_id, v.file_sha256, v.generation_input_hash,
       v.target_start_ms - i.target_start_ms, v.volume, v.trim_in_ms, v.trim_out_ms, v.enabled
FROM video_timeline_voice_items AS v
JOIN video_timeline_items AS i
  ON i.timeline_version_id = v.timeline_version_id AND i.shot_id = v.shot_id;
DROP TABLE video_timeline_voice_items;
ALTER TABLE video_timeline_voice_items_v26 RENAME TO video_timeline_voice_items;
CREATE INDEX ix_voice_timeline_items_candidate ON video_timeline_voice_items(candidate_id);
`);

// 2) 画面子表：去掉 clip_id / target_start_ms，恢复 0019 的 (版本, 镜头) 主键。
database.exec(`
CREATE TABLE video_timeline_items_v26 (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  candidate_id TEXT NOT NULL REFERENCES video_candidates(id),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  position INTEGER NOT NULL CHECK (position >= 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trim_in_ms INTEGER NOT NULL CHECK (trim_in_ms >= 0),
  trim_out_ms INTEGER NOT NULL CHECK (trim_out_ms > trim_in_ms),
  PRIMARY KEY (timeline_version_id, shot_id),
  UNIQUE (timeline_version_id, position)
);
INSERT INTO video_timeline_items_v26
  (timeline_version_id, shot_id, candidate_id, file_sha256, generation_input_hash,
   position, enabled, trim_in_ms, trim_out_ms)
SELECT timeline_version_id, shot_id, candidate_id, file_sha256, generation_input_hash,
       position, enabled, trim_in_ms, trim_out_ms
FROM video_timeline_items;
DROP TABLE video_timeline_items;
ALTER TABLE video_timeline_items_v26 RENAME TO video_timeline_items;
`);

// 3) 版本表：去掉 voice_track_muted 与 bgm_* 七列，恢复 0019+0020（含 audio_volume）形状与其索引。
database.exec(`
CREATE TABLE video_timeline_versions_v26 (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES video_timelines(id) ON DELETE CASCADE,
  episode_version_id TEXT NOT NULL REFERENCES episode_versions(id),
  format_profile_id TEXT NOT NULL REFERENCES format_profiles(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  parent_version_id TEXT REFERENCES video_timeline_versions(id),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  audio_asset_id TEXT,
  total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),
  audio_volume REAL NOT NULL DEFAULT 0.2,
  created_at TEXT NOT NULL,
  UNIQUE (timeline_id, version_no)
);
INSERT INTO video_timeline_versions_v26
  (id, timeline_id, episode_version_id, format_profile_id, version_no, parent_version_id,
   input_hash, audio_asset_id, total_duration_ms, audio_volume, created_at)
SELECT id, timeline_id, episode_version_id, format_profile_id, version_no, parent_version_id,
       input_hash, audio_asset_id, total_duration_ms, audio_volume, created_at
FROM video_timeline_versions;
DROP TABLE video_timeline_versions;
ALTER TABLE video_timeline_versions_v26 RENAME TO video_timeline_versions;
CREATE INDEX ix_video_timeline_versions_timeline ON video_timeline_versions(timeline_id, version_no DESC);
`);

// 4) 回执表：恢复 0018 的 CHECK 枚举（无 UPDATE_VIDEO_TIMELINE），旧应用不存在该回执。
const droppedReceipts = database
  .prepare('SELECT COUNT(*) AS count FROM command_receipts WHERE command_name = ?')
  .get('UPDATE_VIDEO_TIMELINE');
database.exec(`
CREATE TABLE command_receipts_v26 (
  request_id TEXT PRIMARY KEY,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'CREATE_PROJECT', 'UPDATE_PROJECT', 'DELETE_PROJECT', 'RESTORE_PROJECT',
    'INITIALIZE_ORIGINAL', 'INITIALIZE_INPUT', 'REWRITE_SELECTION',
    'SAVE_SCRIPT_DRAFT', 'CONFIRM_SCRIPT_VERSION', 'RESTORE_SCRIPT_VERSION'
  )),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_id TEXT REFERENCES projects(id),
  result_ref_json TEXT NOT NULL CHECK (json_valid(result_ref_json)),
  trace_id TEXT NOT NULL CHECK (length(trace_id) > 0),
  committed_at TEXT NOT NULL
);
INSERT INTO command_receipts_v26
  (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
SELECT request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at
FROM command_receipts
WHERE command_name <> 'UPDATE_VIDEO_TIMELINE';
DROP TABLE command_receipts;
ALTER TABLE command_receipts_v26 RENAME TO command_receipts;
CREATE INDEX ix_command_receipts_project ON command_receipts(project_id) WHERE project_id IS NOT NULL;
`);

// 5) 回退迁移账本到 26，让应用首启重新应用 0027。
database.exec('DELETE FROM schema_migrations WHERE version = 27');

const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
if (foreignKeyViolations.length > 0) {
  throw new Error(`FOREIGN_KEY_CHECK_FAILED:${JSON.stringify(foreignKeyViolations)}`);
}
const integrity = database.prepare('PRAGMA integrity_check').get();
if (integrity?.integrity_check !== 'ok') {
  throw new Error(`INTEGRITY_CHECK_FAILED:${JSON.stringify(integrity)}`);
}
const counts = {
  items: database.prepare('SELECT COUNT(*) AS count FROM video_timeline_items').get()?.count ?? 0,
  voiceItems:
    database.prepare('SELECT COUNT(*) AS count FROM video_timeline_voice_items').get()?.count ?? 0,
  versions:
    database.prepare('SELECT COUNT(*) AS count FROM video_timeline_versions').get()?.count ?? 0,
  receipts: database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()?.count ?? 0,
};
database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
database.close();
process.stdout.write(
  JSON.stringify({
    counts,
    droppedReceipts: droppedReceipts?.count ?? 0,
    foreignKeyViolations: 0,
    headBefore: 27,
    headAfter: 26,
    integrity: integrity?.integrity_check ?? null,
  }),
);
