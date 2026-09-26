(() => {
  const data = window.JINGXU_DATA;
  const app = document.getElementById("app");
  const state = {
    page: "home",
    workType: "短剧",
    projectFilter: "全部",
    search: "",
    stage: "storyboard",
    shot: 2,
    candidate: 1,
    scene: 1,
    moreOpen: false,
    drawer: null,
    modal: null,
    demoState: null,
    dirty: false,
    toast: "",
    generating: false,
    exportReady: false,
    evaluationShot: 2,
    serviceModal: null
  };

  const toneClass = (tone) => `tone-${tone || "amber"}`;
  const shotById = (id) => data.shots.find((shot) => shot.id === Number(id)) || data.shots[0];
  const escapeText = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);

  function header() {
    return `<header class="global-header">
      <button class="brand" data-go="home" aria-label="返回开始页">
        <span class="brand-mark">镜</span>
        <span class="brand-copy"><strong>镜序</strong><small>AI漫剧 / 短剧创作平台</small></span>
      </button>
      <nav class="header-actions" aria-label="全局导航">
        <button class="header-link" data-go="projects">我的作品</button>
        <button class="header-link" data-go="evaluation">质量评测</button>
        <button class="header-link" data-go="settings">设置</button>
      </nav>
    </header>`;
  }

  function stageBar() {
    const activeIndex = data.stages.findIndex((item) => item.id === state.stage);
    return `<div class="workspace-bar">
      <div class="project-name"><button data-go="projects">返回作品</button><strong>《午后列车》</strong><span class="tag">${state.workType}</span></div>
      <nav class="stage-progress" aria-label="六步创作流程">
        ${data.stages.map((stage, index) => `<button class="stage-button ${stage.id === state.stage ? "active" : index < activeIndex ? "done" : ""}" data-stage="${stage.id}"><span class="stage-number">${stage.number}</span><span>${stage.label}</span></button>`).join("")}
      </nav>
      <div class="more-wrap"><button class="more-button" data-action="toggle-more">更多</button>${state.moreOpen ? `<div class="more-menu"><button data-drawer="history">版本与锁定</button><button data-drawer="tasks">生成任务</button><button data-drawer="states">状态演示</button></div>` : ""}</div>
    </div>`;
  }

  function visual(tone, className = "") {
    return `<div class="${className} ${toneClass(tone)}" aria-hidden="true"></div>`;
  }

  function homePage() {
    return `<main class="hero-home" data-screen-label="01 开始创作">
      <section class="hero-inner">
        <div class="hero-title"><p class="eyebrow">镜序创作工作台</p><h1>把一个想法，变成一部<span>好故事</span></h1><p>选择作品形式，我们会用对应的节奏、画面与质量检查陪你完成创作。</p></div>
        <div class="type-choice">
          <button class="type-card ${state.workType === "漫剧" ? "selected" : ""}" data-type="漫剧"><span class="radio-mark"></span><strong>AI漫剧</strong><p>用连续画面、角色对白和镜头节奏，呈现富有想象力的故事。</p></button>
          <button class="type-card ${state.workType === "短剧" ? "selected" : ""}" data-type="短剧"><span class="radio-mark"></span><strong>AI短剧</strong><p>以真人表演逻辑和镜头连续性，快速完成一集短剧。</p></button>
        </div>
        <div class="home-actions"><button class="primary wide" data-action="start">开始创作</button><button class="secondary wide" data-action="import">导入已有故事</button></div>
        <article class="continue-panel">${visual("amber", "media-thumb")}<div><p class="eyebrow">继续创作</p><h2>《午后列车》 <span class="tag">短剧</span></h2><p>当前任务：完善故事梗概</p><small class="muted">预计约 3 分钟</small></div><button class="primary wide" data-stage="story">继续</button></article>
        <div class="route-line"><div class="route-step active"><span class="route-num">1</span><strong>写故事</strong><small class="muted">从想法到完整剧本</small></div><div class="route-step"><span class="route-num">2</span><strong>做分镜</strong><small class="muted">把故事变成镜头</small></div><div class="route-step"><span class="route-num">3</span><strong>出成片</strong><small class="muted">生成、合成并导出</small></div></div>
      </section>
    </main>`;
  }

  function projectsPage() {
    const filtered = data.projects.filter((project) => (state.projectFilter === "全部" || project.type === state.projectFilter) && project.title.includes(state.search));
    return `${header()}<main class="page" data-screen-label="02 我的作品"><section class="page-shell">
      <header class="page-heading"><div><p class="eyebrow">作品管理</p><h1>我的作品</h1><p>在这里继续你的漫剧与短剧创作。</p></div><button class="primary wide" data-go="home">新建作品</button></header>
      <div class="toolbar"><div class="segment" aria-label="作品类型筛选">${["全部","漫剧","短剧"].map((item) => `<button class="${state.projectFilter === item ? "active" : ""}" data-filter="${item}">${item}</button>`).join("")}</div><input class="search" type="search" placeholder="搜索作品名称" value="${escapeText(state.search)}" data-search /></div>
      <div class="project-list"><div class="project-head"><span>作品</span><span>类型</span><span>当前阶段</span><span>完成进度</span><span>最近编辑时间</span><span>操作</span></div>
      ${filtered.length ? filtered.map((project) => `<article class="project-row"><div class="project-main">${visual(project.tone,"project-cover")}<div><strong>《${project.title}》</strong><small>${project.type === "短剧" ? "真人风格 · 都市情感" : "动画风格 · 青春幻想"}</small></div></div><span class="tag ${project.type === "漫剧" ? "blue" : ""}">${project.type}</span><strong>${project.stage}</strong><div><strong>${project.progress}%</strong><div class="progress"><span style="width:${project.progress}%"></span></div></div><span>${project.edited}</span><div class="inline-actions"><button class="primary" data-continue="${project.stage}">继续创作</button><button class="secondary" data-drawer="project">更多</button></div></article>`).join("") : `<div class="empty"><h2>没有找到作品</h2><p>试试其他名称或切换作品类型。</p></div>`}
      </div></section></main>`;
  }

  function workspaceShell(content, title, description, actions = true) {
    return `${header()}<main class="workspace-page" data-screen-label="${title}">${stageBar()}<div class="workspace-content"><div class="workspace-title"><div><p class="eyebrow">${state.workType}项目 · 第 ${data.stages.find((item) => item.id === state.stage)?.number || 1} 步</p><h1>${title}</h1><p>${description}</p></div>${["storyboard","image","video"].includes(state.stage) ? `<span class="mode-notice">短剧模式：优先检查真人表演与镜头连续性</span>` : ""}</div>${content}</div>${actions ? `<footer class="bottom-bar"><button class="secondary" data-action="save">暂存</button><button class="primary wide" data-action="next">保存并继续</button></footer>` : ""}</main>`;
  }

  function storyPage() {
    const content = `<div class="form-layout"><div class="form-fields">
      <div class="field"><label>作品类型</label><div class="segment"><button class="${state.workType === "漫剧" ? "active" : ""}" data-type="漫剧">漫剧</button><button class="${state.workType === "短剧" ? "active" : ""}" data-type="短剧">短剧</button></div></div>
      <div class="field"><label for="title">作品名</label><div><input id="title" value="午后列车" data-edit /><span class="count">4 / 50</span></div></div>
      <div class="field"><label for="genre">故事类型</label><select id="genre" data-edit><option>都市情感</option><option>悬疑</option><option>轻喜剧</option><option>青春成长</option></select></div>
      <div class="field"><label for="conflict">核心冲突</label><textarea id="conflict" data-edit>一位在城市中迷失方向的女孩，必须在事业与内心真正想要的生活之间做出选择。</textarea></div>
      <div class="field"><label for="summary">故事梗概</label><textarea id="summary" data-edit>林夏意外登上一趟慢车，在旅途中遇见沉默的摄影师陈默。两个人从互相防备到彼此理解，最终都找回重新开始的勇气。</textarea></div>
      <div class="field"><label for="audience">目标观众</label><textarea id="audience" data-edit>喜欢都市题材、治愈氛围和人物成长故事的年轻观众。</textarea></div>
    </div><aside class="tip-panel"><h2>本步提示</h2><ol class="tip-list"><li><span class="tip-index">1</span><div><strong>明确主题</strong><span>用一句话说明你最想表达的核心。</span></div></li><li><span class="tip-index">2</span><div><strong>突出冲突</strong><span>让主角面对一个必须解决的困难。</span></div></li><li><span class="tip-index">3</span><div><strong>控制长度</strong><span>先说清起因、变化和结局。</span></div></li><li><span class="tip-index">4</span><div><strong>了解观众</strong><span>明确希望谁会喜欢这个故事。</span></div></li></ol></aside></div>`;
    return workspaceShell(content, "创作故事梗概", `当前选择“${state.workType}”，后续会按对应节奏生成剧本与镜头。`);
  }

  function scriptPage() {
    const sceneText = state.scene === 1 ? data.sceneText.one : data.sceneText.two;
    const content = `<div class="toolbar"><div class="toolbar-left"><span class="tag">短剧</span><span>共 2 个场景 · 约 3 分钟</span></div><div class="meta-row"><span>人物设定 ✓</span><span>分集大纲 ✓</span><span>剧情节拍 ✓</span><strong>场景剧本 4</strong></div></div>
      <div class="script-layout"><aside class="scene-list"><h3>场景目录</h3><button class="scene-item ${state.scene === 1 ? "active" : ""}" data-scene="1"><strong>场景一 · 车站月台</strong><small>约 1 分钟</small></button><button class="scene-item ${state.scene === 2 ? "active" : ""}" data-scene="2"><strong>场景二 · 列车车厢</strong><small>约 2 分钟</small></button><button class="secondary" data-action="add-scene">新增场景</button></aside>
      <section class="script-editor"><div class="editor-toolbar"><button aria-label="加粗">粗</button><button aria-label="斜体">斜</button><button aria-label="段落">段</button><span class="muted">已自动保存</span></div><article class="script-body" contenteditable="true" data-edit><h2>${state.scene === 1 ? "场景一　车站月台" : "场景二　列车车厢"}</h2><div class="script-line"><span>时间</span><strong>午后 · 阳光斜照</strong></div><div class="script-line"><span>地点</span><strong>${state.scene === 1 ? "城市火车站台" : "列车车厢"}</strong></div><div class="script-line"><span>人物</span><strong>林夏、陈默、其他旅客</strong></div><p>${sceneText}</p><div class="script-line"><span>对白</span><p>林夏：“好久不见。”<br />陈默：“嗯……好久不见。”</p></div></article></section>
      <aside class="check-panel"><h2>本步检查</h2><div class="check-row"><span class="check-mark">✓</span><div><strong>人物一致</strong><small>主要人物的设定与关系没有矛盾。</small></div></div><div class="check-row"><span class="check-mark">✓</span><div><strong>情节连贯</strong><small>场景之间过渡自然，逻辑连贯。</small></div></div><div class="check-row"><span class="check-mark">✓</span><div><strong>时长合适</strong><small>预计 3 分钟，符合短剧常见范围。</small></div></div></aside></div>`;
    return workspaceShell(content, "剧本完善", "按人物、情节与场景逐步完善，不再直接展示结构化代码。", true);
  }

  function shotsStrip() {
    return `<div class="shots-strip">${data.shots.map((shot) => `<button class="shot-card ${state.shot === shot.id ? "active" : ""}" data-shot="${shot.id}">${visual(shot.tone,"shot-visual")}<div class="shot-meta"><span>${shot.id}　${shot.seconds}秒</span><span>${shot.state}</span></div></button>`).join("")}</div>`;
  }

  function mediaCore(kind) {
    const shot = shotById(state.shot);
    const isStoryboard = kind === "storyboard";
    const isImage = kind === "image";
    const buttonText = isStoryboard ? "生成本镜头画面" : isImage ? "生成画面候选" : "生成本镜头视频";
    const candidateRow = isStoryboard ? "" : `<div class="candidate-row">${data.candidates.map((candidate) => `<button class="candidate ${state.candidate === candidate.id ? "active" : ""}" data-candidate="${candidate.id}">${visual(candidate.tone,"candidate-visual")}<strong>${candidate.label}${state.candidate === candidate.id ? " · 已选用" : ""}</strong><small>${candidate.note}</small></button>`).join("")}</div>`;
    const details = isStoryboard ? `<div class="detail-field"><label>画面内容</label><textarea data-edit>女生坐在列车靠窗位置，望向窗外，阳光洒在脸上，山川和河流缓缓掠过。</textarea></div><div class="detail-field"><label>人物与动作</label><textarea data-edit>林夏神情平静，目光看向窗外，微微出神，头发随车速轻轻飘动。</textarea></div><div class="detail-field"><label>台词</label><textarea data-edit>${shot.dialogue}</textarea></div><div class="detail-field"><label>镜头运动</label><textarea data-edit>缓慢推进，从侧面中近景推向人物面部。</textarea></div>` : isImage ? `<div class="detail-field"><label>人物</label><textarea data-edit>林夏保持前后镜头一致的发型、服装与年龄感。</textarea></div><div class="detail-field"><label>场景</label><textarea data-edit>列车车厢靠窗位置，窗外是山川与河流。</textarea></div><div class="detail-field"><label>光线</label><textarea data-edit>午后自然光，柔和温暖。</textarea></div><div class="detail-field"><label>构图</label><textarea data-edit>人物位于画面左侧三分之一处。</textarea></div>` : `<div class="detail-field"><label>人物动作</label><textarea data-edit>安静坐在座位上，轻微眨眼和呼吸。</textarea></div><div class="detail-field"><label>镜头运动</label><textarea data-edit>固定机位，缓慢推进。</textarea></div><div class="detail-field"><label>环境变化</label><textarea data-edit>车窗外景色自然后移，光线随列车变化。</textarea></div><div class="detail-field"><label>时长</label><textarea data-edit>15 秒</textarea></div>`;
    return `${shotsStrip()}<div class="media-layout"><section class="preview-panel">${visual(shot.tone,"large-visual")}<div class="preview-controls"><button class="ghost" data-action="play">播放</button><span>00:00 / 00:15</span><div class="control-track"><span></span></div><span>全屏</span></div>${candidateRow}</section><section class="details-panel"><h2>${isStoryboard ? `镜头 ${shot.id}` : isImage ? "画面要求" : "动态要求"}</h2>${details}</section><aside class="next-panel"><h2>下一步</h2><p>${isStoryboard ? "根据镜头内容生成画面。" : isImage ? "生成并挑选最合适的画面候选。" : "根据动态要求生成本镜头视频。"}</p><button class="primary" data-action="generate">${state.generating ? "正在生成…" : buttonText}</button><button class="secondary" data-action="regenerate">重新生成</button><button class="secondary" data-action="skip">稍后处理</button></aside></div>`;
  }

  function storyboardPage() { return workspaceShell(mediaCore("storyboard"), "分镜设计", "逐镜头确认画面、人物、台词和镜头运动。", true); }
  function imagePage() { return workspaceShell(mediaCore("image"), "画面生成", "选择画面候选，保持角色、服装和场景连续。", true); }
  function videoPage() { return workspaceShell(mediaCore("video"), "视频生成", "让选中的画面自然运动，并保持前后镜头连贯。", true); }

  function compositionPage() {
    const content = `<div class="composition-layout"><section class="composition-main">${visual("amber","large-visual")}<div class="preview-controls"><button class="ghost">播放</button><span>00:00 / 01:30</span><div class="control-track"><span></span></div><span>全屏</span></div><div class="timeline"><h3>镜头顺序</h3><div class="timeline-shots">${data.shots.map((shot) => `<div class="timeline-item">${visual(shot.tone,"shot-visual")}<small>${shot.id} · ${shot.seconds}秒</small></div>`).join("")}</div><div class="track"><span class="track-label">画面轨</span><span class="track-line"></span></div><div class="track"><span class="track-label">对白轨</span><span class="track-line dialogue"></span></div><div class="track"><span class="track-label">配乐轨</span><span class="track-line music"></span></div></div></section><aside class="export-side"><h2>成片检查</h2><div class="export-check"><div class="check-row"><span class="check-mark">✓</span><div><strong>镜头完整</strong><small>6 个镜头均已生成</small></div></div><div class="check-row"><span class="check-mark">✓</span><div><strong>对白完整</strong><small>6 段对白均可用</small></div></div><div class="check-row"><span class="check-mark">✓</span><div><strong>配乐已添加</strong><small>背景音乐长度匹配</small></div></div></div><h3>导出设置</h3><div class="segment"><button class="active">竖屏</button><button>横屏</button></div><div class="segment"><button>清晰</button><button class="active">高清</button></div><p class="muted">真人短剧建议使用高清竖屏。</p><button class="primary wide" data-action="compose">${state.exportReady ? "导出成片" : "生成成片"}</button></aside></div><section class="export-records"><h2>最近导出记录</h2><div class="record-row"><strong>《午后列车》</strong><span>1分30秒</span><span>2026年9月22日 14:28</span><span class="status-ok">已导出</span></div><div class="record-row"><strong>《夏日黄昏》</strong><span>2分12秒</span><span>2026年9月20日 19:06</span><span class="status-ok">已导出</span></div></section>`;
    return workspaceShell(content, "合成导出", "检查镜头、对白与配乐，生成完整成片。", false);
  }

  function evaluationPage() {
    const shot = shotById(state.evaluationShot);
    return `${header()}<main class="page" data-screen-label="09 质量评测"><section class="page-shell"><header class="page-heading"><div><p class="eyebrow">创作辅助检查</p><h1>质量评测</h1><p>发现常见问题并给出修改参考，最终质量仍由创作者确认。</p></div><div class="segment"><button>漫剧</button><button class="active">短剧</button></div></header><div class="evaluation-layout"><aside class="evaluation-list"><h2>镜头列表（6）</h2>${data.shots.map((item) => `<button class="evaluation-shot ${item.id === state.evaluationShot ? "active" : ""}" data-evaluation-shot="${item.id}">${visual(item.tone,"shot-visual")}<span><strong>${item.title}</strong><small>${item.seconds}秒</small></span><span class="${item.id === 2 ? "status-warn" : item.id === 6 ? "muted" : "status-ok"}">${item.id === 2 ? "需调整" : item.id === 6 ? "未检查" : "通过"}</span></button>`).join("")}</aside><section class="evaluation-preview"><h2>镜头 ${shot.id} / 6　${shot.title}</h2>${visual(shot.tone,"large-visual")}<h3>镜头信息</h3><p>画面内容：女主角坐在列车上看向窗外，神情安静。</p><p>台词：${shot.dialogue}</p></section><aside class="evaluation-results"><h2>检查结果（短剧）</h2><div class="result-item"><header><strong>人物与服装连续</strong><span class="status-ok">通过</span></header><p>人物与服装和前后镜头保持一致。</p></div><div class="result-item warn"><header><strong>场景与光线连续</strong><span class="status-warn">需调整</span></header><p>当前镜头的光线比上一镜头更强，可能影响观看连贯性。</p><button class="secondary" data-stage="storyboard">返回镜头修改</button></div><div class="result-item"><header><strong>画面与台词一致</strong><span class="status-ok">通过</span></header><p>画面内容与剧本表达一致。</p></div><button class="primary wide" data-action="check-next">检查下一个镜头</button></aside></div></section></main>`;
  }

  function settingsPage() {
    const services = [["文字创作服务","用于生成剧本、大纲和分镜文案。","已设置"],["画面生成服务","用于将人物、场景和分镜变成画面。","已设置"],["视频生成服务","用于将画面和分镜生成动态片段。","需要检查"],["语音与配乐服务","用于角色配音、旁白和背景音乐。","未设置"]];
    return `${header()}<main class="page" data-screen-label="10 设置"><section class="page-shell"><header class="page-heading"><div><p class="eyebrow">创作偏好与服务</p><h1>设置</h1><p>集中管理创作偏好与服务状态，创作页面不暴露技术参数。</p></div></header><div class="settings-grid"><section class="preference-panel"><div><h2>创作偏好</h2><p class="muted">新建作品时自动应用，也可以每次重新选择。</p></div><div><small class="muted">默认作品类型</small><div class="segment"><button class="active">每次询问</button><button>漫剧</button><button>短剧</button></div></div><div><small class="muted">默认画面比例</small><div class="segment"><button class="active">竖屏</button><button>横屏</button></div></div></section>${services.map((service) => `<article class="service-row"><div><strong>${service[0]}</strong><small>${service[1]}</small></div><span class="${service[2] === "已设置" ? "status-ok" : service[2] === "需要检查" ? "status-warn" : "muted"}">${service[2]}</span><span class="muted">凭据与模型信息已隐藏</span><button class="secondary" data-service="${service[0]}">管理</button></article>`).join("")}<section class="privacy-row"><div><h2>数据与隐私</h2><p class="muted">作品与素材保存在本机，不会自动上传到云端。</p></div><button class="secondary" data-action="data-location">查看数据位置</button></section><button class="primary wide" data-action="save-settings">保存设置</button></div></section></main>`;
  }

  function drawer() {
    if (!state.drawer) return "";
    const content = state.drawer === "history" ? `<section class="drawer-section"><h3>当前版本</h3><div class="drawer-row"><span>分镜版本 6</span><span class="status-ok">已确认</span></div><div class="drawer-row"><span>上次保存</span><span>今天 14:28</span></div></section><section class="drawer-section"><h3>字段锁定</h3><div class="drawer-row"><span>人物外观</span><button class="secondary">已锁定</button></div><div class="drawer-row"><span>关键剧情</span><button class="secondary">锁定</button></div></section>` : state.drawer === "tasks" ? `<section class="drawer-section"><h3>最近任务</h3><div class="drawer-row"><span>镜头 2 视频生成</span><span class="status-warn">进行中 64%</span></div><div class="progress"><span style="width:64%"></span></div><div class="drawer-row"><span>镜头 2 画面生成</span><span class="status-ok">已完成</span></div><div class="drawer-row"><span>镜头 6 视频生成</span><span class="status-warn">需要重试</span></div></section>` : state.drawer === "states" ? `<section class="drawer-section"><h3>状态演示</h3><p class="muted">用于确认关键异常状态，不会修改原型数据。</p><button class="secondary" data-demo-state="loading">加载中</button> <button class="secondary" data-demo-state="empty">空白状态</button> <button class="danger" data-demo-state="failure">生成失败</button></section>` : `<section class="drawer-section"><h3>作品操作</h3><button class="secondary">复制作品</button> <button class="secondary">导出项目</button> <button class="danger">删除作品</button></section>`;
    return `<div class="drawer-backdrop" data-action="close-drawer"><aside class="drawer" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><header><div><p class="eyebrow">当前项目</p><h2>${state.drawer === "history" ? "版本与锁定" : state.drawer === "tasks" ? "生成任务" : state.drawer === "states" ? "状态演示" : "更多操作"}</h2></div><button class="drawer-close" data-action="close-drawer" aria-label="关闭">×</button></header>${content}</aside></div>`;
  }

  function modal() {
    if (!state.modal && !state.serviceModal) return "";
    const isDirty = state.modal === "dirty";
    const title = state.serviceModal ? `管理${state.serviceModal}` : isDirty ? "有尚未暂存的修改" : "确认操作";
    const copy = state.serviceModal ? "此处只展示服务状态和用途。正式产品中的凭据会安全保存，不会在页面中完整回显。" : "离开后，本次尚未暂存的修改将不会保留。";
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><header><h2>${title}</h2><button class="drawer-close" data-action="close-modal">×</button></header><p>${copy}</p>${state.serviceModal ? `<div class="field"><label>服务状态</label><select><option>已设置</option><option>未设置</option><option>需要检查</option></select></div>` : ""}<div class="modal-actions"><button class="secondary" data-action="close-modal">取消</button><button class="primary" data-action="confirm-modal">${state.serviceModal ? "保存" : "放弃并离开"}</button></div></section></div>`;
  }

  function demoOverlay() {
    if (!state.demoState) return "";
    const config = state.demoState === "loading" ? ["正在载入作品", "请稍候，作品数据正在从本机读取。"] : state.demoState === "empty" ? ["这里还没有内容", "完成前一步后，本页会显示可继续处理的内容。"] : ["生成没有完成", "输入和已有结果均已保留，你可以安全重试。"];
    return `<div class="state-overlay"><section class="state-card">${state.demoState === "loading" ? `<div class="spinner"></div>` : ""}<h2>${config[0]}</h2><p class="muted">${config[1]}</p>${state.demoState !== "loading" ? `<button class="${state.demoState === "failure" ? "danger" : "primary"}" data-action="close-state">${state.demoState === "failure" ? "重试" : "返回上一步"}</button>` : `<button class="secondary" data-action="close-state">关闭演示</button>`}</section></div>`;
  }

  function renderPage() {
    if (state.page === "home") return homePage();
    if (state.page === "projects") return projectsPage();
    if (state.page === "evaluation") return evaluationPage();
    if (state.page === "settings") return settingsPage();
    if (state.stage === "story") return storyPage();
    if (state.stage === "script") return scriptPage();
    if (state.stage === "storyboard") return storyboardPage();
    if (state.stage === "image") return imagePage();
    if (state.stage === "video") return videoPage();
    return compositionPage();
  }

  function render() {
    app.innerHTML = `<div class="app">${renderPage()}${drawer()}${modal()}${demoOverlay()}${state.toast ? `<div class="toast">${state.toast}</div>` : ""}</div>`;
  }

  function goTo(page) {
    if (state.dirty && page !== state.page) {
      state.modal = "dirty";
      state.pendingPage = page;
      render();
      return;
    }
    state.page = page;
    state.moreOpen = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    render();
  }

  function goStage(stage) {
    if (state.dirty && state.page === "workspace" && stage !== state.stage) {
      state.modal = "dirty";
      state.pendingStage = stage;
      render();
      return;
    }
    state.page = "workspace";
    state.stage = stage;
    state.moreOpen = false;
    state.dirty = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    render();
  }

  function toast(message) {
    state.toast = message;
    render();
    window.setTimeout(() => { state.toast = ""; render(); }, 1800);
  }

  app.addEventListener("input", (event) => {
    if (event.target.matches("[data-edit]")) state.dirty = true;
    if (event.target.matches("[data-search]")) { state.search = event.target.value; render(); }
  });

  app.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.go) return goTo(target.dataset.go);
    if (target.dataset.stage) return goStage(target.dataset.stage);
    if (target.dataset.type) { state.workType = target.dataset.type; state.dirty = state.page === "workspace"; return render(); }
    if (target.dataset.filter) { state.projectFilter = target.dataset.filter; return render(); }
    if (target.dataset.shot) { state.shot = Number(target.dataset.shot); return render(); }
    if (target.dataset.candidate) { state.candidate = Number(target.dataset.candidate); return toast("已选用该候选"); }
    if (target.dataset.scene) { state.scene = Number(target.dataset.scene); return render(); }
    if (target.dataset.evaluationShot) { state.evaluationShot = Number(target.dataset.evaluationShot); return render(); }
    if (target.dataset.drawer) { state.drawer = target.dataset.drawer; state.moreOpen = false; return render(); }
    if (target.dataset.demoState) { state.demoState = target.dataset.demoState; state.drawer = null; return render(); }
    if (target.dataset.service) { state.serviceModal = target.dataset.service; return render(); }
    if (target.dataset.continue) {
      const map = { "故事构思":"story", "剧本完善":"script", "分镜设计":"storyboard", "画面生成":"image", "视频生成":"video", "合成导出":"composition" };
      return goStage(map[target.dataset.continue] || "story");
    }
    const action = target.dataset.action;
    if (action === "start") return goStage("story");
    if (action === "import") return toast("请选择本机的故事文件进行导入");
    if (action === "toggle-more") { state.moreOpen = !state.moreOpen; return render(); }
    if (action === "close-drawer") { state.drawer = null; return render(); }
    if (action === "close-modal") { state.modal = null; state.serviceModal = null; state.pendingPage = null; state.pendingStage = null; return render(); }
    if (action === "confirm-modal") {
      const page = state.pendingPage;
      const stage = state.pendingStage;
      state.dirty = false; state.modal = null; state.serviceModal = null; state.pendingPage = null; state.pendingStage = null;
      if (stage) return goStage(stage);
      if (page) return goTo(page);
      return toast("设置已保存");
    }
    if (action === "close-state") { state.demoState = null; return render(); }
    if (action === "save") { state.dirty = false; return toast("已暂存到本机"); }
    if (action === "next") {
      const index = data.stages.findIndex((item) => item.id === state.stage);
      state.dirty = false;
      return goStage(data.stages[Math.min(index + 1, data.stages.length - 1)].id);
    }
    if (action === "generate" || action === "regenerate") {
      state.generating = true; render();
      return window.setTimeout(() => { state.generating = false; toast("已生成 3 个候选，请选择一个继续"); }, 1300);
    }
    if (action === "skip") return toast("已标记为稍后处理");
    if (action === "play") return toast("预览播放中");
    if (action === "add-scene") return toast("已新增一个空白场景");
    if (action === "compose") { state.exportReady = !state.exportReady; return toast(state.exportReady ? "成片已生成，可以导出" : "成片已导出到本机"); }
    if (action === "check-next") { state.evaluationShot = Math.min(6, state.evaluationShot + 1); return render(); }
    if (action === "data-location") return toast("数据保存在镜序本机项目目录");
    if (action === "save-settings") return toast("设置已保存");
  });

  render();
})();
