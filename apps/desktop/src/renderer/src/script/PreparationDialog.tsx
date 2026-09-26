import type { CreatorPreparationResultDto } from '@jingxu/contracts';

export const PreparationDialog = ({
  onCancel,
  onConfirm,
  onFix,
  pending,
  preparation,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onFix: (
    fixAction: NonNullable<CreatorPreparationResultDto['items'][number]['fixAction']>,
  ) => void;
  readonly pending: boolean;
  readonly preparation: CreatorPreparationResultDto;
}) => (
  <div className="dialog-backdrop">
    <section
      aria-labelledby="preparation-title"
      aria-modal="true"
      className="dialog-card preparation-dialog"
      role="dialog"
    >
      <header>
        <p className="eyebrow">生成前检查</p>
        <h2 id="preparation-title">确认本次生成准备</h2>
        {preparation.isDemo && <p className="demo-result-notice">演示结果 · 不会产生真实费用</p>}
      </header>
      <ul className="preparation-list">
        {preparation.items.map((item) => (
          <li className={`preparation-${item.status.toLowerCase()}`} key={item.code}>
            <div>
              <strong>{item.label}</strong>
              <span>
                {item.status === 'READY' ? '已准备' : item.status === 'WARN' ? '请留意' : '需处理'}
              </span>
            </div>
            <p>{item.detail}</p>
            {item.fixAction !== null && (
              <button
                className="secondary-button"
                onClick={() => {
                  if (item.fixAction !== null) onFix(item.fixAction);
                }}
                type="button"
              >
                去处理
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="preparation-summary">
        <p>
          预计时长：
          {preparation.estimatedDurationSec === null
            ? '暂不可用'
            : `${String(preparation.estimatedDurationSec)} 秒`}
        </p>
        <p>
          参考成本：
          {preparation.isDemo
            ? '零真实费用'
            : preparation.cost.status === 'AVAILABLE'
              ? `${preparation.cost.currency ?? ''} ${String(preparation.cost.min)}–${String(preparation.cost.max)}`
              : preparation.cost.status === 'STALE'
                ? '价格已过期'
                : '暂不可用'}
        </p>
      </div>
      <footer className="dialog-actions">
        <button disabled={pending} onClick={onCancel} type="button">
          返回修改
        </button>
        <button
          data-primary-action
          disabled={!preparation.canProceed || pending}
          onClick={onConfirm}
          type="button"
        >
          {pending ? '正在重新检查…' : '确认并开始'}
        </button>
      </footer>
    </section>
  </div>
);
