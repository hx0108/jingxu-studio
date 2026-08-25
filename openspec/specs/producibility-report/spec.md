# producibility-report Specification

## Purpose
把确定性可生产性规则收口为可追溯报告：固定规则版本、能力快照与参考价格快照，允许带理由覆盖 INFO/WARN，禁止覆盖 BLOCK，报告绑定输入版本。
## Requirements
### Requirement: BLOCK 不可覆盖

系统 MUST 允许带理由覆盖 INFO/WARN，但 MUST 拒绝覆盖 BLOCK；报告 MUST 绑定输入版本、快照和规则版本。

#### Scenario: BLOCK 覆盖

- **WHEN** 用户尝试覆盖 BLOCK finding
- **THEN** 系统 SHALL 拒绝请求并保留原 finding

