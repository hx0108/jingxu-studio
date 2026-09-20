# shot-video-generation Specification

## Purpose

为结构化分镜提供可追溯的视频候选生成、批量处理、受限播放和失效传播能力，并通过离线 Mock 证据支持本地开发验证；真实 Provider 认证由独立 Change 管理。
## Requirements
### Requirement: 已选首帧镜头可发起视频段图生视频生成

镜头 MUST 在「存在已选首帧候选（selected 指针非空）」且视频凭据已配置时才允许发起视频段生成；无已选首帧 MUST 以稳定错误码 `MEDIA_FIRST_FRAME_NOT_SELECTED` 拒绝且不落任何任务/候选行；凭据未配置 MUST 以 `MODEL_CREDENTIAL_INVALID` 前置拒绝并指向视频配置入口。生成输入 MUST 冻结为确定性哈希（选中首帧内容 sha256 + 镜头版本 + 模型/时长/分辨率参数指纹），同 requestId 同输入重放 MUST 返回同任务与候选清单（幂等建档，不产生第二轮）。候选数 MUST 为注入常量（缺省 2），多候选保留不覆盖。请求时长 MUST 按能力快照档位就近映射：取最小档 ≥ `target_duration_sec`，无则最大档并如实标注；MUST NOT 续写、拼接或自动拆分镜头。

#### Scenario: 无已选首帧稳定拒绝

- **GIVEN** 镜头 L 有多个 SUCCEEDED 首帧候选但尚未人工选择
- **WHEN** 用户对 L 发起视频段生成
- **THEN** 系统 SHALL 返回 `MEDIA_FIRST_FRAME_NOT_SELECTED` 且不落任何任务与候选行

#### Scenario: 幂等重放不产生第二轮

- **GIVEN** 镜头 L 已按已选首帧 F（sha256=h1）发起视频生成并建档 2 个 PENDING 候选
- **WHEN** 同 requestId 再次发起（输入未变）
- **THEN** 系统 SHALL 返回既有任务与候选清单，SHALL NOT 创建新任务或新候选行

#### Scenario: 时长档位就近映射

- **GIVEN** 能力快照声明时长档位 [5,10] 秒，镜头 L 的 target_duration_sec=3，已选首帧 F
- **WHEN** 用户发起视频段生成
- **THEN** 请求时长 SHALL 映射为 5 秒（最小档 ≥ 目标），候选记录 requested_duration_sec=5
- **WHEN** 镜头 target_duration_sec=15 再次发起
- **THEN** 请求时长 SHALL 映射为 10 秒（最大档）并如实标注目标超出档位上限，MUST NOT 续写或自动拆分镜头

### Requirement: 视频候选必须支持人工选择与 STALE 传播

每镜头至多一个 SUCCEEDED 视频候选可被人工选择（selected 指针原子切换，同镜头先清后设）；非 SUCCEEDED 候选不可选。旧候选 MUST 在两类输入变化时标记 `STALE_INPUT` 且保留可追溯：①镜头新 ShotContract 版本确认（按 shotVersionId 传播）；②已选首帧变化（按候选记录的 first_frame_file_sha256 与当前选中首帧 sha 不符判定）。STALE 传播 MUST 仅列出受影响镜头，MUST NOT 自动重发或自动建批。候选视图 MUST 按输入世代（generationInputHash）分组呈现。

#### Scenario: 首帧改选触发视频候选 STALE

- **GIVEN** 镜头 L 的视频候选 V1/V2 基于已选首帧 F1（sha=h1）生成且 SUCCEEDED
- **WHEN** 用户将首帧选择从 F1 改为 F2（sha=h2）
- **THEN** V1/V2 SHALL 全部标记 STALE_INPUT，文件与选择历史保留可追溯
- **THEN** 系统 SHALL 仅列出受影响镜头，SHALL NOT 自动发起重生成

#### Scenario: 镜头编辑升版触发 STALE 且选择历史可追溯

- **GIVEN** 镜头 L 存在基于旧镜头版本的视频候选（其中 V1 为 selected）
- **WHEN** L 经 editShot 修改并确认新版本
- **THEN** 旧版本视频候选 SHALL 标记 STALE_INPUT（含 V1，选择指针保留）

#### Scenario: 仅 SUCCEEDED 可选且每镜头至多一个

- **GIVEN** 镜头 L 有 PENDING 候选 V1 与 SUCCEEDED 候选 V2，V3 亦 SUCCEEDED 且已被选择
- **WHEN** 用户尝试选择 V1，随后改选 V2
- **THEN** 选择 V1 SHALL 被稳定拒绝；改选 V2 SHALL 原子切换指针（V3 的 selected 清空、V2 置位）

### Requirement: 视频异步任务必须留三段证据且恢复零重发

视频 Provider 为异步形态：候选 MUST 先持久化 provider_task_id 再进入轮询（spec 不变式）；每段 Provider 调用（SUBMIT/POLL/DOWNLOAD）MUST 独立落 `media_model_invocations` 证据行——请求快照、响应原文（64KiB 截断标记）、usage 落列、mp4 字节恒不入库；候选 invocation_evidence_ref 恒指 SUBMIT 行；DOWNLOAD 为轻量行（结果 URL 快照与落盘 sha256，blob 恒 NULL）。应用重启后：已留 provider_task_id 证据的未终态任务 MUST 续轮询；无证据的任务 MUST 标记 `MEDIA_TASK_INTERRUPTED` 待人工；MUST NOT 自动重发任何未留证请求。用户取消先落 CANCELLED 再中止在飞段，迟到结果经相位复核不落库。

#### Scenario: 重启后留证续轮询、无证待人工

- **GIVEN** 镜头 L 视频任务 T1 处 POLLING（provider_task_id 已持久化），镜头 M 任务 T2 处 SUBMITTED（无 provider 证据），应用退出
- **WHEN** 应用重启执行恢复
- **THEN** T1 SHALL 从既有 provider_task_id 续轮询，SHALL NOT 重新 submit
- **THEN** T2 SHALL 标记 MEDIA_TASK_INTERRUPTED 待人工，SHALL NOT 自动重发

#### Scenario: 三段证据齐备且字节不入库

- **GIVEN** 视频候选 V 经受控 Mock 异步链路（submit→poll×N→download）成功落盘 mp4
- **WHEN** 审计证据查询
- **THEN** V 的证据行 SHALL 含 1 条 SUBMIT（SUCCEEDED，raw+usage）、≥1 条 POLL、1 条 DOWNLOAD（轻量行 blob 恒 NULL、落盘 sha256 与文件一致），invocation_evidence_ref 恒指 SUBMIT 行

### Requirement: 整集视频批量必须显式触发并逐镜头独立建档

批量视频生成 MUST 仅响应显式用户动作；系统联动（STALE 传播）MUST NOT 自动建批。批次目标 MUST 为「已选首帧且当前输入世代无 SUCCEEDED 视频候选」的镜头；无已选首帧或当前世代已有 SUCCEEDED 的镜头 MUST 进入跳过清单如实回告；有效目标为空 MUST 以 `MEDIA_BATCH_NO_PENDING_SHOTS` 稳定拒绝。批次 MUST 惰性逐镜头建档（前一成员终态才提交下一镜头，任意时刻至多一个在飞成员）；成员失败 MUST NOT 阻断后续镜头，失败口径沿用「任务 FAILED 或 COMPLETED 而同轮零 SUCCEEDED」统一判定；队列耗尽后按全成/有败收尾 COMPLETED/PARTIAL_COMPLETED；取消仅作用未建档镜头；重启后 pending 队列继续全新提交、在飞成员按既有恢复规则处置零重发；重试失败镜头表达为仅含失败镜头的新批次。

#### Scenario: 整集一键排队与跳过回告

- **GIVEN** 整集 READY 共 6 镜头：L1/L2 已选首帧且无视频候选，L3 已选首帧且当前世代已有 SUCCEEDED 视频候选，L4–L6 未选首帧
- **WHEN** 用户点击「为整集生成视频」
- **THEN** 批次有效目标 SHALL 为 L1/L2，L3–L6 进入跳过清单如实回告

#### Scenario: 失败隔离与收尾派生

- **GIVEN** 批次推进中 L1 视频任务因 Provider 错误候选级全败（任务 COMPLETED、同轮零 SUCCEEDED）
- **WHEN** 批次继续推进至队列耗尽（L2 成功）
- **THEN** 批次 SHALL 收尾 PARTIAL_COMPLETED，失败清单含 L1 并携带候选错误码；「重试失败镜头」SHALL 创建仅含 L1 的新批次

#### Scenario: 取消与重启恢复不重发

- **GIVEN** 批次运行中 L1 在飞（POLLING），队列剩余 L2
- **WHEN** 用户取消批次后应用重启
- **THEN** 批次 SHALL 为 CANCELLED（剩余队列保留原序可追溯），L1 沿用既有任务恢复规则处置，SHALL NOT 为 L2 或任何镜头自动重发未留证请求

### Requirement: 视频产物必须走内容寻址存储与受限协议且路径不进 Renderer

mp4 字节 MUST 经内容寻址存储落盘（videos 命名空间、MIME 白名单 video/mp4、落盘后 sha256 复算校验、临时文件+原子 rename、路径防逃逸）；候选只登记哈希与元数据。Renderer MUST 经 `jingxu://media/video-candidate/{id}` 受限协议取流（协议支持 Range/206 基本请求，越界回 416），未知/未落盘 id 统一 404；CSP MUST 增 `media-src jingxu:`；文件系统路径 MUST NOT 进入 Renderer、回执或错误信息。候选 MUST 如实记录 requested_duration_sec、actual_duration_sec（Provider 未回报则 null）、续写段数（本切片恒 0）与裁剪区间（恒 null）。

#### Scenario: mp4 落盘与受限取流

- **GIVEN** 视频候选 V 下载完成（Mock 提供的有效 mp4 fixture 字节）
- **WHEN** 落盘与 Renderer 取流
- **THEN** 文件 SHALL 存于 videos 命名空间内容寻址路径，登记 sha256 与复算一致；Renderer 经协议取流成功且响应含 Range 支持；任何回执/错误信息不含文件系统路径

#### Scenario: 时长口径如实记录

- **GIVEN** 候选 V 请求时长 5 秒，Provider 回报实际时长 5.0 秒
- **WHEN** 候选落库
- **THEN** V SHALL 记录 requested_duration_sec=5、actual_duration_sec=5.0、续写段数=0、裁剪区间=null
- **WHEN** Provider 未回报实际时长
- **THEN** actual_duration_sec SHALL 为 null 如实记录，MUST NOT 伪造估算值

### Requirement: 视频生成界面必须区分结果与任务证据

视频生成界面 SHALL 优先展示可播放候选和用户可执行动作，任务与调用证据 MUST 置于可展开的高级信息中。

#### Scenario: 当前镜头视频已生成

- **GIVEN** 当前镜头存在 SUCCEEDED 且可用的视频候选
- **WHEN** 用户进入视频生成阶段
- **THEN** 页面 SHALL 显示受限媒体预览及“选用”状态
- **THEN** 页面 MUST NOT 显示文件路径或 Provider 原始响应

### Requirement: 视频 Provider 必须提供受限的 Seedance 模型选择

视频 Provider 设置 SHALL 提供 `Seedance` 与 `Agnes` 两个真实 Provider（万相档已于 2026-09-20 按用户决策整体移除）；开发和自动化环境另提供明确标记的 `Mock` 联调模式。Seedance SHALL 仅提供 `Seedance-2.0-mini`、`Seedance-2.0`、`Seedance-2.5` 三个模型选项，新安装或尚未保存模型选择的 Seedance Profile MUST 默认 `Seedance-2.0-mini`，已有 Seedance Profile MUST 保持原选择。Agnes SHALL 仅提供 `agnes-video-v2.0`（默认）与 `agnes-video-2.5-flash` 两个冻结模型，固定 `apihub.agnes-ai.com` 端点、data URL 首帧图生视频、5 秒时长与 720P（2.5 Flash 为服务端硬校验），并在设置界面标注当前 $0/秒促销与免费档 1 RPM 限制。Renderer MUST 只提交受限 Provider/模型枚举，MUST NOT 接收任意模型 ID、Provider URL、地域、Workspace、端点 ID、音频开关或本地路径。

Seedance 与 Agnes MUST 使用独立 Provider Profile 和独立凭据引用。模型及当前 Provider 选择与 API Key 分开保存；切换 Provider 或模型 MUST NOT 读取、回显、导出、替换或删除任一 API Key。

#### Scenario: 新 Seedance 档默认 mini

- **GIVEN** 应用已进入可写状态且不存在既有 Seedance 视频 Profile
- **WHEN** 用户首次打开视频 Provider 设置或保存 Seedance 档
- **THEN** 系统 SHALL 将 `Seedance-2.0-mini` 作为受限默认模型
- **THEN** 系统 MUST NOT 自动选择 Seedance-2.0 或 Seedance-2.5

#### Scenario: 用户选择受支持的视频模型

- **GIVEN** 应用已进入可写状态，对应真实 Provider Profile 可用
- **WHEN** 用户选择受支持的 Seedance 模型并保存
- **THEN** 系统 SHALL 保存对应的受限 Provider/模型快照并在重新读取设置时展示所选值
- **THEN** 系统 MUST NOT 在返回 DTO、SQLite 明文字段、日志或 Renderer 状态中暴露 API Key

#### Scenario: 已有 Seedance 选择兼容保留

- **GIVEN** 升级前 Seedance Profile 已保存 Seedance-2.0 或 Seedance-2.5
- **WHEN** 应用完成迁移并重新读取 Profile
- **THEN** 系统 SHALL 展示并继续使用原模型，SHALL NOT 将其自动改写为 mini

#### Scenario: 用户选择受支持的 Agnes 模型

- **GIVEN** 应用已进入可写状态且 Agnes Profile 可用
- **WHEN** 用户选择 Agnes 并保存 `agnes-video-v2.0` 或 `agnes-video-2.5-flash`
- **THEN** 系统 SHALL 保存固定端点、data URL 首帧、5 秒、720P 能力快照并展示该选择与免费促销/1 RPM 提示
- **THEN** 系统 MUST NOT 在 DTO、SQLite 明文字段、日志或 Renderer 状态中暴露 Agnes API Key

#### Scenario: 各 Provider 凭据相互隔离

- **GIVEN** 用户已分别保存 Seedance ARK API Key 与 Agnes API Key
- **WHEN** 用户在 Seedance、Agnes 和 Mock 之间切换
- **THEN** 系统 SHALL 只读取当前真实 Provider 对应的凭据引用
- **THEN** 其他 Provider 的密文、末四位和验证元数据 SHALL 保持不变

#### Scenario: 非法 Provider 或模型选择被拒绝

- **GIVEN** Renderer 或其他调用方提交不在受支持列表的 Provider、模型、地域、URL 或参数
- **WHEN** Main 校验视频 Provider 设置命令
- **THEN** 系统 SHALL 返回稳定请求错误且不得修改当前选择、Provider Profile、凭据或视频任务

#### Scenario: 非法模型选择被拒绝

- **GIVEN** Renderer 或其他调用方提交不在当前 Provider 受支持列表中的模型值
- **WHEN** Main 校验视频 Provider 设置命令
- **THEN** 系统 SHALL 返回稳定请求错误且不得修改 Provider Profile、凭据、当前选择或视频任务

### Requirement: 视频任务必须冻结所选模型并按模型能力提交

每次视频任务建档 SHALL 读取当前视频模式和受支持的 Provider/模型选择，并把模式、Provider、实际模型 ID、能力快照 ID 写入候选、生成输入哈希和调用证据。后续切换模式、Provider 或模型 MUST NOT 改写已建档任务、候选或调用证据；历史任务 SHALL 继续使用建档时冻结的 Adapter、Provider 任务 ID、模型和凭据引用完成轮询或恢复。每个模型的时长、分辨率、首帧图生视频、地域和音频约束 MUST 由受版本控制的本地能力表执行；不支持的参数 MUST 在请求发出前拒绝，不得静默降级、自动换 Provider、开启音频或篡改用户输入。

#### Scenario: 切换 Provider 不改变已建档任务

- **GIVEN** 镜头 L 的视频候选已使用 Provider A、模型 A 建档但尚未完成
- **WHEN** 用户将当前视频 Provider 切换为 Provider B
- **THEN** L 的候选和后续轮询/下载 SHALL 保持 Provider A、模型 A、原能力快照与调用证据
- **THEN** 此后新建的视频候选 SHALL 冻结 Provider B 的当前受支持模型

#### Scenario: 切换模型不改变已建档任务

- **GIVEN** 镜头 L 的视频候选已使用 Provider A 的模型 A 建档但尚未完成
- **WHEN** 用户把同一 Provider 的当前模型切换为模型 B
- **THEN** L 的候选和后续轮询/下载 SHALL 保持 Provider A、模型 A、原能力快照与调用证据
- **THEN** 此后新建的视频候选 SHALL 冻结模型 B

#### Scenario: Agnes 只提交固定免费档参数子集

- **GIVEN** 用户选择 Agnes `agnes-video-v2.0` 或 `agnes-video-2.5-flash`，镜头具有合法已选首帧
- **WHEN** 系统建立真实视频请求
- **THEN** 请求 SHALL 使用固定 `apihub.agnes-ai.com` 端点、data URL 首帧、5 秒时长与 720P（2.5 Flash 显式 `size:"720P"`）
- **THEN** 系统 MUST NOT 提交任意 Base URL、参考音频/视频输入、首尾帧序列、其他时长或分辨率参数

#### Scenario: 新模型的有效子集参数被提交

- **GIVEN** 用户选择任一受支持模型，镜头具有合法已选首帧
- **WHEN** 系统按冻结 Provider 和模型的本地能力约束建立视频请求
- **THEN** 系统 SHALL 只提交该模型确认支持的首帧图生视频参数子集
- **THEN** 系统 MUST NOT 因 Provider 或模型切换自动启用音频、视频编辑、续写或成片能力

#### Scenario: Mock 任务切换后仍可追溯

- **GIVEN** 镜头 L 已在 Mock 模式建档且任务仍在轮询
- **WHEN** 用户把当前视频 Provider 切换为 Seedance 或 Agnes
- **THEN** L SHALL 继续按冻结的 Mock 步骤完成并保持模拟标记
- **THEN** 系统 MUST NOT 把该任务转交真实 Adapter 或读取真实凭据

### Requirement: 模型无权限错误必须可执行且不泄露 Provider 原文

当火山方舟返回模型、地域、接入点不存在、未开通或无权限的错误时，系统 SHALL 将失败归一化为稳定的非重试错误，并按冻结 Provider 提示用户在对应平台为当前 API Key 所属账号开通模型或核对地域/业务空间。Renderer MUST NOT 展示 Provider 原始错误体、请求 ID、Authorization、API Key、签名信息或结果 URL；原始响应仅按既有调用证据边界在 Main/持久化层留存。

#### Scenario: Seedance 模型未获账号授权

- **GIVEN** 已配置的 ARK API Key 无权调用冻结的 Seedance 模型
- **WHEN** 视频候选提交得到模型或接入点不可用响应
- **THEN** 候选 SHALL 以稳定模型不可用错误终态留存，并提示前往火山方舟开通模型或接入点
- **THEN** 系统 MUST NOT 自动切换到 Mock 或其他 Seedance 模型

#### Scenario: 所选模型未获账号授权

- **GIVEN** 已配置的视频 API Key 无权调用建档时冻结的真实 Provider 模型
- **WHEN** 视频候选提交得到模型、地域或接入点不可用的 Provider 响应
- **THEN** 候选 SHALL 以稳定的模型不可用错误终态留存，并向用户展示对应平台的开通或配置下一步
- **THEN** 系统 MUST NOT 自动切换 Provider、自动重试非重试错误或篡改历史证据

#### Scenario: Agnes 限流或促销到期

- **GIVEN** 已配置的 Agnes API Key 在免费档（1 RPM/每日时长配额）或促销计费规则变化
- **WHEN** 视频候选提交得到 429 或计费相关 4xx 响应
- **THEN** 429 SHALL 归一为可重试限流错误并交给既有调度退避；非重试计费错误 SHALL 以稳定错误终态留存并提示核对 Agnes 账号状态
- **THEN** 系统 MUST NOT 自动改用其他 Provider、静默降级参数或篡改历史证据

### Requirement: 视频联调必须默认使用可识别的零网络 Mock

开发启动与自动化测试中的视频生成 MUST 默认使用确定性 Mock，Mock 模式 MUST NOT 读取真实 Provider 凭据、发起网络请求或产生 Provider 费用。切换到真实 Seedance 或 Agnes MUST 是显式动作，并在提交前通过对应凭据闸；正式打包运行 MUST NOT 因凭据缺失或 Provider 失败而静默回退到 Mock。Mock 任务、候选、调用证据和界面状态 MUST 明确标记为模拟结果，不得被展示或导出为真实 Provider 生成证据。

#### Scenario: 开发联调默认零网络

- **GIVEN** 开发者未显式选择真实视频 Provider
- **WHEN** 启动应用并完成视频单镜头、批量、取消、失败或恢复联调
- **THEN** 系统 SHALL 只消费确定性 Mock 步骤且不读取任何真实视频凭据
- **THEN** 网络观察 SHALL 不出现火山方舟或 Agnes AI 视频请求

#### Scenario: 正式运行不得静默伪造成功

- **GIVEN** 正式打包应用选择了真实 Provider 但对应凭据缺失或请求失败
- **WHEN** 用户发起视频生成
- **THEN** 系统 SHALL 以稳定错误拒绝或记录真实失败
- **THEN** 系统 MUST NOT 自动回退到 Mock、创建模拟成功候选或把模拟证据标记为真实 Provider

#### Scenario: 真实调用必须显式开启

- **GIVEN** 当前运行处于 Mock 联调模式且已保存某个真实 Provider 凭据
- **WHEN** 用户未显式切换到该真实 Provider 便发起视频生成
- **THEN** 系统 SHALL 继续使用 Mock 且不得读取该密文
- **WHEN** 用户显式切换并确认真实调用边界后再次生成
- **THEN** 系统 SHALL 在凭据闸通过后仅调用被选中的真实 Provider

