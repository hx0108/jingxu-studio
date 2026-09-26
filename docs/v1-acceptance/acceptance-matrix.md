# 当前验收矩阵

这是发布候选的事实记录，不是通过声明。

| AC       | 当前状态                                       | 证据                                | 阻断                                     |
| -------- | ---------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| AC-V1-01 | 统一 Electron E2E 已通过 | `E2E-AC01-ORIGINAL` | 未覆盖真实用户 |
| AC-V1-02 | Main Dialog 导入、原文保留与锁定改写已通过 | `E2E-AC02-LOCKED-REWRITE` | 未覆盖真实用户 |
| AC-V1-03 | 六类结构编辑与 Bundle roundtrip 已通过 | `E2E-AC03-EDIT-ROUNDTRIP` | 未覆盖真实用户 |
| AC-V1-04 | Provider/Job 失败、取消、迟到与崩溃恢复已通过 | `E2E-AC04-FAILURE` | 未覆盖真实用户 |
| AC-V1-05 | 四种 DialogueRenderMode 与 SQLite 报告证据已通过 | `E2E-AC05-DIALOGUE` | 未覆盖真实用户 |
| AC-V1-06 | 锁冲突矩阵与零部分写入已通过 | `E2E-AC06-LOCK-MATRIX` | 未覆盖真实用户 |

## 首次创作体验增量（未替代 AC-V1-01～06）

| 能力 | 当前自动化证据 | 明确边界 |
| --- | --- | --- |
| 首页续作 | `creator-home.e2e.spec.ts` 覆盖空项目、最近更新项目与后台任务完成后的重新定位 | 不代表真实用户已理解流程 |
| 五分钟体验 | 同一 E2E 覆盖无凭据、离线示例剧本/分镜/参考图与生成前零真实费用提示；`create-demo-seeder.integration.test.ts` 覆盖失败清理后重试 | 体验项目使用受限 Mock；不调用真实 Provider，不产生真实费用，也不代表真实生成质量 |
| 生成前准备 | Application 决策表、Contract/Preload 白名单和 Renderer 测试覆盖服务、参考图、候选、时长与参考成本的聚合展示 | 参考成本不是账单；真实操作仍由服务端二次预检 |
| 结构化剧本编辑 | 五阶段默认使用中文表单，JSON 仅在“高级编辑”中出现 | 最终保存仍以 Main 的正式 Schema 和版本并发校验为准 |

四份 PRD-owned 正式 Schema 已核对且本变更未修改：`ScriptStageOutput`、`ShotContract`、`EpisodeStoryboardExport`、`ProjectTransferBundle`。

## 最新十页工作台与 V2 实施证据（不并入 V1 AC）

| 证据类型 | 当前证据 | 结论边界 |
| --- | --- | --- |
| 原型组件与导航 | `approved-prototype-navigation.e2e.spec.ts` 覆盖十页中文导航、普通页首屏、媒体页滚动、版本高级入口，以及 1920×1080、1440×900、1280×800/125% 缩放 | 证明可达性和布局约束，不代表像素级人工验收或目标用户理解 |
| Mock 媒体主链 | Electron E2E 使用显式 `JINGXU_E2E` Mock 建立图片、视频、时间线和导出状态 | 零网络、零真实费用；不能证明 Agnes 可用性、画质、成功率或账单 |
| 真实本地 FFmpeg | FFmpeg 集成样本和 packaged smoke 验证随包二进制、容器、流、时长及失败无残留 | 只证明本机装配链，不证明上游 Provider 生成质量 |
| 真实 Provider 探针 | 仅在显式门控和凭据存在时单次运行 Agnes 图片/视频 Canary | 本轮原型一致性验收未运行付费探针；历史探针不得复用为当前认证 |
| 目标用户证据 | 尚未完成最新十页工作台的三名目标用户试用 | 自动化、开发者操作和 Mock 不能替代目标用户证据 |

图片与视频新任务固定使用 Agnes；旧 Seedance/万相记录只读保留用于审计。migration 0027 的可编辑三轨属于 V2 实施追踪，不改变上述四份 V1 Schema。

因此当前版本是“自动化 AC-V1-01～06 已通过的 V1 发布候选版”，不是已满足 PRD §9.11 的最终发布版本；真实三名目标用户试用仍需由产品负责人组织并填写记录。
