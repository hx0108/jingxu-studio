// 屏组 C：合成导出（含配音与字幕）、模型服务设置、占位区域。
const { ScreenHead, BottomBar, ToneFrame, Stat, Seg, I, secToTc, pad2 } = window;

function CompositionStage({ direction, timeline, setTimeline, exportState, setExportState }) {
  const [progress, setProgress] = React.useState(0);
  const voice = window.voiceSetup;
  React.useEffect(() => {
    if (exportState !== "running") return undefined;
    const timer = window.setInterval(() => setProgress((value) => Math.min(100, value + 8)), 220);
    return () => window.clearInterval(timer);
  }, [exportState]);
  React.useEffect(() => {
    if (progress >= 100 && exportState === "running") setExportState("success");
  }, [progress, exportState, setExportState]);
  const move = (index, delta) => {
    const next = [...timeline];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setTimeline(next);
  };
  const toggle = (index) => setTimeline(timeline.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: !item.enabled } : item));
  const totalSeconds = timeline.filter((item) => item.enabled).reduce((sum, item) => sum + item.duration, 0);
  return (
    <section className="screen composition-screen" data-screen-label="合成导出">
      <ScreenHead
        stageIndex="06" stageTotal="06" cnIndex="六" direction={direction}
        title="整集预览与时间线"
        description="排序、启停和裁剪都创建新的时间线版本。导出前会再次检查所有媒体输入。"
        status={exportState === "success" ? "done" : "attention"}
      />
      <div className="panel-card episode-preview">
        <div className="preview-stage">
          <ToneFrame tone="blue" className="video-frame" kick="整集预览" num="9:16">
            <button type="button" className="play-button" aria-label="播放整集预览"><I name="play" size={18} /></button>
          </ToneFrame>
          <div className="preview-meta">
            <strong>大富翁的每一天 · 第 1 集</strong>
            <span className="tc">00:45 / 01:02</span>
          </div>
        </div>
      </div>
      <div className="audio-strip">
        <span className="strip-item"><I name="mic" size={14} />配音 <strong>{voice.narrator}</strong></span>
        <span className="strip-item"><I name="music" size={14} />{voice.bgm} · <span className="tc">{voice.bgmLength}</span> · 音量 <span className="tc">{voice.bgmVolume}</span></span>
        <span className="spacer"></span>
        <span className="strip-item"><I name="subs" size={14} />字幕 {voice.subtitle ? "已开启" : "已关闭"}</span>
      </div>
      <div className="timeline-heading">
        <div>
          <h3>镜头时间线</h3>
          <p>{timeline.length} 个片段 · 当前总时长 <span className="tc">{secToTc(totalSeconds)}</span></p>
        </div>
        <Stat status="warning">1 项需要处理</Stat>
      </div>
      <div className="timeline-list">
        {(() => {
          let cursor = 0;
          return timeline.map((item, index) => {
            const start = cursor;
            const end = cursor + item.duration;
            cursor = end;
            const rowClass = [
              "timeline-item",
              item.enabled ? "" : "disabled",
              item.state === "stale" ? "stale" : "",
            ].filter(Boolean).join(" ");
            return (
              <div className={rowClass} key={item.id}>
                <span className="drag-handle" aria-hidden="true"><I name="drag" size={12} /></span>
                <ToneFrame tone={item.color} className="timeline-thumb" num={pad2(item.id)} fig={false} />
                <div className="timeline-copy">
                  <strong>{item.title}</strong>
                  <small>
                    <span className="tc">{secToTc(start)}–{secToTc(end)}</span>
                    {item.state === "stale" && <span> · 候选已过期</span>}
                    {item.state !== "stale" && <span> · {item.enabled ? "已启用" : "已跳过"}</span>}
                  </small>
                </div>
                <label className="mini-toggle">
                  <input type="checkbox" checked={item.enabled} onChange={() => toggle(index)} />
                  <span></span>
                </label>
                <div className="trim-fields">
                  <label>入点<input type="text" defaultValue={secToTc(start)} /></label>
                  <label>出点<input type="text" defaultValue={secToTc(end)} /></label>
                </div>
                <div className="order-actions">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移"><I name="up" size={12} /></button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === timeline.length - 1} aria-label="下移"><I name="down" size={12} /></button>
                </div>
              </div>
            );
          });
        })()}
      </div>
      {exportState !== "idle" && (
        <div className={`export-progress ${exportState}`}>
          <div>
            <strong>{exportState === "success" ? "MP4 导出完成" : "正在合成视频"}</strong>
            <span>{exportState === "success" ? "文件已通过时长、分辨率和解码校验" : <><span className="tc">{progress}%</span> · 正在混合配音与背景音乐</>}</span>
          </div>
          <div className="progress-track"><span style={{ width: `${exportState === "success" ? 100 : progress}%` }}></span></div>
          {exportState === "success" && <button type="button" className="secondary">预览成片</button>}
        </div>
      )}
      <BottomBar hint="镜头 04 的旧候选已过期；原型允许演示导出反馈，正式产品会阻断并要求修复。">
        <button type="button" className="secondary">保存时间线</button>
        {exportState === "running"
          ? <button type="button" className="danger wide" onClick={() => { setExportState("idle"); setProgress(0); }}>取消导出</button>
          : <button type="button" className="primary wide" onClick={() => { setProgress(4); setExportState("running"); }}>导出 MP4</button>}
      </BottomBar>
    </section>
  );
}

function SettingsArea({ direction }) {
  return (
    <section className="standalone-screen" data-screen-label="设置">
      <div className="screen-header">
        <div>
          <div className="screen-kicker"><span>设置</span></div>
          <h1>模型服务</h1>
          <p className="settings-intro">凭据和模型配置集中管理，创作页面只显示脱敏状态。</p>
        </div>
      </div>
      <div className="provider-list">
        {window.providers.map((provider) => (
          <article className="provider-row" key={provider.kind}>
            <span className="provider-kind"><I name={provider.icon} size={16} />{provider.kind}</span>
            <div className="provider-name">
              <strong>{provider.name}</strong>
              <small>Provider</small>
            </div>
            <span className="provider-model">{provider.model}</span>
            <div className="provider-cred">
              <span className="cred-line">{provider.cred}</span>
              <Stat status="done">已配置</Stat>
            </div>
            <button type="button" className="secondary">管理配置</button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PlaceholderArea({ area, onReturn }) {
  const item = window.globalAreas.find((entry) => entry.id === area);
  return (
    <section className="standalone-screen placeholder-area" data-screen-label={item.label}>
      <span className="import-mark"><I name={item.icon} size={22} /></span>
      <h1>{item.label}</h1>
      <p>该区域在正式产品中使用真实数据。原型重点验证六阶段创作工作台，不伪造额外业务记录。</p>
      <button type="button" className="secondary" onClick={onReturn}>返回创作工作台</button>
    </section>
  );
}

Object.assign(window, { CompositionStage, SettingsArea, PlaceholderArea });
