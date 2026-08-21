# project-transfer-import-export Specification

## Purpose
让用户能够以受 Schema 约束的当前项目快照安全迁移剧本与结构化分镜，同时保持历史不可变、导入可回滚、路径不泄漏和媒体引用缺失可见。
## Requirements
### Requirement: Current snapshot export

系统 MUST 使用 `ProjectTransferBundle 1.0.0` 导出项目当前快照，且不得将完整历史版本、SQLite 数据库备份、API Key 或媒体二进制写入 Bundle。

#### Scenario: Export a ready project

- **GIVEN** 项目、StoryBible、脚本阶段和 Episode Storyboard 均通过当前 Schema 与集合校验
- **WHEN** 用户从项目设置发起导出并确认目标文件
- **THEN** 系统原子写出合法 `ProjectTransferBundle 1.0.0`，记录文件 Hash/大小，并仅向 UI 返回导出摘要

#### Scenario: Export has media references

- **GIVEN** 当前分镜引用图片或视频资产
- **WHEN** 用户导出项目快照
- **THEN** Bundle 保留结构化引用但不包含媒体字节，并返回明确的媒体未打包警告

#### Scenario: Export target is cancelled or exists

- **GIVEN** 用户取消系统保存对话框或目标文件已存在
- **WHEN** 导出命令执行
- **THEN** 取消不产生成功记录；已存在文件默认拒绝，只有明确确认后才允许原子替换

### Requirement: Staged bundle validation

系统 MUST 在任何正式写入前完成文件大小、UTF-8、JSON、Bundle Schema、Hash、跨对象引用、版本头和项目归属校验。

#### Scenario: Invalid bundle is rejected

- **GIVEN** Bundle JSON 损坏、Schema 版本不支持、Hash 不匹配或阶段/引用不一致
- **WHEN** 用户选择导入
- **THEN** 系统返回稳定脱敏错误，写入失败的 `import_records` 证据，目标项目和历史版本均保持不变

#### Scenario: Valid bundle enters staging

- **GIVEN** Bundle 通过格式、Schema、Hash 和引用校验
- **WHEN** 用户选择导入模式
- **THEN** 系统生成确定性的 ID Mapping 和导入摘要，但在事务提交前不改变正式项目数据

### Requirement: New project import

系统 MUST 支持 `NEW_PROJECT` 导入并为新项目对象生成新 ID，重写所有文档内引用，且不得伪造 SourceInput 或 ConsentRecord。

#### Scenario: Import as a new project

- **GIVEN** 合法 CURRENT_ONLY Bundle
- **WHEN** 用户选择 `NEW_PROJECT` 并确认导入
- **THEN** 系统在一个短事务中创建新 Project、FormatProfile、Episode、版本头、依赖和审计，保存完整 ID Mapping，并将项目标记为 `IMPORTED_SNAPSHOT`

#### Scenario: Imported snapshot needs original input

- **GIVEN** 导入 Bundle 不包含 SourceInput 或 ConsentRecord
- **WHEN** 用户打开新项目并尝试继续 AI 生成
- **THEN** 系统允许查看、编辑和再次导出，但阻止生成并提示补充原始输入及数据处理确认

### Requirement: Return to origin import

系统 MUST 支持 `RETURN_TO_ORIGIN` 导入到原项目，并通过新当前版本恢复快照，不覆盖任何历史行。

#### Scenario: Restore into the origin project

- **GIVEN** 目标项目存在，Bundle 的原始项目 ID、名称和基线 Hash 与目标一致
- **WHEN** 用户确认 `RETURN_TO_ORIGIN`
- **THEN** 系统创建新的当前 DRAFT/READY 版本，更新阶段头、Episode 当前版本、依赖和审计，并保留旧历史版本字节不变

#### Scenario: Origin project changed concurrently

- **GIVEN** 目标项目在导入校验后发生版本头或名称变化
- **WHEN** 系统提交 `RETURN_TO_ORIGIN`
- **THEN** 系统返回稳定并发冲突错误，事务完全回滚且不创建部分版本

### Requirement: Safe transfer IPC and UI

系统 MUST 通过冻结的 `transfer.exportProject` 和 `transfer.importProject` 白名单提供导入导出，双端校验 strict DTO，且不得向 Renderer 暴露路径、SQL、Key 或内部堆栈。

#### Scenario: Renderer starts transfer

- **GIVEN** 用户位于项目设置或项目列表页面
- **WHEN** 用户发起导入或导出
- **THEN** UI 展示校验/写入状态、成功摘要、Hash、警告或稳定错误，并在命令提交前后保持可恢复反馈

#### Scenario: Transfer command is unauthorized

- **GIVEN** IPC sender 不可信、DTO 含未知字段或当前启动状态不是 READY
- **WHEN** 调用任一 transfer 方法
- **THEN** 系统拒绝调用并返回脱敏错误，不读取文件、不写数据库、不创建媒体任务

### Requirement: Atomic records and idempotency

系统 MUST 使用现有 Transfer 记录和单连接事务边界记录导入导出状态，并保证相同 requestId/同载荷重放不重复创建项目或版本。

#### Scenario: Import fails midway

- **GIVEN** 导入在对象写入、ID 重写、依赖或审计阶段任一步失败
- **WHEN** 事务结束
- **THEN** 所有正式业务写入回滚，失败证据保留，旧项目历史和当前指针不变

#### Scenario: Same command is replayed

- **GIVEN** 相同 requestId 和相同载荷再次提交
- **WHEN** 系统处理重放请求
- **THEN** 返回原始导入/导出摘要，不创建重复记录；不同载荷复用同 requestId 必须被拒绝

