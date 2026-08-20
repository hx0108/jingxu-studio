# Design: shot-edit-lock

## 背景事实（勘察实录，file:line 为 2026-08-20 工作区状态）

- 版本链地基：`StoryboardVersionService`（storyboard-version-service.ts）已有整集 CONFIRM（逐镜头 READY 子版本 + shotSetHash 重算 + stage_head 推进）/ RESTORE（整集快照新建 DRAFT episode_version，不回拨镜头指针）/ `invalidateStoryboardHead`（上游 STALE 传播）；幂等回执（command_receipts）+ `expectedVersionId` 乐观并发 + 错误码 REQUEST_ID_REUSED/SCRIPT_VERSION_CONFLICT/SCRIPT_VERSION_NOT_FOUND 均可复用。
- DB 预建：`shots.lifecycle_status`（ACTIVE/SUPERSEDED/DELETED）、`shot_contract_versions`（document_json blob + 不可变触发器 trg_shot_contract_versions_immutable、UNIQUE(shot_id,version_no)、JSON↔关系列交叉 CHECK）、`episode_versions` + `episode_version_shots`（整集快照）、`lock_records`（json_pointer/locked_by/note/locked_at/unlocked_at，零读写）、`shot_derivations`（零读写）、`script_stage_jobs.write_set_json/lock_snapshot_hash`（write_set 硬编码 `/data`）。
- 锁算法与 DTO 设计稿已在 TECH_DESIGN §9.2（token 前缀/反前缀/相等即冲突；LockRecord 唯一可写事实源、locked_paths 只读投影、锁定/解锁版本化、锁复制到新版本）、§9.2.1（三类对象路径表）、§9.2.2（SelectionRange/WriteSet/LockCommand TS 设计稿）、§10（编辑事务原子动作表：每次改变镜头版本的事务必须新建 episode_versions + 完整 episode_version_shots 快照；V1 最多 20 镜头）、不变量 13（document_json.locked_paths ≡ 有效 LockRecord 路径集合）。
- EDIT_INVARIANT：PRD 9.7.1 允许 ACTIVE 镜头为 DRAFT/STALE_INPUT，保证 ID/顺序/引用/血缘自洽——与既有生成管线 COLLECTION 校验器（`shot-collection-validator.ts`，在生成事务内对 DRAFT 集合运行）语义同族；编辑事务复用该集合校验器，不新造。
- Renderer：`StoryboardPanel.tsx` 只读；五阶段已有 JSON 文本编辑器 + saveDraft 交互先例（`ScriptWorkspace.tsx:245-271`）；script 域未接 React Query/Zustand（组件本地 state，维持现状）。
- IPC：`script` 五方法白名单契约锁定；TECH §11 规划了 storyboard 命名空间（未实现）。

## D1: 编辑 UI 形态【已拍板 2026-08-20：JSON 文本编辑器】

- **方案 A（推荐）：JSON 文本编辑器**。复用五阶段 saveDraft 的成熟交互（文本框 + 保存/校验错误展示），主进程侧 zod/Schema 全量校验兜底，`document_json` 本来就是 blob。实现最轻，编辑能力天然全覆盖白名单字段。
- 方案 B：结构化表单（七组受控字段逐项编辑 + 逐字段校验错误定位）。对创作者友好，但几十个字段 × 枚举/跨字段校验/错误定位的表单工程量大，且锁 UI（D3）在表单里反而更复杂（每字段挂锁）。
- 后继演进：表单可作为 V1 验收后的独立 UI change，届时后端命令契约不变。

## D2: 人工编辑与锁的关系【已拍板 2026-08-20：锁对人 AI 一致】

- **方案 A（推荐）：锁对人与 AI 一致**——编辑已锁定路径（冲突含父/子/相等）必须先显式解锁，否则整次编辑事务阻断并列出冲突路径。与 AC-V1-06 锁矩阵语义、PRD「用户可以主动解锁；系统不得为了完成生成而自动解锁」一致；锁语义单一可测。
- 方案 B：锁只防 AI 写入，人工编辑可直接覆盖。实现少一步，但「锁定」出现两套真相，AC-V1-06 矩阵需按写入者分叉，且用户误触覆盖无保护。

## D3: 锁定 UI 粒度【已拍板 2026-08-20：七根级起步（服务层算法全量）】

- **方案 A（推荐）：UI 起步仅七个一级根**（/narrative_purpose、/cinematography、/content、/dialogue、/continuity、/generation_constraints、/acceptance）。粗粒度挂锁/解锁 UI 简单清晰；**服务层算法按 PRD 全量实现**（任意已存在子路径的锁定命令在 API 层合法，AC-V1-06 父子冲突矩阵在服务层测试全量覆盖），后继 change 只扩 UI 树选择器。
- 方案 B：全子路径树选择器。PRD 全语义一步到位，但 RFC 6901 路径树 + 已存在子路径解析 + 转义（~0/~1）的 UI 工程量大，V1 验证期收益低。

## D4: IPC 命名空间【已拍板 2026-08-20：storyboard.* 命名空间】

- **方案 A（推荐）：新 `storyboard` 命名空间**（storyboard.editShot / storyboard.lockShot / storyboard.unlockShot）。与 TECH §11 规划一致；script 五方法白名单契约不动；新协调器接线与既有模式同构（sender 校验、DTO 双端校验、requestId 去重、输出脱敏复验）。
- 方案 B：扩展 `script.*` 白名单（script.editShot…）。少一组注册，但要改已锁定的五方法契约测试，且 TECH §11 明确 storyboard 独立命名空间。

## 定案事实（不设拍板）

- **锁定/解锁必须版本化**：scv 行不可变触发器 + 不变量 13（投影一致性）共同决定——lock/unlock = 新 scv 版本（内容同当前，仅 locked_paths 集合变化）+ lock_records 行状态变化，同事务完成。无轻量替代。
- **编辑事务动作序列**（TECH §10 同构）：校验编辑后 document（ShotContract 1.1.0）→ 锁复检（对当前有效锁）→ EDIT_INVARIANT（整集 ACTIVE 集合含新版本）→ 插新 scv（DRAFT、parent=当前版本、有效锁复制进 locked_paths）→ 新 episode_version + 完整 episode_version_shots 快照（shotSetHash 重算）→ 移 SHOT_CONTRACT stage_head → 写回执。任一步失败整体回滚，无部分写入。
- **错误码**：复用 REQUEST_ID_REUSED / SCRIPT_VERSION_CONFLICT / SCRIPT_VERSION_NOT_FOUND；新增锁定冲突与非法路径稳定错误码（实施时随命令契约定名，进契约测试）。
- **锁定冲突算法**：RFC 6901 token 化后，锁路径是写路径前缀、写路径是锁路径前缀、或相等 → 冲突；仅七根及已存在子路径可锁；数组下标 token（纯数字）拒绝；非法转义（非 ~0/~1）拒绝；路径必须能在当前 document 解析。
- **锁复制**：编辑产生的新版本继承全部仍有效锁（locked_paths 原样 + lock_records 不动）；SUPERSEDED/DELETED 场景不在本 change。

## 测试策略

- unit（application）：锁算法全矩阵（父/子/相等/无关、数组下标、非法转义、不存在路径、七根白名单外）；编辑事务（新版本链、锁复制、冲突阻断、幂等回执、乐观并发）；投影一致性（locked_paths ≡ lock_records）。
- contract（contracts）：storyboard.* 白名单 + DTO schema + 输出联合（锁定冲突错误形态）。
- integration（persistence）：SQLite 编辑事务原子性（注入失败点回滚无残留）、lock_records 读写、不可变触发器下 lock 版本化。
- E2E（apps/desktop）：编辑往返（改字段 → 新版本出现 → 集合校验通过）、锁阻断（锁 /dialogue → 编辑 dialogue 被阻 → 解锁 → 通过）、幂等重放。
- 全量门禁回归 + README 最近验证证据补记。
