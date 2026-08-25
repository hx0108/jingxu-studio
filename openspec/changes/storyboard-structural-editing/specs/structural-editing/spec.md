## Purpose

支持可追溯的结构化分镜编辑。

## ADDED Requirements

### Requirement: 编辑保持不可变版本链

拆分、合并、复制、排序、删除和恢复 MUST 创建新的 EpisodeVersion；删除 MUST 为软删除，派生镜头 MUST 记录血缘。

#### Scenario: 编辑后集合连续

- **WHEN** 任一结构编辑成功
- **THEN** ACTIVE 镜头 sequence SHALL 从 1 连续递增，shot_set_hash SHALL 重新计算
