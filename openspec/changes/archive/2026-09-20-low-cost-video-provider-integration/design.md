## Context

动机见 `proposal.md`。当前视频链已经具备共享 `VideoModelPort`、确定性 `MockVideoModelAdapter`、真实异步 `SeedanceVideoModelAdapter`、视频任务/候选/调用证据表、内容寻址落盘和七个生成 IPC；但组合根仅在 Electron E2E 时使用 Mock，其他运行固定实例化 Seedance，当前模型解析默认 `doubao-seedance-2-0-260128`。任务表未冻结 Provider/Profile/能力快照，单一 Adapter 在 Provider 切换后也无法可靠恢复旧任务。

PRD v1.4 §10.4 当前只允许一家视频 Provider；本 Change 按用户明确要求同步修订为 Seedance、Wan 与 Agnes 三家受限 Provider，但仍保持“一次任务只显式选择一家、不得自动路由”。PRD v1.4 §10.6 的异步任务、幂等、取消、恢复和多候选语义，以及 TECH_DESIGN v1.1 §4.3.3、§5.3、§13.1～§13.4 的依赖、恢复、密钥和日志边界保持不变。

2026-09-18 官方资料快照确认：北京地域 `wan2.6-i2v-flash` 使用业务空间域名下的异步视频生成接口，支持 Base64 首帧、720P/1080P、2～15 秒整数时长；无声请求必须显式设置 `audio=false`。价格仅作为选型背景，不写入成功事实：720P 无声刊例价 0.15 元/秒、1080P 无声 0.25 元/秒。来源：

- `https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/`
- `https://help.aliyun.com/zh/model-studio/wan2-6-i2v-flash`

2026-09-19 Agnes AI 官方 wiki 与受控真实探针（用户授权 key，当日 $0/秒促销档，共 4 个 5 秒任务）冻结事实：

- 端点：`POST https://apihub.agnes-ai.com/v1/videos` 建任务（OpenAI Videos 兼容形状）；`GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>&model_name=<模型ID>` 轮询（非 text 模式 MUST 带 `model_name`）。本机直连两域通畅（无需代理）。
- 建任务响应含 `id`/`task_id`（同值）与 `video_id`（长 base62 串）；轮询状态机 `queued → in_progress → completed/failed`，实测约 79 秒完成。
- **文档与实际不符**：完成态结果 URL 在顶层 `url` 字段（官方文档写 `metadata.url`，实测不存在）；下载域为 `cos-platform-outputs.agnes-ai.cn`（腾讯云 COS，匿名 GET），MP4 `ftyp` 魔数实测通过。
- **data URL 首帧实测被接受**：`agnes-video-v2.0` 以 `image: "data:image/png;base64,..."` 提交 i2v 任务成功完成并下载，与万相传法一致，无需公网图床。`agnes-video-2.5-flash` 的 i2v 形状为 `mode:"keyframe"` + `first_frame`（400 实测：`images` 数组不被 keyframe 模式接受、`first_frame` 必需），首帧边长须在 256～5760 像素。
- 状态机含文档外值 `pending`（queued 之前）；轮询查询另有独立频控（429 "too many video status queries"，4 秒间隔即可能触发）——轮询 429 按可重试 `MODEL_RATE_LIMITED` 归一，交调度器退避。路由上观察到瞬时 SSL 握手超时/EOF，按可重试网络错误归一。
- `agnes-video-2.5-flash` 服务端硬校验：`size` 仅接受 `"720P"`、`images` ≤5、`audios` ≤3、`videos` 不支持；非法请求在建任务/计费前 400 拒绝。`seconds` 参数为字符串（如 `"5"`）。
- 免费口径：`agnes-video-v2.0` "currently free"；`agnes-video-2.5-flash` 列表价 $0.025/秒、当前 $0/秒（"free for a limited time"）。免费档视频 **1 RPM**（企业 2、Token Plan 5）且受每日时长配额约束；429 表示 RPM/配额超限。来源：

- `https://wiki.agnes-ai.com/en/docs/agnes-video-v20`
- `https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash`
- `https://wiki.agnes-ai.com/en/docs/pricing`、`/en/docs/tokenplan`、`/en/docs/faqs`

## Goals / Non-Goals

**Goals:**

- 让开发启动和自动化默认走零网络、可识别的 Mock，并要求真实调用显式开启。
- 将新 Seedance Profile 默认模型改为 mini，同时保持已有 Profile 和历史任务不变。
- 在现有媒体任务架构中接入受限 Wan 与 Agnes 异步 Adapter，并支持 Provider 切换后的在途任务恢复。
- 让 Provider、Profile、模型和能力快照成为建档时冻结的确定性事实，而非调度时读取可变全局配置。
- 保持三家凭据、网络 allowlist、错误原文和 Renderer 数据边界隔离。

**Non-Goals:**

- 不实现按价格、质量、失败率自动路由或 Provider 自动回退。
- 不实现首尾帧、参考生视频、视频续写、Wan 音频、多镜头模式、Prompt 自动改写或任意地域。
- 不把刊例价做成生产账单或预算扣费；PRD v1.4 §10.8 的成本账本另行建设。
- 不修改四份 PRD-owned V1 JSON Schema；本 Change 属于 V2 实验路径。
- 不引入 DashScope SDK；使用平台内置 `fetch` 保持依赖最小和证据读取一致。

## Decisions

### D1. 模式与默认值由确定性配置决定

定义 `VideoProviderMode = 'MOCK' | 'SEEDANCE' | 'WAN' | 'AGNES'`。开发脚本和 Electron E2E 缺省注入 `MOCK`；真实调用只接受显式 `SEEDANCE`、`WAN` 或 `AGNES`。正式打包不读取开发默认：新安装以 `SEEDANCE` 为初始真实档但在凭据缺失时稳定拒绝，绝不回落 Mock。Main 在启动时把最终模式固定进组合根；Renderer 只能提交受限枚举，不能提交 URL、端点或环境变量。

Seedance 注册表的 `DEFAULT_SEEDANCE_VIDEO_MODEL_ID` 改为 `doubao-seedance-2-0-mini-260615`。默认值只用于不存在 Profile 的新配置；Repository 中已有 model_id 不迁移、不覆盖。Agnes 档内默认模型为 `agnes-video-v2.0`（2.5 Flash 为可选档，720P 硬校验在服务端兜底）。

被否决方案：仅把当前固定 Seedance ID 改成 Wan。该方案破坏用户要求的多 Provider 共存，无法保留 Seedance 任务恢复，也会把 ARK Key 与 DashScope Key 混用。

### D2. 三家真实 Provider 使用独立 Profile 与密文

保留既有 `profile-video-primary` 作为 Seedance 兼容档，不重命名，避免破坏历史 UI、密文文件和 Profile 引用。新增 `profile-video-wan-primary` 与 `profile-video-agnes-primary`，Provider 枚举新增 `DASHSCOPE_WAN_VIDEO` 与 `AGNES_VIDEO`；其 safeStorage 密文文件、末四位、校验时间和删除审计独立。Mock 不创建 Provider Profile，也不读取密文。

新增单例偏好 `video_provider_preferences`，保存 `mode`、真实模式对应的 `provider_profile_id`、`updated_at` 和乐观并发令牌。Main 的保存命令在一个短事务中校验固定映射：SEEDANCE→`profile-video-primary`、WAN→`profile-video-wan-primary`、AGNES→`profile-video-agnes-primary`、MOCK→null。Provider 切换不自动测试凭据，也不删除另一档。

被否决方案：复用同一 `profile-video-primary` 并在切换时覆盖 provider/model/key。该方案会让历史 `credential_ref` 失去语义，切换时有误用另一家密钥和不可恢复覆盖的风险。

### D3. Migration 0023 冻结视频调用来源并保持历史兼容

> **落地修订（2026-09-19）**：树上 `0023_video_provider_preferences.sql` 先行落地了偏好单例切片并被真库 checksum 钉死（不可改写）；本节余量（任务/候选冻结列、三快照播种、受控回填阻断）按同一决策落地为 `0024_low_cost_video_provider_provenance.sql`（前沿 22→23→24），回填/快照/矩阵见 tasks 3.1～3.3 勾注。

新增 `0023_low_cost_video_providers.sql`（原设计占用 0022，因 `enforce-character-style-consistency` 已落地 `0022_media_style_assets.sql`，前沿顺延为 22→23），不得改写 0012～0015 与 0022：

- 新建 `video_provider_preferences` 单例表并写入受限 CHECK（mode ∈ MOCK/SEEDANCE/WAN/AGNES 固定映射）。
- 重建或前进扩展 `video_generation_tasks`，增加 `provider_kind`、`provider_profile_id`、`model_id`、`capability_snapshot_id`、`is_mock`；新任务全部非空且满足 Mock/真实 Profile 条件。
- 扩展 `video_candidates` 同源增加 Provider/Profile/能力快照/Mock 标记，保证 Renderer 无需从可变当前设置推断来源。
- 播种 `dashscope-wan-video/v1` 能力快照（北京业务空间域名模板、`wan2.6-i2v-flash`、Base64 首帧、2～15 秒整数、720P/1080P、`audio=false`、20 MiB、受支持 MIME）与 `agnes-video/v1` 能力快照（`apihub.agnes-ai.com` 固定端点、`agnes-video-v2.0`+`agnes-video-2.5-flash`、data URL 首帧、5 秒固定、720P、PNG/JPEG/WEBP、10 MiB、免费档 1 RPM）；canonical JSON、SHA-256 与 SourceURL 三处核对。
- 旧视频任务和候选按既有 model_id 回填 `VOLCARK_SEEDANCE`、`profile-video-primary`、非 Mock；能力快照按受控模型映射回填。映射不到的历史行阻断 migration/invariant audit，不猜测 Provider。

Migration 前沿从 22 到 23，需同步版本常量、空库/上一版/100+ 历史版本库测试和 checksum。升级前沿用 SQLite 在线备份；失败事务回滚且不启动调度器。

被否决方案：只把 Provider 放进 `generation_input_hash` 或由模型名前缀推断。哈希不可作为可查询事实，且在模型重名、恢复和审计时不够可靠。

### D4. Application 层按任务冻结事实解析 Adapter

把视频组合根的单例 `videoModel` 改为受限 `VideoModelResolver` Application Port：输入冻结的 `provider_kind/profile_id/model_id/is_mock`，返回对应 `VideoModelPort`。媒体调度器增加可选的按任务解析入口；图片实例继续注入固定 Model Port，行为不变。视频任务在建档事务内同时冻结 Provider/Profile/模型/能力快照，之后的 submit、poll、download、取消迟到处理和重启恢复只读取任务冻结值。

Provider 网络请求仍在事务外；SUBMIT/POLL/DOWNLOAD 的证据收尾、候选终态和指针更新继续走既有短事务。`request_snapshot_json` 增加非敏感 Provider/Profile/能力快照标识，不含 Key、首帧字节、任意 URL 或文件路径。

被否决方案：实现一个靠 `provider_task_id` 字符串前缀分流的 Router。它会污染 Provider 原始任务 ID、影响外部对账，也无法可靠处理尚未拿到 task_id 的 submit 阶段。

### D5. Wan Adapter 只实现固定无声首帧图生视频子集

> **⚠️ 已移除（2026-09-20）**：经用户决策「真实万相不接入」，本节及 D5 之外的 Wan 代码面（Adapter/组合根/设置卡/自举通道/E2E）已整体删除；Provider 枚举、选择 DTO 与文档同步收窄为 Seedance + Agnes。0024 中 `dashscope-wan-video/v1` 快照行与历史 `wan2.6-i2v-flash` model_id 映射保留（迁移不可改写），运行时不再有任何万相请求路径。

新增 `WanVideoModelAdapter implements VideoModelPort`，不引入新 SDK。端点由受校验的北京 Workspace ID 派生：

- submit：`POST https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`，固定 `X-DashScope-Async: enable`、Bearer DashScope Key、`model=wan2.6-i2v-flash`、Base64 `img_url`、`parameters.audio=false`、`prompt_extend=false`、`shot_type=single`、`watermark=true`、受控 resolution/duration。
- poll：`GET .../api/v1/tasks/{task_id}`，只映射 PENDING/RUNNING/SUCCEEDED/FAILED/UNKNOWN；UNKNOWN 与过期结果归一为不可自动重发的 `MODEL_RESULT_UNAVAILABLE`。
- download：只接受 HTTPS、无 userinfo 的结果 URL，禁止重定向，下载后以 `ftyp` 魔数校验 MP4，再交既有 videos 内容寻址存储。
- 输入：JPEG/PNG/BMP/WEBP，宽高 240～8000、文件不超过 20 MiB；Renderer 不可扩大该集合。

时长能力从单一 `[5,10]` 改为 Provider 版本化档位：Seedance 保持既有 5/10，Wan 为 2～15 的整数集合，Agnes 两模型固定 5 秒（`seconds:"5"`，不开放时长参数）。建档前先解析 Provider 能力，再执行就近映射并写入输入哈希。分辨率按首帧目标尺寸映射为 720P/1080P（Agnes 固定 720P）；本 Change 不让用户任意覆盖模型参数。

### D5b. Agnes Adapter 只实现固定 720P 首帧图生视频子集

新增 `AgnesVideoModelAdapter implements VideoModelPort`，不引入 SDK，端点为固定常量（无 Workspace 拼接，SSRF 面更小）：

- submit：`POST https://apihub.agnes-ai.com/v1/videos`，Bearer Agnes Key、`model ∈ {agnes-video-v2.0, agnes-video-2.5-flash}`（冻结注册表）、`prompt`、`image: "data:<mime>;base64,..."` 首帧、`mode:"ti2vid"`、`seconds:"5"`；2.5 Flash 额外固定 `size:"720P"`。响应取 `video_id` 作为 providerTaskId（轮询必需；`task_id` 同值仅留档）。
- poll：`GET https://apihub.agnes-ai.com/agnesapi?video_id=<ID>&model_name=<模型ID>`，映射 `queued/in_progress→PENDING`、`completed→SUCCEEDED（取顶层 url，实侧与文档不符处按实测冻结）`、`failed→FAILED`；缺 `url` 的 completed 视为 `MODEL_INVALID_RESPONSE`。
- download：只接受 HTTPS、无 userinfo、域按 Agnes 注册域后缀匹配（`agnes-ai.cn`/`agnes-ai.space` 及其子域——2026-09-19 实测两个输出域 `cos-platform-outputs.agnes-ai.cn` 与 `platform-outputs.agnes-ai.space`，CDN 桶随任务变化，固定单域清单不成立）的结果 URL，禁止重定向，下载后以 `ftyp` 魔数校验 MP4，再交既有 videos 内容寻址存储。
- 输入：JPEG/PNG/WEBP，文件不超过 10 MiB；Renderer 不可扩大该集合。
- RPM：免费档视频 1 RPM，且有**累积 API rate limit**（2026-09-19 实测：当日约 9 个创建后 V2.0 提交返回 "You've reached the API rate limit for free users"，提示升级 Token Plan；免费档测试须按日预算）。Adapter 不做客户端节流，429 归一 `MODEL_RATE_LIMITED`（可重试）交由既有调度器退避；UI 在 Agnes 档标注“免费档约每分钟限 1 个任务”。
- 轮询间隔：`AGNES_VIDEO_POLL_INTERVAL_MS = 7s`（组合根按 AGNES 档覆盖全局 3s——调度器对轮询期错误同样判候选失败无退避，而状态查询频控实测 4 秒间隔即 429、5 秒不触发）。
- 2.5 Flash 容量：免费档队列可满载（HTTP 503 `video_queue_full`，实测可持续 10+ 分钟）；归一 `MODEL_PROVIDER_ERROR`（可重试，“等待后重试”），请求形状本身当日已验证可用。

被否决方案：在 Adapter 内实现按分钟窗的客户端排队。会把限流状态藏在 Adapter 单例里，重启后丢失且与调度器退避双轨冲突；429 语义归一后由调度器统一节流更可审计。

### D6. 错误与未知结果沿用稳定语义

Wan/Agnes HTTP/业务错误归一化：401/403→`MODEL_CREDENTIAL_INVALID`；429→`MODEL_RATE_LIMITED`；5xx/可重试网络错误→`MODEL_PROVIDER_ERROR`/`MODEL_NETWORK_ERROR`；非法参数/图片→`MODEL_INPUT_TOO_LARGE`；模型或地域不可用→`MODEL_MODEL_UNAVAILABLE`；内容安全拒绝→`MODEL_CONTENT_REJECTED`；任务 UNKNOWN、结果 URL 过期或非法→`MODEL_RESULT_UNAVAILABLE`。原始响应最多读取 64 KiB，经 Main-only `evidenceOf` 留档，不进入 Renderer 或普通日志。

调度器的未知结果禁重发、取消迟到不落版本、恢复零重发规则保持不变。Provider 错误不得触发 Seedance↔Wan↔Agnes 或真实→Mock 回退。

### D7. IPC/DTO 与 UI 只暴露受限选择和真实边界

现有七个 `video.*` 生成方法及其 DTO 不变。Provider 设置方法族增加 `getVideoProviderSelection`/`saveVideoProviderSelection`，输入仅含受限 mode 和 `expectedUpdatedAt`；现有 Provider Profile DTO 枚举增加 Wan 与 Agnes，但仍不含 baseUrl、credentialRef、完整 Key 或原始响应。

设置页展示四种模式：Mock（醒目标记“联调模拟，不调用外部模型”）、Seedance（默认 mini）、Wan（固定 2.6 Flash 无声）和 Agnes（V2.0 默认 / 2.5 Flash 可选，标注当前 $0/秒促销与 1 RPM 限制）。真实模式在发起前显示 Provider 和数据处理提示；保存 Provider 选择本身不发网络请求、不计费。Mock 产生的候选卡、任务高级信息和导出前检查均显示模拟来源。

### D8. 真实 Canary 单独受预算开关约束

自动化门禁全部使用 Mock 或注入 fetch，不访问真实网络。新增真实 Wan probe 仅在同时满足人工提供的凭据文件、Workspace ID、`JINGXU_REAL_WAN_VIDEO_PROBE=1` 和明确预算参数时运行；固定一个镜头、一个候选、720P、最短验收时长，打印脱敏任务/证据摘要，不打印 Key、完整响应或结果 URL。未运行该探针时只能声明 Adapter/契约通过，不能声明万相账号可用或真实画质合格。

Agnes 事实冻结探针已于 2026-09-19 经用户授权 key 运行（V2.0 text、V2.0 data URL i2v、2.5 Flash text、2.5 Flash keyframe 四个 5 秒任务，当日 $0/秒），日志存 `jingxu-tools/agnes-probe.log`；该证据只冻结 API 形状与免费事实，不构成画质或生产认证。

### D9. 文档与产品范围同步

Apply 首批任务同步修改 PRD v1.4 §10.4，把“一家视频 Provider”改为“三家受限视频 Provider、人工选择、无自动路由”，并更新 §10.8 的多 Provider 成本口径；TECH_DESIGN v1.1 更新 Provider 实施注记、Application Port、迁移前沿（0023）、安全 allowlist 和测试说明。README 必须继续标明真实 Provider 认证和真实用户验收边界。

四份 PRD-owned V1 JSON Schema 不适用：本 Change 不修改 V1 业务交换契约。公开 `video.*` 生成 IPC 不增加业务方法；Provider 设置 IPC 的新增与 Preload 类型、Zod、白名单和 contract test 同步。

## Risks / Trade-offs

- [三 Provider 扩大维护和测试矩阵] → 仅接 Wan 一个固定模型/地域/无声子集与 Agnes 两个冻结模型，禁止任意 URL 与自动路由；每个 Adapter 共享同一 Port 契约测试。
- [开发默认 Mock 可能掩盖真实参数漂移] → 真实 Canary 独立、显式、低预算运行；发布前按官方文档日期刷新能力快照和 Contract Test。
- [已有任务缺少 Provider provenance] → migration 只按受控历史 model_id 映射；未知模型阻断而不猜测，并对 100+ 历史版本样本运行 invariant audit。
- [Provider 切换时在途任务串线] → Adapter 由任务冻结列解析，当前偏好只影响新建任务。
- [Wan 默认会生成音频导致费用翻倍] → Adapter 请求体与 contract test 强制 `audio=false`，不得依赖 Provider 默认值。
- [Agnes 免费促销结束或限流收紧] → $0/秒为带日期的促销事实（2.5 Flash 明示 limited time）；Adapter 不把免费写入成功语义，促销结束后 4xx 计费错误按现有错误矩阵归一暴露，不静默切换 Provider。
- [Agnes 免费档 1 RPM 拖慢批量] → 批量任务在 Agnes 档按调度器退避自然串行；UI 明示限制，不做自动 Provider 切换。
- [Workspace 域名拼接引入 SSRF] → Workspace ID 使用严格字符/长度校验后插入固定后缀；不接受完整 Base URL，下载 URL 继续执行 HTTPS、userinfo 和 redirect 守卫（Agnes 下载域走固定 allowlist）。
- [三密钥误用或泄露] → 固定独立 credential ID、safeStorage 密文、按 Provider 解析；日志/DTO/诊断包保持白名单。
- [价格随时间变化] → 能力快照与价格说明分离；价格仅做带日期的参考，不进入 Provider 成功或真实账单结论。

## Migration Plan

1. 先同步 PRD v1.4 §10.4/§10.8 与 TECH_DESIGN v1.1，解除现有“一家视频 Provider”范围冲突。
2. 添加失败测试：Seedance 新默认 mini、已有 Profile 保留、开发默认 Mock 零网络、三凭据隔离、任务 Provider 冻结、Wan/Agnes 请求固定参数和错误矩阵。
3. 实施 0023 migration、Repository/Application Ports 和启动 invariant audit；验证空库、v22 样本库及 100+ 历史版本压力库。
4. 实现 Wan/Agnes Adapter 与按任务 Model Resolver，再接入组合根和 Provider 设置 IPC/UI。
5. 运行 format/lint/typecheck/unit/contract/integration/E2E；默认门禁禁止网络。
6. 仅在用户明确提供凭据和预算开关后运行一次真实 Wan Canary，另存脱敏证据；未运行则如实标记未认证（Agnes 探针已按 D8 于 2026-09-19 完成）。

回滚：代码可回退为只解析 Seedance，但 0023 不删除或回写；新增列、偏好和 Wan/Agnes Profile 保留无害。若 migration 失败，事务回滚并保留升级前在线备份，应用进入只读故障页且不启动视频调度器。
