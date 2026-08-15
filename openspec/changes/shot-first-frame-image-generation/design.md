# Design: shot-first-frame-image-generation

按用户指定，本设计围绕三个决策域展开：**D1 能力边界**、**D2 适配器选型**、**D3 逐镜头资产版本语义**；D4–D6 是支撑性决策与开放问题清单。所有引用以 PRD v1.4 §10 与 TECH_DESIGN v1.1 为准。

## D1 能力边界

### 纳入（本 Change 交付）

| 能力                                                               | 依据                                                |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| 逐镜头首帧候选生成（文生图）                                       | PRD §10.2 场景切换/独立首帧路径；§10.5 首帧候选生成 |
| 参考图生图（已上传参考图时）                                       | PRD §10.2 服装道具/角色身份首选机制                 |
| 候选多保留、人工比较与选择、可切换                                 | PRD §10.5/§10.6                                     |
| CHARACTER/SCENE 资产建档与不可变 AssetVersion（参考图仅上传）      | PRD §10.5                                           |
| 生成输入快照哈希 + STALE_INPUT 传播 + 受影响镜头列举，不自动重生成 | PRD §10.5                                           |
| 图片异步任务：幂等、取消、超时、重启恢复                           | PRD §10.6                                           |
| provider_reported_usage（图片数）记入调用证据                      | PRD §10.8                                           |

### 不纳入（后续独立切片）

- **视频、尾帧提取、CONTINUOUS_ACTION 尾帧复用、首尾帧双锚定**：PRD §10.3 对 V2 的完整要求属视频切片；本切片只产首帧，为视频切片提供输入锚点。
- **TTS、口型、时间线合成**：PRD §10.7/§10.9，完全不触碰。
- **资产参考图的「生成」路径**（含画风/道具/声音资产）：本切片资产参考图只上传；AI 原创流程无素材时走文生图路径仍可完整使用。
- **动态 ProviderCapabilityRegistry**：PRD §10.4 的探测/有效期/观测体系不做；沿用既有静态 `provider_capability_snapshots` 表登记一家图片 Provider 的能力快照。
- **成本估算与对账**：无图片价格表种子；`estimated_cost` 恒 UNKNOWN，只记 `provider_reported_usage`。
- **批量重生成、ShotContract `asset_version_ids` 回写、分镜编辑**：镜头绑定记录在本切片的候选输入快照上；已确认分镜集合字节不变，`asset_version_ids` 回写留给分镜编辑/资产完整化切片。
- **SAME_SCENE_CUT 同资产新机位**：作为 Prompt 组装规则实现（同场景资产参考图 + 机位描述），不引入额外表结构。

### 边界自检

本切片独立可用：无任何资产/参考图时，纯文生图即可为整集每镜头产出候选并完成人工选择；上传参考图后一致性增强。不依赖视频/TTS 切片，也不被它们依赖。

## D2 适配器选型

### Port 形态：submit / poll / download 三段原语

`TextModelPort.generate()` 是单次阻塞请求；图片生成不可沿用，原因有二：

1. 图片 Provider 普遍采用异步任务 API 或数十秒级服务端耗时（创建任务 → 轮询 → 取结果 URL → 下载字节），且未来视频任务必为异步。
2. PRD §10.6 要求「应用重启后继续查询未完成任务」——阻塞式调用无法跨进程重启存活，必须把 Provider 任务句柄持久化后由应用层驱动轮询。

```ts
interface ImageModelPort {
  validateCredential(): Promise<CredentialCheck>;
  submit(request: ImageGenerationRequest, signal: AbortSignal): Promise<ImageTaskSubmission>; // { providerTaskId, ... }
  poll(providerTaskId: string, signal: AbortSignal): Promise<ImageTaskStatus>; // PENDING | SUCCEEDED | FAILED + 结果引用
  download(resultRef: ImageResultRef, signal: AbortSignal): Promise<ImageDownload>; // 字节 + 尺寸/格式元数据
  normalizeError(error: unknown): NormalizedModelError;
}
```

状态机（提交→轮询→下载→落盘→落库）由确定性调度代码驱动，Adapter 只做单段 HTTP 与归一化——与 CLAUDE.md「路由、重试、状态码处理属于确定性代码」一致，与既有 jobrunner「崩溃恢复按持久化证据确定终态、不自动重发未知请求」语义对齐。

### Provider 选型：火山方舟 豆包 Seedream（字节家族）

PRD §10.4 限定 V2 仅接入一家图片 Provider。产品负责人于 2026-08-16 指定「字节」家族；经核对：**Seedance 是字节视频生成模型，图片生成模型为 Seedream 系列（豆包·图像生成）**，两者同属火山方舟。本切片选 Seedream：

- 火山方舟图片 API 覆盖文生图与图生图（含组图/分辨率参数），满足 PRD §10.2 两条机制；官方定价透明（如文生图按张计价），利于后续成本切片；
- Seedance（视频）与本切片的 Seedream 同平台同凭据体系——视频切片接入时凭据与网络路径可直接复用；
- 与 Qwen 文本分属两个 Provider 平台：图片能力自此引入第二家 Provider 凭据，但 safeStorage/profile/归一化的既有模式不变，正好验证凭据体系的多 Provider 扩展性。

**Port 必须同时容忍同步与异步 Provider API**：方舟图片接口可能同步返回结果（b64/URL），而未来视频任务必为异步。因此 `submit()` 的返回统一为「终态结果引用 或 providerTaskId」两种形态之一；同步 API 下 poll 恒即时 SUCCEEDED。三段原语与重启恢复语义对两种形态一致，`provider_task_id` 持久化逻辑不因 Provider 同步/异步而分叉。

**model id 不在本提案中伪造**：Apply 期任务 0.2 经火山方舟官方文档核对图片生成（含文生图/图生图）当前推荐的 model id（doubao-seedream 系列，具体版本号以官方文档为准）、参数、限制与同步/异步语义后锁死，写入 `provider_capability_snapshots` 静态快照（沿 V1 模式，source_url + sha256）。核对结论见下节。

### 0.2 官方核对结论（2026-08-16，Apply 期锁定）

依据两份官方页面（webReader 直接抓取，非搜索摘要）：

- 图片生成 API 参考：<https://www.volcengine.com/docs/82379/1541523>（endpoint、参数、限制、响应结构、同步语义）
- 模型列表·图片生成能力表（页面标注更新 2026-05-29）：<https://www.volcengine.com/docs/82379/1330310>（确切可调用 model id 与限流）

**锁定 `model_id = doubao-seedream-5-0-lite-260128`**。模型列表图片生成推荐表共三行：`doubao-seedream-5-0-260128`（括注「同时支持：doubao-seedream-5-0-lite-260128」）、`doubao-seedream-4-5-251128`、`doubao-seedream-4-0-250828`，限流均 500 IPM（非刚性保障）。选 lite 入口的理由：1541523 即 Seedream 5.0 lite 的 API 参考，本切片全部核对参数以其为准；候选轮成本敏感；其余三个 id 如实登记为备选，不新增任何未见于官方表格的 id。

核对确认的设计要点：

1. **同步语义证实**：`POST {base_url}/api/v3/images/generations` 直接返回终态结果（该 API 无图片任务轮询接口；`stream` 仅控制增量输出，不产生任务 id）——D2 的「submit() 返回终态结果引用、同步形态下 poll() 恒即时 SUCCEEDED」设计被官方语义证实。同步形态下 `provider_task_id` 退化为逐候选的调用证据引用（`invocation_evidence_ref` → `model_invocations`）；「有 taskId 恢复 poll」分支保留给未来异步 Provider（视频）。
2. **无 `n` 批量参数**：N=4 经 4 次独立请求实现（D6-1 已按此修正），每次请求各记一条 `model_invocations`；一轮仍聚合为一个 `media_generation_tasks` 行（`candidate_count=4`）。组图（`sequential_image_generation=auto`，max_images ≤15）产出**内容关联**图组而非独立候选，本切片禁用，留作未来 SAME_SCENE_CUT/整集连续帧选项。
3. **`response_format=url` + 即时下载**：结果 URL 24h 内有效，与三段原语及重启恢复兼容（下载段可独立重试）；`b64_json` 不用（大响应体）。
4. **`watermark` 默认 true 保留**（右下角「AI生成」标识）——对齐《人工智能生成合成内容标识办法》的来源标识要求，溯源另由 DB 证据承担；应用不传 `watermark=false`。
5. **`guidance_scale` 与 `seed` 不被 5.0-lite/4.5/4.0 支持**，不发送；`tools`（联网检索 web_search）关闭；`optimize_prompt_options` 不传（standard 默认）。
6. **usage 口径**：`generated_images`（仅成功且计费的张数）与 `output_tokens = floor(Σ(w×h)/256)`、`total_tokens = output_tokens` → 落 `provider_reported_usage`；组图部分失败（`data[].error` 逐项）在本切片不出现（每请求单图）。
7. **参考图入参**：URL 或 `data:image/<fmt>;base64,`；≤14 张、单张 ≤30MB、宽高比 [1/16,16]、边 >14px、总像素 ≤36M——应用层仍按 D6-4 收紧为上传 ≤20MB PNG/JPEG/WebP。
8. **size 语义**：默认 `2048x2048`；显式 WxH 总像素 ∈ [3 686 400, 16 777 216]、宽高比 [1/16,16]。FormatProfile 画幅映射 1:1→2048x2048、16:9→2560x1440、9:16→1440x2560、4:3→2304x1728、3:4→1728x2304 均合法（9:16 恰为总像素下界）。

`provider_capability_snapshots` 静态快照草稿——canonical JSON（UTF-8 无 BOM、紧凑分隔、键序即下文，1381 字节），**sha256 = `801333f3ac43d6b3795b99d07875d0a492955048b21799a5aee3e197adfe3269`**。行种子（`valid_from='2026-08-16'`、`expires_at='9999-12-31'` 静态不过期、`source_url` 取 1541523）归任务 2.1 的 0009 迁移 INSERT，启动路径读取接线归任务 3.2/4.1——沿 0008 模板「迁移种子 + sha256 多处锁死」模式，测试复算哈希：

```text
{"provider":"volcark-seedream","capability":"IMAGE_GENERATION","model_id":"doubao-seedream-5-0-lite-260128","model_id_alternates":["doubao-seedream-5-0-260128","doubao-seedream-4-5-251128","doubao-seedream-4-0-250828"],"endpoint":{"method":"POST","path":"/api/v3/images/generations","base_url_cn_beijing":"https://ark.cn-beijing.volces.com","auth":"Bearer ARK_API_KEY"},"semantics":{"mode":"SYNCHRONOUS","stream":false,"notes":"POST 直接返回终态结果，无图片任务轮询 API；Port submit 返回终态结果引用，poll 恒 SUCCEEDED，download 经结果 URL（24h 有效）"},"request":{"prompt_recommended_max":"300 汉字 / 600 英文词","image_param":{"max_count":14,"max_bytes_each":31457280,"formats":["jpeg","png","webp","bmp","tiff","gif","heic","heif"],"aspect_ratio_range":[0.0625,16],"min_side_px":14,"max_total_pixels":36000000},"size":{"default":"2048x2048","total_pixels_range":[3686400,16777216],"aspect_ratio_range":[0.0625,16]},"unsupported_params":["n","seed","guidance_scale"],"client_defaults":{"response_format":"url","watermark":true,"sequential_image_generation":"disabled","tools":[]}},"response":{"result_url_validity_hours":24,"usage_fields":["generated_images","output_tokens","total_tokens"],"output_tokens_formula":"floor(sum(width*height)/256)","partial_failure":"data[].error 可逐项失败"},"rate_limit":{"max_images_per_minute":500}}
```

### 凭据与 Profile：新增独立 profile 行

新增 `profile_image_primary`（provider=volcark-seedream，base_url 指向方舟），持独立 `credential_ref`（方舟 ARK API Key，独立于 DashScope Key 的第二份密文）。理由：不同 Provider 的 `validateCredential` 语义、模型配置与能力快照各自独立演进，PRD §10.4 的能力注册粒度就是 provider/model；两 Key 分存也让「删除图片凭据不影响文本生成」成为事实。Renderer 仍只见 configured 状态与末 4 位。方舟 Key 同样遵守全部既有红线（safeStorage、不入 SQLite 明文/日志/诊断包）。

### Mock 矩阵

`MockImageModelAdapter` 沿 `MockTextModelAdapter` 模式：确定性 PNG 字节（尺寸/内容随种子可断言）、失败矩阵（网络、限流、内容审核拒绝、任务超时、部分候选失败）、可注入的 poll 抖动，供离线全量门禁与 packaged smoke 使用，不触网。

## D3 逐镜头资产版本语义

### 表结构（迁移 0009）

```text
assets(id, project_id, asset_type CHARACTER|SCENE, bible_ref_id, display_name, created_at, updated_at)
  — bible_ref_id 指向 STORY_BIBLE 的 character_id/scene_id，UNIQUE(project_id, asset_type, bible_ref_id)
asset_versions(id, asset_id, version_no, parent_id, provenance UPLOADED, description,
               file_sha256, byte_size, mime_type, width, height, created_at)
  — 不可变（沿 shot_contract_versions 的 trigger 禁改禁删模式）；版本链单调递增
image_candidates(id, project_id, shot_id, shot_version_id, round_no, index_in_round,
                 generation_input_hash, status PENDING|SUCCEEDED|FAILED|STALE_INPUT,
                 file_sha256, byte_size, mime_type, width, height, storage_rel_path,
                 model_id, provider_task_id, invocation_evidence_ref, selected_at, selected_by_context)
media_generation_tasks(id, project_id, shot_id, shot_version_id, idempotency_key,
                       provider_task_id, phase SUBMITTED|POLLING|DOWNLOADING|COMPLETED|FAILED|CANCELLED,
                       input_hash, candidate_count, status, error_code, created_at, updated_at)
```

### 生成输入快照与哈希

`generation_input_hash = sha256(shot_version 内容哈希 ‖ 排序后绑定 asset_version id 列表 ‖ model_id ‖ 归一化参数)`。绑定解析规则：镜头 `character_ids` + `scene_id` → 各自资产（无资产或无参考图版本的项跳过，不阻断生成）。同 hash 的候选视为同输入世代，跨世代比较无意义——UI 按 hash 分组展示。

### STALE_INPUT 传播（不自动重生成）

两个触发源，均只标记不重发（PRD §10.5）：

1. 项目确认了新的 ShotContract READY 版本 → 旧 shot_version 下的全部候选与选择 STALE_INPUT；
2. 某资产升版 → 输入快照包含旧版本的候选 STALE_INPUT，并向用户列出受影响镜头清单。

选择指针保留在 STALE 候选上可读（历史可追溯），但 UI 必须呈现失效状态，新选择只能落在当前输入世代的候选上。

### 字节存储：内容寻址，不入 SQLite

`projects/<projectId>/images/<sha256 前两位>/<sha256>.<ext>`——同字节天然去重、永不覆盖（PRD §10.6「不覆盖旧结果」在文件系统层的直接体现）；SQLite 只存哈希与相对路径。资产参考图同规则存 `projects/<projectId>/assets/`。上传/下载均先写临时文件再原子 rename，sha256 校验后才登记（沿备份 `.tmp`→rename 模式）。**空间治理（候选/资产保留与清理）按既定决策留待独立 Change**——本切片首次确定了增长模型（N 候选/镜头/轮 + 参考图版本链），该 Change 届时有据可依。

## D4 任务运行时与 IPC

- **调度**：媒体任务独立于 `script_stage_jobs`（该表 stage CHECK 约束不适用）；同项目媒体任务严格串行（与文本 Job 一致的并发模型），不同项目不互相阻塞；不要求与文本 Job 互斥（不同 Provider 限额域）。
- **恢复**：启动时扫描 `media_generation_tasks` 非 终态 行——有 `provider_task_id` 的恢复 poll；SUBMITTED 但无 taskId 且无法证明未发出的，按既有恢复语义标记失败等待人工重发，不自动重发未知请求。
- **IPC（方法级白名单，新 `image` 通道）**：`generateCandidates`、`listCandidates`、`selectCandidate`、`listAssets`、`uploadAssetReference`、`getTask`。零路径/SQL/Authorization 穿透；上传走字节缓冲过 IPC（大小上限），不经文件系统对话框路径直通。
- **Renderer 取图**：受限 `jingxu://media/<candidate|asset-version id>` 协议处理器，仅允许从受管理 projects 根内解析（复用备份路径的 realpath/符号链接防逃逸断言），CSP `img-src` 收紧为 `jingxu:`。Renderer 全程不接触绝对路径。
- **调用证据**：每段真实请求（submit/poll/download 计一次提交段）记 `model_invocations`（复用 provider_request_id/model_id 列），错误归一化沿文本模式。

## D5 安全边界（沿用，逐条对照）

API Key 仅 safeStorage；不可用阻断保存不降级明文；SQLite 只存 credential_ref；Key 不入 .env 示例/日志/埋点/诊断包/截图/导出包；UI 只显 configured + 末 4 位；Renderer 不接收 Authorization、原始 Provider 错误或文件系统堆栈；删除凭据同步删密文并写审计。新增红线：**图片字节不进入 SQLite、日志或诊断包；prompt 与 Provider 响应原文按文本阶段同等脱敏规则处理**。

## D6 决策记录（产品负责人 2026-08-16 拍板）

1. **每轮候选数 N = 4**。0.2 官方核对修正：方舟 `images/generations` 无 `n` 批量参数、组图为内容关联图组不作独立候选——N=4 经 4 次独立同步请求实现（每次各记一条 `model_invocations`），一轮聚合为一个 `media_generation_tasks` 行（`candidate_count=4`）。
2. **先行推进**：认可「提案先行、立即 Apply」；AC-V1-01~06 与 3 名用户试用未完成的事实如实登记（README 与任务 7.3），不因本提案隐式放宽 PRD §10.1.1。
3. **图片 Provider = 字节·火山方舟 豆包 Seedream**（用户指定「字节 Seedance」；Seedance 为视频模型，图片切片用同家族 Seedream，Seedance 留作视频切片天然首选）。
4. **资产参考图上传上限**：单图 ≤ 20MB，PNG/JPEG/WebP。
5. **候选与参考图全保留**：空间治理（保留/清理）留待独立 Change——本切片首次确定增长模型（4 候选/镜头/轮 + 参考图版本链），届时有据可依。
