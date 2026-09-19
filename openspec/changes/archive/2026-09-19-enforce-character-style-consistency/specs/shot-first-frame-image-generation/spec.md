## MODIFIED Requirements

### Requirement: 首帧候选生成必须以冻结镜头版本与资产版本快照为输入

系统 MUST 仅在项目存在 READY 的 ShotContract 版本、目标镜头属于该版本、且客户端 expected shot version 与服务端一致时接受首帧生成请求。生成输入 MUST 由镜头版本内容、项目当前 STYLE 资产版本、按 `character_ids` 解析出的全部 CHARACTER 资产版本、可选的 SCENE 资产版本、model_id 与归一化参数组成，并计算 `generation_input_hash`。STYLE 资产或任一出场 CHARACTER 资产缺失时 MUST 阻断建档并返回稳定错误码与缺失项；SCENE 资产缺失仍可用已解析的 StoryBible 场景描述继续。Prompt 组装 MUST 只消费镜头创意字段、正式 STORY_BIBLE 信封中的 `data` 描述与冻结的一致性资产描述，MUST NOT 依赖模型或 Renderer 提供的系统字段。

#### Scenario: 冻结输入齐全时提交媒体任务

- **GIVEN** 项目存在 READY ShotContract，expected shot version 匹配，项目有当前 STYLE 资产，且镜头全部出场角色均有当前 CHARACTER 资产
- **WHEN** 用户请求为某镜头生成首帧候选
- **THEN** 系统 SHALL 按 STYLE、CHARACTER、SCENE 的确定性顺序解析参考图并计算生成输入哈希
- **THEN** 系统 SHALL 创建 N 个 PENDING 候选与一条媒体任务，provider 调用前持久化幂等键

#### Scenario: 必需一致性资产缺失不创建任务

- **GIVEN** 镜头缺少项目 STYLE 资产或至少一个出场角色的 CHARACTER 资产
- **WHEN** 用户请求生成首帧候选
- **THEN** 系统 MUST 返回稳定一致性前置错误与去重后的缺失资产清单
- **THEN** 系统 MUST NOT 创建任务、候选或批次，MUST NOT 调用 Provider

#### Scenario: 镜头版本不匹配不创建任务

- **GIVEN** expected shot version 过期或镜头不属于当前 READY 集合
- **WHEN** 用户请求生成首帧候选
- **THEN** 系统 MUST 返回稳定前置条件或 STALE_INPUT 错误，MUST NOT 创建任务、调用 Provider 或写入候选

### Requirement: 资产版本必须不可变且图片字节不得写入 SQLite

CHARACTER/SCENE 资产 MUST 按 STORY_BIBLE ID 唯一建档；每个项目 MUST 至多存在一个保留键为 `project-style` 的 STYLE 资产。AssetVersion MUST 不可变且版本号单调递增。参考图与候选字节 MUST 以内容寻址（sha256）存于受管理 `projects/<projectId>/` 目录，写入 MUST 先临时文件后原子 rename 并校验哈希；SQLite MUST 只存哈希、尺寸、格式与相对路径。STYLE 或 CHARACTER 资产升版后，引用旧版本的候选 MUST 标记 STALE_INPUT 并列出受影响镜头，MUST NOT 自动重新生成。

#### Scenario: 参考图上传产生不可变新版本

- **GIVEN** CHARACTER、SCENE 或 STYLE 资产 A 当前版本为 v1
- **WHEN** 用户上传新参考图
- **THEN** 系统 SHALL 写入内容寻址文件并创建 v2 版本行
- **THEN** v1 行与其文件 SHALL 保持不变且仍可被历史候选快照引用

#### Scenario: 项目只允许一个画风锚点

- **GIVEN** 项目已有保留键 `project-style` 的 STYLE 资产
- **WHEN** 用户再次上传画风参考图
- **THEN** 系统 SHALL 为同一 STYLE 资产创建新版本而非第二个 STYLE 资产
- **THEN** 所有受影响的旧输入世代 SHALL 标记 STALE_INPUT 且保持可追溯

#### Scenario: 候选落盘校验失败不登记

- **GIVEN** 下载字节与 Provider 结果引用的哈希不一致
- **WHEN** 系统落盘候选
- **THEN** 该候选 SHALL 标记 FAILED 且 SQLite 不登记该文件
- **THEN** 临时文件 SHALL 被清理

## ADDED Requirements

### Requirement: 正式 StoryBible 描述必须按信封结构解析且失败可见

首帧生成系统 MUST 从 `ScriptStageOutput` 信封的 `data.characters` 与 `data.scenes` 解析当前 STORY_BIBLE 描述，并验证信封阶段为 STORY_BIBLE。为兼容已有本地数据，系统 MAY 读取合法的裸 `data` 对象；非法 JSON、错误阶段或缺少 `data` 的正式信封 MUST 返回稳定预检错误，MUST NOT 静默降级为空描述。角色与场景描述 MUST 进入可复盘的 Prompt 请求快照。

#### Scenario: 真实 StoryBible 信封注入角色和场景描述

- **GIVEN** 当前 StoryBible 是包含 `stage=STORY_BIBLE` 与 `data.characters/scenes` 的合法信封
- **WHEN** 系统构建首帧 Provider 请求
- **THEN** Prompt SHALL 包含镜头所引用角色的姓名与外观以及场景名称与描述
- **THEN** 请求证据快照 SHALL 保存最终 Prompt 和参考图 sha256 清单

#### Scenario: 损坏或错误阶段信封阻断生成

- **GIVEN** 当前 StoryBible 为非法 JSON、正式信封缺少 data，或 stage 不是 STORY_BIBLE
- **WHEN** 用户请求单镜头或整集首帧生成
- **THEN** 系统 SHALL 返回 `MEDIA_CONSISTENCY_STORY_BIBLE_INVALID`
- **THEN** 系统 MUST NOT 建档或调用 Provider

### Requirement: Prompt 与参考图必须使用确定性的一致性顺序

系统 MUST 将项目 STYLE 描述、出场角色 StoryBible 外观、身份保持约束、场景描述、镜头画面与机位要求按固定模板组装；参考图 MUST 按 STYLE、按 `character_ids` 原顺序的 CHARACTER、SCENE 排列。超出 Provider 参考图上限时系统 MUST 以稳定错误阻断，MUST NOT 截断 STYLE 或 CHARACTER 参考图；输入顺序、模板版本、全部资产版本 ID 与参考图 sha256 MUST 进入世代哈希或调用证据，使同一输入可复盘。

#### Scenario: 相同输入产生相同请求蓝图

- **GIVEN** 镜头版本、StoryBible、模型参数及 STYLE/CHARACTER/SCENE 资产版本均未变化
- **WHEN** 系统两次构建首帧请求蓝图
- **THEN** 两次 Prompt、参考图顺序、generation_input_hash 与请求快照 SHALL 完全相同

#### Scenario: 必需参考图超过 Provider 上限时不静默截断

- **GIVEN** STYLE 加全部出场 CHARACTER 参考图数量已经超过当前 Provider 上限
- **WHEN** 用户请求生成首帧
- **THEN** 系统 SHALL 返回 `MEDIA_CONSISTENCY_REFERENCE_LIMIT_EXCEEDED`
- **THEN** 系统 MUST NOT 丢弃任一必需参考图、建档或调用 Provider

### Requirement: 首帧工作区必须展示一致性预检和修复入口

Renderer SHALL 在单镜头生成与整集批量生成前展示项目画风锚点、当前镜头出场角色参考图和 StoryBible 解析状态。缺少必需项时，生成操作 MUST 保持可见但禁用，并显示缺失对象及对应上传或修复入口；批量生成 MUST 汇总所有目标镜头的缺失角色并去重。状态 MUST 来自主进程应用层预检结果，Renderer MUST NOT 自行推断成功。

#### Scenario: 单镜头缺少角色参考图

- **GIVEN** 当前镜头引用角色 `char_lead`，但项目没有该角色的当前 CHARACTER 资产版本
- **WHEN** 用户进入首帧工作区
- **THEN** 界面 SHALL 显示角色名称、缺失状态和上传入口
- **THEN** 生成按钮 SHALL 保持可见但禁用，并解释一致性前置条件

#### Scenario: 批量预检汇总缺失项

- **GIVEN** 多个目标镜头重复引用同一缺失角色且项目缺少 STYLE 资产
- **WHEN** 用户准备整集批量生成
- **THEN** 界面 SHALL 只显示一条该角色缺失项和一条画风缺失项
- **THEN** 修复前系统 MUST NOT 创建部分批次
