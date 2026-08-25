# shot-first-frame-image-generation Specification

## Purpose
TBD - created by archiving change shot-first-frame-image-generation. Update Purpose after archive.
## Requirements
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

Application/Renderer MUST 只依赖 ImageModelPort 与 NormalizedModelError；DashScope 任务结构、HTTP header、Authorization 或 Provider 专有错误 MUST 只存在于 Adapter 实现。凭据 MUST 沿用 safeStorage 加密与独立密文保存；Renderer 只能获取 configured 状态与末 4 位。Adapter 的原始响应证据通道（成功响应原文与 `evidenceOf`）MUST 仅由主进程证据链消费，MUST NOT 进入 NormalizedModelError、日志或 Renderer。

#### Scenario: Provider 任务错误归一化

- **GIVEN** poll 返回 Provider 专有的任务失败结构
- **WHEN** Adapter 归一化错误
- **THEN** 应用层 SHALL 只收到稳定 NormalizedModelError，不含原始 payload 或 Authorization

#### Scenario: 原始响应通道不泄漏进归一错误

- **GIVEN** submit 收到含 Provider 专有结构的错误响应（如 HTTP 429 限流原文）
- **WHEN** Adapter 归一化错误并暴露证据通道
- **THEN** NormalizedModelError SHALL 保持稳定码且 detail 为 null；原始响应 SHALL 只经主进程证据通道（evidenceOf）落库，不进入 Renderer 可达的任何路径

#### Scenario: Mock 矩阵作为离线门禁证据

- **GIVEN** 未配置真实凭据
- **WHEN** 运行全量门禁与 packaged smoke
- **THEN** MockImageModelAdapter SHALL 提供确定性字节与失败矩阵完成验证
- **THEN** 全程 SHALL 不发生真实网络调用或真实用户目录访问

### Requirement: 整集批量首帧必须由显式用户动作触发并逐镜头独立建档

批量生成入口 MUST 仅响应显式用户动作；系统联动（STALE 传播、分镜升版、资产升版）MUST NOT 自动创建批次。批次 MUST 仅覆盖当前 READY 集合内的镜头，且每个成员镜头 MUST 独立建档为既有粒度的单镜头任务（单镜头单轮），MUST NOT 引入跨镜头合并任务。「当前世代已存在 SUCCEEDED 候选」的镜头 MUST 默认跳过并在批次视图中如实回告；有效目标为空时 MUST 以稳定错误码拒绝建档。批量建档前 MUST 沿用既有前置：图片凭据闸与整集 READY 校验。

#### Scenario: READY 整集一键排队

- **GIVEN** 整集分镜已确认 READY（9 镜头），其中镜头 L2 已有当前世代 4 个 SUCCEEDED 候选，图片凭据已配置
- **WHEN** 用户在分镜工作台点击「为整集生成首帧」
- **THEN** 系统 SHALL 创建一个批次，有效目标为 L1、L3–L9 共 8 个镜头，L2 出现在跳过清单
- **THEN** 系统 SHALL 为每个有效目标镜头后续按既有单镜头任务粒度建档，沿用现有冻结输入、幂等与候选语义

#### Scenario: 系统联动不得自动建批

- **GIVEN** 镜头 L 的既有候选因资产升版全部标记 STALE_INPUT
- **WHEN** STALE 传播完成
- **THEN** 系统 SHALL 仅列出受影响镜头，SHALL NOT 自动创建任何批次或任务

#### Scenario: 有效目标为空稳定失败

- **GIVEN** 整集所有镜头均已有当前世代 SUCCEEDED 候选
- **WHEN** 用户点击「为整集生成首帧」
- **THEN** 系统 SHALL 返回稳定错误码 MEDIA_BATCH_NO_PENDING_SHOTS 且不落任何批次行

### Requirement: 批次必须惰性逐镜头提交且崩溃恢复不重发未知请求

批次 MUST 持久化待建档镜头队列，且 MUST 在前一成员任务到达终态后才为下一镜头建档提交；任意时刻每批次 MUST 至多存在一个未终态成员任务。应用重启后，系统 MUST 为「从未建档」的排队镜头继续建档提交（属全新提交），MUST 对已建档未终态任务沿用既有恢复规则——留证续轮询、无证据标 `MEDIA_TASK_INTERRUPTED` 待人工，MUST NOT 自动重发。

#### Scenario: 前一镜头终态后才提交下一镜头

- **GIVEN** 批次运行中，镜头 L1 的任务处于 POLLING，队列剩余 L2、L3
- **WHEN** L1 任务到达终态（含 FAILED）
- **THEN** 系统 SHALL 仅为 L2 建档并提交，L3 继续留在队列

#### Scenario: 重启后队列继续且在飞任务按既有规则恢复

- **GIVEN** 批次运行至 L4 在飞（SUBMITTED 无 provider 证据），队列剩余 L5–L9，应用退出
- **WHEN** 应用重启并执行批次恢复
- **THEN** 系统 SHALL 将 L4 任务标记 `MEDIA_TASK_INTERRUPTED` 待人工，MUST NOT 自动重发
- **THEN** 系统 SHALL 继续为 L5 建档提交，批次推进不中断

### Requirement: 单镜头失败不得阻断批次且收尾状态如实派生

成员任务失败 MUST NOT 阻断同批次后续镜头的建档与提交；候选级失败沿用既有「兄弟候选继续」语义。当队列耗尽且全部成员任务到达终态时，批次 MUST 收尾：全部 COMPLETED 则 `COMPLETED`，任一 FAILED 则 `PARTIAL_COMPLETED`。失败成员 MUST 按统一口径判定：任务相位为 `FAILED`，或任务相位为 `COMPLETED` 但该镜头同轮零 `SUCCEEDED` 候选（Provider 错误候选级全败时任务相位仍为 COMPLETED）；候选级全败成员在批次视图中 SHALL 按 `FAILED` 呈报并携带候选错误码。「重试失败镜头」MUST 表达为仅含失败镜头的新批次，MUST NOT 复活或复用失败任务行。

#### Scenario: 失败隔离

- **GIVEN** 批次推进至镜头 L3，L3 的任务因 Provider 错误候选级全败（任务相位 COMPLETED、同轮零 SUCCEEDED）
- **WHEN** 批次继续推进
- **THEN** 系统 SHALL 继续为 L4 及后续镜头建档提交
- **THEN** 批次视图 SHALL 将 L3 按 FAILED 计入失败清单并携带候选错误码

#### Scenario: 收尾派生与重试边界

- **GIVEN** 9 镜头批次全部终态：8 个 COMPLETED、1 个 FAILED
- **WHEN** 收尾与用户查看批次视图
- **THEN** 批次状态 SHALL 为 PARTIAL_COMPLETED 且失败清单仅含该镜头
- **WHEN** 用户点击「重试失败镜头」
- **THEN** 系统 SHALL 创建仅含该镜头的新批次（新 requestId），旧批次与旧任务行保持不变

### Requirement: 批次取消仅作用于未提交镜头

用户取消批次时，系统 MUST 将批次标记 `CANCELLED` 并停止消费剩余队列；已到达终态的成员任务结果 MUST 保留，正在提交的在飞任务 MUST 运行至自然终态，MUST NOT 被强制中断。取消 MUST 幂等，对已收尾批次取消 SHALL 无副作用。

#### Scenario: 取消剩余队列

- **GIVEN** 批次运行中：L1 已 COMPLETED，L2 在飞，队列剩余 L3–L9
- **WHEN** 用户点击「取消剩余」
- **THEN** 批次 SHALL 标记 CANCELLED，L3–L9 不再建档
- **THEN** L2 SHALL 运行至自然终态，L1 的候选 SHALL 保留可查可选

### Requirement: 分镜镜头列表必须聚合呈现首帧状态与批次进度

分镜工作台的镜头列表 MUST 为每个镜头呈现首帧状态（无候选、排队中、生成中、候选就绪、失败），数据 MUST 来自列表级查询而非逐镜头轮询拼接。批次运行期间 MUST 呈现进度（已完成/总数、失败数）与取消、重试失败入口；轮询 MUST 沿用既有有界模式（可见性守卫、终态即停）。

#### Scenario: 徽标与进度聚合

- **GIVEN** 批次运行中：L1 生成中、L2 已就绪 4 候选、L3 失败、L4–L9 排队中，L2 之外另有非批次镜头 M 已有候选
- **WHEN** 用户查看分镜工作台
- **THEN** 镜头列表 SHALL 为 L1–L9 与 M 分别呈现对应首帧状态徽标
- **THEN** 批次进度 SHALL 呈现 2/9 已终态（1 失败）与取消、重试失败入口

### Requirement: 媒体调用证据必须真实落库且与候选终态原子提交

每段真实 Provider 请求（SUBMIT/DOWNLOAD）MUST 在 `media_model_invocations` 落一条证据行：请求快照（prompt、size、参数指纹与参考图 sha256 清单，MUST NOT 含参考图字节或凭据）、响应全文（含失败原文）及其 sha256、`provider_reported_usage`（图片数与输出 tokens）。终态候选的 `invocation_evidence_ref` MUST 指向真实证据行；证据终态收尾与候选终态 MUST 在同一事务原子提交；中断残留的 STARTED 行 MUST 如实保留且不参与恢复决策。图片字节 MUST NOT 写入证据行（下载段证据只记结果 URL 快照与落盘 sha256，字节留在内容寻址存储）。

#### Scenario: 整集真实生成后证据可 SQL 复盘

- **GIVEN** 一个 4 候选任务经真实 Provider 全部生成成功
- **WHEN** 任务驱动完成
- **THEN** `media_model_invocations` SHALL 存在 4 条 SUBMIT 终态行（含响应原文与 usage 图片数；provider_request_id 以 Provider 实际返回为准，Provider 未返回任务 id 时记 null）与对应 DOWNLOAD 行；每条终态候选行的 invocation_evidence_ref SHALL 可 JOIN 到其 SUBMIT 证据行

#### Scenario: 限流失败留档原文且 Renderer 仍只见归一码

- **GIVEN** submit 收到 HTTP 429 限流错误响应
- **WHEN** 候选按归一错误码落 FAILED
- **THEN** 同一事务 SHALL 收尾证据行（error_code=MODEL_RATE_LIMITED、错误响应原文落 blob）
- **THEN** Renderer SHALL 仍只收到归一错误码，不含原文

#### Scenario: 下载段轻量证据不重复存字节

- **GIVEN** 同步 submit 成功并进入下载段
- **WHEN** 图片字节落盘内容寻址存储且候选 SUCCEEDED
- **THEN** SHALL 存在 DOWNLOAD 段证据行（结果 URL 快照与落盘 sha256，耗时可由 created_at/finished_at 复盘）；其 response_body_blob SHALL 为 NULL

#### Scenario: 崩溃窗口残留 STARTED 且恢复语义不变

- **GIVEN** submit 网络在飞时进程崩溃
- **WHEN** 下次启动恢复扫描
- **THEN** 证据行 SHALL 停留 STARTED 如实反映中断；候选恢复决策 SHALL 仍只依据 provider_task_id 证据（缺失即 INTERRUPTED 待人工），MUST NOT 因证据行存在而自动重发

### Requirement: 首帧生成界面必须按当前镜头呈现候选

首帧生成界面 SHALL 在当前镜头上下文内展示选中候选、其他候选、任务状态与允许操作，不得要求用户在整页长列表中定位当前结果。

#### Scenario: 当前镜头已有多个首帧候选

- **GIVEN** 当前镜头包含一个已选候选和其他历史候选
- **WHEN** 用户进入画面生成阶段
- **THEN** 中间区域 SHALL 优先展示已选候选
- **THEN** 右侧或候选区 SHALL 提供预览、选用和重新生成动作
