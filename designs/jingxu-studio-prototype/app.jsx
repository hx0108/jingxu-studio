const {
  StatusPill,
  GlobalSidebar,
  ProjectFlow,
  Topbar,
  Inspector,
  CandidateCard,
  InspectorSection,
  Definition,
  CheckRow,
} = window;

function InputStage({ onNext }) {
  const [mode, setMode] = React.useState("original");
  const [text, setText] = React.useState("一个隐瞒巨额财富的普通上班族，每天醒来都会收到一笔神秘转账，但每花一分钱，就会有人更接近他的真实身份。");
  const enough = text.trim().length >= 20;
  return (
    <section className="screen input-screen" data-screen-label="创作输入">
      <ScreenHeader eyebrow="第 1 步 · 创作输入" title="从一个故事种子开始" description="选择原创创意或导入已有剧本。原文会保留，系统不会静默截断。" status="done" />
      <div className="mode-tabs"><button type="button" className={mode === "original" ? "active" : ""} onClick={() => setMode("original")}>原创创意</button><button type="button" className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}>导入已有剧本</button></div>
      {mode === "original" ? (
        <div className="editor-card large-editor"><label htmlFor="idea">创意内容</label><textarea id="idea" value={text} onChange={(event) => setText(event.target.value)}></textarea><div className="field-meta"><span className={enough ? "valid" : "invalid"}>{text.length}/2,000 个字符 · 最少 20 个</span><span>支持中文、英文和标点</span></div></div>
      ) : (
        <div className="import-drop"><span className="import-mark">文</span><h3>选择 TXT 或 Markdown 文件</h3><p>文件由系统对话框读取，不会向界面暴露本地路径。</p><button type="button" className="primary">选择文件</button><small>最大 30,000 个 Unicode 字符</small></div>
      )}
      <label className="consent"><input type="checkbox" defaultChecked /><span>我确认将以上内容发送给已配置的文本模型处理，并已阅读数据处理说明。</span></label>
      <BottomAction hint={enough ? "内容有效，可以创建工作区。" : "还需输入至少 20 个字符。"}><button type="button" className="primary wide" disabled={!enough} onClick={onNext}>创建剧本工作区</button></BottomAction>
    </section>
  );
}

function ScriptStage({ step, onStep, onNext }) {
  const stepIndex = window.scriptSteps.findIndex((item) => item.id === step);
  const current = window.scriptSteps[stepIndex];
  const next = window.scriptSteps[stepIndex + 1];
  return (
    <section className="screen script-screen" data-screen-label="剧本开发">
      <ScreenHeader eyebrow={`剧本开发 · ${stepIndex + 1}/5`} title={current.label} description="内容可直接编辑。确认后会创建新版本，并解锁下一阶段。" status={current.status === "done" ? "done" : "draft"} />
      <div className="script-document">
        <div className="document-toolbar"><span>结构化正文</span><div><button type="button" className="text-action">对比版本</button><button type="button" className="text-action">恢复历史</button></div></div>
        {step === "concept" && <><DocumentBlock label="一句话梗概" text="一个靠神秘转账成为隐形富豪的上班族，在追查金钱来源时发现自己正被一套精密系统观察。" /><DocumentBlock label="核心冲突" text="他必须在维持普通生活与查明财富真相之间做出选择，而每次消费都会暴露新的身份线索。" /></>}
        {step === "bible" && <><DocumentBlock label="世界规则" text="每天 06:00，账户会自动增加 8,888,888 元；当天未消费的部分会在午夜冻结。任何消费都会触发一次现实中的‘回声事件’。" /><DocumentBlock label="主角弧光" text="林峥从隐藏财富、逃避关系，逐步学会承担选择的代价，并主动追踪系统背后的控制者。" /><DocumentBlock label="关键角色" text="林峥｜谨慎克制的隐形富豪；林知夏｜观察敏锐的妹妹；周沉｜身份不明的金融调查员。" /></>}
        {step === "outline" && <><DocumentBlock label="本集目标" text="建立神秘转账规则，暴露跟踪者，并在午夜冻结账户作为集尾钩子。" /><DocumentBlock label="三段结构" text="清晨到账与伪装日常 → 跟踪迹象升级 → 交易失败与账户冻结。" /></>}
        {step === "beats" && <><BeatRow index="01" title="余额提醒" time="0–8 秒" /><BeatRow index="02" title="早餐试探" time="8–22 秒" /><BeatRow index="03" title="跟踪升级" time="22–48 秒" /><BeatRow index="04" title="午夜冻结" time="48–62 秒" /></>}
        {step === "scene" && <><DocumentBlock label="场景 01 · 顶层公寓 · 清晨" text="手机震动。林峥睁眼，屏幕上的余额数字映在他的瞳孔里。他没有惊讶，只熟练地关闭提醒。餐桌另一端，林知夏观察着他。" /><DocumentBlock label="场景 02 · 电梯 · 早晨" text="一个陌生男人站在角落，准确说出林峥每天出门的时间。电梯数字逐层下降，空气变得凝固。" /></>}
      </div>
      <BottomAction hint={next ? `确认后可继续：${next.label}` : "场景剧本确认后可以生成结构化分镜。"}>
        <button type="button" className="secondary">保存修改</button><button type="button" className="secondary">重新生成</button><button type="button" className="secondary success-outline">确认为可用</button><button type="button" className="primary wide" onClick={() => { if (next) onStep(next.id); else onNext(); }}>{next ? `下一步：生成${next.label}` : "下一步：生成分镜"}</button>
      </BottomAction>
    </section>
  );
}

function StoryboardStage({ shot }) {
  return (
    <section className="screen storyboard-screen" data-screen-label="分镜设计">
      <ScreenHeader eyebrow="第 3 步 · 分镜设计" title={`镜头 ${String(shot.id).padStart(2, "0")} · ${shot.title}`} description="镜头列表、内容与检查器保持同一上下文。结构操作不会覆盖历史版本。" status={shot.state} />
      <div className="shot-hero">
        <div className={`shot-preview-large preview-${shot.color}`}><span>画面构图预览</span><div className="scene-geometry"><i></i><b></b><em></em></div><small>{shot.frame}</small></div>
        <div className="shot-fields"><DocumentBlock label="画面描述" text={`清晨的冷色环境中，${shot.frame}。人物保持克制，背景光线形成轻微压迫感。`} /><div className="two-column-fields"><DocumentBlock label="运镜" text={shot.camera} /><DocumentBlock label="目标时长" text={`${shot.duration} 秒`} /></div><DocumentBlock label="对白 / 旁白" text={shot.dialogue} /></div>
      </div>
      <div className="quality-row"><div><span className="quality-icon">✓</span><div><strong>连续性检查通过</strong><small>角色、场景和 previous_shot 引用有效</small></div></div><div><span className="quality-icon warn">!</span><div><strong>1 条建议检查</strong><small>正脸长对白接近 4 秒阈值</small></div></div></div>
      <BottomAction hint="当前镜头已自动保存。整集确认后才能进入画面生成。"><button type="button" className="secondary">拆分镜头</button><button type="button" className="secondary">复制镜头</button><button type="button" className="secondary">保存修改</button><button type="button" className="primary wide">确认为可用</button></BottomAction>
    </section>
  );
}

function MediaStage({ kind, shot, selectedCandidate, setSelectedCandidate, onNext }) {
  const isVideo = kind === "video";
  const candidates = window.candidateSets[kind];
  return (
    <section className="screen media-screen" data-screen-label={isVideo ? "视频生成" : "画面生成"}>
      <ScreenHeader eyebrow={`第 ${isVideo ? "5" : "4"} 步 · ${isVideo ? "视频生成" : "画面生成"}`} title={`镜头 ${String(shot.id).padStart(2, "0")} · ${isVideo ? "视频候选" : "首帧候选"}`} description={`当前镜头已有 ${candidates.length} 个可用候选。预览、选用和重新生成使用一致操作。`} status={shot.state === "empty" ? "attention" : "done"} />
      <div className="selected-summary"><div><span className="summary-mark">{isVideo ? "视" : "图"}</span><div><small>当前选用</small><strong>{candidates.find((item) => item.id === selectedCandidate)?.label || "尚未选择"}</strong></div></div><button type="button" className="secondary">重新生成</button></div>
      <div className="candidate-grid">
        {candidates.map((item) => <CandidateCard key={item.id} item={item} kind={kind} selected={item.id === selectedCandidate} onSelect={() => setSelectedCandidate(item.id)} />)}
        <article className="candidate-generating"><div className="loading-orbit"><span></span></div><strong>生成新候选</strong><small>预计需要 30–60 秒</small><button type="button" className="secondary">开始生成</button></article>
      </div>
      <details className="failed-task"><summary>查看一次历史失败任务</summary><div><span className="failure-mark">!</span><p><strong>视频模型响应超时</strong><small>原候选和输入已保留，可以直接重试。</small></p><button type="button" className="secondary">重试</button></div></details>
      <BottomAction hint={isVideo ? "当前镜头已有选用视频；全部镜头完成后可以进入合成。" : "选用首帧后才能生成当前镜头的视频候选。"}><button type="button" className="secondary">批量生成剩余镜头</button><button type="button" className="primary wide" onClick={onNext}>{isVideo ? "下一步：合成导出" : "下一步：生成视频"}</button></BottomAction>
    </section>
  );
}

function CompositionStage({ timeline, setTimeline, exportState, setExportState }) {
  const [progress, setProgress] = React.useState(0);
  React.useEffect(() => {
    if (exportState !== "running") return undefined;
    const timer = window.setInterval(() => setProgress((value) => Math.min(100, value + 8)), 220);
    return () => window.clearInterval(timer);
  }, [exportState]);
  React.useEffect(() => { if (progress >= 100 && exportState === "running") setExportState("success"); }, [progress, exportState, setExportState]);
  const move = (index, direction) => { const next = [...timeline]; const target = index + direction; if (target < 0 || target >= next.length) return; const [item] = next.splice(index, 1); next.splice(target, 0, item); setTimeline(next); };
  const toggle = (index) => setTimeline(timeline.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: !item.enabled } : item));
  return (
    <section className="screen composition-screen" data-screen-label="合成导出">
      <ScreenHeader eyebrow="第 6 步 · 合成导出" title="整集预览与时间线" description="排序、启停和裁剪都创建新的时间线版本。导出前会再次检查所有媒体输入。" status={exportState === "success" ? "done" : "attention"} />
      <div className="episode-preview"><div className="preview-stage"><div className="video-frame"><span>整集预览</span><div className="scene-geometry"><i></i><b></b><em></em></div><button type="button" className="play-large">▶</button></div></div><div className="preview-meta"><strong>大富翁的每一天 · 第 1 集</strong><span>00:45 / 01:02</span></div></div>
      <div className="timeline-heading"><div><h3>镜头时间线</h3><p>6 个片段 · 当前总时长 45 秒</p></div><StatusPill status="warning">1 项需要处理</StatusPill></div>
      <div className="timeline-list">
        {timeline.map((item, index) => (
          <div className={!item.enabled ? "timeline-item disabled" : "timeline-item"} key={item.id}>
            <span className="drag-handle">⋮⋮</span><div className={`timeline-thumb thumb-${item.color}`}><b>{String(item.id).padStart(2, "0")}</b></div><div className="timeline-copy"><strong>{item.title}</strong><small>{item.duration} 秒 · {item.enabled ? "已启用" : "已跳过"}</small></div><label className="mini-toggle"><input type="checkbox" checked={item.enabled} onChange={() => toggle(index)} /><span></span></label><div className="trim-fields"><label>入点<input type="text" defaultValue="00:00.0" /></label><label>出点<input type="text" defaultValue={`00:0${Math.min(9, item.duration)}.0`} /></label></div><div className="order-actions"><button type="button" onClick={() => move(index, -1)} disabled={index === 0}>↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === timeline.length - 1}>↓</button></div>
          </div>
        ))}
      </div>
      {exportState !== "idle" && <div className={`export-progress ${exportState}`}><div><strong>{exportState === "success" ? "MP4 导出完成" : "正在合成视频"}</strong><span>{exportState === "success" ? "文件已通过时长、分辨率和解码校验" : `${progress}% · 正在混合原声与背景音乐`}</span></div><div className="progress-track"><span style={{ width: `${exportState === "success" ? 100 : progress}%` }}></span></div>{exportState === "success" && <button type="button" className="secondary">预览成片</button>}</div>}
      <BottomAction hint="镜头 04 的旧候选已过期；原型允许演示导出反馈，正式产品会阻断并要求修复。"><button type="button" className="secondary">保存时间线</button>{exportState === "running" ? <button type="button" className="danger wide" onClick={() => { setExportState("idle"); setProgress(0); }}>取消导出</button> : <button type="button" className="primary wide" onClick={() => { setProgress(4); setExportState("running"); }}>导出 MP4</button>}</BottomAction>
    </section>
  );
}

function ScreenHeader({ eyebrow, title, description, status }) { return <header className="screen-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><StatusPill status={status} /></header>; }
function DocumentBlock({ label, text }) { return <div className="document-block"><label>{label}</label><div contentEditable suppressContentEditableWarning>{text}</div></div>; }
function BeatRow({ index, title, time }) { return <div className="beat-row"><span>{index}</span><strong>{title}</strong><small>{time}</small><button type="button" className="text-action">编辑</button></div>; }
function BottomAction({ hint, children }) { return <footer className="bottom-action"><p><span className="hint-dot"></span>{hint}</p><div>{children}</div></footer>; }

function GuideDialog({ onClose }) { return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title" onMouseDown={(event) => event.stopPropagation()}><header><div><small>原型评审说明</small><h2 id="guide-title">建议按创作流程体验</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></header><ol><li><strong>切换六个阶段</strong><span>观察当前位置、状态和主要操作是否清楚。</span></li><li><strong>选择不同镜头</strong><span>确认左侧对象、中间内容与右侧检查器同步变化。</span></li><li><strong>切换候选与时间线</strong><span>体验选用、排序、启停和导出进度。</span></li><li><strong>调整布局密度</strong><span>比较紧凑与舒展模式的信息效率。</span></li></ol><p>本原型仅验证信息架构与交互，不调用真实模型或写入项目数据。</p><button type="button" className="primary wide" onClick={onClose}>开始体验</button></section></div>; }

function SettingsArea() { return <section className="standalone-screen" data-screen-label="设置"><ScreenHeader eyebrow="设置" title="模型服务" description="凭据和模型配置集中管理，创作页面只显示脱敏状态。" status="done" /><div className="settings-grid"><ModelCard name="文本模型" provider="Qwen" model="qwen-plus" /><ModelCard name="图片模型" provider="火山方舟 ARK" model="Seedream 5.0 Lite" /><ModelCard name="视频模型" provider="火山方舟 ARK" model="Seedance 2.5" /></div></section>; }
function ModelCard({ name, provider, model }) { return <article className="model-card"><div className="model-card-head"><span>{name.slice(0, 1)}</span><div><small>{name}</small><h3>{provider}</h3></div><StatusPill status="done">已配置</StatusPill></div><Definition label="当前模型" value={model} /><Definition label="凭据" value="已安全保存 · 末四位 9821" /><button type="button" className="secondary full-width">管理配置</button></article>; }
function PlaceholderArea({ area, onReturn }) { const item = window.globalAreas.find((entry) => entry.id === area); return <section className="standalone-screen placeholder-area" data-screen-label={item.label}><span className="placeholder-mark">{item.mark}</span><h1>{item.label}</h1><p>该区域在正式产品中使用真实数据。原型重点验证六阶段创作工作台，不伪造额外业务记录。</p><button type="button" className="secondary" onClick={onReturn}>返回创作工作台</button></section>; }

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
  const [timeline, setTimeline] = React.useState(window.shots.map((shot) => ({ ...shot, enabled: true })));
  const shot = window.shots.find((item) => item.id === selectedShot) || window.shots[0];
  const stageLabel = window.productionStages.find((item) => item.id === stage)?.label || "创作工作台";
  const changeArea = (area) => { setActiveArea(area); if (area === "workspace") setInspectorOpen(true); };
  const nextStage = (id) => { setStage(id); setInspectorTab("common"); };
  return (
    <div className={`prototype-shell density-${density}`}>
      <GlobalSidebar activeArea={activeArea} onNavigate={changeArea} />
      {activeArea === "workspace" ? (
        <main className="workspace-shell">
          <ProjectFlow stage={stage} onStage={nextStage} scriptStep={scriptStep} onScriptStep={setScriptStep} selectedShot={selectedShot} onShot={setSelectedShot} />
          <section className="content-column">
            <Topbar stageLabel={stageLabel} density={density} setDensity={setDensity} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} setGuideOpen={setGuideOpen} />
            <div className="canvas-scroll" key={stage}>
              {stage === "input" && <InputStage onNext={() => nextStage("script")} />}
              {stage === "script" && <ScriptStage step={scriptStep} onStep={setScriptStep} onNext={() => nextStage("storyboard")} />}
              {stage === "storyboard" && <StoryboardStage shot={shot} />}
              {stage === "image" && <MediaStage kind="image" shot={shot} selectedCandidate={imageCandidate} setSelectedCandidate={setImageCandidate} onNext={() => nextStage("video")} />}
              {stage === "video" && <MediaStage kind="video" shot={shot} selectedCandidate={videoCandidate} setSelectedCandidate={setVideoCandidate} onNext={() => nextStage("composition")} />}
              {stage === "composition" && <CompositionStage timeline={timeline} setTimeline={setTimeline} exportState={exportState} setExportState={setExportState} />}
            </div>
          </section>
          {inspectorOpen && <Inspector stage={stage} tab={inspectorTab} setTab={setInspectorTab} shot={shot} exportState={exportState} onClose={() => setInspectorOpen(false)} />}
        </main>
      ) : (
        <main className="area-shell"><Topbar stageLabel={window.globalAreas.find((item) => item.id === activeArea)?.label || ""} density={density} setDensity={setDensity} inspectorOpen={false} setInspectorOpen={() => {}} setGuideOpen={setGuideOpen} />{activeArea === "settings" ? <SettingsArea /> : <PlaceholderArea area={activeArea} onReturn={() => changeArea("workspace")} />}</main>
      )}
      {guideOpen && <GuideDialog onClose={() => setGuideOpen(false)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
