## Purpose

为镜序 Studio V1 提供可重现、可升级、失败可回滚且只允许 Main 进程访问的本地 SQLite 事实源，并通过启动门、在线备份和受控恢复保护用户数据及后续业务运行。

## ADDED Requirements

### Requirement: 本地数据库连接必须满足固定安全基线

系统 MUST 在 Main 进程中持有唯一写连接，并在允许任何业务写入前验证外键、WAL、FULL synchronous 和 5000 毫秒 busy timeout 均已生效；Renderer MUST NOT 获得数据库路径、连接、Statement 或任意 SQL 执行能力。

#### Scenario: 新安装创建本地数据库

- **GIVEN** 用户数据根目录中不存在数据库文件
- **WHEN** 应用执行数据库启动阶段
- **THEN** 系统 SHALL 在受管理的数据目录创建数据库和必要父目录
- **THEN** 系统 SHALL 在进入可写模式前验证全部连接基线

#### Scenario: 连接基线无法生效

- **GIVEN** 任一必需 PRAGMA 无法设置或读取值与要求不符
- **WHEN** 应用执行数据库启动阶段
- **THEN** 系统 MUST 以稳定错误码 `DATABASE_PRAGMA_FAILED` 阻断可写启动
- **THEN** 系统 MUST NOT 继续执行 migration 或启动未来的 JobRunner

#### Scenario: Renderer 尝试越过持久化边界

- **GIVEN** 应用已经打开数据库
- **WHEN** Renderer 检查 `window.jingxu` 和可访问的运行时对象
- **THEN** Renderer MUST NOT 获得数据库连接、任意路径、SQL 字符串入口或通用 IPC 调用能力

### Requirement: Migration 必须严格顺序且可重现

系统 MUST 只接受名称符合 `NNNN_short_description.sql`、从版本 1 连续递增且版本唯一的 migration 集合，并 SHALL 使用 migration 原始文件字节的 SHA-256 记录每个已应用版本。

#### Scenario: 空库应用初始 migration

- **GIVEN** 数据库没有已应用 migration 且发布包内 migration 集合合法
- **WHEN** 应用执行启动 migration
- **THEN** 系统 SHALL 按版本升序执行全部待应用文件
- **THEN** 系统 SHALL 为每个成功版本保存版本号、文件名、SHA-256 和应用时间

#### Scenario: 重复启动跳过已应用 migration

- **GIVEN** 数据库已记录全部当前 migration 且记录的名称和 SHA-256 与发布包一致
- **WHEN** 应用再次启动
- **THEN** 系统 SHALL 不重复执行任何已应用 SQL
- **THEN** 数据库内容和 `schema_migrations` 记录 SHALL 保持不变

#### Scenario: Migration 集合存在缺口或重复版本

- **GIVEN** 发布包中的 migration 版本不连续、名称非法或存在重复版本号
- **WHEN** 系统扫描 migration 集合
- **THEN** 系统 MUST 以 `MIGRATION_SEQUENCE_INVALID` 阻断启动
- **THEN** 系统 MUST NOT 修改数据库

#### Scenario: 已应用 migration 发生漂移

- **GIVEN** 数据库已记录某 migration 的名称和 SHA-256
- **WHEN** 发布包中同版本文件的名称或 SHA-256 与记录不一致
- **THEN** 系统 MUST 以 `MIGRATION_CHECKSUM_MISMATCH` 阻断启动
- **THEN** 系统 MUST NOT 覆盖历史记录或重新执行漂移文件

#### Scenario: 数据库版本高于当前应用

- **GIVEN** 数据库记录了当前应用不认识的更高 migration 版本
- **WHEN** 当前应用启动
- **THEN** 系统 MUST 以 `DATABASE_VERSION_TOO_NEW` 进入只读故障状态
- **THEN** 系统 MUST NOT 对数据库执行降级写入或删除未知结构

### Requirement: 初始数据库结构必须落实 V1 持久化约束

首个生产 migration MUST 创建 TECH_DESIGN v1.1 §8.4 登记的全部 V1 表，并 SHALL 落实能够由 SQLite 表达的 FK、CHECK、partial unique、必要索引和不可变版本 UPDATE trigger；跨行领域不变量仍由后续 Application Service 在事务中负责，不得通过伪造数据库约束改变业务语义。

#### Scenario: 初始结构在空库完整创建

- **GIVEN** 一个空数据库和正式 `0001_initial.sql`
- **WHEN** migration runner 成功提交版本 1
- **THEN** TECH_DESIGN v1.1 §8.4 的每张表 SHALL 存在
- **THEN** `foreign_key_check` SHALL 返回零条违规记录

#### Scenario: 数据库约束拒绝非法关系

- **GIVEN** 初始 migration 已成功应用
- **WHEN** 集成测试分别写入无效外键、重复 current、重复 stage head、重复 sequence、重复有效锁或非法枚举
- **THEN** 每次非法写入 MUST 被数据库约束拒绝
- **THEN** 同一测试事务 MUST NOT 留下部分数据

#### Scenario: 历史版本不能原地更新

- **GIVEN** 数据库中存在 StoryBible、Script、Episode 或 ShotContract 历史版本
- **WHEN** 调用方尝试 UPDATE 其不可变内容
- **THEN** 数据库 MUST 拒绝该 UPDATE
- **THEN** 调用方只能通过后续业务 Change 插入新版本完成更正

### Requirement: 已有数据库升级前必须生成一致备份

系统 MUST 在修改具有已应用 migration 的数据库前创建 SQLite 在线一致备份，并 SHALL 先验证备份可打开且其 schema version 与升级前源库一致；备份失败时不得开始升级。

#### Scenario: 旧版本数据库升级前备份成功

- **GIVEN** 数据库已有至少一个已应用版本且存在待执行 migration
- **WHEN** 系统准备升级
- **THEN** 系统 SHALL 在受管理的 `backups` 目录生成唯一备份及元数据
- **THEN** 只有备份通过可打开性和版本核对后才 SHALL 开始 migration 事务

#### Scenario: 备份创建或验证失败

- **GIVEN** 已有数据库需要升级但备份目录不可写、备份 API 失败或备份验证不通过
- **WHEN** 系统执行升级前备份
- **THEN** 系统 MUST 以 `DATABASE_BACKUP_FAILED` 阻断启动
- **THEN** 原数据库及其 migration 记录 MUST 保持升级前状态

#### Scenario: 全新空库无需制造升级备份

- **GIVEN** 数据库为本次启动新建且不存在任何用户数据或已应用 migration
- **WHEN** 系统应用首个 migration
- **THEN** 系统 SHALL 允许直接初始化而不创建无内容备份

### Requirement: Migration 失败必须原子回滚

系统 MUST 在单一短事务中执行本次全部待应用 migration 及其 `schema_migrations` 记录；任一 SQL 或记录写入失败时 SHALL 回滚到启动前 schema version，不得把部分升级报告为成功。

#### Scenario: 中间 migration 执行失败

- **GIVEN** 数据库存在多个待应用 migration 且其中一个确定性失败
- **WHEN** migration runner 执行本次升级
- **THEN** 系统 MUST 以 `MIGRATION_APPLY_FAILED` 回滚本次全部 schema 和 migration 记录修改
- **THEN** 原数据库 SHALL 仍可按升级前版本打开

#### Scenario: 压力库升级成功

- **GIVEN** 上一版本样本库包含至少 100 个历史版本对象且全部当前不变量成立
- **WHEN** 系统完成备份并应用待执行 migration
- **THEN** 升级 SHALL 成功且历史行数、版本内容 hash 和父链记录保持不变
- **THEN** 完整性、外键和适用于当前阶段的 invariant audit SHALL 全部通过

### Requirement: 启动自检必须控制全局写入权限

系统 SHALL 按数据库打开、连接基线、migration、数据库检查和恢复门的顺序维护可观察启动状态；只有全部阶段通过后才能进入正常可写界面，任一阶段失败都 MUST 进入独立只读故障页并禁用正常导航、生成、导入、导出及未来的 JobRunner。

#### Scenario: 全部数据库启动检查通过

- **GIVEN** 数据库可打开、migration 一致且所有必需检查通过
- **WHEN** 启动编排完成
- **THEN** 系统 SHALL 将运行时状态设为 `READY`
- **THEN** 应用 SHALL 允许进入正常界面

#### Scenario: 数据库损坏或检查失败

- **GIVEN** 完整性检查、`foreign_key_check` 或当前已实现的 invariant audit 返回失败
- **WHEN** 启动编排评估检查结果
- **THEN** 系统 MUST 以 `DATABASE_INVARIANT_FAILED` 或更具体的稳定错误码进入只读故障页
- **THEN** 系统 MUST NOT 通过关闭检查、自动删除数据或创建新库覆盖原库来继续启动

#### Scenario: 用户在故障页重试

- **GIVEN** 应用处于数据库只读故障状态且底层问题已被用户修复
- **WHEN** 用户触发 `runtime.retryStartup`
- **THEN** 系统 SHALL 从数据库打开阶段重新执行完整自检而不是只重试失败步骤
- **THEN** 只有全部阶段通过后才 SHALL 离开故障页

#### Scenario: 故障信息保持脱敏且可行动

- **GIVEN** 任一数据库启动阶段失败
- **WHEN** Renderer 获取启动状态
- **THEN** 返回内容 SHALL 包含稳定错误码、失败阶段、是否可重试、可用恢复动作和脱敏摘要
- **THEN** 返回内容 MUST NOT 包含 SQL、堆栈、数据库连接、任意绝对路径、密钥或用户内容

### Requirement: 数据库恢复必须保留诊断证据并可失败回退

系统 MUST 只允许从 Main 维护并验证的备份清单恢复；恢复前 SHALL 关闭数据库连接并保存当前数据库及其 WAL/SHM 的诊断副本，恢复后 SHALL 重新执行完整启动自检。Renderer MUST NOT 提交任意文件路径作为恢复源。

#### Scenario: 从有效备份恢复成功

- **GIVEN** 应用处于只读故障状态且存在通过验证的受管理备份
- **WHEN** 用户确认恢复该备份
- **THEN** 系统 SHALL 先创建当前损坏状态的唯一诊断副本，再原子替换数据库
- **THEN** 系统 SHALL 重新执行完整自检，并仅在全部通过后进入 `READY`

#### Scenario: 恢复源不在受管理清单

- **GIVEN** Renderer 提交未知 backup id、伪造 id 或文件路径
- **WHEN** Main 校验恢复命令
- **THEN** 系统 MUST 以 `BACKUP_NOT_ALLOWED` 拒绝请求
- **THEN** 系统 MUST NOT 读取、复制或替换任何目标文件

#### Scenario: 恢复过程中失败

- **GIVEN** 当前数据库诊断副本已创建但备份替换、重新打开或完整自检失败
- **WHEN** 恢复编排终止
- **THEN** 系统 MUST 保持只读故障状态并返回 `DATABASE_RESTORE_FAILED`
- **THEN** 系统 SHALL 保留诊断副本、选定备份和可恢复的替换前数据库，不得把失败恢复报告为成功

#### Scenario: 备份与诊断副本不被静默清理

- **GIVEN** 系统已产生升级备份或恢复诊断副本
- **WHEN** 应用完成启动、退出或再次恢复
- **THEN** 本 Change MUST NOT 自动删除或覆盖这些文件
