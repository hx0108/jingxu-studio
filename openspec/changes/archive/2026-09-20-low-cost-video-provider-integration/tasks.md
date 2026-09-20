## 1. 产品与技术事实源同步

- [x] 1.1 按 proposal 的范围决定同步修改 PRD v1.4 §10.4/§10.8：允许 Seedance、Wan 与 Agnes 三家受限视频 Provider、每次任务人工显式选择一家、禁止自动路由，并保持 V1 验收边界不变。
- [x] 1.2 更新 TECH_DESIGN v1.1 的视频 Provider 实施注记、`VideoModelResolver` 依赖方向、0023 migration 前沿、三凭据/网络 allowlist 和真实 Canary 边界；更新 README，继续如实标注真实 Provider 与用户验收状态。
- [x] 1.3 复核 2026-09-18 阿里云官方 API/价格页并冻结 `wan2.6-i2v-flash` 北京地域、Base64 首帧、2～15 秒整数、720P/1080P、`audio=false` 证据；若官方事实与设计冲突，停止实现并修订 Change。
- [x] 1.4 复核 2026-09-19 Agnes 官方 wiki 并以受控真实探针冻结事实：固定端点、`video_id`+`model_name` 轮询、完成态顶层 `url`（与文档 `metadata.url` 不符按实测冻结）、COS 下载域、data URL 首帧被接受、`seconds` 字符串、2.5 Flash 仅 720P/图≤5/无视频输入、当前 $0/秒促销与免费档 1 RPM。探针日志 `jingxu-tools/agnes-probe.log`。

## 2. 测试先行：模式、默认值与契约

- [x] 2.1 先添加失败单元测试覆盖“新 Seedance Profile 默认 mini、既有 2.0/2.5 Profile 保留不改写、非法模型拒绝”，追溯 Requirement「视频 Provider 必须提供受限的 Seedance 模型选择」。
- [x] 2.2 先添加失败单元/组合根测试覆盖“开发默认 Mock 零凭据读取零网络、正式真实档失败不回退 Mock、真实调用必须显式开启”，追溯 Requirement「视频联调必须默认使用可识别的零网络 Mock」三个 Scenario。
- [x] 2.3 先扩展 Provider/Preload Contract 测试：只接受 `MOCK|SEEDANCE|WAN|AGNES`、`DASHSCOPE_WAN_VIDEO`/`AGNES_VIDEO` 和受限模型；拒绝任意 URL、地域、Workspace 域名、音频开关及密钥字段，保持七个 `video.*` 生成方法不变。
- [x] 2.4 先添加失败测试覆盖 Seedance/Wan/Agnes 三个固定 Profile 的保存、轮换、删除、末四位与验证时间隔离，以及 Provider 切换不读取或修改另一密文。

## 3. 0023 持久化与历史兼容

- [x] 3.1 先添加 migration/invariant 失败测试，覆盖空库、v22 样本库、既有 Seedance 2.0/2.5 Profile、在途视频任务、未知历史 model_id 阻断和 100+ 历史版本压力库。
- [x] 3.2 新增不可变迁移：创建单例 `video_provider_preferences`，为视频任务/候选冻结 Provider/Profile/model/capability/is_mock，播种 canonical `dashscope-wan-video/v1`、`agnes-video/v1` 与 `volcark-seedance-video/v3`（2.x 家族）能力快照及 SHA-256。落地拆两支：`0023_video_provider_preferences.sql`（偏好单例，已被真库 checksum 钉死）+ `0024_low_cost_video_provider_provenance.sql`（冻结列/快照/受控回填）。
- [x] 3.3 迁移前沿已到 24、迁移清单/checksum 测试已同步、旧 Seedance 行按受控模型映射回填且 `profile-video-primary`/历史 model_id/任务 ID/候选/调用证据不变（矩阵已验证）；SQLite Repository 溯源读写映射已随 4.2 落地（列↔记录 + 一致性守卫 + 往返测试），建档写路径经 resolveProvenance 显式冻结（Mock 行 is_mock=1 归真），SQL DEFAULT 仅兜底旧调用形状。
- [x] 3.4 为视频 Provider 偏好新增 Application-owned Port 和 SQLite/in-memory 实现，使用 `expectedUpdatedAt` 乐观并发；验证保存失败整事务回滚且不影响三家 Provider Profile。

## 4. Application 冻结与按任务路由

- [x] 4.1 先添加视频建档测试，断言模式、Provider、Profile、model、capability snapshot 与 Mock 标记在一个事务中冻结并进入 generation input hash/request snapshot，当前偏好变化不改写历史。
- [x] 4.2 新增 `VideoModelResolver` Application Port，并让视频调度器按任务冻结事实解析 Model Port；图片调度器继续使用固定 Adapter，现有图片测试必须零行为变化。
- [x] 4.3 把时长/分辨率映射改为能力快照驱动：Seedance 维持 5/10 秒，Wan 允许 2～15 秒整数，Agnes 固定 5 秒/720P；不支持参数在 submit 前稳定拒绝且不得静默降级。
- [x] 4.4 添加重启/切换集成测试：Seedance、Wan、Agnes、Mock 四类在途任务在当前模式改变后仍由原 Adapter 轮询/下载；UNKNOWN、取消迟到和结果未知保持零重发。

## 5. Wan 与 Agnes Adapter

- [x] 5.1 先添加 `WanVideoModelAdapter` Contract 单测，精确断言北京 Workspace 域名、异步请求头、`wan2.6-i2v-flash`、Base64 首帧、`audio=false`、`prompt_extend=false`、`shot_type=single`、`watermark=true` 和受控 resolution/duration；禁止额外参数。
- [x] 5.2 实现无 SDK 的 Wan submit/poll/download：任务状态映射、24 小时结果 URL、HTTPS/userinfo/redirect 守卫、64 KiB 响应证据截断和 MP4 `ftyp` 魔数校验。
- [x] 5.3 先补齐并实现 Wan 错误矩阵：401/403、429、5xx、网络错误、超时、取消、非法 JSON、非法图片/参数、内容拒绝、模型/地域不可用、UNKNOWN 和过期 URL；非重试错误不得切换 Provider。
- [x] 5.4 更新 model-adapters 公开入口与通用 `VideoModelPort` 契约测试，确保 Seedance/Mock/Wan/Agnes 的 submit/poll/download/evidenceOf 行为一致且 Provider DTO 不越过 Adapter 边界。
- [x] 5.5 先添加 `AgnesVideoModelAdapter` Contract 单测：固定 `apihub.agnes-ai.com` 端点、冻结模型枚举、data URL 首帧、`mode:"ti2vid"`、`seconds:"5"`、2.5 Flash 固定 `size:"720P"`、轮询带 `video_id`+`model_name`、完成态取顶层 `url`、下载域 allowlist 仅 `cos-platform-outputs.agnes-ai.cn`；禁止额外参数。
- [x] 5.6 实现无 SDK 的 Agnes submit/poll/download：`queued/in_progress/completed/failed` 状态映射、HTTPS/userinfo/redirect 守卫与域 allowlist、64 KiB 响应证据截断、MP4 `ftyp` 魔数校验。
- [x] 5.7 补齐 Agnes 错误矩阵：401/403、429（免费档 1 RPM 预期常见，可重试）、5xx、网络/SSL 错误、超时、取消、非法 JSON、参数 400（2.5 Flash 720P/图数硬校验）、内容拒绝；非重试错误不得切换 Provider。

## 6. Main、IPC 与设置界面

- [x] 6.1 在 Main 组合根接入 `MOCK|SEEDANCE|WAN|AGNES` 受限解析：开发/E2E 默认 Mock，正式新安装为 Seedance+mini 且无凭据时拒绝；增加 Wan/Agnes 独立 CredentialAdapter 引用和固定 allowlist（Agnes 无 Workspace 派生）。
- [x] 6.2 增加 `getVideoProviderSelection`/`saveVideoProviderSelection` 的 Main/Preload/Contracts 白名单、Zod DTO、singleflight/乐观并发和脱敏错误；保存选择本身不得发网络请求。
- [x] 6.3 改造视频 Provider 设置卡：展示 Mock 醒目标记、Seedance 三模型且默认 mini、Wan 固定 Flash 无声档、Agnes V2.0 默认/2.5 Flash 可选（标注 $0/秒促销与 1 RPM 限制）；三家 Key 分开保存/轮换/删除，切换不回显或清空另一档。
- [x] 6.4 在视频候选、任务高级信息和导出前检查显示 Mock/Seedance/Wan/Agnes 来源及 Mock 模拟标识；任何视图不得出现完整 Key、Authorization、Workspace 域名、结果 URL、原始响应或文件路径。
- [x] 6.5 扩展 Electron E2E：Mock 单镜头/批量/失败/取消/重启全链零网络；切换 Provider 后旧任务不串线；正式真实档缺凭据稳定失败且不生成模拟成功候选。

## 7. 验证与受控真实探针

- [x] 7.1 运行 `openspec validate low-cost-video-provider-integration --strict`，并核对 proposal/spec/design/tasks、PRD、TECH、Schema 与代码不存在未处理冲突。
- [x] 7.2 运行最小合并门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`，记录各命令通过/失败/跳过数量。
- [x] 7.3 运行相关 Electron E2E（至少视频生成、Provider 设置、恢复、媒体协议与安全边界），确认默认网络访问为零并检查最终 diff 不含密钥、结果 URL、临时视频或无关原型文件改动。
- [x] 7.4 ~~真实 Wan Canary~~ **已随万相档移除而取消（2026-09-20 用户决策：真实万相不接入）**；运行面已无任何万相请求路径，无需真实认证，README/TECH 同步如实标注。
- [x] 7.5 Agnes Adapter 级 Canary 已运行（2026-09-20，$0 档）：V2.0 经真实 Adapter 全链通过（submit→17 次轮询含 1 次瞬时网络错误重试→下载 1.6MB MP4 ftyp 校验→实报 5 秒；脱敏证据 jingxu-tools/agnes-adapter-canary-v20.log，key 泄漏扫描 0）。2.5 Flash submit 经 12 分钟 12 次重试全部 503 队列满载（D5b 已知免费档容量条件，当日持续超 10 分钟实测上限），每次均正确归一 MODEL_PROVIDER_ERROR 可重试——服务端容量状态无法由客户端解决，非 Adapter 缺陷；请求形状已由 2026-09-19 事实探针验证（text+keyframe 双形态均完成真实任务），待 Agnes 队列恢复后可随时补跑 `-t "2.5 Flash"`。
