// 屏组 A：创作输入、剧本开发。
const { Seg, ScreenHead, BottomBar, DocBlock, Stat, I } = window;

function InputStage({ direction, onNext }) {
  const [mode, setMode] = React.useState("original");
  const [text, setText] = React.useState("一个隐瞒巨额财富的普通上班族，每天醒来都会收到一笔神秘转账，但每花一分钱，就会有人更接近他的真实身份。");
  const enough = text.trim().length >= 20;
  return (
    <section className="screen input-screen" data-screen-label="创作输入">
      <ScreenHead
        stageIndex="01" stageTotal="06" cnIndex="一" direction={direction}
        title="从一个故事种子开始"
        description="选择原创创意或导入已有剧本。原文会完整保留，系统不会静默截断。"
        status="done"
      />
      <div className="seg mode-tabs">
        <Seg
          ariaLabel="输入方式"
          value={mode}
          onChange={setMode}
          options={[{ value: "original", label: "原创创意" }, { value: "import", label: "导入已有剧本" }]}
        />
      </div>
      {mode === "original" ? (
        <div className="panel-card editor-card large-editor">
          <label htmlFor="idea">创意内容</label>
          <textarea id="idea" value={text} onChange={(event) => setText(event.target.value)}></textarea>
          <div className="field-meta">
            <span className={enough ? "valid" : "invalid"}><span className="tc">{text.length} / 2,000</span> 字符 · 最少 20 个</span>
            <span>支持中文、英文和标点</span>
          </div>
        </div>
      ) : (
        <div className="import-drop">
          <span className="import-mark"><I name="doc" size={20} /></span>
          <h3>选择 TXT 或 Markdown 文件</h3>
          <p>文件由系统对话框读取，不会向界面暴露本地路径。</p>
          <button type="button" className="primary">选择文件</button>
          <small>最大 30,000 个 Unicode 字符</small>
        </div>
      )}
      <label className="consent">
        <input type="checkbox" defaultChecked />
        <span>我确认将以上内容发送给已配置的文本模型处理，并已阅读数据处理说明。</span>
      </label>
      <BottomBar hint={enough ? "内容有效，可以创建工作区。" : "还需输入至少 20 个字符。"}>
        <button type="button" className="primary wide" disabled={!enough} onClick={onNext}>创建剧本工作区</button>
      </BottomBar>
    </section>
  );
}

function BeatRow({ index, title, time }) {
  return (
    <div className="beat-row">
      <span>{index}</span>
      <strong>{title}</strong>
      <small className="tc">{time}</small>
      <button type="button" className="text-action">编辑</button>
    </div>
  );
}

function ScriptStage({ direction, step, onStep, onNext }) {
  const stepIndex = window.scriptSteps.findIndex((item) => item.id === step);
  const current = window.scriptSteps[stepIndex];
  const next = window.scriptSteps[stepIndex + 1];
  return (
    <section className="screen script-screen" data-screen-label="剧本开发">
      <ScreenHead
        stageIndex="02" stageTotal="06" cnIndex="二" direction={direction}
        title={`${current.label} · ${stepIndex + 1}/5`}
        description="内容可直接编辑。确认后会创建新版本，并解锁下一阶段。"
        status={current.status === "done" ? "done" : "draft"}
      />
      <div className="panel-card script-document">
        <div className="document-toolbar">
          <span>结构化正文</span>
          <div>
            <button type="button" className="text-action">对比版本</button>
            <button type="button" className="text-action">恢复历史</button>
          </div>
        </div>
        {step === "concept" && <>
          <DocBlock label="一句话梗概" text="一个靠神秘转账成为隐形富豪的上班族，在追查金钱来源时发现自己正被一套精密系统观察。" />
          <DocBlock label="核心冲突" text="他必须在维持普通生活与查明财富真相之间做出选择，而每次消费都会暴露新的身份线索。" />
        </>}
        {step === "bible" && <>
          <DocBlock label="世界规则" text="每天 06:00，账户会自动增加 8,888,888 元；当天未消费的部分会在午夜冻结。任何消费都会触发一次现实中的「回声事件」。" />
          <DocBlock label="主角弧光" text="林峥从隐藏财富、逃避关系，逐步学会承担选择的代价，并主动追踪系统背后的控制者。" />
          <DocBlock label="关键角色（已锁定）" text="林峥｜谨慎克制的隐形富豪；林知夏｜观察敏锐的妹妹；周沉｜身份不明的金融调查员。" locked />
        </>}
        {step === "outline" && <>
          <DocBlock label="本集目标" text="建立神秘转账规则，暴露跟踪者，并在午夜冻结账户作为集尾钩子。" />
          <DocBlock label="三段结构" text="清晨到账与伪装日常 → 跟踪迹象升级 → 交易失败与账户冻结。" />
        </>}
        {step === "beats" && <div className="beat-list">
          <BeatRow index="01" title="余额提醒" time="00:00–00:08" />
          <BeatRow index="02" title="早餐试探" time="00:08–00:22" />
          <BeatRow index="03" title="跟踪升级" time="00:22–00:48" />
          <BeatRow index="04" title="午夜冻结" time="00:48–01:02" />
        </div>}
        {step === "scene" && <>
          <DocBlock label="场景 01 · 顶层公寓 · 清晨" text="手机震动。林峥睁眼，屏幕上的余额数字映在他的瞳孔里。他没有惊讶，只熟练地关闭提醒。餐桌另一端，林知夏观察着他。" />
          <DocBlock label="场景 02 · 电梯 · 早晨" text="一个陌生男人站在角落，准确说出林峥每天出门的时间。电梯数字逐层下降，空气变得凝固。" />
        </>}
      </div>
      <BottomBar hint={next ? `确认后可继续：${next.label}` : "场景剧本确认后可以生成结构化分镜。"}>
        <button type="button" className="secondary">保存修改</button>
        <button type="button" className="secondary">重新生成</button>
        <button type="button" className="secondary">确认为可用</button>
        <button type="button" className="primary wide" onClick={() => { if (next) onStep(next.id); else onNext(); }}>
          {next ? `下一步：生成${next.label}` : "下一步：生成分镜"}
        </button>
      </BottomBar>
    </section>
  );
}

Object.assign(window, { InputStage, ScriptStage });
