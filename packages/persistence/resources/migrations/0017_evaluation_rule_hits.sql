-- 0017_evaluation_rule_hits.sql
--
-- storyboard-evaluation-set：evaluation_samples 补 rule_hits_json/rule_version（D2 入库时落库）。
-- 结构缺口（0001 已发布不可改写）：评测表无确定性规则命中列，读时现算在引擎升级后
-- 不可追溯（PRD §9.9 要求每个样本保存命中与规则版本）。0017 之前不存在任何写入路径，
-- 历史行为 NULL，不回填、不重写；读侧映射 NULL→null 保持诚实（迁移前语义）。

ALTER TABLE evaluation_samples ADD COLUMN rule_hits_json TEXT CHECK (
  rule_hits_json IS NULL OR json_valid(rule_hits_json)
);
ALTER TABLE evaluation_samples ADD COLUMN rule_version TEXT;
