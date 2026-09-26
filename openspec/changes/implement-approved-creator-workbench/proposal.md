## Why

用户已经确认 `designs/jingxu-ai-drama-prototype/` 的 10 页全中文高保真原型，并要求将其交互落到正式 Electron 应用。当前 Renderer 已有真实剧本、分镜、图片、视频、配音与 FFmpeg 合成能力，但页面结构、信息层级和时间线操作仍与已确认原型不一致，尤其合成页仍以表单和列表为主，不能按原型直接拖动、裁剪和组织三条轨道。

本变更承接 PRD v1.4 §10.9 的 V2 时间线与成片能力、§15 的界面与异常状态要求，以及 TECH_DESIGN v1.1 §6.5–§6.7 的现有媒体实现注记；它是 V2 生产闭环的实现增量，不改变 V1 发布门槛，也不把既有实验/Mock 证据描述为真实 Provider 或用户验证结果。

## What Changes

- 将正式 Renderer 重组为原型确认的 10 个页面：开始创作、我的作品、故事构思、剧本完善、分镜设计、画面生成、视频生成、合成导出、质量评测和设置；统一使用中文业务语言、电影感本地素材、暗色蒙版和橙色主操作。
- 保留既有 Application、IPC、不可变版本、任务、凭据和安全边界；原型中的示例内容只用于 DEMO 项目，真实项目必须读取主进程返回的真实状态，不使用前端伪数据或 `localStorage` 充当业务事实源。
- 将首页和普通编辑页限制在单视口工作区内并按浏览器高度压缩标题、卡片和间距；画面、视频和合成页允许工作区内部滚动且隐藏视觉滚动条，同时保留键盘和滚轮可达性。
- 将故事、剧本、分镜、媒体候选、评测和设置页面的已实现操作映射到原型组件，覆盖加载、空、运行、错误、成功、未保存离开和只读故障状态。
- 将图片与视频的新生成任务统一绑定 AGNES Provider：设置页只展示 AGNES 图片/视频配置，新视频任务不再读取或接受 Seedance 偏好；历史 Seedance 任务与候选仍按原 Provider 标识只读展示和审计，不静默改写。
- **BREAKING（Renderer 交互）**：以原型的六步流程替换当前工作区默认布局与默认信息层级；现有高级信息、历史恢复、任务证据和 Provider 细节继续保留在渐进式入口，不再占据默认主画布。
- 将合成导出页升级为真实三轨编辑器：画面轨、对白轨和配乐轨支持选择、播放头定位、拖动改位、双端裁剪、分割、复制、删除、撤销和重做；对白/配乐支持静音与音量，配乐支持淡入淡出。
- 时间线编辑必须保存为不可变新版本并参与并发校验、输入哈希、导出前复检和 FFmpeg 参数构建；刷新或重启从 SQLite 当前版本恢复，不能依赖 Renderer 临时状态。
- 明确分割、复制和删除的业务语义：不得伪造新生成候选；同一候选可由多个时间线片段引用，但每个片段具有稳定 `clipId`、源区间和目标起点，删除只创建新时间线版本，不删除候选或媒体文件。
- 同步必要的 IPC DTO、追加 migration、技术设计、测试和验收材料；四份 PRD-owned V1 JSON Schema 预计不变，若实施发现必须修改则停止并单独审查。
- 非目标：新增图片/视频/TTS Provider、自动 Provider 路由、迁移或重写历史 Seedance 证据、精准口型、V3 语义质量模型、云端协作、复杂多层专业剪辑器、任意文件路径访问以及未经人工确认的自动发布。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `desktop-workspace-foundation`: 将已确认的 10 页信息架构、全中文页面、响应式视口和可访问滚动规则纳入正式桌面工作区要求。
- `guided-creator-workspace`: 将六步主流程、唯一主操作、渐进式高级信息和原型中的页面状态落实到真实项目数据与命令。
- `storyboard-media-workspace`: 统一分镜、画面、视频、合成的镜头上下文、候选预览、检查器、滚动与状态交互。
- `video-composition-export`: 将现有排序/启停/裁剪时间线扩展为基于稳定片段标识和目标起点的真实可视化编辑、版本保存与导出执行。
- `voice-audio-timeline`: 将对白轨和配乐轨的拖动、裁剪、静音、音量及配乐淡入淡出纳入不可变时间线和数据驱动混音。

## Impact

- **Renderer**：主要影响 `AppShell`、`ProjectWorkspace`、`CreatorHome`、`ScriptWorkspace`、`StoryboardPanel`、`FirstFramePanel`、`VideoCompositionPanel`、`EvaluationWorkspace`、`ProviderSettings`、共享布局/图标/样式，并新增可复用的时间轴、轨道、片段和页面状态组件。
- **IPC / Preload / Contracts**：复用现有逐方法 IPC；为稳定 `clipId`、目标起点、音轨淡入淡出、轨道静音和必要的预览定位新增严格 Zod DTO。Renderer 仍不得接触路径、密钥、Provider 原始响应或通用 IPC。
- **Application / Domain**：扩展时间线编辑服务的确定性校验、版本输入哈希、并发冲突、撤销/重做的提交边界和导出装配；模型不参与编辑决策。
- **Persistence**：预计追加 migration 扩展视频、对白和配乐片段的时间线字段；不改写既有 migration，保留历史时间线兼容读取并提供稳定默认值。
- **FFmpeg / 文件安全**：Main 继续使用受信 FFmpeg/FFprobe 和参数数组；新片段起点、裁剪、静音、音量和淡入淡出必须进入滤镜图，失败或取消不产生部分成功文件。
- **兼容性**：既有项目、旧时间线、演示项目和导出记录必须可打开；旧时间线迁移为等价连续片段视图，不改变已有媒体文件和历史版本。
- **文档与验收**：同步 PRD v1.4 V2 实施追踪、TECH_DESIGN v1.1、主 OpenSpec 增量、Renderer/Contract/Integration/Electron E2E、Windows 打包与 packaged smoke。V2 进入条件和真实用户/Provider 认证仍单独报告，不因本变更自动满足。
