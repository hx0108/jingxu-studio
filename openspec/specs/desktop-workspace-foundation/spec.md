# desktop-workspace-foundation Specification

## Purpose

为镜序 Studio 提供可重现、可启动且默认隔离本地权限的桌面工程基线，并用互斥的自动化门禁保证后续业务 Change 在一致的架构和安全边界内实施。

## Requirements

### Requirement: 可重现的工程工作区

工程 MUST 提供由唯一 pnpm lockfile 锁定的 workspace，并为安装、启动、格式检查、Lint、类型检查、四类测试和打包提供稳定的根命令。

#### Scenario: 干净环境安装与启动

- **GIVEN** 受支持的 Node.js 和 pnpm 环境以及不含 `node_modules` 的干净仓库
- **WHEN** 开发者使用 lockfile 完成安装并运行桌面启动命令
- **THEN** 桌面应用 SHALL 显示镜序 Studio 空白工程界面
- **THEN** 仓库 SHALL 不生成或提交 npm、Yarn 或其他包管理器锁文件

#### Scenario: 不支持的环境无法安静降级

- **GIVEN** Node.js 或包管理器版本不满足仓库声明的引擎要求
- **WHEN** 开发者尝试安装或运行根命令
- **THEN** 过程 MUST 以非成功结果和可诊断信息停止
- **THEN** 过程 MUST NOT 自动切换包管理器或放宽引擎要求

### Requirement: 安全桌面运行时基线

应用 MUST 以沙箱、上下文隔离、禁用 Renderer Node 集成和启用 Web 安全的方式创建主窗口，并默认拒绝未受信导航、新窗口和权限请求。

#### Scenario: 主窗口使用强制安全选项

- **GIVEN** 镜序 Studio 开始创建主窗口
- **WHEN** 窗口配置被构造
- **THEN** `contextIsolation` SHALL 为 `true`、`nodeIntegration` SHALL 为 `false`、`sandbox` SHALL 为 `true`、`webSecurity` SHALL 为 `true`

#### Scenario: 未受信导航与新窗口被拒绝

- **GIVEN** 主窗口已加载镜序 Studio 受信应用资源
- **WHEN** 页面尝试导航到非受信 origin、打开新窗口或请求未声明系统权限
- **THEN** 应用 MUST 拒绝该操作
- **THEN** 应用 MUST NOT 通过 Shell、默认浏览器或第二窗口继续该请求

#### Scenario: 打包应用不连接外部资源

- **GIVEN** 镜序 Studio 以打包模式启动且尚未引入 Provider Change
- **WHEN** Renderer 加载应用界面
- **THEN** Renderer SHALL 只加载随应用发布的受信本地资源
- **THEN** 内容安全策略 MUST 拒绝任意外部连接、对象嵌入和非受信脚本

### Requirement: Renderer 权限与 Preload 白名单隔离

Renderer MUST NOT 直接获得 Node.js、Electron IPC、文件系统、Shell、数据库或 Provider 能力；Preload SHALL 只暴露冻结的逐方法 `window.jingxu` 白名单对象。

#### Scenario: Renderer 无法访问 Node.js

- **GIVEN** 桌面应用已启动并显示 Renderer 界面
- **WHEN** E2E 检查 Renderer 的 Node.js 全局对象和模块加载入口
- **THEN** `process`、`require` 和直接 `ipcRenderer` 访问 MUST 不可用

#### Scenario: 首个 Change 不暴露业务 IPC

- **GIVEN** `bootstrap-electron-workspace` 尚未实现任何业务用例
- **WHEN** Renderer 读取 `window.jingxu`
- **THEN** `window.jingxu` SHALL 存在、为只读冻结对象且不含业务方法
- **THEN** `window.jingxu` MUST NOT 暴露通用 `send`、`on`、`once`、`invoke` 或任意频道参数入口

### Requirement: 互斥且可审计的工程门禁

工程 SHALL 提供格式、Lint、类型、Unit、Contract、Integration 和 Electron E2E 独立门禁，每个测试脚本 MUST 仅收集它所有的文件后缀。

#### Scenario: 四类测试不重复收集

- **GIVEN** 仓库同时存在 Unit、Contract、Integration 和 E2E 测试样本
- **WHEN** 分别运行四个测试命令
- **THEN** 每个测试文件 SHALL 只被一个 Runner 收集
- **THEN** 任一命令 MUST NOT 依赖 Runner 的默认模糊匹配范围

#### Scenario: 任一必需门禁失败时整体失败

- **GIVEN** 格式、Lint、类型或适用测试中存在未通过结果
- **WHEN** 开发者运行对应根门禁命令
- **THEN** 命令 MUST 返回非零退出码并保留可诊断输出
- **THEN** 命令 MUST NOT 通过跳过、自动删除或放宽失败检查来报告成功

### Requirement: 工程基线不伪造业务能力

工程界面和运行时 MUST 将当前产物表述为开发脚手架，不得展示或声称数据库、Provider、剧本生成、分镜编辑或 V2/V3 能力已可用。

#### Scenario: 空白界面显示真实开发状态

- **GIVEN** 用户启动首个工程基线版本
- **WHEN** Renderer 显示应用内容
- **THEN** 界面 SHALL 明确表示这是镜序 Studio V1 工程基线
- **THEN** 界面 MUST NOT 提供伪造的项目、AI 生成、分镜、导入导出或 Provider 操作入口

### Requirement: 启动门必须包含 Schema 与关键资源自检阶段

应用 MUST 在数据库打开、migration 与数据库审计成功后执行 `SCHEMA_REGISTRY` 阶段，并且只有 Schema Registry、资源核验和成功证据提交全部完成后才能进入 `READY`。该阶段失败 SHALL 复用既有只读故障页、运行时状态查询、写入门和幂等重试，不得构造可写业务服务。

#### Scenario: Schema 阶段成功后进入 READY

- **GIVEN** 数据库阶段已经完成且四份 Schema 资源与锁清单一致
- **WHEN** 启动门执行 `SCHEMA_REGISTRY` 阶段
- **THEN** 状态 SHALL 把该阶段加入 `completedPhases` 后进入 `READY`
- **THEN** Project 写入入口才 SHALL 激活真实 Application Service

#### Scenario: Schema 阶段失败进入只读故障

- **GIVEN** 数据库可读且 migration 成功，但 Schema 资源核验或证据提交失败
- **WHEN** 启动门处理该失败
- **THEN** 状态 MUST 进入 `READ_ONLY_FAULT`、`currentPhase=SCHEMA_REGISTRY` 且 `writeEnabled=false`
- **THEN** 故障页 SHALL 显示稳定错误码、脱敏摘要和重试动作，不得显示绝对路径、Schema 原文或堆栈

#### Scenario: 故障态尝试业务写入

- **GIVEN** 当前故障发生在 `SCHEMA_REGISTRY` 阶段
- **WHEN** Renderer 尝试创建、更新、删除或恢复 Project
- **THEN** 六个 Project IPC 安全边界 SHALL 保持注册
- **THEN** 所有 Command MUST 返回稳定的 `STARTUP_WRITE_BLOCKED` 且不得构造 UnitOfWork 驱动的业务服务

#### Scenario: 修复资源后幂等重试

- **GIVEN** 用户已修复或重新安装缺失资源，当前状态为 Schema 只读故障
- **WHEN** Renderer 使用当前 revision 和 requestId 调用既有 `runtime.retryStartup`
- **THEN** 系统 SHALL 从数据库阶段开始重新执行完整启动检查并重新核验全部四份 Schema
- **THEN** 同一 requestId 的并发重试 MUST 共享结果，只有全部阶段通过才恢复 `READY`
