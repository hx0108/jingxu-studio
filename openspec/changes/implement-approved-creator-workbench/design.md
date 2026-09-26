## Context

参见 [proposal.md](./proposal.md) 的动机与产品范围。当前正式应用已经具备 React Renderer、逐方法 Preload、Main IPC、Application Service、SQLite 不可变版本、视频/配音候选、内容寻址媒体、FFmpeg/FFprobe 合成和演示项目；现有 `VideoCompositionPanel` 仍以数字输入和列表为主。已确认原型是纯 HTML/CSS/JavaScript 的交互基准，不能直接嵌入正式应用，也不能把其 `localStorage`、模拟计时器或示例成功状态当作业务事实。

当前 migration head 为 `0026_project_experience_mode.sql`。工作树同时包含 `simplify-first-run-creator-experience` 和 Agnes Provider 相关未提交修改，本 Change 的 Apply 必须保留这些修改并在每个重叠文件上按现状合并。四份 PRD-owned V1 JSON Schema 不承载媒体时间线，本设计预计无需修改。

## Goals / Non-Goals

**Goals:**

- 以正式 React 组件复现 10 页原型的信息架构、视觉层级、响应式视口和关键交互，同时连接现有真实查询与命令。
- 将三轨时间轴升级为可保存、可恢复、可追溯、可导出的真实编辑模型；每次保存创建不可变子版本。
- 让画面、对白和配乐编辑使用同一毫秒时间基准并进入输入哈希、导出前复检和 FFmpeg 参数。
- 保持 Renderer → Preload/IPC → Application → Ports → Persistence/Media Adapter 的依赖方向以及本地路径、凭据和原始 Provider 响应隔离。
- 保留既有项目、时间线、导出记录、演示模式与高级证据入口的兼容读取。

**Non-Goals:**

- 不把原型 HTML 作为 iframe/WebView 或运行时代码导入正式应用。
- 不新增 Provider、模型、云服务、口型、自动质量模型或自动发布。
- 不建设多视频层、转场特效、关键帧曲线、调色、无限轨道或插件系统等专业 NLE 能力。
- 不承诺 Renderer 草稿预览与最终 FFmpeg 编码逐帧一致；已导出的受验证 MP4 仍是成片事实。
- 不把完成 UI 和 Mock E2E 解释为 V2 进入条件、真实 Provider 质量或目标用户试用已经通过。

## Decisions

### D1. 将原型拆为正式组件和页面视图，不复用原型运行时

在 `apps/desktop/src/renderer/src/` 内扩展现有 `ProjectWorkspace` 屏幕状态和六阶段路由：开始页、作品页、故事、剧本、分镜、画面、视频、合成、评测、设置分别由真实组件渲染。共享的品牌头、六步流程栏、页面状态卡、镜头条、候选卡、检查器、底部操作和对话框提取为可测试组件；电影感素材复制到 Renderer 本地 assets 并由 Vite 打包。

选择这一方案而不是嵌入 `designs/jingxu-ai-drama-prototype/`，因为正式应用必须复用现有状态、无障碍、IPC 和 CSP，且不能形成第二套业务实现。原型目录继续作为视觉验收基准和截图来源，不成为运行时依赖。

### D2. 页面只消费显式 ViewModel，业务完成状态仍由 Application 决定

Renderer 为十页建立页面级 ViewModel，将现有 `CreatorNextAction`、项目详情、阶段、分镜、媒体候选、任务、时间线和评测 DTO 映射为中文展示状态。ViewModel 只负责格式化、可见性和交互草稿，不推导 READY、STALE、凭据就绪、导出可用或价格事实。

首页继续在点击主要操作前调用 `creatorGuide.getNextAction`；媒体/合成主要操作先调用现有准备检查，并由服务端提交时二次复检。高级证据从“更多”或检查器入口打开，沿用现有 DTO，不复制一套状态源。

被否决方案：把原型的静态样例直接硬编码到 React。该方案会让真实项目展示伪进度，并破坏演示/真实数据隔离。

### D3. 视口使用应用壳固定、页面内容区自适应的两级滚动模型

应用壳使用 `height: 100dvh` 和固定品牌头；普通页面主区 `min-height: 0`、`overflow: hidden`，通过 `clamp()`、容器查询/高度媒体查询压缩非关键间距，最小可用高度以下不继续压缩文字和控件，而切换为内部滚动并保持焦点可见。画面、视频、合成页使用唯一 `.workspace-scroll-region` 作为纵向滚动容器，浏览器滚动条视觉隐藏但保留 `overflow-y:auto`、滚轮、触控板、PageUp/PageDown 和焦点滚动。

不使用全局 `body { overflow: hidden }` 掩盖溢出，也不按固定 1920×1080 缩放整页；后者会复现左右黑边、点击坐标失真和小字问题。

### D4. 时间线 DTO 从“每镜头一项”扩展为“稳定片段实例”

画面片段新增：

- `clipId`：系统生成的稳定 ID；同一 timelineVersion 内唯一。
- `targetStartMs`：片段在成片时间轴的目标起点，100ms 精度。
- 既有 `shotId/candidateId/fileSha256/generationInputHash/trimInMs/trimOutMs/enabled/position` 保留。

同一候选允许被多个片段引用，分割和复制只创建新的 `clipId` 及源区间，不创建媒体候选。单画面轨不允许启用片段重叠；空隙允许存在并由导出装配为黑色视频+静音占位，避免保存时静默移动用户片段。若产品验收决定不允许空隙，只需在服务校验增加 `VIDEO_TIMELINE_GAP`，不会改变存储形状。

对白片段新增 `clipId` 与绝对 `targetStartMs`；继续绑定配音候选三元组并保留 `shotId` 供追溯和字幕/对齐关联。配乐仍限一个已导入音频资产，版本行新增 `bgmStartMs`、`bgmTrimInMs`、`bgmTrimOutMs`、`bgmMuted`、`bgmFadeInMs`、`bgmFadeOutMs` 和 `voiceTrackMuted`；既有 `audioVolume` 继续作为配乐音量。

片段总上限设为 60，保留单集最多 20 个源镜头，同时允许有限分割/复制；超限返回 `VIDEO_TIMELINE_CLIP_LIMIT`。该上限由 Contract 和 Application 同时校验。

被否决方案：以数组下标充当片段身份。排序、分割或重做后下标会漂移，无法稳定审计与并发校验。

### D5. migration 0027 重建时间线子表并对旧版本做等价回填

新增 `0027_editable_composition_timeline.sql`：

1. 重建 `video_timeline_items`，主键改为 `(timeline_version_id, clip_id)`，保留 `(timeline_version_id, position)` 唯一约束，新增 `target_start_ms` 和候选/镜头索引。
2. 重建 `video_timeline_voice_items`，主键改为 `(timeline_version_id, clip_id)`，新增 `target_start_ms`；保留候选、镜头和版本外键。
3. 为 `video_timeline_versions` 追加对白轨静音和配乐起点、裁剪、静音、淡入淡出列及 CHECK。
4. 旧画面项按 `position` 和有效裁剪时长累加生成连续 `target_start_ms`，`clip_id` 由旧 `(timeline_version_id, shot_id)` 确定性派生；旧对白起点按关联画面起点加原 `offset_ms` 回填；旧配乐按起点 0、全长、未静音、淡入 0、既有默认淡出语义回填。

Migration 在单事务运行并保持旧表备份仅存在于事务内部；失败整体回滚。测试覆盖空库、v26 样本库、含 100+ 历史版本库、重复候选片段和外键审计。不得改写 0019/0020。

### D6. 保存是一条原子 Application 命令，撤销/重做仅管理未提交草稿

继续复用 `video.updateTimeline` 命令并扩展严格 DTO：`projectId/requestId/episodeId/expectedVersionId` 加完整三轨草稿。Application 先做 Zod 形状校验，再在事务外解析/复检媒体事实，计算片段区间、重叠、裁剪、候选世代、对白对齐与淡入淡出约束；最后在短事务中插入新版本、子轨行、审计、command receipt 并更新 current pointer。inputHash 对规范化后的所有片段、轨道设置、候选哈希、FormatProfile 和映射快照排序后计算。

Renderer 以 reducer/Zustand 局部 slice 维护最多 30 个草稿快照，支持撤销/重做；拖动期间只更新草稿和预览，pointer-up 不自动写库。用户点击“保存”或“保存并继续”才发命令。刷新/重启丢弃未保存历史并读取当前版本；dirty 离开使用现有确认对话框。

被否决方案：每个 pointermove 都创建时间线版本。它会放大写入、产生无意义历史并使 requestId/并发冲突不可管理。

### D7. 拖动、裁剪和键盘操作共享确定性编辑函数

新增纯函数编辑核心，输入当前草稿、片段 ID、动作和时间刻度，输出新草稿或稳定错误：选择、seek、move、trim-start、trim-end、split、duplicate、delete、mute、volume、fade、undo、redo。指针交互只负责把像素位移换算为毫秒并以 100ms 吸附；按钮和键盘调用同一函数。

默认快捷键：空格播放/暂停、Delete 删除选中片段、Ctrl+Z 撤销、Ctrl+Shift+Z/Ctrl+Y 重做。焦点位于输入控件时不劫持快捷键。拖动手柄具有可读标签，片段提供数值起点/入点/出点替代输入。

### D8. 草稿预览与最终导出分离但共享时间线语义

Renderer 预览根据播放头选择当前画面片段，通过受限 `jingxu://media` URL 播放源候选，并按草稿起点/裁剪切换；对白和配乐使用 HTMLMediaElement 的受限 URL 做近似同步、音量和静音预览。seek、播放和切换不创建业务版本。浏览器实时预览无法保证与 FFmpeg 滤镜逐帧一致，因此界面标明“工作预览”；导出成功后播放经 FFprobe/哈希验证的 MP4。

Main 导出装配按已保存版本构建：画面 `trim/setpts`、空隙生成占位、片段排序后 concat；对白按绝对 `targetStartMs` 使用 delay/trim/volume，轨道静音时不加入混音；配乐使用 trim、delay、volume、fade in/out，静音时不加入。字幕仍由 `shotId` 与冻结文本哈希派生并按对应画面片段窗口展开；同一镜头多片段时字幕按启用片段分别生成或由用户关闭，不能静默重复整段文本。

### D9. IPC、安全和错误边界保持现状

不新增通用 IPC。现有 `video.getTimeline/createTimeline/updateTimeline/startExport/cancelExport` 继续逐方法注册并扩展 DTO；Preload 再校验返回。Renderer 只收到 ID、哈希、状态和受限媒体 URL，不收到路径、FFmpeg 命令行、Key、Provider 端点、Prompt 或原始响应。

新增稳定错误码至少包括：`VIDEO_TIMELINE_CLIP_LIMIT`、`VIDEO_TIMELINE_OVERLAP`、`VIDEO_TIMELINE_EMPTY`、`VIDEO_TIMELINE_CLIP_NOT_FOUND`、`VIDEO_TIMELINE_START_INVALID`、`VIDEO_AUDIO_FADE_INVALID`。错误进入既有 `AppErrorDto`，包含中文下一步且不泄露内部实现。

### D10. 视觉验收以原型为基准，但代码验收以语义和真实状态为准

从原型提取颜色、间距、字体层级、蒙版、暗角、卡片和本地素材，形成 Renderer token；不复制绝对坐标热区。E2E 使用 1920×1080、1440×900 和支持的最小窗口检查十页到达、无横向溢出、普通页面主操作可见、媒体页全部内容可滚动、三轨编辑和 dirty 恢复。视觉截图只辅助比较，语义定位、DTO、数据库版本和实际导出结果是通过门槛。

### D11. 新媒体任务统一路由到 AGNES，历史 Provider 事实保持不可变

图片路径继续使用 `AGNES_IMAGE` 固定 Profile。视频路径在非 Mock 模式下固定使用 `AGNES_VIDEO` Profile、受限模型注册表和 AGNES 能力快照，不再读取 `video_provider_preferences` 决定新任务，也不接受 `JINGXU_VIDEO_PROVIDER=SEEDANCE`。设置页只渲染 AGNES 视频卡，不再暴露“当前视频档”切换。

已有 Seedance Profile、偏好行、候选与调用证据不删除：Provider 枚举和历史解析 Adapter 继续用于旧任务恢复与审计，防止把历史 Seedance 调用静默伪装成 AGNES。Mock 仍只由开发/E2E 的 Main-only 开关启用，并保留醒目标识。

## Risks / Trade-offs

- **[范围较大且与当前未提交 Renderer 修改重叠]** → Apply 前记录重叠文件和基线测试，按组件分批落地；不覆盖 `simplify-first-run`、Agnes 或用户修改。
- **[旧时间线没有稳定片段 ID 和绝对起点]** → migration 使用确定性派生和累计有效时长回填，并对 v19/v20/v26 样本做升级矩阵与哈希/外键审计。
- **[实时浏览器预览与 FFmpeg 可能有亚帧差异]** → 100ms 编辑精度、明确“工作预览”，成功成片只认 Main 侧 FFprobe/哈希校验。
- **[同一候选多片段导致字幕或对白重复]** → 对白/字幕继续绑定片段与 shot 追溯；导出前显示重复检查并要求明确启用状态。
- **[隐藏滚动条降低内容可发现性]** → 媒体页保留可见的内容分区、底部渐隐/提示和键盘滚动，不隐藏焦点；E2E 验证最后一项可达。
- **[V2 UI 完成被误认为达到发布条件]** → 文案、验收和最终报告继续区分 Mock、真实 Provider 探针、用户试用和正式发布证据。
- **[时间线片段增多增加滤镜图复杂度]** → 限制 60 个片段、在 Application 预先验证、对 FFmpeg 参数长度和导出耗时加入集成/压力测试。

## Migration Plan

1. 在独立 `codex/implement-approved-creator-workbench` 分支或隔离工作树实施；若必须在当前脏工作树继续，先保存基线 diff 和重叠文件清单。
2. 先增加 Contract 失败测试和 migration 0027 升级测试，再落地 DTO、Repository 与 Application 校验；旧 UI 在此阶段继续工作。
3. 完成 FFmpeg 装配与 Mock/真实本地媒体集成验证后，再切换合成页到新三轨组件。
4. 分页将十页视觉骨架接入真实 ViewModel，逐页替换旧布局并保持高级入口。
5. 运行格式、lint、类型、单元、Contract、Integration、相关 Electron E2E、Windows 打包和 packaged smoke；重新生成 V1/V2 验收证据，不复用旧 UI 截图。
6. 回滚代码时保留 0027 和新数据读取兼容；旧版本 UI 可忽略新增列并继续读取基础时间线。不得删除 migration 或丢弃用户已保存的新时间线版本。

## Open Questions

无。当前按单画面轨不允许重叠、允许显式空隙并由黑场/静音占位导出的语义实施；若产品希望改为自动吸附并消除空隙，需要在 Apply 前作为规格变更确认。
