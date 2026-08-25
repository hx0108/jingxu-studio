const { statusCopy } = window;

function StatusPill({ status, children }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-symbol" aria-hidden="true"></span>
      {children || statusCopy[status] || "状态待确认"}
    </span>
  );
}

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
            <span className="nav-mark">{item.mark}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="project-context">
        <small>当前项目</small>
        <strong>大富翁的每一天</strong>
        <span>第 1 集 · 竖屏 9:16</span>
      </div>
    </aside>
  );
}

function ProjectFlow({ stage, onStage, scriptStep, onScriptStep, selectedShot, onShot }) {
  const showShots = ["storyboard", "image", "video"].includes(stage);
  return (
    <aside className="flow-panel" aria-label="项目创作流程">
      <header className="flow-header">
        <button type="button" className="back-button">返回项目</button>
        <div>
          <small>当前作品</small>
          <h2>大富翁的每一天</h2>
        </div>
        <div className="episode-row">
          <span>第 1 集</span>
          <StatusPill status="active">制作中</StatusPill>
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
              <span className="stage-number">{item.index}</span>
              <span className="stage-main">
                <strong>{item.label}</strong>
                <small>{statusCopy[item.status]}</small>
              </span>
              <span className={`stage-indicator indicator-${item.status}`} aria-hidden="true"></span>
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
                    <small>{statusCopy[step.status]}</small>
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
            <small>6 个 · 45 秒</small>
          </div>
          <div className="shot-list">
            {window.shots.map((shot) => (
              <button
                type="button"
                key={shot.id}
                className={selectedShot === shot.id ? "shot-row active" : "shot-row"}
                onClick={() => onShot(shot.id)}
              >
                <span className={`shot-thumb thumb-${shot.color}`}><b>{String(shot.id).padStart(2, "0")}</b></span>
                <span className="shot-row-copy">
                  <strong>{shot.title}</strong>
                  <small>{shot.duration} 秒 · {statusCopy[shot.state]}</small>
                </span>
                <span className={`shot-state state-${shot.state}`} aria-label={statusCopy[shot.state]}></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

function Topbar({ stageLabel, density, setDensity, inspectorOpen, setInspectorOpen, setGuideOpen }) {
  return (
    <header className="topbar">
      <div>
        <div className="breadcrumbs"><span>创作工作台</span><i></i><strong>{stageLabel}</strong></div>
        <p>项目进度自动保存 · 最近保存于刚刚</p>
      </div>
      <div className="top-actions">
        <div className="density-switch" aria-label="布局密度">
          <button type="button" className={density === "compact" ? "active" : ""} onClick={() => setDensity("compact")}>紧凑</button>
          <button type="button" className={density === "comfortable" ? "active" : ""} onClick={() => setDensity("comfortable")}>舒展</button>
        </div>
        <button type="button" className="secondary small" onClick={() => setGuideOpen(true)}>原型说明</button>
        <button type="button" className="inspector-toggle secondary small" onClick={() => setInspectorOpen(!inspectorOpen)}>检查器</button>
      </div>
    </header>
  );
}

function Inspector({ stage, tab, setTab, shot, exportState, onClose }) {
  return (
    <aside className="inspector-panel" aria-label="上下文检查器">
      <header className="inspector-header">
        <div><small>上下文检查器</small><h2>{stage === "composition" ? "导出设置" : shot ? `镜头 ${String(shot.id).padStart(2, "0")}` : "当前步骤"}</h2></div>
        <button type="button" className="close-inspector" onClick={onClose} aria-label="关闭检查器">×</button>
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
              <InspectorSection title="背景音乐">
                <div className="asset-line"><span className="asset-icon">音</span><div><strong>城市夜行曲.m4a</strong><small>02:14 · 音量 18%</small></div><button type="button" className="text-action">更换</button></div>
              </InspectorSection>
              <InspectorSection title="输出规格">
                <Definition label="画面" value="1080 × 1920" />
                <Definition label="帧率" value="24 FPS" />
                <Definition label="格式" value="MP4 · H.264" />
              </InspectorSection>
              <InspectorSection title="导出检查">
                <CheckRow label="6 个镜头视频可用" ok />
                <CheckRow label="时间线裁剪合法" ok />
                <CheckRow label="镜头 04 候选已过期" warn />
                <p className="inspector-note">修复阻塞项后才能导出，不会跳过坏镜头。</p>
              </InspectorSection>
              {exportState !== "idle" && <InspectorSection title="当前任务"><StatusPill status={exportState === "success" ? "done" : "running"}>{exportState === "success" ? "导出完成" : "正在合成"}</StatusPill></InspectorSection>}
            </>
          ) : (
            <>
              <InspectorSection title="当前对象">
                <Definition label="镜头规格" value={shot ? `${shot.frame}` : "第 1 集"} />
                <Definition label="目标时长" value={shot ? `${shot.duration} 秒` : "90 秒"} />
                <Definition label="画面比例" value="9:16" />
              </InspectorSection>
              <InspectorSection title="模型服务">
                <CheckRow label="文本模型" ok value="已配置" />
                <CheckRow label="图片模型" ok value="已配置" />
                <CheckRow label="视频模型" ok value="已配置" />
                <button type="button" className="text-action full">前往模型服务设置</button>
              </InspectorSection>
              <InspectorSection title="引用素材">
                <div className="reference-chip"><span className="avatar">林</span><div><strong>林知夏</strong><small>角色外观已锁定</small></div></div>
                <div className="reference-chip"><span className="avatar scene">景</span><div><strong>顶层公寓</strong><small>场景参考 v2</small></div></div>
              </InspectorSection>
            </>
          )}
        </div>
      )}
      {tab === "history" && (
        <div className="inspector-body">
          <InspectorSection title="当前版本"><Definition label="版本" value="v6 · 已确认" /><Definition label="父版本" value="v5" /><Definition label="保存时间" value="18:24" /></InspectorSection>
          <InspectorSection title="锁定字段"><div className="lock-row"><span>角色外观</span><StatusPill status="done">已锁定</StatusPill></div><div className="lock-row"><span>关键剧情</span><button type="button" className="text-action">锁定</button></div></InspectorSection>
          <details className="advanced"><summary>高级信息</summary><code>/content/character_appearance</code><code>输入哈希 · 7ca1…8b2f</code><code>版本 ID · shotver_0006</code></details>
        </div>
      )}
      {tab === "task" && (
        <div className="inspector-body">
          <InspectorSection title="最近任务"><div className="task-row"><span className="task-icon success">✓</span><div><strong>视频候选生成</strong><small>已完成 · 42 秒</small></div></div><div className="task-row"><span className="task-icon success">✓</span><div><strong>首帧候选生成</strong><small>已完成 · 18 秒</small></div></div></InspectorSection>
          <details className="advanced"><summary>查看任务证据</summary><code>请求 · req_8a12…</code><code>任务 · job_0042</code><code>调用记录 · 2 条</code></details>
        </div>
      )}
    </aside>
  );
}

function InspectorSection({ title, children }) { return <section className="inspector-section"><h3>{title}</h3>{children}</section>; }
function Definition({ label, value }) { return <div className="definition"><span>{label}</span><strong>{value}</strong></div>; }
function CheckRow({ label, ok, warn, value }) { return <div className={`check-row ${warn ? "warn" : ok ? "ok" : ""}`}><span className="check-symbol">{warn ? "!" : ok ? "✓" : "·"}</span><span>{label}</span>{value && <strong>{value}</strong>}</div>; }

function CandidateCard({ item, selected, onSelect, kind }) {
  return (
    <article className={selected ? "candidate-card selected" : "candidate-card"}>
      <div className={`candidate-preview preview-${item.color} ${kind === "video" ? "video-preview" : ""}`}>
        <span className="preview-kicker">{kind === "video" ? "视频预览" : "画面候选"}</span>
        <div className="figure-placeholder"><span></span><i></i></div>
        {kind === "video" && <button type="button" className="play-button" aria-label="播放视频">▶</button>}
        {selected && <span className="selected-ribbon">当前选用</span>}
      </div>
      <div className="candidate-copy"><div><strong>{item.label}</strong><small>{item.note}</small></div><StatusPill status={selected ? "done" : "active"}>{item.score}</StatusPill></div>
      <div className="candidate-actions"><button type="button" className="secondary">预览</button><button type="button" className={selected ? "secondary selected-button" : "primary"} onClick={onSelect}>{selected ? "已选用" : "选用"}</button></div>
    </article>
  );
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
  CheckRow,
});
