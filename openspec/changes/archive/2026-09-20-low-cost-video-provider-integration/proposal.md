## Why

> **范围修订（2026-09-20）**：经用户决策，万相（`wan2.6-i2v-flash`）档整体移除——Adapter、组合根注册、设置卡、E2E 与真实探针任务（原 7.4）全部取消；本提案下文涉及万相的段落保留为决策历史，落地范围以 Seedance + Agnes 双真实 Provider 为准。0023/0024 迁移已被真库 checksum 钉死，其中万相能力快照行（`dashscope-wan-video/v1`）保留为无害残留，不回写。

当前视频实验链默认解析为 Seedance-2.0，日常联调除 Electron E2E 外会进入真实火山方舟适配器，容易把状态机、IPC、恢复和下载链路验证转化为不必要的计费调用。现阶段需要把确定性 Mock 作为常规联调默认路径，把 Seedance 默认档降为 Seedance-2.0-mini，并在不改写既有任务证据的前提下增加阿里云百炼万相 `wan2.6-i2v-flash` 无声首帧图生视频与 Agnes AI `agnes-video-v2.0`/`agnes-video-2.5-flash` 两个当前 $0/秒档视频模型，形成可显式选择、可追溯、可控预算的三真实 Provider 路径。

本 Change 属于 PRD v1.4 §10.2、§10.4、§10.6 和 §10.8 的 V2 实验能力，不改变 PRD v1.4 §9.7～§9.11 的 V1 发布验收，也不把低价模型接入描述为真实质量、成本或生产认证。

PRD v1.4 §10.4 当前限定个人项目 V2 只接入一家视频 Provider；用户明确要求保留 Seedance 并同时接入万相（2026-09-18）与 Agnes（2026-09-19），因此本 Change 同步把该限制修订为“三家受限视频 Provider、每次任务只显式选择一家、不得自动路由”。在 PRD 与 TECH 完成同步前，该范围冲突属于 Apply/Verify 阻断项。

## What Changes

- 将未配置新选择的 Seedance 视频档默认模型从 Seedance-2.0 改为 `Seedance-2.0-mini`；已有 Profile、已建档任务、候选、输入哈希和调用证据保持原模型不变。
- 增加开发/自动化专用的显式 Mock 视频联调模式；开发与测试入口默认 Mock，必须通过显式选择并满足凭据闸才允许真实 Provider 请求，Mock 结果在 UI 和证据中清楚标记，不能伪装成真实生成。
- 新增阿里云百炼万相视频 Provider，首批只允许北京地域 `wan2.6-i2v-flash`、首帧图生视频、`audio=false`、720P/1080P 受限参数；Provider URL、模型 ID、地域和音频开关不接受 Renderer 任意输入。
- 新增 Agnes AI 视频 Provider（OpenAI Videos 兼容异步任务 API），首批只允许 `agnes-video-v2.0` 与 `agnes-video-2.5-flash` 两个冻结模型、data URL 首帧图生视频、5 秒固定时长、720P 档（2.5 Flash 服务端硬校验仅 720P）；官方当前定价 $0/秒（2.5 Flash 为限时促销，V2.0 currently free），免费档视频 1 RPM/每日时长配额按平台公告为准；Provider URL、模型 ID 不接受 Renderer 任意输入。
- 同步修订 PRD v1.4 §10.4 的“一家视频 Provider”限制和 TECH_DESIGN v1.1 的视频 Provider 实施注记；三家 Provider 仅允许人工显式选择，不引入自动路由。
- Seedance、万相与 Agnes 使用独立 Provider Profile 和独立 safeStorage 密文；用户显式选择当前视频 Provider，切换不得读取、覆盖或删除另一家的 API Key。
- 复用既有 `VideoModelPort`、视频任务状态机、幂等、调用证据、内容寻址存储和受限媒体协议；新增万相与 Agnes 异步 submit/poll/download Adapter、错误归一化、能力快照及兼容迁移（0023，因 0022 已被 `enforce-character-style-consistency` 的 `0022_media_style_assets.sql` 占用）。
- 真实视频调用保持候选数、时长和重试语义可审计；结果未知不得自动重发，Mock 测试不得产生 Provider 调用或费用。
- 同步 Provider 数据提示、README/TECH 实施快照以及真实低成本 Canary 的人工授权说明；本 Change 的自动化验收以 Mock 和本地契约为主，真实万相探针单独受预算开关约束，Agnes 事实冻结探针已于 2026-09-19 在用户授权 key 下完成（见 design.md Context）。
- 非目标：不新增多模型自动路由、按价格自动切换、首尾帧/参考生视频、自动音频、视频续写、生产成本账单、公开在线服务或质量优劣承诺。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `shot-video-generation`: 修改视频 Provider 选择、默认模型、联调 Mock 边界、Provider 凭据隔离、任务模型冻结和真实错误处理要求，并增加万相 2.6 Flash 与 Agnes V2.0/2.5 Flash 的受限首帧图生视频路径。

## Impact

- **代码**：`packages/model-adapters` 新增 DashScope/Wan 与 Agnes 视频适配器与能力注册表；`packages/application` 的 Provider 类型、当前视频 Provider 解析及请求蓝图按 Provider 参数化；Electron Main 组合根按 Mock/Seedance/Wan/Agnes 注入；Renderer 视频 Provider 设置增加显式 Provider/联调模式展示。
- **IPC/契约**：保留现有 `video.*` 方法数量与业务 DTO 主体，扩展受限 Provider/模型枚举和 Provider Profile DTO；任何新增字段均经 Zod 校验且不暴露密钥、URL、本地路径或原始响应。
- **数据库**：新增前进 migration 0023，保存独立万相/Agnes Profile、当前视频 Provider 选择和版本化能力快照；不改写既有 migration，不修改四份 PRD-owned V1 Schema，不覆盖 `profile-video-primary` 的历史 Seedance 事实。
- **进程/网络**：真实请求仍只发生在 Electron Main 的受限 Adapter，Seedance 仅访问火山方舟 HTTPS allowlist，万相仅访问百炼北京地域 HTTPS allowlist，Agnes 仅访问 `apihub.agnes-ai.com`（API）与 `cos-platform-outputs.agnes-ai.cn`（结果下载）HTTPS allowlist；Renderer、Application 和 JobRunner 不持有 API Key 或 Provider 专有 DTO。
- **安全**：三家凭据分别由 safeStorage 加密，SQLite 只保存引用和脱敏元数据；切换 Provider 不触发凭据复制、回显、导出或自动探测。
- **兼容性**：已有 Seedance Profile 和在途/历史任务继续使用冻结的 Seedance 模型；新安装的 Seedance 缺省档为 mini；开发/测试脚本迁移到 Mock 默认，正式打包不得因缺失显式配置而静默生成 Mock 成功结果。
- **测试**：增加 unit、contract、SQLite integration 和 Electron E2E，覆盖默认模型迁移、Mock 零网络、三凭据隔离、Provider 切换、Wan/Agnes submit/poll/download、401/429/5xx/超时/取消/结果未知、重启恢复和历史任务冻结；真实 Canary 仅在人工提供凭据和预算开关时运行。
