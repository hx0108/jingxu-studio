# 镜序 Studio OpenSpec SDD 工作流

## 1. 目的与事实源

本文档定义镜序 Studio 的规范驱动开发流程。OpenSpec 管理单次变更的意图、增量需求、技术设计、实现任务和归档证据，不替代下列上位事实源：

| 事实类型 | 权威文件 |
|---|---|
| 产品语义、V1 范围和发布验收 | `镜序Studio_AI漫剧工作台_产品需求文档_PRD_v1.4.md` |
| 架构、数据库、事务、安全和测试 | `TECH_DESIGN.md` v1.1 |
| 机器字段、枚举和跨字段条件 | 四份 `镜序Studio_V1_*.schema.json` |
| AI 编码 Agent 执行护栏 | `AGENTS.md` |
| 已归档行为的增量规范 | `openspec/specs/` |
| 未实施或实施中的变更 | `openspec/changes/<change-id>/` |

如 Active Change 与 PRD、TECH、Schema 或 AGENTS 冲突，停止 Apply，先修正冲突的规范产物。

## 2. 何时必须建立 Change

以下变更必须先建立 Active Change：

- 新功能、用户流程或可观察行为变化。
- 架构分层、进程边界、Application Port 或公开 IPC 变化。
- JSON Schema、数据表、migration、状态机、锁或导入导出契约变化。
- Provider、密钥、网络访问、数据政策或 Electron 安全边界变化。
- 会影响 AC-V1-01 至 AC-V1-06 的修复或重构。

仅修正错别字、链接或不改变语义的格式时可不建 Change。

## 3. 标准流程

```text
Explore -> Propose -> 人工审查 -> Apply -> Verify -> Sync -> Archive
```

1. **Explore**：读取当前文档和代码，消除范围、契约和验收歧义；不创建产物或代码。
2. **Propose**：为单一可独立验收的能力创建 `proposal.md`、`specs/`、`design.md` 和 `tasks.md`。
3. **人工审查**：核对范围、非目标、Requirement/Scenario、架构影响、失败路径和测试门禁。
4. **Apply**：用户明确要求后，按 `tasks.md` 执行测试先行的最小实现。
5. **Verify**：对照所有 Requirement/Scenario、任务、实现、测试和当前 diff，输出阻断项、警告和建议。
6. **Sync**：将已验证的 delta spec 合并到 `openspec/specs/`。长时间变更可提前 Sync，普通变更在 Archive 前完成。
7. **Archive**：无阻断问题后归档 Change，保留变更原因和验证证据。

Codex 的 OpenSpec 工作流以项目内 `.agents/skills/openspec-*` 为准；当前 CLI 1.8.0 使用技能式调用，例如 `$openspec-propose` 和 `$openspec-apply-change`。安装或更新后需重启 Codex。

## 4. Change 命名与边界

- Change ID 使用英文 `kebab-case`，例如 `bootstrap-electron-workspace`。
- 一个 Change 只包含一个可独立审查、验证和回滚的能力，不以整个 V1 或整个 Sprint 作为单一 Change。
- 开发分支使用 `codex/<change-id>`。
- Proposal 中必须列出非目标，防止把后续 Change 或 V2/V3 能力顺手实现。
- 涉及公开 Schema、migration、IPC 或安全边界时，在 Proposal 和 Design 同时声明兼容性与回滚方案。

## 5. 审查门禁

### Apply 前

- Proposal、Specs、Design、Tasks 全部存在，且 OpenSpec 状态无缺失依赖。
- 每条 Requirement 至少一个可观察 Scenario，重要边界具有失败或恢复用例。
- 变更已映射到 PRD 验收项、TECH 章节和适用测试层级。
- Schema、DB、IPC、migration、Provider 和安全影响均已明确说明。
- 不存在会改变产品语义的未决问题。

### Archive 前

- `tasks.md` 完成状态与实际代码和测试一致。
- 适用的 format、lint、typecheck、unit、contract、integration 和 E2E 实际运行。
- Verify 无未处理阻断问题，文档、Schema、Fixture 和 migration 无漂移。
- 归档摘要列出实际命令、结果、未验证项和剩余风险。

## 6. V1 Change 顺序

1. `bootstrap-electron-workspace`
2. `sqlite-migration-runtime`
3. `project-format-profile-management`
4. `schema-registry-version-locks`
5. `jobrunner-qwen-text-adapter`
6. `staged-script-generation`
7. `storyboard-editing`
8. `project-transfer-import-export`
9. `evaluation-release-acceptance`

顺序可根据已发现依赖调整，但任何调整都必须更新相关 Proposal/Design，不得在 Apply 中静默扩大范围。
