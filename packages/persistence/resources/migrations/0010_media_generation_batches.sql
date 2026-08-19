-- 0010_media_generation_batches.sql
-- V2 图片切片排队编排骨架（batch-first-frame-generation design D1-C 惰性逐镜头建档）：
--   media_generation_batches   批次行：目标/跳过清单与待建档队列（pending 队列是推进事实源）
--   media_generation_tasks.batch_id  成员任务归属（可空——既有单镜头任务 NULL 语义不变）
-- 批次状态在队列耗尽且成员任务全部终态时收尾派生（COMPLETED / PARTIAL_COMPLETED）；
-- 取消仅停止消费剩余队列（design D6-A），不中断在飞任务。
-- 队列 JSON 数组元素为 shots.id；长度受应用层 1..20 约束（契约 MEDIA_BATCH_MAX_SHOTS），
-- 此处只做非空 JSON 数组形态校验，元素合法性由外键消费路径保证。

CREATE TABLE media_generation_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL_COMPLETED', 'CANCELLED')),
  -- 建批时经当前世代跳过过滤后的有效目标（顺序即排队顺序）。
  target_shot_ids_json TEXT NOT NULL CHECK (json_valid(target_shot_ids_json)),
  -- 尚未建档的队列（惰性消费：事务内取队首建档后移除）。
  pending_shot_ids_json TEXT NOT NULL CHECK (json_valid(pending_shot_ids_json)),
  -- 服务端跳过过滤回告（当前世代已有 SUCCEEDED 候选的镜头）。
  skipped_shot_ids_json TEXT NOT NULL CHECK (json_valid(skipped_shot_ids_json)),
  -- 中止场景（成员建档失败）的批次级稳定错误码；正常收尾为 NULL。
  error_code TEXT CHECK (error_code IS NULL OR status <> 'COMPLETED'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

ALTER TABLE media_generation_tasks
  ADD COLUMN batch_id TEXT REFERENCES media_generation_batches(id);

CREATE INDEX ix_media_batches_project_status ON media_generation_batches(project_id, status);
CREATE INDEX ix_media_tasks_batch ON media_generation_tasks(batch_id) WHERE batch_id IS NOT NULL;
