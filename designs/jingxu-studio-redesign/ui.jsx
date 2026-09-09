// 共享 UI 原语：状态文字、分段控件、屏头、色块帧、检查器条目。
const { statusCopy, pad2 } = window;

function Stat({ status, children }) {
  return <span className={`stat ${status}`}>{children || statusCopy[status] || "状态待确认"}</span>;
}

function Seg({ options, value, onChange, ariaLabel, extraClass }) {
  return (
    <div className={`seg ${extraClass || ""}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ScreenHead({ stageIndex, stageTotal, cnIndex, direction, title, description, status }) {
  return (
    <header className="screen-header">
      <div>
        <div className="screen-kicker">
          {direction === "ink" && cnIndex
            ? <span className="cn-kicker">第{cnIndex}阶段 · 共六</span>
            : <><span className="tc">{stageIndex} / {stageTotal}</span><span>阶段</span></>}
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {status && <Stat status={status} />}
    </header>
  );
}

function BottomBar({ hint, children }) {
  return (
    <footer className="bottom-action">
      <p><span className="hint-mark"></span>{hint}</p>
      <div>{children}</div>
    </footer>
  );
}

function DocBlock({ label, text, locked }) {
  return (
    <div className={locked ? "document-block locked" : "document-block"}>
      <label>{label}{locked && <window.I name="lock" size={12} />}</label>
      <div contentEditable={!locked} suppressContentEditableWarning>{text}</div>
    </div>
  );
}

// 平涂色块 + 1px 构图线：诚实的「示意帧」，代替旧版的渐变光晕假场景。
function ToneFrame({ tone, kick, num, fig = true, className = "", children }) {
  return (
    <span className={`tone-frame tone-${tone} ${className}`}>
      {kick && <span className="kick">{kick}</span>}
      {num && <span className="num">{num}</span>}
      <span className="wire" aria-hidden="true"></span>
      {fig && <i className="fig" aria-hidden="true"></i>}
      {children}
    </span>
  );
}

function InspectorSection({ title, children }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

function DefRow({ label, value, mono }) {
  return <div className="definition"><span>{label}</span><strong className={mono ? "tc" : ""}>{value}</strong></div>;
}

function CheckRow({ label, ok, warn, value }) {
  return (
    <div className={`check-row ${warn ? "warn" : ""}`}>
      <span className="mark" aria-hidden="true"></span>
      <span>{label}</span>
      {value && <strong>{value}</strong>}
    </div>
  );
}

Object.assign(window, { Stat, Seg, ScreenHead, BottomBar, DocBlock, ToneFrame, InspectorSection, DefRow, CheckRow });
