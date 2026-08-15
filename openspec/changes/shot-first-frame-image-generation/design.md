# Design: shot-first-frame-image-generation

按用户指定，本设计围绕三个决策域展开：**D1 能力边界**、**D2 适配器选型**、**D3 逐镜头资产版本语义**；D4–D6 是支撑性决策与开放问题清单。所有引用以 PRD v1.4 §10 与 TECH_DESIGN v1.1 为准。

## D1 能力边界

### 纳入（本 Change 交付）

| 能力 | 依据 |
|---|---|
| 逐镜头首帧候选生成（文生图） | PRD §10.2 场景切换/独立首帧路径；§10.5 首帧候选生成 |
| 参考图生图（已上传参考图时） | PRD §10.2 服装道具/角色身份首选机制 |
| 候选多保留、人工比较与选择、可切换 | PRD §10.5/§10.6 |
| CHARACTER/SCENE 资产建档与不可变 AssetVersion（参考图仅上传） | PRD §10.5 |
| 生成输入快照哈希 + STALE_INPUT 传播 + 受影响镜头列举，不自动重生成 | PRD §10.5 |
| 图片异步任务：幂等、取消、超时、重启恢复 | PRD §10.6 |
| provider_reported_usage（图片数）记入调用证据 | PRD §10.8 |

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

1. DashScope 图片任务是异步任务 API（创建任务 → 轮询 → 取结果 URL → 下载字节），单次调用服务端耗时数十秒。
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

### Provider 选型：DashScope 通义万相

PRD §10.4 限定 V2 仅接入一家图片 Provider。选 DashScope 通义万相（wanx 文生图系列）：

- 与 Qwen 文本同平台、同凭据体系（同一 DashScope API Key），safeStorage/profile/测试 IPC 全部复用既有模式；
- `https://dashscope.aliyuncs.com` 网络路径已在真实联调中验证（含系统代理行为已知）；
- 原生异步任务 API 与上述三段原语一一对应；
- 支持文生图与参考图（图编辑/参考生图）两类机制，覆盖 PRD §10.2 两条路径。

**model id 不在本提案中伪造**：Apply 期任务 0.x 经官方文档核对文生图与参考图两条 API 的具体 model id、参数与限制后锁死，写入 `provider_capability_snapshots` 静态快照（沿 V1 模式）。

### 凭据与 Profile：新增独立 profile 行

新增 `profile_image_primary`（provider=dashscope-wanx），持独立 `credential_ref`（同一 DashScope Key 值另存一份密文）。理由：图片与文本的 `validateCredential` 语义、模型配置与能力快照各自独立演进，PRD §10.4 的能力注册粒度就是 provider/model；重复一份密文成本可忽略，换来能力边界清晰。Renderer 仍只见 configured 状态与末 4 位。

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

## D6 开放决策点（需产品负责人在提案审查时拍板）

1. **每轮候选数 N**：默认 4（单 Provider 任务批量返回 4 图，一次任务产一轮）。可改 2/4。
2. **先行推进 vs 严格等 V1 验收**：PRD §10.1.1 的 V2 进入条件（AC-V1-01~06 + 3 用户试用）未满足；本提案按「提案先行、Apply 待立项」处理，需明确认可。
3. **图片 Provider**：推荐 DashScope 通义万相（理由见 D2）；若已有其他候选（如即梦/豆包图片）需在此提出。
4. **资产参考图上传大小/格式上限**：建议单图 ≤ 20MB，PNG/JPEG/WebP。
5. **候选保留策略**：本切片不清理（全保留）；空间治理独立 Change——确认接受短期内 `projects/` 增长。
