## Purpose

提供统一 V1 自动化验收与真实用户试用证据模板。

## ADDED Requirements

### Requirement: 证据与用户试用分离

Mock/Electron 自动化结果 MUST 与三名目标用户真实试用记录分开保存，未有真实记录不得声称发布验收完成。

#### Scenario: 缺少用户记录

- **WHEN** 自动化 AC-V1-01～06 已通过但用户记录为空
- **THEN** 发布状态 SHALL 仍为待试用
