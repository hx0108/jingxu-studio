# shot-first-frame-image-generation Specification

## ADDED Requirements

### Requirement: 首帧候选生成必须以冻结镜头版本与资产版本快照为输入

系统 MUST 仅在项目存在 READY 的 ShotContract 版本、目标镜头属于该版本、且客户端 expected shot version 与服务端一致时接受首帧生成请求。生成输入 MUST 由镜头版本内容、按 `character_ids`/`scene_id` 解析出的资产版本列表、model_id 与归一化参数组成，并计算 `generation_input_hash`；绑定解析 MUST 不因资产缺失而阻断（缺失项跳过）。Prompt 组装 MUST 只消费镜头创意字段与 STORY_BIBLE 描述，MUST NOT 依赖模型或 Renderer 提供的系统字段。

#### Scenario: 冻结输入齐全时提交媒体任务

- **GIVEN** 项目存在 READY ShotContract 且 expected shot version 匹配
- **WHEN** 用户请求为某镜头生成首帧候选
- **THEN** 系统 SHALL 解析该镜头绑定的 CHARACTER/SCENE 资产当前版本并计算生成输入哈希
- **THEN** 系统 SHALL 创建 N 个 PENDING 候选与一条媒体任务，provider 调用前持久化幂等键

#### Scenario: 镜头版本不匹配不创建任务

- **GIVEN** expected shot version 过期或镜头不属于当前 READY 集合
- **WHEN** 用户请求生成首帧候选
- **THEN** 系统 MUST 返回稳定前置条件或 STALE_INPUT 错误，MUST NOT 创建任务、调用 Provider 或写入候选

### Requirement: 媒体生成任务必须可恢复且不自动重发未知请求

媒体任务 MUST 支持幂等键去重、取消与超时。`provider_task_id` MUST 在首次 poll 前持久化；应用重启后，系统 MUST 对已持久化 taskId 的未终态任务恢复轮询，对无法证明已发出的提交 MUST 标记失败等待人工重发，MUST NOT 自动重发未知请求。Provider 专有的任务结构只允许存在于 ImageModelAdapter 内。

#### Scenario: 重启后按证据恢复轮询

- **GIVEN** 应用在上一次 poll 前已持久化 provider_task_id，随后进程退出
- **WHEN** 应用重启并扫描未终态媒体任务
- **THEN** 系统 SHALL 从持久化 taskId 继续轮询并推进候选落盘
- **THEN** 系统 SHALL NOT 重新 submit 同一任务

#### Scenario: 未知是否发出的提交不自动重发

- **GIVEN** 任务处于 SUBMITTED 且无 provider_task_id，无法证明 Provider 未收到请求
- **WHEN** 应用重启恢复
- **THEN** 系统 SHALL 将任务标记为失败并提示人工重发
- **THEN** 系统 SHALL NOT 自动重新 submit

### Requirement: 候选多保留且人工选择可切换可追溯

每轮生成 MUST 保留全部成功候选，MUST NOT 覆盖或删除旧轮结果。每镜头 MUST 至多一个当前选择；切换选择 MUST 记录选择时间与选择时输入哈希，历史选择 MUST 可查询。部分候选失败 MUST 不影响同轮其余候选的保留与可选性。

#### Scenario: 多轮生成不覆盖旧候选

- **GIVEN** 某镜头已有一轮 4 个成功候选
- **WHEN** 用户再次生成一轮
- **THEN** 系统 SHALL 新增一轮候选且旧候选保持可查可选中
- **THEN** 当前选择在输入哈希未变时 SHALL 保持不变

#### Scenario: 人工选择可切换且留痕

- **GIVEN** 当前输入世代存在多轮候选且已选择候选 A
- **WHEN** 用户改选同世代候选 B
- **THEN** 系统 SHALL 原子更新选择指针并保留 A 的历史选择记录
- **THEN** 系统 MUST NOT 允许选择 STALE_INPUT 世代或 FAILED 状态的候选

### Requirement: 输入变更必须传播 STALE_INPUT 且不得自动重生成

项目确认新 ShotContract READY 版本或资产升版时，系统 MUST 将输入哈希不再匹配的候选与选择标记 STALE_INPUT，MUST NOT 自动重新生成。资产升版 MUST 支持列出受影响镜头清单。STALE 候选 MUST 保持可读以供追溯。

#### Scenario: 分镜升版传播失效

- **GIVEN** 镜头 L 存在基于 shot_version v3 的候选与选择
- **WHEN** 项目确认了包含 L 新版本 v4 的 ShotContract READY 集合
- **THEN** 基于 v3 的候选与选择 SHALL 标记 STALE_INPUT
- **THEN** 系统 SHALL NOT 自动为 L 重新生成候选

#### Scenario: 资产升版列出受影响镜头

- **GIVEN** 资产 A 的版本 v1 被多个镜头的候选输入快照引用
- **WHEN** A 升版为 v2
- **THEN** 引用 v1 的候选 SHALL 标记 STALE_INPUT
- **THEN** 系统 SHALL 能列出这些候选对应的受影响镜头清单供用户决策

### Requirement: 资产版本必须不可变且图片字节不得写入 SQLite

CHARACTER/SCENE 资产 MUST 按 STORY_BIBLE ID 唯一建档；AssetVersion MUST 不可变且版本号单调递增（沿既有版本表禁改禁删模式）。参考图与候选字节 MUST 以内容寻址（sha256）存于受管理 `projects/<projectId>/` 目录，写入 MUST 先临时文件后原子 rename 并校验哈希；SQLite MUST 只存哈希、尺寸、格式与相对路径。

#### Scenario: 参考图上传产生不可变新版本

- **GIVEN** 资产 A 当前版本 v1
- **WHEN** 用户上传新参考图
- **THEN** 系统 SHALL 写入内容寻址文件并创建 v2 版本行
- **THEN** v1 行与其文件 SHALL 保持不变且仍可被历史候选快照引用

#### Scenario: 候选落盘校验失败不登记

- **GIVEN** 下载字节与 Provider 结果引用的哈希不一致
- **WHEN** 系统落盘候选
- **THEN** 该候选 SHALL 标记 FAILED 且 SQLite 不登记该文件
- **THEN** 临时文件 SHALL 被清理

### Requirement: 图片字节必须经受限媒体通道到达 Renderer

Renderer MUST 仅通过受限 `jingxu://media` 协议引用图片字节，MUST NOT 接收绝对路径、文件系统句柄或经 IPC 透传的任意字节。协议处理器 MUST 校验资源标识归属当前项目并将解析约束在受管理 projects 根内（含符号链接防逃逸）；生产 CSP MUST 将 `img-src` 收紧为该通道。

#### Scenario: 越权资源标识被拒绝

- **GIVEN** Renderer 请求不属于任何已登记候选/资产版本的 media 标识
- **WHEN** 协议处理器解析请求
- **THEN** SHALL 拒绝该请求且不暴露文件系统路径细节

#### Scenario: 生产 CSP 只允许媒体通道图片

- **GIVEN** 生产 Renderer 加载完成
- **WHEN** 页面引用 `http://`、`file://` 或外部来源的图片
- **THEN** 加载 SHALL 被 CSP 阻止

### Requirement: ImageModelAdapter 必须屏蔽 Provider 专有结构与凭据

Application/Renderer MUST 只依赖 ImageModelPort 与 NormalizedModelError；DashScope 任务结构、HTTP header、Authorization 或 Provider 专有错误 MUST 只存在于 Adapter 实现。凭据 MUST 沿用 safeStorage 加密与独立密文保存；Renderer 只能获取 configured 状态与末 4 位。每段真实 Provider 请求 MUST 记一条调用证据并登记 `provider_reported_usage`（图片数）。

#### Scenario: Provider 任务错误归一化

- **GIVEN** poll 返回 Provider 专有的任务失败结构
- **WHEN** Adapter 归一化错误
- **THEN** 应用层 SHALL 只收到稳定 NormalizedModelError，不含原始 payload 或 Authorization

#### Scenario: Mock 矩阵作为离线门禁证据

- **GIVEN** 未配置真实凭据
- **WHEN** 运行全量门禁与 packaged smoke
- **THEN** MockImageModelAdapter SHALL 提供确定性字节与失败矩阵完成验证
- **THEN** 全程 SHALL 不发生真实网络调用或真实用户目录访问
