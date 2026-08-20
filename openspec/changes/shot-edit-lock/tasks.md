# Tasks: shot-edit-lock

## 1. 契约与锁核心（application 层）

- [ ] 1.1 锁算法纯函数（RFC 6901 解析/七根白名单/数组下标与非法转义拒绝/可解析性校验/token 前缀冲突判定）→ 验证：unit 全矩阵（含 AC-V1-06 Fixture 形态：父写子、子写父、同路径、非法转义、不存在路径、数组下标）
- [ ] 1.2 ShotEditLockService 编辑事务（校验→锁复检→EDIT_INVARIANT→新 scv DRAFT+锁复制→新整集快照+shotSetHash→stage_head→回执；乐观并发+幂等）→ 验证：unit 断言版本链/快照原子性（注入失败点无残留）/冲突阻断明细/锁继承
- [ ] 1.3 lock/unlock 版本化命令（新版本仅变 locked_paths；lock_records 同事务写；投影一致性）→ 验证：unit 断言 locked_paths ≡ lock_records 有效集合（不变量 13）

## 2. 持久化（persistence 层）

- [ ] 2.1 lock_records 读写端口 + SQLite/内存双实现 → 验证：integration 原子性（编辑事务注入失败回滚，lock_records 无孤儿）+ 不可变触发器下 lock 版本化路径
- [ ] 2.2 编辑事务 SQL 接线（新 scv + episode_version_shots 完整快照 + receipts 同事务）→ 验证：integration 快照完整性（20 镜头上限/sequence 连续/shotSetHash 复算一致）

## 3. IPC 与组合根

- [ ] 3.1 contracts：storyboard.* 命令 DTO schema + 白名单契约测试（按 D4 拍板）→ 验证：contract 测试锁定通道清单与错误形态联合
- [ ] 3.2 main/preload 注册（sender 校验、DTO 双端校验、requestId 去重、输出脱敏复验）+ 组合根注入 → 验证：组合根集成测试

## 4. Renderer

- [ ] 4.1 StoryboardPanel 编辑入口与编辑视图（按 D1 拍板形态）→ 验证：E2E 编辑往返（保存→新版本状态可见）
- [ ] 4.2 锁定/解锁入口与锁定标识（按 D3 拍板粒度）→ 验证：E2E 锁阻断（锁 /dialogue→编辑被阻→解锁→通过）与幂等重放
- [ ] 4.3 重建三 bundle + 全量门禁（tsc/eslint/format/unit/contract/integration/e2e）→ 验证：全绿 + 既有 16+3 E2E 不回归

## 5. 文档与收尾

- [ ] 5.1 README 当前已实现 + 最近验证证据补记
- [ ] 5.2 `openspec validate shot-edit-lock --strict` + `--all --strict` 通过
- [ ] 5.3 归档 change、更新 main
