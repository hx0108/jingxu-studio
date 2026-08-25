## Purpose

支持已有 UTF-8 剧本输入与受锁保护的选区改写。

## ADDED Requirements

### Requirement: 原文输入不可静默截断

系统 MUST 接受 1–30,000 个 Unicode 字符的非空 `.txt/.md` 内容，并保存原文 hash 与元数据。

#### Scenario: 超限或空白输入被拒绝

- **WHEN** 输入为空白、0 字符或超过 30,000 字符
- **THEN** 系统 SHALL 返回稳定输入错误且不写入 SourceInput

### Requirement: 选区改写尊重锁

系统 MUST 在提交前复检 expectedVersionId 与 write set；与锁路径父子或同路径冲突时整次拒绝。

#### Scenario: 锁字段改写

- **WHEN** write set 与有效锁路径冲突
- **THEN** 系统 SHALL 返回 SHOT_LOCK_CONFLICT 且不产生部分版本
