-- 0026_project_experience_mode.sql
-- 五分钟体验模式（simplify-first-run-creator-experience，2026-09-21）：projects 增加项目级
-- 受控体验标记。'DEMO' 项目由内置示例种子命令创建：媒体任务固定 is_mock=true、真实生成
-- 解析器不得选择、Transfer 导出被阻止（导入侧不存在演示 Bundle）。默认 'STANDARD' 保证
-- 既有行与既有创建通路语义完全不变；无任何通路可将 'DEMO' 改回 'STANDARD'。

ALTER TABLE projects ADD COLUMN experience_mode TEXT NOT NULL DEFAULT 'STANDARD' CHECK (
  experience_mode IN ('STANDARD', 'DEMO')
);
