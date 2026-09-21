## 1. Apply 前基线与契约冻结

- [x] 1.1 重新检查工作树、当前 migration head、Agnes 图片 Provider 未提交改动和 `cine-workspace-theme`/`v1-acceptance-evidence` 状态，记录重叠文件并确认不覆盖用户修改。
- [x] 1.2 为首页续作、准备检查和演示初始化定义 strict Zod 输入/输出、稳定业务动作枚举、脱敏字段与错误码，并先补失败的 Contract/Preload 白名单测试。
- [x] 1.3 为五阶段表单建立正式 Schema 字段覆盖矩阵和 JSON Pointer 到中文控件路径映射清单，断言系统元数据不进入可编辑 `data`。
- [x] 1.4 选择一个无第三方版权内容的合成示例故事与参考资产，建立 manifest、hash 和 Schema/集合校验测试，明确“演示结果/零真实费用”文案。

## 2. 确定性续作解析与首页单一入口

- [x] 2.1 先编写 `CreatorGuideService.getNextAction` 决策表单元测试，覆盖无项目、输入未初始化、五阶段缺失/DRAFT/STALE/READY、分镜、参考资产、图片、视频、配音、合成、完成和后台状态漂移。
- [x] 2.2 实现 Application 层续作解析及稳定项目选择规则（显式项目优先，否则 `updated_at DESC, id ASC`），通过现有 Port 读取事实且不在 Renderer 复制业务判断。
- [x] 2.3 注册 `creatorGuide.getNextAction` IPC、Preload 逐方法桥接和 Composition Root 依赖，验证非法 DTO、跨项目 ID 和缺失项目返回稳定错误且零写入。
- [x] 2.4 将首页改为唯一主 CTA“继续制作本集”，实现无项目起始选择、点击前重新解析、直接定位阻断步骤及回到当前续作动作的路径。
- [x] 2.5 增加 Renderer 与 Electron E2E，证明多项目稳定选择、已有项目自动续作、后台 Job 完成后重定位和默认首页不要求先配置服务。

## 3. 五分钟体验模式

- [ ] 3.1 先编写演示初始化的 Application/Integration 测试，覆盖无凭据离线成功、requestId 幂等恢复、半程失败整体回滚、真实 CredentialPort 零读取和演示/真实候选隔离。
- [ ] 3.2 核实是否已有可靠项目级演示标志；若没有，新增最小顺序 migration、Project/Transfer DTO 与 Repository 映射，并完成空库、上一版本库和 100+ 历史版本库升级测试。
- [ ] 3.3 实现 `startDemo` 原子 Seed、Fixture/CAS staging 和演示恢复逻辑，所有演示任务固定 Mock 并持续保存可查询的演示标识。
- [ ] 3.4 注册 `creatorGuide.startDemo` IPC 与 Renderer 起始入口，所有演示页面和候选持续展示“演示结果/不会产生真实费用”，真实制作不继承演示凭据或 Mock 成功事实。
- [ ] 3.5 增加全新用户、无网络、无凭据 Electron E2E，在约 5 分钟体验目标路径内完成示例浏览与演示导出，并验证初始化失败可重试且无半项目。

## 4. 五阶段结构化表单

- [ ] 4.1 先为 CONCEPT 双向映射、边界长度、字段错误定位、dirty 保留和系统字段拒绝编写 Renderer/Contract 测试，再实现概念表单。
- [ ] 4.2 先为 STORY_BIBLE 的角色、场景、世界规则、道具增删改与稳定业务键编写 round-trip 测试，再实现重复项表单。
- [ ] 4.3 先为 EPISODE_OUTLINE 与 BEAT_SHEET 的目标时长、节拍 3–20 项、顺序和字段错误编写测试，再实现大纲与节拍表单。
- [ ] 4.4 先为 SCENE_SCRIPT 的场景、角色引用、动作、对白类型/说话人和预计时长编写测试，再实现场景剧本表单。
- [ ] 4.5 实现共享表单壳、保存/确认/dirty 离开流程和 Pointer 错误映射；所有最终保存继续调用既有 `script.saveDraft` 并以主进程 Schema 结果为准。
- [ ] 4.6 实现“高级编辑”模式与共享草稿，覆盖表单到 JSON、合法 JSON 回表单、非法 JSON 阻止覆盖、模式切换不创建版本和 expectedVersionId 冲突保留编辑。
- [ ] 4.7 更新剧本阶段 Electron E2E，验证普通路径无 JSON/版本/锁/Provider，五阶段均可结构化保存确认，高级 JSON 仍可按需使用且不暴露信封系统字段。

## 5. 生成前准备向导

- [ ] 5.1 先为 `getPreparation` 编写单元决策表，覆盖服务就绪、STYLE/CHARACTER 缺失、引用超限、媒体候选缺失/过期、预计时长、价格有效/未知/过期、多个阻断聚合和演示零费用。
- [ ] 5.2 实现 Application 聚合查询，复用既有 Credential 状态、一致性预检、媒体可用性和参考价格事实，返回 `READY/WARN/BLOCK`、修复动作及 revision，不复制生成规则。
- [ ] 5.3 注册 `creatorGuide.getPreparation` IPC/Preload，并补 Contract 安全断言，确保密钥、端点、Workspace、Profile、模型快照 ID、路径、完整 Prompt 和原始响应不进入 Renderer。
- [ ] 5.4 实现一次展示服务、角色图、画风图、预计时长、参考成本、警告和全部阻断项的向导；每个阻断项可定位修复，修复后恢复原项目/镜头/批次范围并重新检查。
- [ ] 5.5 将真实画面、视频、配音和合成主操作接入准备向导；确认时重新读取状态，原生成服务继续执行二次预检，缺凭据或失败绝不静默回退 Mock。
- [ ] 5.6 增加 Electron E2E，验证多阻断聚合、逐项修复、范围恢复、确认前状态漂移、价格未知/过期和真实生成零伪成功。

## 6. 默认界面简化与渐进披露

- [ ] 6.1 调整 `WorkspaceLayout` 默认检查器为下一步、准备状态和创作参考，宽屏/窄屏均保持唯一主要操作与可访问抽屉。
- [ ] 6.2 将首页、流程栏、剧本、分镜和媒体默认文案改为中文业务语言，移除默认 JSON、Provider、Profile、版本号/ID、能力快照、锁、任务 ID、哈希和英文枚举显示。
- [ ] 6.3 保留“历史与恢复”“高级编辑”“高级信息”入口，验证版本、锁、任务和错误码仍可追溯且敏感信息、原始响应和本地路径始终不显示。
- [ ] 6.4 将设置入口按“生成服务 → 文本/画面/视频/配音”组织，仅在用户进入配置时展示必要厂商、模型、地域和数据处理说明。
- [ ] 6.5 更新 Renderer 快照/语义测试和关键流程 E2E，断言每页只突出一个主要操作、禁用操作有中文原因、窄窗不遮挡核心内容。

## 7. 文档同步、完整验证与试用准备

- [ ] 7.1 按实际实现同步 PRD v1.4 验收追踪、TECH_DESIGN v1.1 的 IPC/架构/迁移/安全说明、示例 Fixture 边界和 E2E 清单；若四份正式 Schema 未变，明确记录“已核对、无需修改”。
- [ ] 7.2 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`，记录通过/失败/跳过数量并修复本变更导致的问题。
- [ ] 7.3 运行相关 `pnpm test:e2e`，覆盖首次体验、首页续作、结构化表单、准备向导、失败恢复、旧项目兼容和 AC-V1-01 至 AC-V1-06 回归。
- [ ] 7.4 运行 Windows x64 打包与 packaged smoke，确认内置 Fixture/参考资产可从打包资源离线读取且不泄露本地开发路径。
- [ ] 7.5 检查最终 diff、migration checksum、日志/Fixture/截图和导出内容，确认无密钥、用户私有内容、临时文件或 Agnes 并行改动被覆盖。
- [ ] 7.6 基于新交互构建 3 名目标用户受控试用脚本与记录模板，采集首次完成率、有效操作时间、墙钟时间、求助点和 Bad Case；未完成试用前不得声称 P0 首次成功路径已经用户验证。
