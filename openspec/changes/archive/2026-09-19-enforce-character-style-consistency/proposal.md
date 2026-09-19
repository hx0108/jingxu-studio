## Why

当前首帧链路在真实工作区中会把 `STORY_BIBLE` 信封误当成裸数据读取，导致 `output.data.characters/scenes` 的角色外观与场景描述没有进入 Provider Prompt；同时系统只支持 CHARACTER/SCENE 参考资产，没有项目级画风资产与生成前完整性门禁，因此缺少参考图时仍会静默退化为逐镜文本生成，角色和画风容易跨镜漂移。PRD v1.4 §10.2 已明确角色身份应优先使用主体参考图、场景切换仍需风格和资产约束，§10.5 也将画风列为版本化资产；需要把这些控制要求落实为确定性输入与可见预检。

## What Changes

- 修复首帧请求蓝图对正式 `ScriptStageOutput/STORY_BIBLE` 信封的解析，并保留对已落库裸 `data` 形态的兼容读取；损坏或非 STORY_BIBLE 信封不得静默伪装成有效描述。
- 将媒体资产类型扩展为 `STYLE`，允许每个项目维护一个当前画风参考版本及文字描述；版本仍不可变，升版沿用 STALE_INPUT 传播和受影响镜头清单。
- 首帧 Prompt 固定注入项目画风锚点、出场角色的 StoryBible 外观和身份保持约束；参考图按“画风 → 出场角色 → 场景”的确定性顺序组装并写入证据快照。
- 新增生成前一致性预检：项目缺少画风锚点、任一出场角色缺少当前参考图，或正式 StoryBible 无法解析时，以稳定错误码阻断单镜头和整集批量建档，并返回可执行的缺失项清单；不再静默降级为无锚点生成。
- 在首帧工作区展示“角色/画风一致性”状态、缺失资产和上传入口；禁用生成动作时保留可见原因。
- 增加真实 StoryBible 信封、角色参考缺失、画风参考缺失、资产升版失效、单镜头与整集批量一致性门禁的 Unit/Contract/Integration/E2E 覆盖。
- 不引入自动人脸识别、LoRA/模型训练、局部重绘、多 Provider 路由或“100% 一致”承诺；模型质量仍由人工候选选择与后续评测承担，符合 PRD v1.4 §10.2 的能力边界。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `shot-first-frame-image-generation`: 修正 StoryBible 描述解析，新增项目级 STYLE 资产、确定性参考图/Prompt 组装、一致性预检门禁、STALE 传播与 Renderer 缺失项反馈。

## Impact

- **产品/验收**：落实 PRD v1.4 §10.2、§10.5，并补充 §10.10 所需的资产版本、参数和人工选择可追溯证据；强一致模式下，旧项目首次生成前需要补齐画风与出场角色参考图，属于有意的前置条件收紧。
- **Schema**：不修改四份 PRD-owned V1 JSON Schema；ShotContract 字段与枚举保持兼容。图片 IPC 的 `assetType`、预检结果和错误 DTO 需要同步更新 Zod 契约。
- **数据库**：新增前进 migration 扩展媒体资产类型/项目画风绑定，不改写既有 migration；历史 CHARACTER/SCENE 资产与候选保持可读，STYLE 升版触发新输入世代。
- **代码**：影响 `packages/application/src/media` 的 StoryBible/Prompt/生成输入解析，media persistence 与 migration，图片 IPC/preload 契约，`FirstFramePanel` 与批量生成状态，以及 Mock/真实请求证据快照。
- **进程/安全**：不改变 Renderer → Preload/IPC → Main → Application 的边界；STYLE 图片继续走既有内容寻址存储和 `jingxu://media` 受限协议，不向 Renderer 暴露路径或字节，不扩大 Provider/网络 allowlist。
- **兼容性**：已有候选、历史资产版本和导出不回写；升级后仅新的生成建档应用一致性门禁。旧项目可查看历史结果，补齐锚点后再生成，不自动调用 Provider、不自动重生成。
