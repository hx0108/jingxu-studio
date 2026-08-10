## Purpose

为镜序 Studio V1 提供唯一、离线、可验证的正式 JSON Schema 入口，使开发态与 Windows 打包态在断网条件下使用同一组版本和哈希锁，并在契约资源异常时安全阻断写入。

## ADDED Requirements

### Requirement: Registry 必须以固定清单离线解析四份正式 Schema

系统 MUST 内置恰好四条启用的 V1 Schema 锁记录，每条记录 SHALL 包含预期 `$id`、Draft、`schema_version`、逻辑资源名和 64 位小写 SHA-256。Registry MUST 仅接受清单中的完整 `$id`，且不得通过 HTTP、DNS、动态 `loadSchema` 或任意用户 URL 获取 Schema。

#### Scenario: 按已知 ID 获取本地 Schema

- **GIVEN** 四份资源与锁清单完全一致且设备断网
- **WHEN** 调用方使用任一已登记完整 `$id` 请求校验器
- **THEN** Registry SHALL 返回由对应本地资源编译的校验入口
- **THEN** 系统 MUST NOT 发起网络请求或把 URL 转换成网络资源位置

#### Scenario: 请求未知或漂移版本 ID

- **GIVEN** 调用方请求未登记 `$id`，或使用已知契约名但版本不同的 `$id`
- **WHEN** Registry 解析该请求
- **THEN** 系统 MUST 返回稳定的 `SCHEMA_ID_NOT_REGISTERED`
- **THEN** 系统 MUST NOT 回退到最新版本、相近文件名或网络解析

#### Scenario: 清单含重复 ID 或资源名

- **GIVEN** 构建中的锁清单包含重复 `$id`、重复逻辑资源名或不完整记录
- **WHEN** Registry 初始化
- **THEN** 初始化 MUST 失败且不得生成部分可用 Registry
- **THEN** 错误结果 SHALL 标识清单无效而不暴露绝对路径

### Requirement: 启动自检必须核对资源字节、身份、版本和引用闭包

系统 MUST 在开放业务写入前读取全部四份资源，并逐一核对 UTF-8 JSON、文件 SHA-256、`$id`、`$schema` Draft 2020-12、顶层 `schema_version` 常量及所有外部 `$ref`。任一检查失败 MUST 使整组 Registry 不可用，不得只禁用单份 Schema。

#### Scenario: 四份资源完整通过

- **GIVEN** 四份文件存在、字节与锁定 hash 一致、身份和版本正确，且外部 `$ref` 全部指向清单内 ID
- **WHEN** 启动执行 Schema Registry 自检
- **THEN** 系统 SHALL 原子发布包含四个校验器的可用 Registry
- **THEN** 自检证据 SHALL 精确记录四条已验证锁记录

#### Scenario: 文件缺失、损坏或 hash 漂移

- **GIVEN** 任一资源缺失、不是合法 UTF-8 JSON、被截断或 SHA-256 与清单不同
- **WHEN** 启动执行自检
- **THEN** 系统 MUST 拒绝发布整个 Registry 并返回对应稳定错误码
- **THEN** 错误摘要 MUST NOT 包含 Schema 原文、绝对路径或堆栈

#### Scenario: 身份、Draft 或版本不一致

- **GIVEN** 文件 hash 检查所依据的测试清单与资源匹配，但 `$id`、`$schema` 或顶层 `schema_version` 常量不等于锁记录
- **WHEN** Registry 核验语义身份
- **THEN** 系统 MUST 分别以稳定身份、Draft 或版本错误拒绝启动
- **THEN** 系统 MUST NOT 通过修改内存清单或接受数据库旧值继续运行

#### Scenario: 外部引用不在闭包中

- **GIVEN** 任一外部 `$ref` 指向未登记 ID、错误版本或非 `jingxu.studio` 目标
- **WHEN** Registry 编译四份 Schema
- **THEN** 系统 MUST 返回稳定的 `SCHEMA_REFERENCE_UNRESOLVED`
- **THEN** 编译器 MUST NOT 尝试联网补齐引用

### Requirement: 正式业务 JSON 必须通过 Draft 2020-12 校验并返回确定性结果

系统 SHALL 使用支持 JSON Schema Draft 2020-12 的校验器执行正式契约校验；校验结果 MUST 包含目标 schema ID、布尔结果和有界、稳定排序的结构化问题列表。Zod MUST NOT 替代正式 Schema 校验，校验器 MUST NOT 修改输入对象或静默删除未知字段。

#### Scenario: 合法业务对象通过

- **GIVEN** 输入对象满足目标 Schema 的字段、枚举、条件分支、格式和引用约束
- **WHEN** 调用方按目标 `$id` 校验输入
- **THEN** 系统 SHALL 返回 `valid=true` 和空问题列表
- **THEN** 输入对象在校验前后 MUST 保持语义与字节序列化结果不变

#### Scenario: 非法业务对象返回结构化问题

- **GIVEN** 输入对象违反一个或多个正式 Schema 约束
- **WHEN** 调用方执行校验
- **THEN** 系统 MUST 返回 `valid=false`、目标 schema ID 和有界问题列表
- **THEN** 每个问题 SHALL 仅包含实例 JSON Pointer、Schema 关键字和稳定消息码，不得包含完整用户内容

#### Scenario: 相同输入重复校验

- **GIVEN** Registry 版本、目标 ID 和输入 JSON 均相同
- **WHEN** 在同一构建中重复校验
- **THEN** 问题排序、路径和消息码 SHALL 完全一致

### Requirement: 跨 Schema 引用必须在断网环境完成闭包校验

系统 MUST 预注册四份 Schema 后再编译根契约，使 EpisodeStoryboardExport 能解析 ShotContract，使 ProjectTransferBundle 能解析 ScriptStageOutput 与 EpisodeStoryboardExport。引用解析 MUST 以完整 `$id` 精确匹配，不得依赖文件相对路径或注册顺序的偶然行为。

#### Scenario: Episode 导出离线解析 ShotContract

- **GIVEN** 设备断网且输入是包含合法 ShotContract 的 EpisodeStoryboardExport
- **WHEN** Registry 使用 Episode 根 ID 校验输入
- **THEN** 校验 SHALL 完成并应用锁定 ShotContract 版本的全部约束

#### Scenario: Transfer Bundle 离线解析完整引用链

- **GIVEN** 设备断网且 ProjectTransferBundle 包含合法 ScriptStageOutput 与 EpisodeStoryboardExport
- **WHEN** Registry 使用 Transfer Bundle 根 ID 校验输入
- **THEN** 校验 SHALL 在本地解析全部传递引用并返回确定性结果

#### Scenario: 被引用对象违反下游 Schema

- **GIVEN** 根对象结构合法但其中一个被引用 ShotContract 或 ScriptStageOutput 违反对应 Schema
- **WHEN** 校验根对象
- **THEN** 结果 MUST 为失败且问题路径 SHALL 指向根对象内的实际实例位置

### Requirement: Fixture 必须覆盖每份正式 Schema 的合法与单错误样本

四份正式 Schema 每份 MUST 至少提供一个合法 Fixture 和一个只包含单一预期错误的非法 Fixture。Fixture SHALL 使用虚构、非敏感内容，并以元数据声明目标 schema ID、预期结果和非法样本的唯一预期消息码。

#### Scenario: 合法 Fixture 全量回归

- **GIVEN** 当前构建包含四份合法 Fixture
- **WHEN** Contract Test 在禁用网络的环境逐一校验
- **THEN** 四份 Fixture SHALL 分别通过其目标根 Schema

#### Scenario: 单错误 Fixture 精确失败

- **GIVEN** 当前构建包含四份单错误非法 Fixture
- **WHEN** Contract Test 逐一校验
- **THEN** 每份 Fixture MUST 只命中声明的一个预期错误原因
- **THEN** 测试 MUST NOT 通过模糊快照掩盖额外错误

### Requirement: 开发态与打包态必须使用相同资源锁并保留核验证据

开发运行和 Windows x64 打包产物 MUST 从同一逻辑锁清单解析四份 Schema。成功自检后系统 SHALL 在短事务中使 `schema_registry_manifest` 恰好反映本构建的四条已验证记录；数据库旧记录不得覆盖静态锁，核验失败不得写入新的成功证据。

#### Scenario: 开发态与打包态资源一致

- **GIVEN** 同一 Git 提交分别以开发态和 Windows x64 打包态启动
- **WHEN** 两者完成 Registry 自检
- **THEN** 两者 SHALL 报告相同的四个 ID、版本与 SHA-256
- **THEN** 打包资源 MUST NOT 包含缺失文件、额外启用 Schema 或被改写字节

#### Scenario: 数据库存在旧 manifest

- **GIVEN** SQLite 中保存了上一构建的 Schema manifest，而当前包内静态锁不同
- **WHEN** 新构建启动并核验当前资源
- **THEN** 系统 SHALL 以包内静态锁为期望值重新验证资源
- **THEN** 只有全部验证通过后才 MUST 在单一短事务中替换本地成功证据

#### Scenario: 证据写入失败

- **GIVEN** 四份资源验证成功但 manifest 持久化事务失败
- **WHEN** 启动尝试提交核验证据
- **THEN** 系统 MUST 保持 Registry 未发布并进入只读故障
- **THEN** 数据库 MUST NOT 留下部分新 manifest 行
