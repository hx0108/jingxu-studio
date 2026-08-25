## Purpose

恢复 V1 发布候选的可执行门禁。

## ADDED Requirements

### Requirement: 静态门禁可执行

工程 MUST 通过格式、Lint、TypeScript 和测试收集检查。

#### Scenario: 当前代码无静态回归

- **WHEN** 执行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck` 和 `pnpm test:collection`
- **THEN** 命令 SHALL 成功结束
