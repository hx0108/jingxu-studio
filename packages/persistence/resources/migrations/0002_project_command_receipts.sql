-- 0002_project_command_receipts.sql
-- 追加不可变 migration：建立通用 Project 写命令幂等回执表（Design §4）。
-- 本文件发布后字节/SHA-256 不可改写；需要回滚时使用升级前受管理备份恢复，
-- 不得删除 command_receipts 或手改 schema_migrations（Design Migration Plan）。
-- 回执只保存 requestId、命令名、payload SHA-256、可空 Project 引用、安全结果引用
-- JSON、traceId 和提交时间；不保存名称、genre/style、目录或完整命令载荷。

CREATE TABLE command_receipts (
  request_id TEXT PRIMARY KEY,
  command_name TEXT NOT NULL CHECK (
    command_name IN ('CREATE_PROJECT', 'UPDATE_PROJECT', 'DELETE_PROJECT', 'RESTORE_PROJECT')
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT REFERENCES projects(id),
  result_ref_json TEXT NOT NULL CHECK (json_valid(result_ref_json)),
  trace_id TEXT NOT NULL CHECK (length(trace_id) > 0),
  committed_at TEXT NOT NULL
);

-- requestId 已由 PRIMARY KEY 唯一，覆盖跨重启/响应丢失的幂等预查；此索引支撑
-- invariant audit 与未来按 Project 解析回执引用，跳过 project_id 为空的行。
CREATE INDEX ix_command_receipts_project
  ON command_receipts(project_id)
  WHERE project_id IS NOT NULL;
