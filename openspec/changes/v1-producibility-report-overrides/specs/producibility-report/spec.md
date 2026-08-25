## Purpose

固定可生产性规则、快照和人工覆盖边界。

## ADDED Requirements

### Requirement: BLOCK 不可覆盖

系统 MUST 允许带理由覆盖 INFO/WARN，但 MUST 拒绝覆盖 BLOCK；报告 MUST 绑定输入版本、快照和规则版本。

#### Scenario: BLOCK 覆盖

- **WHEN** 用户尝试覆盖 BLOCK finding
- **THEN** 系统 SHALL 拒绝请求并保留原 finding
