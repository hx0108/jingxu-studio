# Proposal: shot-edit-lock

## Why

PRD 9.8 要求分镜「可编辑、可锁定」，但当前分镜工作区是纯只读（`StoryboardPanel.tsx:119-121` 明文「不支持编辑、拆分、合并、排序或删除」），`locked_paths` 全代码库恒空数组（`shot-system-fields.ts:224` 为唯一写点），`lock_records` 表 0001 已预建但零读写。产品承诺「可编辑、可锁定、可恢复、可追溯」四缺二；且模型漂移（如 2026-08-20 Qwen speaker_id）在不可自动修复时用户没有任何手工修正兜底，只能整集重生成。

本 change 落地第一刀：**镜头创意字段的人工编辑与锁定**。后续切片（结构操作拆分/合并/复制/排序/删除、局部 AI 重生成、导入导出）各自独立立项。

## What Changes

- 新增逐镜头编辑事务：人工编辑白名单创意字段 → 校验（ShotContract 1.1.0 + EDIT_INVARIANT 集合校验 + 锁复检）→ 原子创建新镜头版本（DRAFT，parent 指向当前版本）+ 新整集快照（episode_versions + episode_version_shots）；幂等回执 + 乐观并发复用既有模式。
- 激活 `lock_records` 表：LockService 为唯一锁事实源，`document_json.locked_paths` 为同事务只读投影（TECH 不变量 13）；锁定/解锁本身是版本化操作（新版本只改锁集合）；有效锁自动复制到编辑产生的新版本。
- 锁定语义按 PRD 9.8.1 全量实现：RFC 6901、七根白名单及已存在子路径、禁元数据/ID/状态/provenance/数组下标、路径可解析性校验、冲突判定（父/子/相等 token 前缀比较）；用户显式解锁，系统不得自动解锁。
- 新 IPC 命名空间与 Renderer 编辑入口（形态按 D1/D3/D4 拍板）。

## 非目标

- 结构操作：拆分、合并、复制、拖动排序、软删除（`shot_derivations` 表与 lifecycle SUPERSEDED/DELETED 留给结构操作 change）。
- 局部 AI 重生成（字段/镜头级 regenerate）与 AI 侧 write_set/锁快照接入（`write_set_json` 目前硬编码 `/data`，待局部重生成 change 消费）。
- StoryBible/ScriptVersion 五阶段对象的锁定（PRD 锁定覆盖三类对象，本 change 只做 ShotContract 域）。
- 导入导出业务入口（EpisodeStoryboardExport/ProjectTransferBundle schema 已锁版，transfer IPC 留后继 change）。
- 表格视图、多人并发。
- 整集恢复的镜头指针回拨语义（沿用既有拍板 D4「不回拨」）。

## Capabilities

### 新增 `shot-edit-lock`

- Requirement: 逐镜头创意字段编辑事务（版本链 + 集合不变量 + 幂等）
- Requirement: 镜头锁定/解锁（LockRecord 唯一事实源 + locked_paths 投影一致性 + 版本化锁定）
- Requirement: 编辑事务锁复检与原子性（父子/相等冲突 100% 阻断，无部分写入）
- Requirement: 分镜工作区编辑与锁定入口

## Impact

- **代码**：`packages/application`（新 ShotEditLockService，StoryboardVersionService 旁系）、`packages/persistence`（lock_records 读写 + 编辑事务 SQL）、`packages/contracts`（新命令 DTO + IPC 白名单）、`apps/desktop` main/preload/renderer（新通道 + StoryboardPanel 编辑化改造）。
- **Schema**：四份 PRD-owned Schema 零改动（locked_paths pattern 已锁版可直用）；无新迁移（lock_records/episode_version_shots 等表 0001 已预建）。
- **兼容与回滚**：纯增量（新通道、新命令、新版本行），不触碰既有生成/确认/恢复路径的行为；回滚 = 移除新通道与服务注册，历史数据（新版本行、lock_records 行）对旧代码惰性无害。
- **验收映射**：PRD AC-V1-03（编辑部分——结构操作除外）、AC-V1-06 锁定边界（服务层全矩阵）；TECH_DESIGN §9.2/§9.2.1/§9.2.2/§10、不变量 13；V1-SCR 指标「锁定保护成功率 100%」的人工编辑侧。
- **测试层级**：unit（锁算法/编辑事务）、contract（IPC 白名单/DTO）、integration（SQLite 事务原子性）、E2E（编辑往返 + 锁阻断 UI 断言）。
