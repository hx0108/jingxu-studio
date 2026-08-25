# release-gate Specification

## Purpose
恢复并固化 V1 发布候选的可执行门禁：格式、Lint、TypeScript、测试收集与全量测试链必须可在本地按固定命令复现执行并留下记录。
## Requirements
### Requirement: 静态门禁可执行

工程 MUST 通过格式、Lint、TypeScript 和测试收集检查。

#### Scenario: 当前代码无静态回归

- **WHEN** 执行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck` 和 `pnpm test:collection`
- **THEN** 命令 SHALL 成功结束

