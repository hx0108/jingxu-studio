# Tasks — shot-contract-generation

实施分线见 design.md §9。每完成一组任务跑对应门禁；全部完成后走 Verify 清单。

## 1. 契约与 Application Port（B 线前置）

- [x] 1.1 定义 `ModelShotSetCandidate` TECH-internal 契约：信封 + 逐镜头创意键存在性（沿五阶段手写校验约定，键缺失进可修复的 CANDIDATE_SCHEMA 层，details 定位 `shots[i].group.key`；取值/枚举/跨字段仍归注入后的 ShotContract 1.1.0 正式校验）
- [x] 1.2 定义分镜 Application 仓储 Port：episode_versions / shots / shot_contract_versions / episode_version_shots 的插入、按阶段头读取、findMaxVersionNo 类查询（独立 `StoryboardRepositories` 接口、只增不改 `ScriptRepositories`，避免破坏全部单测 fake；§2.1 再并入 ScriptUnitOfWork）
- [x] 1.3 系统字段注入器：标识/版本/溯源/上下文注入 + `audio_required`/`lip_sync_required` 按 `(spoken_text, dialogue_render_mode)` 推导表 + 常量字段（budget UNKNOWN、locked_paths 空、asset_version_ids 空）；创意键显式挑选（模型多余键/伪造系统字段丢弃），NARRATION_FIRST+有台词时 speaker_id 系统推导为 narrator（Schema 强制精确值，不信任模型）；`target_duration_sec` 属创意字段由模型提供（1–20 由 FINAL 定界）、`previous_shot_id` 系统派生（CONTINUOUS_ACTION→sequence-1，模型值丢弃）
- [x] 1.4 集合校验器：sequence 连续唯一、previous_shot_id 集合内回指、character/speaker/scene ID 源自冻结 STORY_BIBLE、Σ duration ∈ [30,180]；输出有界明细（稳定码 SHOT_SET_{SEQUENCE,PREVIOUS_SHOT,CHARACTER,SCENE,DURATION}_*；COLLECTION 在 FINAL 之前执行，首镜头 CONTINUOUS_ACTION 在此层以可修复明细拦下，design.md D3 已记）
- [x] 1.5 Unit：注入器推导表全分支、集合校验器负/正例、shot_set_hash 确定性（注入器/集合校验器已随 §1.3/§1.4 落地；`shot-set-hash.ts` 纯函数 + 4 用例：精确序列化钉死、乱序归一、分量/顺序敏感性、空集合形态）

## 2. Persistence（A 线）

- [x] 2.1 SQLite 分镜仓储实现 + ScriptUnitOfWork 扩展（`SqliteEpisodeVersionRepository`/`SqliteShotRepository`/`SqliteShotContractVersionRepository` 并入 UoW；`ScriptJobRepositories` 扩展 `StoryboardRepositories`，shots 端口补 `findById`、`updateCurrentVersionIds` 带 `updatedAt`；四表单事务写入集成测试 5/5 绿，含列绑定 CHECK / UNIQUE / 不可变触发器 / 指针推进）
- [x] 2.2 迁移 `0008_prompt_templates_shot_contract.sql`：插入 shot_contract/v1（active=1，sha256 与 packages/prompts manifest 一致——script-migration 集成测试双向锁死：种子 sha === manifest sha === sha256(template_text)；幂等：重复应用后仍 count=1、MAX(version)=8）
- [x] 2.3 版本硬编码同步：4 个测试文件 + `scripts/verify-packaged-project-smoke.mjs`（head 7→8，future-version 测试改 `.run(9, '0009_future.sql')`；smoke 另补 promptLocks SHOT_CONTRACT 条目与 0008 资源校验）
- [x] 2.4 Integration：真库写入满足 document_json 列绑定 CHECK、`UNIQUE(shot_id,version_no)`、不可变触发器（UPDATE 必须 ABORT）、迁移幂等（前四项均已落地：§2.1 storyboard 5 用例 + §2.2 script-migration 0008 describe 2 用例）

## 3. Application 服务（B 线）

- [x] 3.1 `script-input-freezer`：SHOT_CONTRACT 放行，冻结 STORY_BIBLE + EPISODE_OUTLINE + SCENE_SCRIPT + format_profile_id
- [x] 3.2 `script-job-request`：分镜请求构造（SHOT_CONTRACT 模板 + userPayload 包装，含修复路径）
- [x] 3.3 `script-job-contract`：替换 `SCRIPT_STAGE_UNSUPPORTED`——逐镜头 FINAL（Registry ShotContract 1.1.0）+ 真实 COLLECTION + PRE_COMMIT 冻结复检 + commit 写整集集合（含管线 COLLECTION 先于 FINAL 的 D3 顺序与组合根接线；修复 §1.4 注入器 newShotId 双调用致 previous_shot_id 悬空）
- [x] 3.4 确认路径：逐镜头 READY 子版本（contract_version+1、LOCAL_VERIFIED）+ READY episode_version + shot_set_hash 重算 + 阶段头
- [x] 3.5 失效传播：SHOT_CONTRACT 下游只插一个 STALE_INPUT episode_version（快照沿用），依赖图扩展
- [x] 3.6 恢复路径：分镜阶段 restoreVersion 复用既有语义（历史集合 → 新 DRAFT 整集）
- [x] 3.7 Unit：确认/失效/恢复版本推进、head 乐观并发冲突、STALE_INPUT 阻断生成

## 4. Prompt 与适配器（B 线）

- [x] 4.1 SHOT_CONTRACT v1 模板：字段契约、枚举、ID 来源约束、注入提示（与 2.2 sha256 一致）；packages/prompts manifest 同步（SHOT_CONTRACT 的 candidateSchemaId 特判为 ModelShotSetCandidate/v1，与 @jingxu/validation 常量及 smoke 锁三处对齐）
- [x] 4.2 MockTextModelAdapter：SHOT_CONTRACT 可重复输出 + 失败矩阵扩展（含集合级失败样本）
- [x] 4.3 Qwen 适配器：无结构性变更，仅确认 JSON Mode 与超长输出截断行为（候选信封顶层为 JSON 对象满足 json_object；finish_reason=length 截断文本原样透传，由候选契约 JSON_PARSE→一次修复→仍失败 FAILED 兜底）

## 5. IPC 与 Renderer（C 线）

- [x] 5.1 `job.create` 放行 stage=SHOT_CONTRACT（operation 限 GENERATE）；strict DTO 同步 contracts
- [x] 5.2 `script.getWorkspace` 响应扩展 storyboard 节（episode_version 元数据 + 镜头摘要列表 + 状态 + 时长汇总）
- [x] 5.3 `script.confirmVersion`/`restoreVersion` 分镜路径接线（复用回执命令）
- [x] 5.4 Renderer 分镜工作区：镜头卡片列表、详情面板、生成/确认按钮、STALE/READY 徽标、时长汇总条、集合校验错误明细展示（脱敏）
- [x] 5.5 Contract 测试：storyboard DTO 形状、错误码映射完整性

## 6. E2E 与 Verify

- [x] 6.1 Electron E2E（Mock）：SCENE_SCRIPT READY → 生成 → DRAFT 集合 → 确认 → READY；上游再确认 → 整集 STALE；恢复历史集合
- [x] 6.2 全量门禁：format:check / lint / typecheck / test:collection / test / test:contract / test:integration / test:e2e
- [x] 6.3 `pnpm build` 三产物 + `pnpm package:win`（重打包，替换只含迁移 0001–0003 的旧产物）
- [x] 6.4 Windows x64 clean packaged smoke（含迁移 0008；验证新产物对 v7 生产库可正常启动）
- [x] 6.5 真实 Qwen 联调：五阶段 READY 后生成 SHOT_CONTRACT，记录证据（2026-08-16 全绿：五阶段 + SHOT_CONTRACT 全 SUCCEEDED，9 镜头 / Σ61s ∈ [30,180]，确认 READY `shot_set_hash=383bda6f…`；联调发现无台词镜头 speaker/时长未按 allOf 派生的缺陷，已修 + 回归钉）
- [x] 6.6 README 同步：已实现/未实现边界、验证证据；生产库 0008 应用留证（沿 0007 惯例；MAX(version)=8 @ 2026-08-15T15:58Z，active 模板 6 条含 shot_contract/v1；重打包后两 smoke 复跑绿）
- [x] 6.7 `openspec validate --strict` + Sync + Archive（validate 通过后归档，主 specs 同步由 archive 完成）
