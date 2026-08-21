## ADDED Requirements

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
