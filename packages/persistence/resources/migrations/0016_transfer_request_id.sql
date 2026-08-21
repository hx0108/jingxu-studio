-- 0016_transfer_request_id.sql
--
-- project-transfer-import-export：export_records/import_records 补 request_id/result_json。
-- 结构缺口（0001 已发布不可改写）：两表均无 request_id 列与回放摘要列，Transfer 的
-- requestId 幂等（同 requestId 同载荷重放返回原摘要）无处落库——由 3.2/3.3 集成测试
-- 证明后新增本 migration。历史行保持 NULL，不回填、不重写。
-- SUCCEEDED 且 request_id 非空的行按 request_id 唯一（部分唯一索引兜底并发双写）。

ALTER TABLE export_records ADD COLUMN request_id TEXT;
ALTER TABLE export_records ADD COLUMN result_json TEXT CHECK (
  result_json IS NULL OR json_valid(result_json)
);

CREATE UNIQUE INDEX ux_export_records_request_id
  ON export_records(request_id)
  WHERE status = 'SUCCEEDED' AND request_id IS NOT NULL;

ALTER TABLE import_records ADD COLUMN request_id TEXT;
ALTER TABLE import_records ADD COLUMN result_json TEXT CHECK (
  result_json IS NULL OR json_valid(result_json)
);

CREATE UNIQUE INDEX ux_import_records_request_id
  ON import_records(request_id)
  WHERE status = 'SUCCEEDED' AND request_id IS NOT NULL;
