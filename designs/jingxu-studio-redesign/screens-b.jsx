// 屏组 B：分镜设计、画面生成 / 视频生成（复用同一镜头上下文）。
const { ScreenHead, BottomBar, DocBlock, ToneFrame, Stat, I } = window;

function StoryboardStage({ direction, shot }) {
  const shotNo = String(shot.id).padStart(2, "0");
  return (
    <section className="screen storyboard-screen" data-screen-label="分镜设计">
      <ScreenHead
        stageIndex="03" stageTotal="06" cnIndex="三" direction={direction}
        title={`镜头 ${shotNo} · ${shot.title}`}
        description="镜头列表、内容与检查器保持同一上下文。结构操作不会覆盖历史版本。"
        status={shot.state}
      />
      <div className="panel-card shot-hero">
        <ToneFrame tone={shot.color} className="shot-preview-large" kick="构图示意" num={shotNo}>
          <small>{shot.frame}</small>
        </ToneFrame>
        <div className="shot-fields">
          <DocBlock label="画面描述" text={`清晨的冷色环境中，${shot.frame}。人物保持克制，背景光线形成轻微压迫感。`} />
          <div className="two-column-fields">
            <DocBlock label={shot.locked ? "运镜（已锁定）" : "运镜"} text={shot.camera} locked={shot.locked} />
            <DocBlock label="目标时长" text={`${shot.duration} 秒`} />
          </div>
          <DocBlock label="对白 / 旁白" text={shot.dialogue} />
        </div>
      </div>
      <div className="quality-row">
        <div>
          <span className="quality-mark" aria-hidden="true"></span>
          <div>
            <strong>连续性检查通过</strong>
            <small>角色、场景和 previous_shot 引用有效</small>
          </div>
        </div>
        <div>
          <span className="quality-mark warn" aria-hidden="true"></span>
          <div>
            <strong>1 条建议检查</strong>
            <small>正脸长对白接近 4 秒阈值</small>
          </div>
        </div>
      </div>
      <BottomBar hint="当前镜头已自动保存。整集确认后才能进入画面生成。">
        <button type="button" className="secondary">拆分镜头</button>
        <button type="button" className="secondary">复制镜头</button>
        <button type="button" className="secondary">保存修改</button>
        <button type="button" className="primary wide">确认为可用</button>
      </BottomBar>
    </section>
  );
}

function CandidateCard({ item, kind, selected, onSelect }) {
  const isVideo = kind === "video";
  return (
    <article className={selected ? "candidate-card selected" : "candidate-card"}>
      <ToneFrame tone={item.color} className="candidate-preview" kick={isVideo ? "视频预览" : "画面候选"} fig={!isVideo}>
        {isVideo && <button type="button" className="play-button" aria-label="播放视频"><I name="play" size={18} /></button>}
        {selected && <span className="selected-flag">当前选用</span>}
      </ToneFrame>
      <div className="candidate-copy">
        <div>
          <strong>{item.label}</strong>
          <small>{item.note}</small>
        </div>
        <Stat status={selected ? "done" : "active"}>{item.score}</Stat>
      </div>
      <div className="candidate-actions">
        <button type="button" className="secondary">预览</button>
        <button type="button" className={selected ? "secondary" : "primary"} onClick={onSelect}>{selected ? "已选用" : "选用"}</button>
      </div>
    </article>
  );
}

function MediaStage({ direction, kind, shot, selectedCandidate, setSelectedCandidate, onNext }) {
  const isVideo = kind === "video";
  const candidates = window.candidateSets[kind];
  const chosen = candidates.find((item) => item.id === selectedCandidate);
  const hasCandidates = !["empty", "failed"].includes(shot.state);
  return (
    <section className="screen media-screen" data-screen-label={isVideo ? "视频生成" : "画面生成"}>
      <ScreenHead
        stageIndex={isVideo ? "05" : "04"} stageTotal="06" cnIndex={isVideo ? "五" : "四"} direction={direction}
        title={`镜头 ${String(shot.id).padStart(2, "0")} · ${isVideo ? "视频候选" : "首帧候选"}`}
        description={hasCandidates
          ? `当前镜头已有 ${candidates.length} 个可用候选。预览、选用和重新生成使用一致操作。`
          : shot.state === "failed" ? "上一个生成任务失败。原始输入已保留，可以直接重试。" : "当前镜头还没有生成结果。"}
        status={shot.state}
      />
      {shot.state === "failed" ? (
        <div className="state-banner is-failed">
          <span className="banner-mark"><I name="refresh" size={18} /></span>
          <p>
            <strong>{isVideo ? "视频候选生成失败" : "首帧候选生成失败"}</strong>
            <small>{shot.failure} · 输入与历史候选已保留，重试不会覆盖它们。</small>
          </p>
          <button type="button" className="primary">重试生成</button>
        </div>
      ) : shot.state === "empty" ? (
        <div className="state-banner">
          <span className="banner-mark"><I name={isVideo ? "film" : "image"} size={18} /></span>
          <p>
            <strong>{isVideo ? "尚未生成视频候选" : "尚未生成首帧候选"}</strong>
            <small>{isVideo ? "需要先在画面生成阶段选用首帧。" : "将按当前镜头契约生成 2–3 个候选，预计 30–60 秒。"}</small>
          </p>
          <button type="button" className="primary">{isVideo ? "查看首帧" : "开始生成"}</button>
        </div>
      ) : (
        <>
          <div className="selected-summary">
            <div className="left">
              <ToneFrame tone={shot.color} className="summary-thumb" />
              <div>
                <small>当前选用</small>
                <strong>{chosen ? chosen.label : "尚未选择"}</strong>
              </div>
            </div>
            <button type="button" className="secondary"><I name="refresh" size={14} />重新生成</button>
          </div>
          <div className="candidate-grid">
            {candidates.map((item) => (
              <CandidateCard key={item.id} item={item} kind={kind} selected={item.id === selectedCandidate} onSelect={() => setSelectedCandidate(item.id)} />
            ))}
            <article className="candidate-generating">
              <span className="pulse-dot" aria-hidden="true"></span>
              <strong>生成新候选</strong>
              <small>预计需要 30–60 秒</small>
              <button type="button" className="secondary">开始生成</button>
            </article>
          </div>
          <details className="failed-task">
            <summary>查看一次历史失败任务</summary>
            <div>
              <span className="failure-mark" aria-hidden="true"></span>
              <p>
                <strong>视频模型响应超时</strong>
                <small>原候选和输入已保留，可以直接重试。</small>
              </p>
              <button type="button" className="secondary">重试</button>
            </div>
          </details>
        </>
      )}
      <BottomBar hint={isVideo ? "当前镜头已有选用视频；全部镜头完成后可以进入合成。" : "选用首帧后才能生成当前镜头的视频候选。"}>
        <button type="button" className="secondary">批量生成剩余镜头</button>
        <button type="button" className="primary wide" onClick={onNext}>{isVideo ? "下一步：合成导出" : "下一步：生成视频"}</button>
      </BottomBar>
    </section>
  );
}

Object.assign(window, { StoryboardStage, MediaStage });
