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
    serviceModal: null,
    playing: false,
    exportAspect: "竖屏",
    exportQuality: "高清",
    defaultType: "每次询问",
    defaultAspect: "竖屏",
    evaluationOpen: "lighting",
    timelineHistory: [],
    timelineFuture: [],
    timeline: {
      duration: 90,
      playhead: 18,
      selectedTrack: "video",
      selectedClipId: "v2",
      muted: { video: false, dialogue: false, music: false },
      volume: { video: 100, dialogue: 82, music: 46 },
      clips: {
        video: [
          { id: "v1", shot: 1, start: 0, duration: 15, label: "镜头 1" },
          { id: "v2", shot: 2, start: 15, duration: 15, label: "镜头 2" },
          { id: "v3", shot: 3, start: 30, duration: 15, label: "镜头 3" },
          { id: "v4", shot: 4, start: 45, duration: 15, label: "镜头 4" },
          { id: "v5", shot: 5, start: 60, duration: 15, label: "镜头 5" },
          { id: "v6", shot: 6, start: 75, duration: 15, label: "镜头 6" }
        ],
        dialogue: [
          { id: "d1", start: 3, duration: 9, label: "林夏：这里的风，真好。" },
          { id: "d2", start: 18, duration: 8, label: "陈默：好久不见。" },
          { id: "d3", start: 34, duration: 7, label: "林夏：你也坐这趟车？" },
          { id: "d4", start: 50, duration: 8, label: "陈默：想重新开始。" },
          { id: "d5", start: 66, duration: 8, label: "林夏：那就一起吧。" },
          { id: "d6", start: 80, duration: 7, label: "旁白：列车驶向远方。" }
        ],
        music: [
          { id: "m1", start: 0, duration: 90, label: "午后旅途 · 温暖钢琴" }
        ]
      }
    },
    story: {
      title: "午后列车",
      genre: "都市情感",
      conflict: "一位在城市中迷失方向的女孩，必须在事业与内心真正想要的生活之间做出选择。",
      summary: "林夏意外登上一趟慢车，在旅途中遇见沉默的摄影师陈默。两个人从互相防备到彼此理解，最终都找回重新开始的勇气。",
      audience: "喜欢都市题材、治愈氛围和人物成长故事的年轻观众。"
    },
    scriptHtml: {}
  };

  try {
    const savedTimeline = JSON.parse(window.localStorage.getItem("jingxu-editable-timeline-v1") || "null");
    if (savedTimeline?.clips?.video?.length && savedTimeline?.clips?.dialogue?.length && savedTimeline?.clips?.music?.length) {
      state.timeline = savedTimeline;
    }
  } catch {
    window.localStorage.removeItem("jingxu-editable-timeline-v1");
  }

  const toneClass = (tone) => `tone-${tone || "amber"}`;
  const shotById = (id) => data.shots.find((shot) => shot.id === Number(id)) || data.shots[0];
  const escapeText = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const snapTime = (value) => Math.round(value * 2) / 2;
  const formatTimelineTime = (seconds) => {
    const safe = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  };

  let timelineGesture = null;
  let playbackTimer = null;

  function timelineSnapshot() {
    return JSON.stringify(state.timeline);
  }

  function restoreTimeline(snapshot) {
    state.timeline = JSON.parse(snapshot);
  }

  function rememberTimeline(snapshot = timelineSnapshot()) {
    state.timelineHistory.push(snapshot);
    if (state.timelineHistory.length > 30) state.timelineHistory.shift();
    state.timelineFuture = [];
  }

  function selectedTimelineClip() {
    return state.timeline.clips[state.timeline.selectedTrack]?.find((clip) => clip.id === state.timeline.selectedClipId) || null;
  }

  function currentVideoClip() {
    return state.timeline.clips.video.find((clip) => state.timeline.playhead >= clip.start && state.timeline.playhead < clip.start + clip.duration) || state.timeline.clips.video[0];
  }

  function renderTimelineClip(track, clip) {
    const selected = state.timeline.selectedTrack === track && state.timeline.selectedClipId === clip.id;
    const left = (clip.start / state.timeline.duration) * 100;
    const width = (clip.duration / state.timeline.duration) * 100;
    const media = track === "video" ? `<img src="assets/media/shot-${clip.shot}.webp" alt="" draggable="false" />` : "";
    return `<button class="clip-block ${track} ${selected ? "selected" : ""} ${clip.fadeIn ? "fade-in" : ""} ${clip.fadeOut ? "fade-out" : ""}" style="left:${left}%;width:${width}%" data-track="${track}" data-clip-id="${clip.id}" aria-label="${clip.label}，${clip.duration} 秒">
      <span class="trim-handle start" data-trim="start" aria-hidden="true"></span>${media}<span class="clip-copy"><strong>${clip.label}</strong><small>${clip.duration.toFixed(1)} 秒</small></span><span class="trim-handle end" data-trim="end" aria-hidden="true"></span>
    </button>`;
  }

  function timelineTrack(track, label) {
    const isAudio = track !== "video";
    const clips = state.timeline.clips[track].map((clip) => renderTimelineClip(track, clip)).join("");
    const playhead = (state.timeline.playhead / state.timeline.duration) * 100;
    return `<div class="timeline-track-row">
      <div class="track-header"><div><strong>${label}</strong><small>${state.timeline.clips[track].length} 个片段</small></div>${isAudio ? `<button class="track-mute ${state.timeline.muted[track] ? "active" : ""}" data-action="toggle-track-mute" data-audio-track="${track}">${state.timeline.muted[track] ? "取消静音" : "静音"}</button><input class="track-volume" type="range" min="0" max="100" value="${state.timeline.volume[track]}" data-volume-track="${track}" aria-label="${label}音量" />` : ""}</div>
      <div class="timeline-lane ${track}" data-timeline-seek="true"><span class="lane-grid"></span>${clips}<span class="lane-playhead" style="left:${playhead}%"></span></div>
    </div>`;
  }

  function mutateTimeline(message, mutation) {
    rememberTimeline();
    mutation();
    state.dirty = true;
    toast(message);
  }

  function undoTimeline() {
    const snapshot = state.timelineHistory.pop();
    if (!snapshot) return;
    state.timelineFuture.push(timelineSnapshot());
    restoreTimeline(snapshot);
    state.playing = false;
    window.clearInterval(playbackTimer);
    playbackTimer = null;
    toast("已撤销上一步剪辑");
  }

  function redoTimeline() {
    const snapshot = state.timelineFuture.pop();
    if (!snapshot) return;
    state.timelineHistory.push(timelineSnapshot());
    restoreTimeline(snapshot);
    toast("已重做剪辑");
  }

  function splitTimelineClip() {
    const clip = selectedTimelineClip();
    if (!clip) return toast("请先选择一个片段");
    const splitAt = snapTime(state.timeline.playhead);
    if (splitAt <= clip.start + 0.5 || splitAt >= clip.start + clip.duration - 0.5) return toast("请把播放头移动到片段内部再分割");
    mutateTimeline("片段已在播放头处分割", () => {
      const originalEnd = clip.start + clip.duration;
      clip.duration = splitAt - clip.start;
      const copy = { ...clip, id: `${clip.id}-${Date.now().toString(36)}`, start: splitAt, duration: originalEnd - splitAt, label: `${clip.label} 后段` };
      state.timeline.clips[state.timeline.selectedTrack].push(copy);
      state.timeline.selectedClipId = copy.id;
    });
  }

  function deleteTimelineClip() {
    const clip = selectedTimelineClip();
    if (!clip) return toast("请先选择一个片段");
    if (state.timeline.selectedTrack === "video" && state.timeline.clips.video.length === 1) return toast("画面轨至少需要保留一个片段");
    mutateTimeline("已删除所选片段", () => {
      const clips = state.timeline.clips[state.timeline.selectedTrack];
      state.timeline.clips[state.timeline.selectedTrack] = clips.filter((item) => item.id !== clip.id);
      const next = state.timeline.clips[state.timeline.selectedTrack][0];
      state.timeline.selectedClipId = next?.id || null;
    });
  }

  function duplicateTimelineClip() {
    const clip = selectedTimelineClip();
    if (!clip) return toast("请先选择一个片段");
    mutateTimeline("已复制片段，可继续拖动调整", () => {
      const copy = { ...clip, id: `${clip.id}-copy-${Date.now().toString(36)}`, start: clamp(snapTime(clip.start + clip.duration + 1), 0, state.timeline.duration - clip.duration), label: `${clip.label} 副本` };
      state.timeline.clips[state.timeline.selectedTrack].push(copy);
      state.timeline.selectedClipId = copy.id;
      state.timeline.playhead = copy.start;
    });
  }

  function togglePlayback() {
    state.playing = !state.playing;
    window.clearInterval(playbackTimer);
    playbackTimer = null;
    if (state.playing) {
      playbackTimer = window.setInterval(() => {
        state.timeline.playhead = Math.min(state.timeline.duration, state.timeline.playhead + 0.5);
        if (state.timeline.playhead >= state.timeline.duration) {
          state.playing = false;
          window.clearInterval(playbackTimer);
          playbackTimer = null;
        }
        render();
      }, 500);
    }
    render();
  }

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
    const projectMap = { amber: 1, blue: 2, green: 3, violet: 4, rose: 5 };
    const shotMap = { green: 1, amber: 2, blue: 3, violet: 4, cyan: 5, rose: 6 };
    const candidateMap = { amber: 1, blue: 2, violet: 3 };
    let source = "assets/media/heroine-main.webp";
    if (className.includes("project-cover")) source = `assets/media/project-${projectMap[tone] || 1}.webp`;
    else if (className.includes("candidate-visual")) source = `assets/media/candidate-${candidateMap[tone] || 1}.webp`;
    else if (className.includes("media-thumb")) source = "assets/media/continue-drama.webp";
    else if (className.includes("shot-visual")) source = `assets/media/shot-${shotMap[tone] || 2}.webp`;
    else if (className.includes("large-visual") && tone !== "amber") source = `assets/media/shot-${shotMap[tone] || 2}.webp`;
    return `<div class="${className} ${toneClass(tone)}"><img src="${source}" alt="" draggable="false" /></div>`;
  }

  function homePage() {
    return `${header()}<main class="hero-home" data-screen-label="01 开始创作">
      <section class="hero-inner">
        <div class="hero-title"><p class="eyebrow">镜序创作工作台</p><h1>把一个想法，变成一部<span>好故事</span></h1><p>选择作品形式，我们会用对应的节奏、画面与质量检查陪你完成创作。</p></div>
        <div class="type-choice">
          <button class="type-card ${state.workType === "漫剧" ? "selected" : ""}" data-type="漫剧"><img src="assets/media/home-comic.webp" alt="动漫风格女孩在列车窗边" /><span class="type-card-copy"><span class="radio-mark"></span><strong>AI漫剧</strong><p>用连续画面、角色对白和镜头节奏，呈现富有想象力的故事。</p></span></button>
          <button class="type-card ${state.workType === "短剧" ? "selected" : ""}" data-type="短剧"><img src="assets/media/home-drama.webp" alt="真人风格女孩在列车窗边" /><span class="type-card-copy"><span class="radio-mark"></span><strong>AI短剧</strong><p>以真人表演逻辑和镜头连续性，快速完成一集短剧。</p></span></button>
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
    const scrollClass = ["image", "video", "composition"].includes(state.stage) ? " scroll-workspace" : "";
    return `${header()}<main class="workspace-page${scrollClass}" data-screen-label="${title}">${stageBar()}<div class="workspace-content"><div class="workspace-title"><div><p class="eyebrow">${state.workType}项目 · 第 ${data.stages.find((item) => item.id === state.stage)?.number || 1} 步</p><h1>${title}</h1><p>${description}</p></div>${["storyboard","image","video"].includes(state.stage) ? `<span class="mode-notice">短剧模式：优先检查真人表演与镜头连续性</span>` : ""}</div>${content}</div>${actions ? `<footer class="bottom-bar"><button class="secondary" data-action="save">暂存</button><button class="primary wide" data-action="next">保存并继续</button></footer>` : ""}</main>`;
  }

  function storyPage() {
    const content = `<div class="form-layout"><div class="form-fields">
      <div class="field"><label>作品类型</label><div class="segment"><button class="${state.workType === "漫剧" ? "active" : ""}" data-type="漫剧">漫剧</button><button class="${state.workType === "短剧" ? "active" : ""}" data-type="短剧">短剧</button></div></div>
      <div class="field"><label for="title">作品名</label><div><input id="title" value="${escapeText(state.story.title)}" data-edit data-field="title" maxlength="50" /><span class="count">${state.story.title.length} / 50</span></div></div>
      <div class="field"><label for="genre">故事类型</label><select id="genre" data-edit data-field="genre">${["都市情感","悬疑","轻喜剧","青春成长"].map((item) => `<option ${state.story.genre === item ? "selected" : ""}>${item}</option>`).join("")}</select></div>
      <div class="field"><label for="conflict">核心冲突</label><textarea id="conflict" data-edit data-field="conflict" maxlength="200">${escapeText(state.story.conflict)}</textarea></div>
      <div class="field"><label for="summary">故事梗概</label><textarea id="summary" data-edit data-field="summary" maxlength="500">${escapeText(state.story.summary)}</textarea></div>
      <div class="field"><label for="audience">目标观众</label><textarea id="audience" data-edit data-field="audience" maxlength="200">${escapeText(state.story.audience)}</textarea></div>
    </div><aside class="tip-panel"><h2>本步提示</h2><ol class="tip-list"><li><span class="tip-index">1</span><div><strong>明确主题</strong><span>用一句话说明你最想表达的核心。</span></div></li><li><span class="tip-index">2</span><div><strong>突出冲突</strong><span>让主角面对一个必须解决的困难。</span></div></li><li><span class="tip-index">3</span><div><strong>控制长度</strong><span>先说清起因、变化和结局。</span></div></li><li><span class="tip-index">4</span><div><strong>了解观众</strong><span>明确希望谁会喜欢这个故事。</span></div></li></ol></aside></div>`;
    return workspaceShell(content, "创作故事梗概", `当前选择“${state.workType}”，后续会按对应节奏生成剧本与镜头。`);
  }

  function scriptPage() {
    const sceneText = state.scene === 1 ? data.sceneText.one : data.sceneText.two;
    const defaultScript = `<h2>${state.scene === 1 ? "场景一　车站月台" : "场景二　列车车厢"}</h2><div class="script-line"><span>时间</span><strong>午后 · 阳光斜照</strong></div><div class="script-line"><span>地点</span><strong>${state.scene === 1 ? "城市火车站台" : "列车车厢"}</strong></div><div class="script-line"><span>人物</span><strong>林夏、陈默、其他旅客</strong></div><p>${sceneText}</p><div class="script-line"><span>对白</span><p>林夏：“好久不见。”<br />陈默：“嗯……好久不见。”</p></div>`;
    const scriptContent = state.scriptHtml[state.scene] || defaultScript;
    const content = `<div class="toolbar"><div class="toolbar-left"><span class="tag">短剧</span><span>共 2 个场景 · 约 3 分钟</span></div><div class="meta-row"><span>人物设定 ✓</span><span>分集大纲 ✓</span><span>剧情节拍 ✓</span><strong>场景剧本 4</strong></div></div>
      <div class="script-layout"><aside class="scene-list"><h3>场景目录</h3><button class="scene-item ${state.scene === 1 ? "active" : ""}" data-scene="1"><strong>场景一 · 车站月台</strong><small>约 1 分钟</small></button><button class="scene-item ${state.scene === 2 ? "active" : ""}" data-scene="2"><strong>场景二 · 列车车厢</strong><small>约 2 分钟</small></button><button class="secondary" data-action="add-scene">新增场景</button></aside>
      <section class="script-editor"><div class="editor-toolbar"><button aria-label="加粗" data-action="format" data-format="加粗">粗</button><button aria-label="斜体" data-action="format" data-format="斜体">斜</button><button aria-label="段落" data-action="format" data-format="段落">段</button><span class="muted">${state.dirty ? "有未暂存修改" : "已自动保存"}</span></div><article class="script-body" contenteditable="true" data-edit>${scriptContent}</article></section>
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
    return `${shotsStrip()}<div class="media-layout"><section class="preview-panel">${visual(shot.tone,"large-visual")}<div class="preview-controls"><button class="ghost" data-action="play">${state.playing ? "暂停" : "播放"}</button><span>${state.playing ? "00:06" : "00:00"} / 00:15</span><div class="control-track"><span class="${state.playing ? "is-playing" : ""}"></span></div><button class="ghost" data-action="fullscreen">全屏</button></div>${candidateRow}</section><section class="details-panel"><h2>${isStoryboard ? `镜头 ${shot.id}` : isImage ? "画面要求" : "动态要求"}</h2>${details}</section><aside class="next-panel"><h2>下一步</h2><p>${isStoryboard ? "根据镜头内容生成画面。" : isImage ? "生成并挑选最合适的画面候选。" : "根据动态要求生成本镜头视频。"}</p><button class="primary" data-action="generate">${state.generating ? "正在生成…" : buttonText}</button><button class="secondary" data-action="regenerate">重新生成</button><button class="secondary" data-action="skip">稍后处理</button></aside></div>`;
  }

  function storyboardPage() { return workspaceShell(mediaCore("storyboard"), "分镜设计", "逐镜头确认画面、人物、台词和镜头运动。", true); }
  function imagePage() { return workspaceShell(mediaCore("image"), "画面生成", "选择画面候选，保持角色、服装和场景连续。", true); }
  function videoPage() { return workspaceShell(mediaCore("video"), "视频生成", "让选中的画面自然运动，并保持前后镜头连贯。", true); }

  function compositionPage() {
    const activeVideo = currentVideoClip();
    const activeShot = shotById(activeVideo?.shot || 1);
    const selected = selectedTimelineClip();
    const rulerTicks = [0, 15, 30, 45, 60, 75, 90].map((time) => `<span style="left:${(time / state.timeline.duration) * 100}%"><i></i>${formatTimelineTime(time)}</span>`).join("");
    const content = `<div class="composition-layout editor-composition"><section class="composition-main editor-main">
      ${visual(activeShot.tone,"large-visual")}
      <div class="preview-controls"><button class="ghost" data-action="play">${state.playing ? "暂停" : "播放"}</button><span>${formatTimelineTime(state.timeline.playhead)} / ${formatTimelineTime(state.timeline.duration)}</span><button class="control-track timeline-progress" data-timeline-seek="true" aria-label="调整播放位置"><span style="width:${(state.timeline.playhead / state.timeline.duration) * 100}%"></span></button><button class="ghost" data-action="fullscreen">全屏</button></div>
      <div class="timeline-editor"><div class="timeline-toolbar"><div class="inline-actions"><button class="secondary" data-action="timeline-undo" ${state.timelineHistory.length ? "" : "disabled"}>撤销</button><button class="secondary" data-action="timeline-redo" ${state.timelineFuture.length ? "" : "disabled"}>重做</button><button class="secondary" data-action="timeline-split" ${selected ? "" : "disabled"}>分割</button><button class="secondary" data-action="timeline-duplicate" ${selected ? "" : "disabled"}>复制</button><button class="danger" data-action="timeline-delete" ${selected ? "" : "disabled"}>删除</button></div><div class="timeline-selection">${selected ? `已选：<strong>${selected.label}</strong>　开始 ${formatTimelineTime(selected.start)}　时长 ${selected.duration.toFixed(1)} 秒` : "请选择一个片段"}</div></div>
        <div class="timeline-ruler-row"><span class="ruler-label">时间</span><button class="timeline-ruler" data-timeline-seek="true" aria-label="移动播放头">${rulerTicks}<b class="ruler-playhead" style="left:${(state.timeline.playhead / state.timeline.duration) * 100}%"></b></button></div>
        <div class="timeline-tracks">${timelineTrack("video", "画面轨")}${timelineTrack("dialogue", "对白轨")}${timelineTrack("music", "配乐轨")}</div>
        <p class="timeline-help">拖动片段可调整位置；拖动片段两端可裁剪；点击时间尺移动播放头，再使用“分割”拆开片段。</p>
      </div>
    </section><aside class="export-side editor-side"><section><h2>片段与声音</h2>${selected ? `<div class="clip-inspector"><strong>${selected.label}</strong><div><span>开始</span><b>${formatTimelineTime(selected.start)}</b></div><div><span>时长</span><b>${selected.duration.toFixed(1)} 秒</b></div>${state.timeline.selectedTrack === "music" ? `<div class="fade-actions"><button class="secondary ${selected.fadeIn ? "active" : ""}" data-action="timeline-fade-in">淡入 2 秒</button><button class="secondary ${selected.fadeOut ? "active" : ""}" data-action="timeline-fade-out">淡出 2 秒</button></div>` : ""}</div>` : `<p class="muted">选择时间轴片段后，可进行裁剪、分割和删除。</p>`}</section>
      <section><h2>成片检查</h2><div class="export-check"><div class="check-row"><span class="check-mark">✓</span><div><strong>镜头完整</strong><small>${state.timeline.clips.video.length} 个画面片段</small></div></div><div class="check-row"><span class="check-mark">✓</span><div><strong>对白已对齐</strong><small>${state.timeline.clips.dialogue.length} 段对白可微调</small></div></div><div class="check-row"><span class="check-mark">✓</span><div><strong>配乐已添加</strong><small>音量 ${state.timeline.volume.music}%</small></div></div></div></section>
      <section><h3>导出设置</h3><div class="segment"><button class="${state.exportAspect === "竖屏" ? "active" : ""}" data-export-aspect="竖屏">竖屏</button><button class="${state.exportAspect === "横屏" ? "active" : ""}" data-export-aspect="横屏">横屏</button></div><div class="segment"><button class="${state.exportQuality === "清晰" ? "active" : ""}" data-export-quality="清晰">清晰</button><button class="${state.exportQuality === "高清" ? "active" : ""}" data-export-quality="高清">高清</button></div><p class="muted">当前选择：${state.exportQuality} · ${state.exportAspect}</p><button class="primary wide" data-action="compose">${state.exportReady ? "导出成片" : "生成成片"}</button></section>
    </aside></div><section class="export-records"><h2>最近导出记录</h2><div class="record-row"><strong>《午后列车》</strong><span>1分30秒</span><span>2026年9月22日 14:28</span><span class="status-ok">已导出</span><button class="secondary" data-action="open-export">打开文件</button></div><div class="record-row"><strong>《夏日黄昏》</strong><span>2分12秒</span><span>2026年9月20日 19:06</span><span class="status-ok">已导出</span><button class="secondary" data-action="open-export">打开文件</button></div></section>`;
    return workspaceShell(content, "合成导出", "拖动、裁剪并对齐画面、对白与配乐，再生成完整成片。", false);
  }

  function evaluationPage() {
    const shot = shotById(state.evaluationShot);
    return `${header()}<main class="page" data-screen-label="09 质量评测"><section class="page-shell"><header class="page-heading"><div><p class="eyebrow">创作辅助检查</p><h1>质量评测</h1><p>发现常见问题并给出修改参考，最终质量仍由创作者确认。</p></div><div class="segment"><button data-type="漫剧">漫剧</button><button class="active" data-type="短剧">短剧</button></div></header><div class="evaluation-layout"><aside class="evaluation-list"><h2>镜头列表（6）</h2>${data.shots.map((item) => `<button class="evaluation-shot ${item.id === state.evaluationShot ? "active" : ""}" data-evaluation-shot="${item.id}">${visual(item.tone,"shot-visual")}<span><strong>${item.title}</strong><small>${item.seconds}秒</small></span><span class="${item.id === 2 ? "status-warn" : item.id === 6 ? "muted" : "status-ok"}">${item.id === 2 ? "需调整" : item.id === 6 ? "未检查" : "通过"}</span></button>`).join("")}</aside><section class="evaluation-preview"><h2>镜头 ${shot.id} / 6　${shot.title}</h2>${visual(shot.tone,"large-visual")}<h3>镜头信息</h3><p>画面内容：女主角坐在列车上看向窗外，神情安静。</p><p>台词：${shot.dialogue}</p></section><aside class="evaluation-results"><h2>检查结果（短剧）</h2><div class="result-item"><button class="result-header" data-result="character"><strong>人物与服装连续</strong><span class="status-ok">通过　⌄</span></button>${state.evaluationOpen === "character" ? "<p>人物与服装和前后镜头保持一致，未发现明显问题。</p>" : ""}</div><div class="result-item warn"><button class="result-header" data-result="lighting"><strong>场景与光线连续</strong><span class="status-warn">需调整　⌄</span></button>${state.evaluationOpen === "lighting" ? '<p>当前镜头的光线比上一个镜头更强，跳变较明显，可能影响观看连贯性。</p><button class="secondary" data-stage="storyboard">返回镜头修改</button>' : ""}</div><div class="result-item"><button class="result-header" data-result="dialogue"><strong>画面与台词一致</strong><span class="status-ok">通过　⌄</span></button>${state.evaluationOpen === "dialogue" ? "<p>画面内容与剧本表达一致，当前无需调整。</p>" : ""}</div><button class="primary wide" data-action="check-next">检查下一个镜头</button></aside></div></section></main>`;
  }

  function settingsPage() {
    const services = [["文字创作服务","用于生成剧本、大纲和分镜文案。","已设置"],["画面生成服务","用于将人物、场景和分镜变成画面。","已设置"],["视频生成服务","用于将画面和分镜生成动态片段。","需要检查"],["语音与配乐服务","用于角色配音、旁白和背景音乐。","未设置"]];
    return `${header()}<main class="page settings-page" data-screen-label="10 设置"><section class="page-shell"><header class="page-heading"><div><p class="eyebrow">创作偏好与服务</p><h1>设置</h1><p>根据你的创作习惯配置服务与偏好，让灵感更快变成故事。</p></div></header><div class="settings-grid"><section class="preference-panel"><div><h2>创作偏好</h2><p class="muted">新建项目时自动应用，也可以每次重新选择。</p></div><div><small class="muted">默认作品类型</small><div class="segment">${["每次询问","漫剧","短剧"].map((item) => `<button class="${state.defaultType === item ? "active" : ""}" data-default-type="${item}">${item}</button>`).join("")}</div></div><div><small class="muted">默认画面比例</small><div class="segment">${["竖屏","横屏"].map((item) => `<button class="${state.defaultAspect === item ? "active" : ""}" data-default-aspect="${item}">${item}</button>`).join("")}</div></div></section>${services.map((service) => `<article class="service-row"><div><strong>${service[0]}</strong><small>${service[1]}</small></div><span class="${service[2] === "已设置" ? "status-ok" : service[2] === "需要检查" ? "status-warn" : "muted"}">${service[2]}</span><span class="muted">凭据与模型信息已隐藏</span><button class="secondary" data-service="${service[0]}">管理</button></article>`).join("")}<section class="privacy-row"><div><h2>数据与隐私</h2><p class="muted">作品与素材保存在本机，不会自动上传到云端。</p></div><button class="secondary" data-action="data-location">查看数据位置</button></section><button class="primary wide" data-action="save-settings">保存设置</button></div></section></main>`;
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
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true"><header><h2>${title}</h2><button class="drawer-close" data-action="close-modal">×</button></header><p>${copy}</p>${state.serviceModal ? `<div class="field"><label>服务状态</label><select><option>已设置</option><option>未设置</option><option>需要检查</option></select></div>` : ""}<div class="modal-actions"><button class="secondary" data-action="close-modal">取消</button><button class="primary" data-action="confirm-modal">${state.serviceModal ? "保存" : "放弃并离开"}</button></div></section></div>`;
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
    const scrollTop = app.querySelector(".scroll-workspace")?.scrollTop || 0;
    try {
      window.localStorage.setItem("jingxu-editable-timeline-v1", JSON.stringify(state.timeline));
    } catch {
      // 原型仍可继续使用；仅在浏览器禁止本地存储时不保留剪辑状态。
    }
    app.innerHTML = `<div class="app">${renderPage()}${drawer()}${modal()}${demoOverlay()}${state.toast ? `<div class="toast">${state.toast}</div>` : ""}</div>`;
    const scrollWorkspace = app.querySelector(".scroll-workspace");
    if (scrollWorkspace) scrollWorkspace.scrollTop = scrollTop;
  }

  function goTo(page) {
    if (state.dirty && page !== state.page) {
      state.modal = "dirty";
      state.pendingPage = page;
      render();
      return;
    }
    if (page !== "workspace") stopTimelinePlayback();
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
    if (stage !== "composition") stopTimelinePlayback();
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

  function stopTimelinePlayback() {
    state.playing = false;
    window.clearInterval(playbackTimer);
    playbackTimer = null;
  }

  app.addEventListener("input", (event) => {
    if (event.target.matches("[data-volume-track]")) {
      state.timeline.volume[event.target.dataset.volumeTrack] = Number(event.target.value);
      state.dirty = true;
    }
    if (event.target.matches("[data-edit]")) {
      state.dirty = true;
      if (event.target.dataset.field) state.story[event.target.dataset.field] = event.target.value;
      if (event.target.matches(".script-body")) state.scriptHtml[state.scene] = event.target.innerHTML;
      const count = event.target.parentElement?.querySelector(".count");
      if (count) count.textContent = `${event.target.value.length} / ${event.target.maxLength}`;
    }
    if (event.target.matches("[data-search]")) { state.search = event.target.value; render(); }
  });

  app.addEventListener("change", (event) => {
    if (!event.target.matches("[data-volume-track]")) return;
    if (event.target._timelineSnapshot) rememberTimeline(event.target._timelineSnapshot);
    event.target._timelineSnapshot = null;
    toast(`${event.target.dataset.volumeTrack === "dialogue" ? "对白" : "配乐"}音量已调整为 ${event.target.value}%`);
  });

  app.addEventListener("pointerdown", (event) => {
    const range = event.target.closest?.("[data-volume-track]");
    if (range) {
      range._timelineSnapshot = timelineSnapshot();
      return;
    }
    const clipElement = event.target.closest?.(".clip-block");
    if (!clipElement) return;
    event.preventDefault();
    const track = clipElement.dataset.track;
    const clip = state.timeline.clips[track].find((item) => item.id === clipElement.dataset.clipId);
    const lane = clipElement.closest(".timeline-lane");
    if (!clip || !lane) return;
    state.timeline.selectedTrack = track;
    state.timeline.selectedClipId = clip.id;
    const trim = event.target.closest?.("[data-trim]")?.dataset.trim;
    timelineGesture = {
      track,
      clipId: clip.id,
      type: trim === "start" ? "trim-start" : trim === "end" ? "trim-end" : "move",
      startX: event.clientX,
      laneWidth: lane.getBoundingClientRect().width,
      initialStart: clip.start,
      initialDuration: clip.duration,
      snapshot: timelineSnapshot(),
      moved: false
    };
  });

  window.addEventListener("pointermove", (event) => {
    if (!timelineGesture) return;
    const clip = state.timeline.clips[timelineGesture.track].find((item) => item.id === timelineGesture.clipId);
    if (!clip) return;
    const delta = snapTime(((event.clientX - timelineGesture.startX) / timelineGesture.laneWidth) * state.timeline.duration);
    if (Math.abs(delta) >= 0.5) timelineGesture.moved = true;
    if (timelineGesture.type === "move") {
      clip.start = clamp(snapTime(timelineGesture.initialStart + delta), 0, state.timeline.duration - clip.duration);
    } else if (timelineGesture.type === "trim-start") {
      const newStart = clamp(snapTime(timelineGesture.initialStart + delta), 0, timelineGesture.initialStart + timelineGesture.initialDuration - 1);
      clip.duration = timelineGesture.initialDuration - (newStart - timelineGesture.initialStart);
      clip.start = newStart;
    } else {
      clip.duration = clamp(snapTime(timelineGesture.initialDuration + delta), 1, state.timeline.duration - timelineGesture.initialStart);
    }
    const element = app.querySelector(`[data-clip-id="${clip.id}"]`);
    if (element) {
      element.style.left = `${(clip.start / state.timeline.duration) * 100}%`;
      element.style.width = `${(clip.duration / state.timeline.duration) * 100}%`;
      const duration = element.querySelector("small");
      if (duration) duration.textContent = `${clip.duration.toFixed(1)} 秒`;
    }
  });

  window.addEventListener("pointerup", () => {
    if (!timelineGesture) return;
    const gesture = timelineGesture;
    timelineGesture = null;
    if (gesture.moved) {
      rememberTimeline(gesture.snapshot);
      const clip = state.timeline.clips[gesture.track].find((item) => item.id === gesture.clipId);
      if (clip) state.timeline.playhead = clip.start;
      state.dirty = true;
      return toast(gesture.type === "move" ? "片段位置已更新" : "片段长度已裁剪");
    }
    render();
  });

  app.addEventListener("click", (event) => {
    if (event.target.matches(".modal-backdrop")) {
      state.modal = null;
      state.serviceModal = null;
      state.pendingPage = null;
      state.pendingStage = null;
      return render();
    }
    const clipButton = event.target.closest?.(".clip-block");
    if (clipButton) {
      state.timeline.selectedTrack = clipButton.dataset.track;
      state.timeline.selectedClipId = clipButton.dataset.clipId;
      const clip = selectedTimelineClip();
      if (clip) state.timeline.playhead = clip.start;
      return render();
    }
    const seekSurface = event.target.closest?.("[data-timeline-seek]");
    if (seekSurface) {
      const rect = seekSurface.getBoundingClientRect();
      state.timeline.playhead = snapTime(clamp(((event.clientX - rect.left) / rect.width) * state.timeline.duration, 0, state.timeline.duration));
      state.playing = false;
      window.clearInterval(playbackTimer);
      playbackTimer = null;
      return render();
    }
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
    if (target.dataset.exportAspect) { state.exportAspect = target.dataset.exportAspect; return render(); }
    if (target.dataset.exportQuality) { state.exportQuality = target.dataset.exportQuality; return render(); }
    if (target.dataset.defaultType) { state.defaultType = target.dataset.defaultType; return render(); }
    if (target.dataset.defaultAspect) { state.defaultAspect = target.dataset.defaultAspect; return render(); }
    if (target.dataset.result) { state.evaluationOpen = state.evaluationOpen === target.dataset.result ? "" : target.dataset.result; return render(); }
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
    if (action === "play") return state.stage === "composition" ? togglePlayback() : (state.playing = !state.playing, render());
    if (action === "fullscreen") return toast("已进入全屏预览演示");
    if (action === "timeline-undo") return undoTimeline();
    if (action === "timeline-redo") return redoTimeline();
    if (action === "timeline-split") return splitTimelineClip();
    if (action === "timeline-delete") return deleteTimelineClip();
    if (action === "timeline-duplicate") return duplicateTimelineClip();
    if (action === "toggle-track-mute") return mutateTimeline(`${target.dataset.audioTrack === "dialogue" ? "对白" : "配乐"}${state.timeline.muted[target.dataset.audioTrack] ? "已取消静音" : "已静音"}`, () => { state.timeline.muted[target.dataset.audioTrack] = !state.timeline.muted[target.dataset.audioTrack]; });
    if (action === "timeline-fade-in" || action === "timeline-fade-out") {
      const clip = selectedTimelineClip();
      if (!clip) return;
      const key = action === "timeline-fade-in" ? "fadeIn" : "fadeOut";
      return mutateTimeline(`${action === "timeline-fade-in" ? "淡入" : "淡出"}已${clip[key] ? "关闭" : "开启"}`, () => { clip[key] = !clip[key]; });
    }
    if (action === "open-export") return toast("已打开本机导出文件位置");
    if (action === "add-scene") return toast("已新增一个空白场景");
    if (action === "compose") { state.exportReady = !state.exportReady; return toast(state.exportReady ? "成片已生成，可以导出" : "成片已导出到本机"); }
    if (action === "check-next") { state.evaluationShot = Math.min(6, state.evaluationShot + 1); return render(); }
    if (action === "data-location") return toast("数据保存在镜序本机项目目录");
    if (action === "save-settings") return toast("设置已保存");
    if (action === "format") return toast(`已应用${target.dataset.format || "文本"}格式`);
  });

  window.addEventListener("keydown", (event) => {
    if (state.page !== "workspace" || state.stage !== "composition") return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      return event.shiftKey ? redoTimeline() : undoTimeline();
    }
    if ((event.ctrlKey || event.metaKey) && key === "y") {
      event.preventDefault();
      return redoTimeline();
    }
    if (event.key === "Delete") {
      event.preventDefault();
      return deleteTimelineClip();
    }
    if (event.code === "Space") {
      event.preventDefault();
      return togglePlayback();
    }
  });

  render();
})();
