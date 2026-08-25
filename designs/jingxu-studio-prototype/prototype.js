(() => {
  // designs/jingxu-studio-prototype/data.jsx
  var globalAreas = [
    { id: "home", label: "首页", mark: "首" },
    { id: "projects", label: "我的项目", mark: "项" },
    { id: "workspace", label: "创作工作台", mark: "创" },
    { id: "assets", label: "素材库", mark: "素" },
    { id: "tasks", label: "生成任务", mark: "任" },
    { id: "exports", label: "导出记录", mark: "出" },
    { id: "evaluation", label: "质量与评测", mark: "质" },
    { id: "settings", label: "设置", mark: "设" }
  ];
  var productionStages = [
    { id: "input", index: "01", label: "创作输入", status: "done" },
    { id: "script", index: "02", label: "剧本开发", status: "done" },
    { id: "storyboard", index: "03", label: "分镜设计", status: "active" },
    { id: "image", index: "04", label: "画面生成", status: "attention" },
    { id: "video", index: "05", label: "视频生成", status: "active" },
    { id: "composition", index: "06", label: "合成导出", status: "blocked" }
  ];
  var scriptSteps = [
    { id: "concept", label: "故事概念", status: "done" },
    { id: "bible", label: "故事圣经", status: "done" },
    { id: "outline", label: "单集大纲", status: "done" },
    { id: "beats", label: "节拍表", status: "done" },
    { id: "scene", label: "场景剧本", status: "draft" }
  ];
  var shots = [
    { id: 1, title: "清晨的余额提醒", duration: 5, state: "ready", frame: "晨光 / 手机特写", dialogue: "余额到账：8,888,888 元。", camera: "缓慢推近", color: "violet" },
    { id: 2, title: "餐桌上的试探", duration: 7, state: "ready", frame: "餐厅 / 双人中景", dialogue: "今天，也要装作什么都没发生。", camera: "固定镜头", color: "amber" },
    { id: 3, title: "电梯里的陌生人", duration: 6, state: "running", frame: "电梯 / 近景", dialogue: "你每天都在同一时间出门。", camera: "轻微手持", color: "cyan" },
    { id: 4, title: "被跟踪的证据", duration: 8, state: "warning", frame: "地下车库 / 远景", dialogue: "那辆黑车，又出现了。", camera: "横移跟随", color: "rose" },
    { id: 5, title: "办公室的交易", duration: 10, state: "empty", frame: "办公室 / 过肩镜头", dialogue: "钱可以买到安静，但买不到忠诚。", camera: "缓慢环绕", color: "blue" },
    { id: 6, title: "午夜账户冻结", duration: 9, state: "empty", frame: "公寓 / 全景", dialogue: "账户已冻结。", camera: "快速推近", color: "indigo" }
  ];
  var candidateSets = {
    image: [
      { id: "A", label: "构图 A", note: "角色表情准确", selected: true, score: "推荐", color: "violet" },
      { id: "B", label: "构图 B", note: "环境信息更完整", selected: false, score: "备选", color: "cyan" },
      { id: "C", label: "构图 C", note: "光影更戏剧化", selected: false, score: "备选", color: "amber" }
    ],
    video: [
      { id: "V1", label: "视频段 V1", note: "动作自然 · 5.0 秒", selected: true, score: "当前选用", color: "violet" },
      { id: "V2", label: "视频段 V2", note: "运镜更明显 · 5.0 秒", selected: false, score: "备选", color: "blue" }
    ]
  };
  var statusCopy = {
    active: "进行中",
    attention: "需要处理",
    blocked: "前置条件未满足",
    done: "已完成",
    draft: "草稿",
    empty: "未生成",
    ready: "已确认",
    running: "生成中",
    warning: "建议检查"
  };
  Object.assign(window, {
    globalAreas,
    productionStages,
    scriptSteps,
    shots,
    candidateSets,
    statusCopy
  });

  // designs/jingxu-studio-prototype/components.jsx
  var { statusCopy: statusCopy2 } = window;
  function StatusPill({ status, children }) {
    return /* @__PURE__ */ React.createElement("span", { className: `status status-${status}` }, /* @__PURE__ */ React.createElement("span", { className: "status-symbol", "aria-hidden": "true" }), children || statusCopy2[status] || "状态待确认");
  }
  function GlobalSidebar({ activeArea, onNavigate }) {
    return /* @__PURE__ */ React.createElement("aside", { className: "global-sidebar" }, /* @__PURE__ */ React.createElement("div", { className: "brand" }, /* @__PURE__ */ React.createElement("span", { className: "brand-mark" }, "镜"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "镜序 Studio"), /* @__PURE__ */ React.createElement("small", null, "AI 漫剧工作台"))), /* @__PURE__ */ React.createElement("nav", { className: "global-nav", "aria-label": "全局导航" }, window.globalAreas.map((item) => /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        key: item.id,
        className: activeArea === item.id ? "nav-item active" : "nav-item",
        "aria-current": activeArea === item.id ? "page" : void 0,
        onClick: () => onNavigate(item.id)
      },
      /* @__PURE__ */ React.createElement("span", { className: "nav-mark" }, item.mark),
      /* @__PURE__ */ React.createElement("span", null, item.label)
    ))), /* @__PURE__ */ React.createElement("div", { className: "project-context" }, /* @__PURE__ */ React.createElement("small", null, "当前项目"), /* @__PURE__ */ React.createElement("strong", null, "大富翁的每一天"), /* @__PURE__ */ React.createElement("span", null, "第 1 集 · 竖屏 9:16")));
  }
  function ProjectFlow({ stage, onStage, scriptStep, onScriptStep, selectedShot, onShot }) {
    const showShots = ["storyboard", "image", "video"].includes(stage);
    return /* @__PURE__ */ React.createElement("aside", { className: "flow-panel", "aria-label": "项目创作流程" }, /* @__PURE__ */ React.createElement("header", { className: "flow-header" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "back-button" }, "返回项目"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("small", null, "当前作品"), /* @__PURE__ */ React.createElement("h2", null, "大富翁的每一天")), /* @__PURE__ */ React.createElement("div", { className: "episode-row" }, /* @__PURE__ */ React.createElement("span", null, "第 1 集"), /* @__PURE__ */ React.createElement(StatusPill, { status: "active" }, "制作中"))), /* @__PURE__ */ React.createElement("nav", { className: "stage-list", "aria-label": "六阶段创作流程" }, window.productionStages.map((item) => /* @__PURE__ */ React.createElement(React.Fragment, { key: item.id }, /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        className: stage === item.id ? "stage-item active" : "stage-item",
        onClick: () => onStage(item.id)
      },
      /* @__PURE__ */ React.createElement("span", { className: "stage-number" }, item.index),
      /* @__PURE__ */ React.createElement("span", { className: "stage-main" }, /* @__PURE__ */ React.createElement("strong", null, item.label), /* @__PURE__ */ React.createElement("small", null, statusCopy2[item.status])),
      /* @__PURE__ */ React.createElement("span", { className: `stage-indicator indicator-${item.status}`, "aria-hidden": "true" })
    ), item.id === "script" && stage === "script" && /* @__PURE__ */ React.createElement("div", { className: "script-step-list" }, window.scriptSteps.map((step) => /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        key: step.id,
        className: scriptStep === step.id ? "script-step active" : "script-step",
        onClick: () => onScriptStep(step.id)
      },
      /* @__PURE__ */ React.createElement("span", null, step.label),
      /* @__PURE__ */ React.createElement("small", null, statusCopy2[step.status])
    )))))), showShots && /* @__PURE__ */ React.createElement("section", { className: "shot-list-section" }, /* @__PURE__ */ React.createElement("div", { className: "section-label-row" }, /* @__PURE__ */ React.createElement("span", null, "镜头列表"), /* @__PURE__ */ React.createElement("small", null, "6 个 · 45 秒")), /* @__PURE__ */ React.createElement("div", { className: "shot-list" }, window.shots.map((shot) => /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        key: shot.id,
        className: selectedShot === shot.id ? "shot-row active" : "shot-row",
        onClick: () => onShot(shot.id)
      },
      /* @__PURE__ */ React.createElement("span", { className: `shot-thumb thumb-${shot.color}` }, /* @__PURE__ */ React.createElement("b", null, String(shot.id).padStart(2, "0"))),
      /* @__PURE__ */ React.createElement("span", { className: "shot-row-copy" }, /* @__PURE__ */ React.createElement("strong", null, shot.title), /* @__PURE__ */ React.createElement("small", null, shot.duration, " 秒 · ", statusCopy2[shot.state])),
      /* @__PURE__ */ React.createElement("span", { className: `shot-state state-${shot.state}`, "aria-label": statusCopy2[shot.state] })
    )))));
  }
  function Topbar({ stageLabel, density, setDensity, inspectorOpen, setInspectorOpen, setGuideOpen }) {
    return /* @__PURE__ */ React.createElement("header", { className: "topbar" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "breadcrumbs" }, /* @__PURE__ */ React.createElement("span", null, "创作工作台"), /* @__PURE__ */ React.createElement("i", null), /* @__PURE__ */ React.createElement("strong", null, stageLabel)), /* @__PURE__ */ React.createElement("p", null, "项目进度自动保存 · 最近保存于刚刚")), /* @__PURE__ */ React.createElement("div", { className: "top-actions" }, /* @__PURE__ */ React.createElement("div", { className: "density-switch", "aria-label": "布局密度" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: density === "compact" ? "active" : "", onClick: () => setDensity("compact") }, "紧凑"), /* @__PURE__ */ React.createElement("button", { type: "button", className: density === "comfortable" ? "active" : "", onClick: () => setDensity("comfortable") }, "舒展")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary small", onClick: () => setGuideOpen(true) }, "原型说明"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "inspector-toggle secondary small", onClick: () => setInspectorOpen(!inspectorOpen) }, "检查器")));
  }
  function Inspector({ stage, tab, setTab, shot, exportState, onClose }) {
    return /* @__PURE__ */ React.createElement("aside", { className: "inspector-panel", "aria-label": "上下文检查器" }, /* @__PURE__ */ React.createElement("header", { className: "inspector-header" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("small", null, "上下文检查器"), /* @__PURE__ */ React.createElement("h2", null, stage === "composition" ? "导出设置" : shot ? `镜头 ${String(shot.id).padStart(2, "0")}` : "当前步骤")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "close-inspector", onClick: onClose, "aria-label": "关闭检查器" }, "×")), /* @__PURE__ */ React.createElement("div", { className: "inspector-tabs", role: "tablist" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: tab === "common" ? "active" : "", onClick: () => setTab("common") }, "常用"), /* @__PURE__ */ React.createElement("button", { type: "button", className: tab === "history" ? "active" : "", onClick: () => setTab("history") }, "版本与锁"), /* @__PURE__ */ React.createElement("button", { type: "button", className: tab === "task" ? "active" : "", onClick: () => setTab("task") }, "任务")), tab === "common" && /* @__PURE__ */ React.createElement("div", { className: "inspector-body" }, stage === "composition" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(InspectorSection, { title: "背景音乐" }, /* @__PURE__ */ React.createElement("div", { className: "asset-line" }, /* @__PURE__ */ React.createElement("span", { className: "asset-icon" }, "音"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "城市夜行曲.m4a"), /* @__PURE__ */ React.createElement("small", null, "02:14 · 音量 18%")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "text-action" }, "更换"))), /* @__PURE__ */ React.createElement(InspectorSection, { title: "输出规格" }, /* @__PURE__ */ React.createElement(Definition, { label: "画面", value: "1080 × 1920" }), /* @__PURE__ */ React.createElement(Definition, { label: "帧率", value: "24 FPS" }), /* @__PURE__ */ React.createElement(Definition, { label: "格式", value: "MP4 · H.264" })), /* @__PURE__ */ React.createElement(InspectorSection, { title: "导出检查" }, /* @__PURE__ */ React.createElement(CheckRow, { label: "6 个镜头视频可用", ok: true }), /* @__PURE__ */ React.createElement(CheckRow, { label: "时间线裁剪合法", ok: true }), /* @__PURE__ */ React.createElement(CheckRow, { label: "镜头 04 候选已过期", warn: true }), /* @__PURE__ */ React.createElement("p", { className: "inspector-note" }, "修复阻塞项后才能导出，不会跳过坏镜头。")), exportState !== "idle" && /* @__PURE__ */ React.createElement(InspectorSection, { title: "当前任务" }, /* @__PURE__ */ React.createElement(StatusPill, { status: exportState === "success" ? "done" : "running" }, exportState === "success" ? "导出完成" : "正在合成"))) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(InspectorSection, { title: "当前对象" }, /* @__PURE__ */ React.createElement(Definition, { label: "镜头规格", value: shot ? `${shot.frame}` : "第 1 集" }), /* @__PURE__ */ React.createElement(Definition, { label: "目标时长", value: shot ? `${shot.duration} 秒` : "90 秒" }), /* @__PURE__ */ React.createElement(Definition, { label: "画面比例", value: "9:16" })), /* @__PURE__ */ React.createElement(InspectorSection, { title: "模型服务" }, /* @__PURE__ */ React.createElement(CheckRow, { label: "文本模型", ok: true, value: "已配置" }), /* @__PURE__ */ React.createElement(CheckRow, { label: "图片模型", ok: true, value: "已配置" }), /* @__PURE__ */ React.createElement(CheckRow, { label: "视频模型", ok: true, value: "已配置" }), /* @__PURE__ */ React.createElement("button", { type: "button", className: "text-action full" }, "前往模型服务设置")), /* @__PURE__ */ React.createElement(InspectorSection, { title: "引用素材" }, /* @__PURE__ */ React.createElement("div", { className: "reference-chip" }, /* @__PURE__ */ React.createElement("span", { className: "avatar" }, "林"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "林知夏"), /* @__PURE__ */ React.createElement("small", null, "角色外观已锁定"))), /* @__PURE__ */ React.createElement("div", { className: "reference-chip" }, /* @__PURE__ */ React.createElement("span", { className: "avatar scene" }, "景"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "顶层公寓"), /* @__PURE__ */ React.createElement("small", null, "场景参考 v2")))))), tab === "history" && /* @__PURE__ */ React.createElement("div", { className: "inspector-body" }, /* @__PURE__ */ React.createElement(InspectorSection, { title: "当前版本" }, /* @__PURE__ */ React.createElement(Definition, { label: "版本", value: "v6 · 已确认" }), /* @__PURE__ */ React.createElement(Definition, { label: "父版本", value: "v5" }), /* @__PURE__ */ React.createElement(Definition, { label: "保存时间", value: "18:24" })), /* @__PURE__ */ React.createElement(InspectorSection, { title: "锁定字段" }, /* @__PURE__ */ React.createElement("div", { className: "lock-row" }, /* @__PURE__ */ React.createElement("span", null, "角色外观"), /* @__PURE__ */ React.createElement(StatusPill, { status: "done" }, "已锁定")), /* @__PURE__ */ React.createElement("div", { className: "lock-row" }, /* @__PURE__ */ React.createElement("span", null, "关键剧情"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "text-action" }, "锁定"))), /* @__PURE__ */ React.createElement("details", { className: "advanced" }, /* @__PURE__ */ React.createElement("summary", null, "高级信息"), /* @__PURE__ */ React.createElement("code", null, "/content/character_appearance"), /* @__PURE__ */ React.createElement("code", null, "输入哈希 · 7ca1…8b2f"), /* @__PURE__ */ React.createElement("code", null, "版本 ID · shotver_0006"))), tab === "task" && /* @__PURE__ */ React.createElement("div", { className: "inspector-body" }, /* @__PURE__ */ React.createElement(InspectorSection, { title: "最近任务" }, /* @__PURE__ */ React.createElement("div", { className: "task-row" }, /* @__PURE__ */ React.createElement("span", { className: "task-icon success" }, "✓"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "视频候选生成"), /* @__PURE__ */ React.createElement("small", null, "已完成 · 42 秒"))), /* @__PURE__ */ React.createElement("div", { className: "task-row" }, /* @__PURE__ */ React.createElement("span", { className: "task-icon success" }, "✓"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "首帧候选生成"), /* @__PURE__ */ React.createElement("small", null, "已完成 · 18 秒")))), /* @__PURE__ */ React.createElement("details", { className: "advanced" }, /* @__PURE__ */ React.createElement("summary", null, "查看任务证据"), /* @__PURE__ */ React.createElement("code", null, "请求 · req_8a12…"), /* @__PURE__ */ React.createElement("code", null, "任务 · job_0042"), /* @__PURE__ */ React.createElement("code", null, "调用记录 · 2 条"))));
  }
  function InspectorSection({ title, children }) {
    return /* @__PURE__ */ React.createElement("section", { className: "inspector-section" }, /* @__PURE__ */ React.createElement("h3", null, title), children);
  }
  function Definition({ label, value }) {
    return /* @__PURE__ */ React.createElement("div", { className: "definition" }, /* @__PURE__ */ React.createElement("span", null, label), /* @__PURE__ */ React.createElement("strong", null, value));
  }
  function CheckRow({ label, ok, warn, value }) {
    return /* @__PURE__ */ React.createElement("div", { className: `check-row ${warn ? "warn" : ok ? "ok" : ""}` }, /* @__PURE__ */ React.createElement("span", { className: "check-symbol" }, warn ? "!" : ok ? "✓" : "·"), /* @__PURE__ */ React.createElement("span", null, label), value && /* @__PURE__ */ React.createElement("strong", null, value));
  }
  function CandidateCard({ item, selected, onSelect, kind }) {
    return /* @__PURE__ */ React.createElement("article", { className: selected ? "candidate-card selected" : "candidate-card" }, /* @__PURE__ */ React.createElement("div", { className: `candidate-preview preview-${item.color} ${kind === "video" ? "video-preview" : ""}` }, /* @__PURE__ */ React.createElement("span", { className: "preview-kicker" }, kind === "video" ? "视频预览" : "画面候选"), /* @__PURE__ */ React.createElement("div", { className: "figure-placeholder" }, /* @__PURE__ */ React.createElement("span", null), /* @__PURE__ */ React.createElement("i", null)), kind === "video" && /* @__PURE__ */ React.createElement("button", { type: "button", className: "play-button", "aria-label": "播放视频" }, "▶"), selected && /* @__PURE__ */ React.createElement("span", { className: "selected-ribbon" }, "当前选用")), /* @__PURE__ */ React.createElement("div", { className: "candidate-copy" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, item.label), /* @__PURE__ */ React.createElement("small", null, item.note)), /* @__PURE__ */ React.createElement(StatusPill, { status: selected ? "done" : "active" }, item.score)), /* @__PURE__ */ React.createElement("div", { className: "candidate-actions" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "预览"), /* @__PURE__ */ React.createElement("button", { type: "button", className: selected ? "secondary selected-button" : "primary", onClick: onSelect }, selected ? "已选用" : "选用")));
  }
  Object.assign(window, {
    StatusPill,
    GlobalSidebar,
    ProjectFlow,
    Topbar,
    Inspector,
    CandidateCard,
    InspectorSection,
    Definition,
    CheckRow
  });

  // designs/jingxu-studio-prototype/app.jsx
  var {
    StatusPill: StatusPill2,
    GlobalSidebar: GlobalSidebar2,
    ProjectFlow: ProjectFlow2,
    Topbar: Topbar2,
    Inspector: Inspector2,
    CandidateCard: CandidateCard2,
    InspectorSection: InspectorSection2,
    Definition: Definition2,
    CheckRow: CheckRow2
  } = window;
  function InputStage({ onNext }) {
    const [mode, setMode] = React.useState("original");
    const [text, setText] = React.useState("一个隐瞒巨额财富的普通上班族，每天醒来都会收到一笔神秘转账，但每花一分钱，就会有人更接近他的真实身份。");
    const enough = text.trim().length >= 20;
    return /* @__PURE__ */ React.createElement("section", { className: "screen input-screen", "data-screen-label": "创作输入" }, /* @__PURE__ */ React.createElement(ScreenHeader, { eyebrow: "第 1 步 · 创作输入", title: "从一个故事种子开始", description: "选择原创创意或导入已有剧本。原文会保留，系统不会静默截断。", status: "done" }), /* @__PURE__ */ React.createElement("div", { className: "mode-tabs" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: mode === "original" ? "active" : "", onClick: () => setMode("original") }, "原创创意"), /* @__PURE__ */ React.createElement("button", { type: "button", className: mode === "import" ? "active" : "", onClick: () => setMode("import") }, "导入已有剧本")), mode === "original" ? /* @__PURE__ */ React.createElement("div", { className: "editor-card large-editor" }, /* @__PURE__ */ React.createElement("label", { htmlFor: "idea" }, "创意内容"), /* @__PURE__ */ React.createElement("textarea", { id: "idea", value: text, onChange: (event) => setText(event.target.value) }), /* @__PURE__ */ React.createElement("div", { className: "field-meta" }, /* @__PURE__ */ React.createElement("span", { className: enough ? "valid" : "invalid" }, text.length, "/2,000 个字符 · 最少 20 个"), /* @__PURE__ */ React.createElement("span", null, "支持中文、英文和标点"))) : /* @__PURE__ */ React.createElement("div", { className: "import-drop" }, /* @__PURE__ */ React.createElement("span", { className: "import-mark" }, "文"), /* @__PURE__ */ React.createElement("h3", null, "选择 TXT 或 Markdown 文件"), /* @__PURE__ */ React.createElement("p", null, "文件由系统对话框读取，不会向界面暴露本地路径。"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary" }, "选择文件"), /* @__PURE__ */ React.createElement("small", null, "最大 30,000 个 Unicode 字符")), /* @__PURE__ */ React.createElement("label", { className: "consent" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", defaultChecked: true }), /* @__PURE__ */ React.createElement("span", null, "我确认将以上内容发送给已配置的文本模型处理，并已阅读数据处理说明。")), /* @__PURE__ */ React.createElement(BottomAction, { hint: enough ? "内容有效，可以创建工作区。" : "还需输入至少 20 个字符。" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary wide", disabled: !enough, onClick: onNext }, "创建剧本工作区")));
  }
  function ScriptStage({ step, onStep, onNext }) {
    const stepIndex = window.scriptSteps.findIndex((item) => item.id === step);
    const current = window.scriptSteps[stepIndex];
    const next = window.scriptSteps[stepIndex + 1];
    return /* @__PURE__ */ React.createElement("section", { className: "screen script-screen", "data-screen-label": "剧本开发" }, /* @__PURE__ */ React.createElement(ScreenHeader, { eyebrow: `剧本开发 · ${stepIndex + 1}/5`, title: current.label, description: "内容可直接编辑。确认后会创建新版本，并解锁下一阶段。", status: current.status === "done" ? "done" : "draft" }), /* @__PURE__ */ React.createElement("div", { className: "script-document" }, /* @__PURE__ */ React.createElement("div", { className: "document-toolbar" }, /* @__PURE__ */ React.createElement("span", null, "结构化正文"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", { type: "button", className: "text-action" }, "对比版本"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "text-action" }, "恢复历史"))), step === "concept" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(DocumentBlock, { label: "一句话梗概", text: "一个靠神秘转账成为隐形富豪的上班族，在追查金钱来源时发现自己正被一套精密系统观察。" }), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "核心冲突", text: "他必须在维持普通生活与查明财富真相之间做出选择，而每次消费都会暴露新的身份线索。" })), step === "bible" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(DocumentBlock, { label: "世界规则", text: "每天 06:00，账户会自动增加 8,888,888 元；当天未消费的部分会在午夜冻结。任何消费都会触发一次现实中的‘回声事件’。" }), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "主角弧光", text: "林峥从隐藏财富、逃避关系，逐步学会承担选择的代价，并主动追踪系统背后的控制者。" }), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "关键角色", text: "林峥｜谨慎克制的隐形富豪；林知夏｜观察敏锐的妹妹；周沉｜身份不明的金融调查员。" })), step === "outline" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(DocumentBlock, { label: "本集目标", text: "建立神秘转账规则，暴露跟踪者，并在午夜冻结账户作为集尾钩子。" }), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "三段结构", text: "清晨到账与伪装日常 → 跟踪迹象升级 → 交易失败与账户冻结。" })), step === "beats" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(BeatRow, { index: "01", title: "余额提醒", time: "0–8 秒" }), /* @__PURE__ */ React.createElement(BeatRow, { index: "02", title: "早餐试探", time: "8–22 秒" }), /* @__PURE__ */ React.createElement(BeatRow, { index: "03", title: "跟踪升级", time: "22–48 秒" }), /* @__PURE__ */ React.createElement(BeatRow, { index: "04", title: "午夜冻结", time: "48–62 秒" })), step === "scene" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(DocumentBlock, { label: "场景 01 · 顶层公寓 · 清晨", text: "手机震动。林峥睁眼，屏幕上的余额数字映在他的瞳孔里。他没有惊讶，只熟练地关闭提醒。餐桌另一端，林知夏观察着他。" }), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "场景 02 · 电梯 · 早晨", text: "一个陌生男人站在角落，准确说出林峥每天出门的时间。电梯数字逐层下降，空气变得凝固。" }))), /* @__PURE__ */ React.createElement(BottomAction, { hint: next ? `确认后可继续：${next.label}` : "场景剧本确认后可以生成结构化分镜。" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "保存修改"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "重新生成"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary success-outline" }, "确认为可用"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary wide", onClick: () => {
      if (next) onStep(next.id);
      else onNext();
    } }, next ? `下一步：生成${next.label}` : "下一步：生成分镜")));
  }
  function StoryboardStage({ shot }) {
    return /* @__PURE__ */ React.createElement("section", { className: "screen storyboard-screen", "data-screen-label": "分镜设计" }, /* @__PURE__ */ React.createElement(ScreenHeader, { eyebrow: "第 3 步 · 分镜设计", title: `镜头 ${String(shot.id).padStart(2, "0")} · ${shot.title}`, description: "镜头列表、内容与检查器保持同一上下文。结构操作不会覆盖历史版本。", status: shot.state }), /* @__PURE__ */ React.createElement("div", { className: "shot-hero" }, /* @__PURE__ */ React.createElement("div", { className: `shot-preview-large preview-${shot.color}` }, /* @__PURE__ */ React.createElement("span", null, "画面构图预览"), /* @__PURE__ */ React.createElement("div", { className: "scene-geometry" }, /* @__PURE__ */ React.createElement("i", null), /* @__PURE__ */ React.createElement("b", null), /* @__PURE__ */ React.createElement("em", null)), /* @__PURE__ */ React.createElement("small", null, shot.frame)), /* @__PURE__ */ React.createElement("div", { className: "shot-fields" }, /* @__PURE__ */ React.createElement(DocumentBlock, { label: "画面描述", text: `清晨的冷色环境中，${shot.frame}。人物保持克制，背景光线形成轻微压迫感。` }), /* @__PURE__ */ React.createElement("div", { className: "two-column-fields" }, /* @__PURE__ */ React.createElement(DocumentBlock, { label: "运镜", text: shot.camera }), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "目标时长", text: `${shot.duration} 秒` })), /* @__PURE__ */ React.createElement(DocumentBlock, { label: "对白 / 旁白", text: shot.dialogue }))), /* @__PURE__ */ React.createElement("div", { className: "quality-row" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "quality-icon" }, "✓"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "连续性检查通过"), /* @__PURE__ */ React.createElement("small", null, "角色、场景和 previous_shot 引用有效"))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "quality-icon warn" }, "!"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "1 条建议检查"), /* @__PURE__ */ React.createElement("small", null, "正脸长对白接近 4 秒阈值")))), /* @__PURE__ */ React.createElement(BottomAction, { hint: "当前镜头已自动保存。整集确认后才能进入画面生成。" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "拆分镜头"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "复制镜头"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "保存修改"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary wide" }, "确认为可用")));
  }
  function MediaStage({ kind, shot, selectedCandidate, setSelectedCandidate, onNext }) {
    const isVideo = kind === "video";
    const candidates = window.candidateSets[kind];
    return /* @__PURE__ */ React.createElement("section", { className: "screen media-screen", "data-screen-label": isVideo ? "视频生成" : "画面生成" }, /* @__PURE__ */ React.createElement(ScreenHeader, { eyebrow: `第 ${isVideo ? "5" : "4"} 步 · ${isVideo ? "视频生成" : "画面生成"}`, title: `镜头 ${String(shot.id).padStart(2, "0")} · ${isVideo ? "视频候选" : "首帧候选"}`, description: `当前镜头已有 ${candidates.length} 个可用候选。预览、选用和重新生成使用一致操作。`, status: shot.state === "empty" ? "attention" : "done" }), /* @__PURE__ */ React.createElement("div", { className: "selected-summary" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "summary-mark" }, isVideo ? "视" : "图"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("small", null, "当前选用"), /* @__PURE__ */ React.createElement("strong", null, candidates.find((item) => item.id === selectedCandidate)?.label || "尚未选择"))), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "重新生成")), /* @__PURE__ */ React.createElement("div", { className: "candidate-grid" }, candidates.map((item) => /* @__PURE__ */ React.createElement(CandidateCard2, { key: item.id, item, kind, selected: item.id === selectedCandidate, onSelect: () => setSelectedCandidate(item.id) })), /* @__PURE__ */ React.createElement("article", { className: "candidate-generating" }, /* @__PURE__ */ React.createElement("div", { className: "loading-orbit" }, /* @__PURE__ */ React.createElement("span", null)), /* @__PURE__ */ React.createElement("strong", null, "生成新候选"), /* @__PURE__ */ React.createElement("small", null, "预计需要 30–60 秒"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "开始生成"))), /* @__PURE__ */ React.createElement("details", { className: "failed-task" }, /* @__PURE__ */ React.createElement("summary", null, "查看一次历史失败任务"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "failure-mark" }, "!"), /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "视频模型响应超时"), /* @__PURE__ */ React.createElement("small", null, "原候选和输入已保留，可以直接重试。")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "重试"))), /* @__PURE__ */ React.createElement(BottomAction, { hint: isVideo ? "当前镜头已有选用视频；全部镜头完成后可以进入合成。" : "选用首帧后才能生成当前镜头的视频候选。" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "批量生成剩余镜头"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary wide", onClick: onNext }, isVideo ? "下一步：合成导出" : "下一步：生成视频")));
  }
  function CompositionStage({ timeline, setTimeline, exportState, setExportState }) {
    const [progress, setProgress] = React.useState(0);
    React.useEffect(() => {
      if (exportState !== "running") return void 0;
      const timer = window.setInterval(() => setProgress((value) => Math.min(100, value + 8)), 220);
      return () => window.clearInterval(timer);
    }, [exportState]);
    React.useEffect(() => {
      if (progress >= 100 && exportState === "running") setExportState("success");
    }, [progress, exportState, setExportState]);
    const move = (index, direction) => {
      const next = [...timeline];
      const target = index + direction;
      if (target < 0 || target >= next.length) return;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      setTimeline(next);
    };
    const toggle = (index) => setTimeline(timeline.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: !item.enabled } : item));
    return /* @__PURE__ */ React.createElement("section", { className: "screen composition-screen", "data-screen-label": "合成导出" }, /* @__PURE__ */ React.createElement(ScreenHeader, { eyebrow: "第 6 步 · 合成导出", title: "整集预览与时间线", description: "排序、启停和裁剪都创建新的时间线版本。导出前会再次检查所有媒体输入。", status: exportState === "success" ? "done" : "attention" }), /* @__PURE__ */ React.createElement("div", { className: "episode-preview" }, /* @__PURE__ */ React.createElement("div", { className: "preview-stage" }, /* @__PURE__ */ React.createElement("div", { className: "video-frame" }, /* @__PURE__ */ React.createElement("span", null, "整集预览"), /* @__PURE__ */ React.createElement("div", { className: "scene-geometry" }, /* @__PURE__ */ React.createElement("i", null), /* @__PURE__ */ React.createElement("b", null), /* @__PURE__ */ React.createElement("em", null)), /* @__PURE__ */ React.createElement("button", { type: "button", className: "play-large" }, "▶"))), /* @__PURE__ */ React.createElement("div", { className: "preview-meta" }, /* @__PURE__ */ React.createElement("strong", null, "大富翁的每一天 · 第 1 集"), /* @__PURE__ */ React.createElement("span", null, "00:45 / 01:02"))), /* @__PURE__ */ React.createElement("div", { className: "timeline-heading" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", null, "镜头时间线"), /* @__PURE__ */ React.createElement("p", null, "6 个片段 · 当前总时长 45 秒")), /* @__PURE__ */ React.createElement(StatusPill2, { status: "warning" }, "1 项需要处理")), /* @__PURE__ */ React.createElement("div", { className: "timeline-list" }, timeline.map((item, index) => /* @__PURE__ */ React.createElement("div", { className: !item.enabled ? "timeline-item disabled" : "timeline-item", key: item.id }, /* @__PURE__ */ React.createElement("span", { className: "drag-handle" }, "⋮⋮"), /* @__PURE__ */ React.createElement("div", { className: `timeline-thumb thumb-${item.color}` }, /* @__PURE__ */ React.createElement("b", null, String(item.id).padStart(2, "0"))), /* @__PURE__ */ React.createElement("div", { className: "timeline-copy" }, /* @__PURE__ */ React.createElement("strong", null, item.title), /* @__PURE__ */ React.createElement("small", null, item.duration, " 秒 · ", item.enabled ? "已启用" : "已跳过")), /* @__PURE__ */ React.createElement("label", { className: "mini-toggle" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: item.enabled, onChange: () => toggle(index) }), /* @__PURE__ */ React.createElement("span", null)), /* @__PURE__ */ React.createElement("div", { className: "trim-fields" }, /* @__PURE__ */ React.createElement("label", null, "入点", /* @__PURE__ */ React.createElement("input", { type: "text", defaultValue: "00:00.0" })), /* @__PURE__ */ React.createElement("label", null, "出点", /* @__PURE__ */ React.createElement("input", { type: "text", defaultValue: `00:0${Math.min(9, item.duration)}.0` }))), /* @__PURE__ */ React.createElement("div", { className: "order-actions" }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => move(index, -1), disabled: index === 0 }, "↑"), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => move(index, 1), disabled: index === timeline.length - 1 }, "↓"))))), exportState !== "idle" && /* @__PURE__ */ React.createElement("div", { className: `export-progress ${exportState}` }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, exportState === "success" ? "MP4 导出完成" : "正在合成视频"), /* @__PURE__ */ React.createElement("span", null, exportState === "success" ? "文件已通过时长、分辨率和解码校验" : `${progress}% · 正在混合原声与背景音乐`)), /* @__PURE__ */ React.createElement("div", { className: "progress-track" }, /* @__PURE__ */ React.createElement("span", { style: { width: `${exportState === "success" ? 100 : progress}%` } })), exportState === "success" && /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "预览成片")), /* @__PURE__ */ React.createElement(BottomAction, { hint: "镜头 04 的旧候选已过期；原型允许演示导出反馈，正式产品会阻断并要求修复。" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary" }, "保存时间线"), exportState === "running" ? /* @__PURE__ */ React.createElement("button", { type: "button", className: "danger wide", onClick: () => {
      setExportState("idle");
      setProgress(0);
    } }, "取消导出") : /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary wide", onClick: () => {
      setProgress(4);
      setExportState("running");
    } }, "导出 MP4")));
  }
  function ScreenHeader({ eyebrow, title, description, status }) {
    return /* @__PURE__ */ React.createElement("header", { className: "screen-header" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "eyebrow" }, eyebrow), /* @__PURE__ */ React.createElement("h1", null, title), /* @__PURE__ */ React.createElement("p", null, description)), /* @__PURE__ */ React.createElement(StatusPill2, { status }));
  }
  function DocumentBlock({ label, text }) {
    return /* @__PURE__ */ React.createElement("div", { className: "document-block" }, /* @__PURE__ */ React.createElement("label", null, label), /* @__PURE__ */ React.createElement("div", { contentEditable: true, suppressContentEditableWarning: true }, text));
  }
  function BeatRow({ index, title, time }) {
    return /* @__PURE__ */ React.createElement("div", { className: "beat-row" }, /* @__PURE__ */ React.createElement("span", null, index), /* @__PURE__ */ React.createElement("strong", null, title), /* @__PURE__ */ React.createElement("small", null, time), /* @__PURE__ */ React.createElement("button", { type: "button", className: "text-action" }, "编辑"));
  }
  function BottomAction({ hint, children }) {
    return /* @__PURE__ */ React.createElement("footer", { className: "bottom-action" }, /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("span", { className: "hint-dot" }), hint), /* @__PURE__ */ React.createElement("div", null, children));
  }
  function GuideDialog({ onClose }) {
    return /* @__PURE__ */ React.createElement("div", { className: "dialog-backdrop", role: "presentation", onMouseDown: onClose }, /* @__PURE__ */ React.createElement("section", { className: "guide-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "guide-title", onMouseDown: (event) => event.stopPropagation() }, /* @__PURE__ */ React.createElement("header", null, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("small", null, "原型评审说明"), /* @__PURE__ */ React.createElement("h2", { id: "guide-title" }, "建议按创作流程体验")), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: onClose, "aria-label": "关闭" }, "×")), /* @__PURE__ */ React.createElement("ol", null, /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("strong", null, "切换六个阶段"), /* @__PURE__ */ React.createElement("span", null, "观察当前位置、状态和主要操作是否清楚。")), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("strong", null, "选择不同镜头"), /* @__PURE__ */ React.createElement("span", null, "确认左侧对象、中间内容与右侧检查器同步变化。")), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("strong", null, "切换候选与时间线"), /* @__PURE__ */ React.createElement("span", null, "体验选用、排序、启停和导出进度。")), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("strong", null, "调整布局密度"), /* @__PURE__ */ React.createElement("span", null, "比较紧凑与舒展模式的信息效率。"))), /* @__PURE__ */ React.createElement("p", null, "本原型仅验证信息架构与交互，不调用真实模型或写入项目数据。"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "primary wide", onClick: onClose }, "开始体验")));
  }
  function SettingsArea() {
    return /* @__PURE__ */ React.createElement("section", { className: "standalone-screen", "data-screen-label": "设置" }, /* @__PURE__ */ React.createElement(ScreenHeader, { eyebrow: "设置", title: "模型服务", description: "凭据和模型配置集中管理，创作页面只显示脱敏状态。", status: "done" }), /* @__PURE__ */ React.createElement("div", { className: "settings-grid" }, /* @__PURE__ */ React.createElement(ModelCard, { name: "文本模型", provider: "Qwen", model: "qwen-plus" }), /* @__PURE__ */ React.createElement(ModelCard, { name: "图片模型", provider: "火山方舟 ARK", model: "Seedream 5.0 Lite" }), /* @__PURE__ */ React.createElement(ModelCard, { name: "视频模型", provider: "火山方舟 ARK", model: "Seedance 2.5" })));
  }
  function ModelCard({ name, provider, model }) {
    return /* @__PURE__ */ React.createElement("article", { className: "model-card" }, /* @__PURE__ */ React.createElement("div", { className: "model-card-head" }, /* @__PURE__ */ React.createElement("span", null, name.slice(0, 1)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("small", null, name), /* @__PURE__ */ React.createElement("h3", null, provider)), /* @__PURE__ */ React.createElement(StatusPill2, { status: "done" }, "已配置")), /* @__PURE__ */ React.createElement(Definition2, { label: "当前模型", value: model }), /* @__PURE__ */ React.createElement(Definition2, { label: "凭据", value: "已安全保存 · 末四位 9821" }), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary full-width" }, "管理配置"));
  }
  function PlaceholderArea({ area, onReturn }) {
    const item = window.globalAreas.find((entry) => entry.id === area);
    return /* @__PURE__ */ React.createElement("section", { className: "standalone-screen placeholder-area", "data-screen-label": item.label }, /* @__PURE__ */ React.createElement("span", { className: "placeholder-mark" }, item.mark), /* @__PURE__ */ React.createElement("h1", null, item.label), /* @__PURE__ */ React.createElement("p", null, "该区域在正式产品中使用真实数据。原型重点验证六阶段创作工作台，不伪造额外业务记录。"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "secondary", onClick: onReturn }, "返回创作工作台"));
  }
  function App() {
    const [activeArea, setActiveArea] = React.useState("workspace");
    const [stage, setStage] = React.useState("storyboard");
    const [scriptStep, setScriptStep] = React.useState("scene");
    const [selectedShot, setSelectedShot] = React.useState(1);
    const [imageCandidate, setImageCandidate] = React.useState("A");
    const [videoCandidate, setVideoCandidate] = React.useState("V1");
    const [inspectorTab, setInspectorTab] = React.useState("common");
    const [inspectorOpen, setInspectorOpen] = React.useState(true);
    const [density, setDensity] = React.useState("compact");
    const [guideOpen, setGuideOpen] = React.useState(false);
    const [exportState, setExportState] = React.useState("idle");
    const [timeline, setTimeline] = React.useState(window.shots.map((shot2) => ({ ...shot2, enabled: true })));
    const shot = window.shots.find((item) => item.id === selectedShot) || window.shots[0];
    const stageLabel = window.productionStages.find((item) => item.id === stage)?.label || "创作工作台";
    const changeArea = (area) => {
      setActiveArea(area);
      if (area === "workspace") setInspectorOpen(true);
    };
    const nextStage = (id) => {
      setStage(id);
      setInspectorTab("common");
    };
    return /* @__PURE__ */ React.createElement("div", { className: `prototype-shell density-${density}` }, /* @__PURE__ */ React.createElement(GlobalSidebar2, { activeArea, onNavigate: changeArea }), activeArea === "workspace" ? /* @__PURE__ */ React.createElement("main", { className: "workspace-shell" }, /* @__PURE__ */ React.createElement(ProjectFlow2, { stage, onStage: nextStage, scriptStep, onScriptStep: setScriptStep, selectedShot, onShot: setSelectedShot }), /* @__PURE__ */ React.createElement("section", { className: "content-column" }, /* @__PURE__ */ React.createElement(Topbar2, { stageLabel, density, setDensity, inspectorOpen, setInspectorOpen, setGuideOpen }), /* @__PURE__ */ React.createElement("div", { className: "canvas-scroll", key: stage }, stage === "input" && /* @__PURE__ */ React.createElement(InputStage, { onNext: () => nextStage("script") }), stage === "script" && /* @__PURE__ */ React.createElement(ScriptStage, { step: scriptStep, onStep: setScriptStep, onNext: () => nextStage("storyboard") }), stage === "storyboard" && /* @__PURE__ */ React.createElement(StoryboardStage, { shot }), stage === "image" && /* @__PURE__ */ React.createElement(MediaStage, { kind: "image", shot, selectedCandidate: imageCandidate, setSelectedCandidate: setImageCandidate, onNext: () => nextStage("video") }), stage === "video" && /* @__PURE__ */ React.createElement(MediaStage, { kind: "video", shot, selectedCandidate: videoCandidate, setSelectedCandidate: setVideoCandidate, onNext: () => nextStage("composition") }), stage === "composition" && /* @__PURE__ */ React.createElement(CompositionStage, { timeline, setTimeline, exportState, setExportState }))), inspectorOpen && /* @__PURE__ */ React.createElement(Inspector2, { stage, tab: inspectorTab, setTab: setInspectorTab, shot, exportState, onClose: () => setInspectorOpen(false) })) : /* @__PURE__ */ React.createElement("main", { className: "area-shell" }, /* @__PURE__ */ React.createElement(Topbar2, { stageLabel: window.globalAreas.find((item) => item.id === activeArea)?.label || "", density, setDensity, inspectorOpen: false, setInspectorOpen: () => {
    }, setGuideOpen }), activeArea === "settings" ? /* @__PURE__ */ React.createElement(SettingsArea, null) : /* @__PURE__ */ React.createElement(PlaceholderArea, { area: activeArea, onReturn: () => changeArea("workspace") })), guideOpen && /* @__PURE__ */ React.createElement(GuideDialog, { onClose: () => setGuideOpen(false) }));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
})();
