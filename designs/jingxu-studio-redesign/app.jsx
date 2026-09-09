// 应用外壳：全局导航 / 顶栏（含方向切换）/ 流程轨 / 检查器 / 评审说明。
const {
  Stat, Seg, ToneFrame, InspectorSection, DefRow, CheckRow, I, pad2,
} = window;

function GlobalSidebar({ activeArea, onNavigate }) {
  return (
    <aside className="global-sidebar">
      <div className="brand">
        <span className="brand-mark">镜</span>
        <div>
          <strong>镜序 Studio</strong>
          <small>AI 漫剧工作台</small>
        </div>
      </div>
      <nav className="global-nav" aria-label="全局导航">
        {window.globalAreas.map((item) => (
          <button
            type="button"
            key={item.id}
            className={activeArea === item.id ? "nav-item active" : "nav-item"}
            aria-current={activeArea === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <I name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="project-context">
        <span>当前项目</span>
        <strong>大富翁的每一天</strong>
        <small>第 1 集 · <span className="tc">9:16</span></small>
      </div>
    </aside>
  );
}

function ProjectFlow({ direction, stage, onStage, scriptStep, onScriptStep, selectedShot, onShot }) {
  const showShots = ["storyboard", "image", "video"].includes(stage);
  return (
    <aside className="flow-panel" aria-label="项目创作流程">
      <header className="flow-header">
        <button type="button" className="back-button"><I name="left" size={13} />返回项目</button>
        <div>
          <small>当前作品</small>
          <h2>大富翁的每一天</h2>
        </div>
        <div className="episode-row">
          <span>第 1 集</span>
          <Stat status="active">制作中</Stat>
        </div>
      </header>
      <nav className="stage-list" aria-label="六阶段创作流程">
        {window.productionStages.map((item) => (
          <React.Fragment key={item.id}>
            <button
              type="button"
              className={stage === item.id ? "stage-item active" : "stage-item"}
              onClick={() => onStage(item.id)}
            >
              <span className={direction === "ink" ? "stage-num cn" : "stage-num"}>{direction === "ink" ? item.cn : item.index}</span>
              <span className="stage-main">
                <strong>{item.label}</strong>
                <small>{window.statusCopy[item.status]}</small>
              </span>
              <span className={`stage-mark ${item.status}`} aria-hidden="true"></span>
            </button>
            {item.id === "script" && stage === "script" && (
              <div className="script-step-list">
                {window.scriptSteps.map((step) => (
                  <button
                    type="button"
                    key={step.id}
                    className={scriptStep === step.id ? "script-step active" : "script-step"}
                    onClick={() => onScriptStep(step.id)}
                  >
                    <span>{step.label}</span>
                    <small>{window.statusCopy[step.status]}</small>
                  </button>
                ))}
              </div>
            )}
          </React.Fragment>
        ))}
      </nav>
      {showShots && (
        <section className="shot-list-section">
          <div className="section-label-row">
            <span>镜头列表</span>
            <small><span className="tc">6</span> 个 · <span className="tc">45</span> 秒</small>
          </div>
          <div className="shot-list">
            {window.shots.map((shot) => (
              <button
                type="button"
                key={shot.id}
                className={selectedShot === shot.id ? "shot-row active" : "shot-row"}
                onClick={() => onShot(shot.id)}
              >
                <ToneFrame tone={shot.color} className="shot-thumb" fig={false} />
                <span className="shot-row-copy">
                  <strong>{shot.title}{shot.locked && <I name="lock" size={11} />}</strong>
                  <small><span className="tc">{shot.duration}</span> 秒 · {window.statusCopy[shot.state]}</small>
                </span>
                <span className={`shot-state ${shot.state}`} aria-label={window.statusCopy[shot.state]}></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

function Topbar({ stageLabel, direction, setDirection, density, setDensity, inspectorOpen, setInspectorOpen, setGuideOpen }) {
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <span>创作工作台</span>
        <i></i>
        <strong>{stageLabel}</strong>
      </div>
      <div className="top-actions">
        <Seg
          extraClass="direction-switch"
          ariaLabel="设计方向"
          value={direction}
          onChange={setDirection}
          options={[{ value: "cine", label: "剪辑台" }, { value: "ink", label: "墨韵" }]}
        />
        <Seg
          ariaLabel="布局密度"
          value={density}
          onChange={setDensity}
          options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒展" }]}
        />
        <button type="button" className="secondary small" onClick={() => setGuideOpen(true)}>原型说明</button>
        <button type="button" className="icon-button inspector-toggle" onClick={() => setInspectorOpen(!inspectorOpen)} aria-label="切换检查器">
          <I name="sliders" size={14} />
        </button>
      </div>
    </header>
  );
}

function Inspector({ stage, tab, setTab, shot, exportState, onClose }) {
  return (
    <aside className="inspector-panel" aria-label="上下文检查器">
      <header className="inspector-header">
        <div>
          <small>上下文检查器</small>
          <h2>{stage === "composition" ? "导出设置" : shot ? `镜头 ${pad2(shot.id)}` : "当前步骤"}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭检查器"><I name="close" size={13} /></button>
      </header>
      <div className="inspector-tabs" role="tablist">
        <button type="button" className={tab === "common" ? "active" : ""} onClick={() => setTab("common")}>常用</button>
        <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>版本与锁</button>
        <button type="button" className={tab === "task" ? "active" : ""} onClick={() => setTab("task")}>任务</button>
      </div>
      {tab === "common" && (
        <div className="inspector-body">
          {stage === "composition" ? (
            <>
              <InspectorSection title="配音与音频">
                <div className="asset-line">
                  <I name="music" size={16} />
                  <div>
                    <strong>{window.voiceSetup.bgm}</strong>
                    <small><span className="tc">{window.voiceSetup.bgmLength}</span> · 音量 <span className="tc">{window.voiceSetup.bgmVolume}</span></small>
                  </div>
                  <button type="button" className="text-action">更换</button>
                </div>
              </InspectorSection>
              <InspectorSection title="输出规格">
                <DefRow label="画面" value="1080 × 1920" mono />
                <DefRow label="帧率" value="24 FPS" mono />
                <DefRow label="格式" value="MP4 · H.264" mono />
              </InspectorSection>
              <InspectorSection title="导出检查">
                <CheckRow label="6 个镜头视频可用" ok />
                <CheckRow label="时间线裁剪合法" ok />
                <CheckRow label="镜头 04 候选已过期" warn />
                <p className="inspector-note">修复阻塞项后才能导出，不会跳过坏镜头。</p>
              </InspectorSection>
              {exportState !== "idle" && (
                <InspectorSection title="当前任务">
                  <Stat status={exportState === "success" ? "done" : "running"}>{exportState === "success" ? "导出完成" : "正在合成"}</Stat>
                </InspectorSection>
              )}
            </>
          ) : (
            <>
              <InspectorSection title="当前对象">
                <DefRow label="镜头规格" value={shot ? shot.frame : "第 1 集"} />
                <DefRow label="目标时长" value={shot ? `${shot.duration} 秒` : "90 秒"} mono />
                <DefRow label="画面比例" value="9:16" mono />
              </InspectorSection>
              <InspectorSection title="模型服务">
                <CheckRow label="文本模型" ok value="已配置" />
                <CheckRow label="图片模型" ok value="已配置" />
                <CheckRow label="视频模型" ok value="已配置" />
                <button type="button" className="text-action full">前往模型服务设置</button>
              </InspectorSection>
              <InspectorSection title="引用素材">
                <div className="reference-line">
                  <I name="user" size={16} />
                  <div><strong>林知夏</strong><small>角色外观已锁定</small></div>
                </div>
                <div className="reference-line">
                  <I name="scene" size={16} />
                  <div><strong>顶层公寓</strong><small>场景参考 v2</small></div>
                </div>
              </InspectorSection>
            </>
          )}
        </div>
      )}
      {tab === "history" && (
        <div className="inspector-body">
          <InspectorSection title="当前版本">
            <DefRow label="版本" value="v6 · 已确认" mono />
            <DefRow label="父版本" value="v5" mono />
            <DefRow label="保存时间" value="18:24" mono />
          </InspectorSection>
          <InspectorSection title="锁定字段">
            <div className="lock-row">
              <span><I name="lock" size={13} />角色外观</span>
              <Stat status="done">已锁定</Stat>
            </div>
            <div className="lock-row">
              <span><I name="lock" size={13} />关键剧情</span>
              <button type="button" className="text-action">锁定</button>
            </div>
          </InspectorSection>
          <details className="advanced">
            <summary>高级信息</summary>
            <code>/content/character_appearance</code>
            <code>输入哈希 · 7ca1…8b2f</code>
            <code>版本 ID · shotver_0006</code>
          </details>
        </div>
      )}
      {tab === "task" && (
        <div className="inspector-body">
          <InspectorSection title="最近任务">
            {window.recentTasks.map((task) => (
              <div className="task-block" key={task.title}>
                <div className="task-head">
                  <I name={task.icon} size={16} />
                  <div className="task-copy">
                    <strong>{task.title}</strong>
                    <small>{task.note}</small>
                  </div>
                  {task.state === "running"
                    ? <span className="task-time tc">{task.progress}%</span>
                    : task.state === "failed"
                      ? <button type="button" className="text-action task-retry">重试</button>
                      : <Stat status={task.state} />}
                </div>
                {task.state === "running" && (
                  <div className="task-progress"><span style={{ width: `${task.progress}%` }}></span></div>
                )}
              </div>
            ))}
          </InspectorSection>
          <details className="advanced">
            <summary>查看任务证据</summary>
            <code>请求 · req_8a12…</code>
            <code>任务 · job_0042</code>
            <code>调用记录 · 2 条</code>
          </details>
        </div>
      )}
    </aside>
  );
}

function GuideDialog({ direction, onClose }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <small>UI 重设计评审说明</small>
            <h2 id="guide-title">两个方向，一套骨架</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><I name="close" size={13} /></button>
        </header>
        <ol>
          <li><strong>切换设计方向</strong><span>顶栏「剪辑台 / 墨韵」对比工具理性与文学气质，当前为{direction === "cine" ? "剪辑台" : "墨韵"}。</span></li>
          <li><strong>走完六个阶段</strong><span>观察 1px 分割线、单一信号色和字号灰度层级是否消除了面板感。</span></li>
          <li><strong>选择不同镜头</strong><span>流程轨、中间内容与检查器保持同一镜头上下文。</span></li>
          <li><strong>体验时间线与导出</strong><span>等宽时间码、排序启停与导出反馈；配音与字幕在合成阶段。</span></li>
        </ol>
        <p>本原型仅验证视觉与交互方向，不调用真实模型或写入项目数据。</p>
        <button type="button" className="primary wide" onClick={onClose}>开始评审</button>
      </section>
    </div>
  );
}

function App() {
  const [direction, setDirection] = React.useState("cine");
  const [activeArea, setActiveArea] = React.useState("workspace");
  const [stage, setStage] = React.useState("storyboard");
  const [scriptStep, setScriptStep] = React.useState("scene");
  const [selectedShot, setSelectedShot] = React.useState(1);
  const [imageCandidate, setImageCandidate] = React.useState("A");
  const [videoCandidate, setVideoCandidate] = React.useState("V1");
  const [inspectorTab, setInspectorTab] = React.useState("common");
  const [inspectorOpen, setInspectorOpen] = React.useState(true);
  const [density, setDensity] = React.useState("compact");
  const [guideOpen, setGuideOpen] = React.useState(true);
  const [exportState, setExportState] = React.useState("idle");
  const [timeline, setTimeline] = React.useState(window.shots.map((shot) => ({ ...shot, enabled: true })));
  const shot = window.shots.find((item) => item.id === selectedShot) || window.shots[0];
  const stageLabel = window.productionStages.find((item) => item.id === stage)?.label || "创作工作台";
  const changeArea = (area) => { setActiveArea(area); if (area === "workspace") setInspectorOpen(true); };
  const nextStage = (id) => { setStage(id); setInspectorTab("common"); };
  return (
    <div className="prototype-shell" data-direction={direction} data-density={density}>
      <GlobalSidebar activeArea={activeArea} onNavigate={changeArea} />
      {activeArea === "workspace" ? (
        <main className="workspace-shell">
          <ProjectFlow direction={direction} stage={stage} onStage={nextStage} scriptStep={scriptStep} onScriptStep={setScriptStep} selectedShot={selectedShot} onShot={setSelectedShot} />
          <section className="content-column">
            <Topbar
              stageLabel={stageLabel}
              direction={direction} setDirection={setDirection}
              density={density} setDensity={setDensity}
              inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen}
              setGuideOpen={setGuideOpen}
            />
            <div className="canvas-scroll" key={stage}>
              {stage === "input" && <window.InputStage direction={direction} onNext={() => nextStage("script")} />}
              {stage === "script" && <window.ScriptStage direction={direction} step={scriptStep} onStep={setScriptStep} onNext={() => nextStage("storyboard")} />}
              {stage === "storyboard" && <window.StoryboardStage direction={direction} shot={shot} />}
              {stage === "image" && <window.MediaStage direction={direction} kind="image" shot={shot} selectedCandidate={imageCandidate} setSelectedCandidate={setImageCandidate} onNext={() => nextStage("video")} />}
              {stage === "video" && <window.MediaStage direction={direction} kind="video" shot={shot} selectedCandidate={videoCandidate} setSelectedCandidate={setVideoCandidate} onNext={() => nextStage("composition")} />}
              {stage === "composition" && <window.CompositionStage direction={direction} timeline={timeline} setTimeline={setTimeline} exportState={exportState} setExportState={setExportState} />}
            </div>
          </section>
          {inspectorOpen && <Inspector stage={stage} tab={inspectorTab} setTab={setInspectorTab} shot={shot} exportState={exportState} onClose={() => setInspectorOpen(false)} />}
        </main>
      ) : (
        <main className="area-shell">
          <Topbar
            stageLabel={window.globalAreas.find((item) => item.id === activeArea)?.label || ""}
            direction={direction} setDirection={setDirection}
            density={density} setDensity={setDensity}
            inspectorOpen={false} setInspectorOpen={() => {}}
            setGuideOpen={setGuideOpen}
          />
          {activeArea === "settings"
            ? <window.SettingsArea direction={direction} />
            : <window.PlaceholderArea area={activeArea} onReturn={() => changeArea("workspace")} />}
        </main>
      )}
      {guideOpen && <GuideDialog direction={direction} onClose={() => setGuideOpen(false)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
