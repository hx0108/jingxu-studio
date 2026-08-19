## ADDED Requirements

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
