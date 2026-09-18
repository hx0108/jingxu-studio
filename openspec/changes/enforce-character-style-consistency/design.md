## Context

见 [proposal.md](./proposal.md) 的问题背景。当前媒体链路已经具备 CHARACTER/SCENE 资产版本、内容寻址文件、图片任务、候选世代哈希、调用证据与 STALE_INPUT 传播；但 `media-request-blueprint` 把正式 StoryBible 信封当作裸对象解析，真实 `data.characters/scenes` 不会进入 Prompt。资产枚举没有 STYLE，生成服务又把缺失资产定义为可跳过，因此系统无法把 PRD v1.4 §10.2、§10.5 的一致性策略变成建档前门禁。

本变更跨 contracts、application、persistence、main IPC/preload 与 renderer；不改变 Provider Adapter 的凭据和网络边界。现有未跟踪 `low-cost-video-provider-integration` Change 与本变更独立，实施时必须按当时 migration head 选择下一个编号。

## Goals / Non-Goals

**Goals:**

- 修复正式 StoryBible 信封解析，并以单一纯函数同时服务预检、Prompt 和测试。
- 将项目画风与出场角色参考图固化为生成前必需的版本化输入。
- 让单镜头、批量建档、世代哈希、Provider 请求和证据快照使用同一套解析结果。
- 升版后只做确定性 STALE 传播，不自动产生费用或覆盖历史结果。

**Non-Goals:**

- 不训练 LoRA/Embedding，不做人脸识别、相似度评分、自动局部重绘或 Provider 质量承诺。
- 不修改四份 PRD-owned V1 Schema，不把 STYLE 写入 ShotContract 的 V1 `asset_version_ids`。
- 不改变视频 i2v 输入、已选首帧语义或时间线合成；视频通过新首帧自然继承改进。
- 不自动为旧项目生成或猜测画风锚点。

## Decisions

### D1. 以正式信封解析器替换宽松根级读取

在 Application 层建立无副作用的 StoryBible 描述解析器，先识别合法 `ScriptStageOutput`（`stage=STORY_BIBLE`，读取 `data`），再兼容历史裸 data 对象。解析结果使用判别联合返回成功或稳定失败原因，而不是 `EMPTY_BIBLE`。预检和请求蓝图必须调用同一解析器，避免“UI 说可生成、调度时又降级”。

否决只在现有函数中把 `root.characters` 改成 `root.data.characters`：这会继续把错误阶段与损坏信封静默当空描述，也不能覆盖旧裸数据兼容。

### D2. STYLE 复用既有资产/版本/文件通道

扩展媒体 `asset_type` 为 `CHARACTER | SCENE | STYLE`。STYLE 使用项目内保留 `bible_ref_id=project-style`，依赖既有 `(project_id, asset_type, bible_ref_id)` 唯一约束保证单项目一个逻辑画风资产；每次上传只新增不可变 AssetVersion。STYLE 的 `description` 是画风文字锚点，参考图是视觉锚点。

选择复用资产表而不是新增 style 表，理由是版本链、内容寻址、安全协议、上传 IPC、证据和 STALE 传播语义完全相同。否决把 STYLE 伪装成 SCENE：这会污染 StoryBible 引用语义并使受影响镜头判断不可审计。

SQLite CHECK 不能原地扩枚举。新增前进 migration 创建新版 `assets`/`asset_versions` 表、复制数据、重建父链外键/索引/immutable trigger 后原子替换；migration 名称使用实施时下一个可用编号，不改写 `0009_media_assets_images.sql`。迁移必须覆盖空库、当前 head 升级、历史父版本链和 `foreign_key_check`。

### D3. 一个应用层预检结果驱动单镜头、批量和 UI

新增只读预检 Query，输入项目及可选 shotIds，输出：StoryBible 状态、STYLE 当前版本、每个目标镜头的出场角色及对应 CHARACTER 当前版本、可选 SCENE 版本、去重缺失项和 `ready`。单镜头 `generateCandidates` 与批量 `generateCandidatesForShots` 在任何写事务前调用该 Query；只要必需项缺失，整次命令失败，不产生部分批次。

稳定错误码：

- `MEDIA_CONSISTENCY_STORY_BIBLE_INVALID`
- `MEDIA_CONSISTENCY_STYLE_REQUIRED`
- `MEDIA_CONSISTENCY_CHARACTER_REFERENCE_REQUIRED`
- `MEDIA_CONSISTENCY_REFERENCE_LIMIT_EXCEEDED`

错误 AppResult 只携带有界、结构化缺失 ID/显示名，不含路径、图片字节、完整 StoryBible 或 Provider 内容。IPC 新增 `image.getConsistencyPreflight` 逐方法白名单；Zod DTO 为 single source，Preload 只暴露该方法。

否决仅由 Renderer 检查：客户端状态可能过期，无法阻止 IPC 直调或批量竞态。

### D4. 冻结输入和请求蓝图使用同一确定性排序

解析顺序固定为：STYLE `project-style` → `character_ids` 原顺序且去重 → SCENE。必需参考图数量超过能力快照 `max_count` 时前置失败；不得继续使用现有 `.slice(0, 14)` 静默截断。SCENE 参考图是可选项，只有在加入后超限时可省略并在预检 warning 与证据中记录，不影响必需 STYLE/CHARACTER。

Prompt 模板固定版本，例如 `first-frame-consistency-v1`，段落顺序为：画风锚点、镜头主描述、场景、人物身份/外观、机位/首帧、连续性、避免项。模板版本进入 `parametersFingerprint`；STYLE/CHARACTER/SCENE 当前 AssetVersion ID 全部进入 `boundAssetVersionIds`，因此任一锚点升版会得到新 `generation_input_hash`。

Provider 请求仍由 Adapter 只做 DTO 映射；参考图字节通过现有 `MediaReferenceImageReader` 读取，Adapter 不理解 STYLE/CHARACTER 业务语义。证据快照增加有序 `referenceImages[{kind,bibleRefId,assetVersionId,sha256}]`，不保存字节或本地路径。

### D5. STALE 传播按 STYLE 全项目、CHARACTER/SCENE 按绑定镜头

STYLE 升版遍历当前 READY 镜头并重算当前世代，所有旧哈希候选标记 STALE_INPUT；CHARACTER/SCENE 保持按 StoryBible 引用筛选。上传事务先原子提交新 AssetVersion，再在应用服务中调用既有失效服务；失效失败必须作为可见错误返回，保留已提交资产版本并允许幂等重试失效扫描，不能回删版本或自动生成。

### D6. Renderer 复用资产上传，不复制生成状态机

`FirstFramePanel` 增加一致性卡片和 STYLE 选项；角色缺失项直接预填 `assetType=CHARACTER` 与 bibleRefId，画风入口固定 `STYLE/project-style`。按钮禁用策略只消费主进程 preflight DTO；提交时服务端仍复检。批量视图显示去重缺失项，不创建新的客户端任务状态机。

### D7. 事务、安全与公开契约边界

- 预检只读；任务/候选建档继续在现有 UnitOfWork 短事务中完成，Provider 请求仍在事务外。
- V1 JSON Schema、ShotContract 和 EpisodeStoryboardExport 不变；STYLE 是媒体域资产，不成为第二个 StoryBible 字段事实源。
- Renderer 不接收绝对路径或字节；STYLE 预览继续用 `jingxu://media/asset-version/*`。
- 不新增依赖、网络 host、Provider 参数或凭据字段。

## Risks / Trade-offs

- [旧项目生成被新门禁阻断] → 历史候选仍可查看；预检列出缺失项并提供直接上传入口，补齐后才允许产生新费用。
- [单张画风参考图不能保证所有镜头完全同风格] → Prompt 与视觉双锚定、候选人工选择和证据可复盘；产品文案明确“不承诺完全一致”。
- [参考图数量上限与多角色镜头冲突] → 必需项超限时前置阻断并提示拆镜；不静默牺牲角色参考图。
- [SQLite 表重建破坏历史父链] → migration 集成测试对行数、parent_id、唯一约束、immutable trigger 和 `foreign_key_check` 做升级前后对账；升级前沿用现有在线备份。
- [资产升版与批量在飞产生竞态] → 建档和调度前复算 generation_input_hash；不匹配候选走既有 STALE_INPUT，绝不自动重发。
- [StoryBible 兼容读取掩盖新坏数据] → 只有无法识别为正式信封的合法裸 data 才兼容；出现信封标志却结构错误时必须失败。

## Migration Plan

1. 在实施开始时确认当前 migration head，创建唯一的下一编号 migration；先补 migration 升级失败测试，再实现表重建。
2. 发布数据库/Repository/Contract 支持后，旧项目可读但新的图片生成被预检门禁；不回写历史项目。
3. 发布 Application 解析器、预检、哈希与 STALE 传播，再接 IPC/Renderer；Mock 门禁先通过后才允许一次受控真实 Seedream 探针。
4. 回滚应用版本时数据库中的 STYLE 行对旧二进制不可识别，因此回滚需恢复升级前 SQLite 备份；不尝试删除 STYLE 行逆迁移。

## Open Questions

无。画风锚点采用单项目一个 STYLE 资产、强门禁及 `project-style` 保留键已在本设计中锁定，后续若需要多风格分段应建立独立 Change。
