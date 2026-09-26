import { useState } from 'react';

import { ProviderSettings } from './ProviderSettings';
import { readCreatorPreferences, saveCreatorPreferences } from '../project/creator-preferences';

const SERVICES = [
  ['文字创作服务', '用于生成剧本、大纲、分镜文案与文本内容。', 'text'],
  ['画面生成服务', '用于将文字变成角色、场景和分镜画面。', 'image'],
  ['视频生成服务', '用于将画面和分镜生成动态视频片段。', 'video'],
  ['语音与配乐服务', '用于生成角色配音、旁白以及背景音乐。', 'audio'],
] as const;

type ServiceIconName = (typeof SERVICES)[number][2] | 'privacy';

const ServiceIcon = ({ name }: { readonly name: ServiceIconName }) => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
    {name === 'text' && (
      <>
        <path d="M6 3.5h9l3 3v14H6z" />
        <path d="M9 9h6M9 12.5h6M9 16h4" />
      </>
    )}
    {name === 'image' && (
      <>
        <rect height="15" rx="1.5" width="18" x="3" y="4.5" />
        <circle cx="8" cy="9" r="1.5" />
        <path d="m5.5 17 4-4 3 3 2.5-2.5 3.5 3.5" />
      </>
    )}
    {name === 'video' && <path d="m9 7 8 5-8 5z" />}
    {name === 'audio' && (
      <>
        <path d="M10 18V7l8-2v11" />
        <circle cx="7.5" cy="18" r="2.5" />
        <circle cx="15.5" cy="16" r="2.5" />
      </>
    )}
    {name === 'privacy' && (
      <>
        <path d="M12 3 19 6v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6z" />
        <path d="m9.5 12 1.7 1.7 3.5-4" />
      </>
    )}
  </svg>
);

export interface ApprovedSettingsWorkspaceProps {
  readonly onBack?: () => void;
}

export const ApprovedSettingsWorkspace = ({ onBack }: ApprovedSettingsWorkspaceProps) => {
  const [preferences, setPreferences] = useState(readCreatorPreferences);
  const [textReady, setTextReady] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [showStorageInfo, setShowStorageInfo] = useState(false);

  return (
    <section className="approved-settings-page" aria-labelledby="settings-title">
      {onBack !== undefined && (
        <button className="approved-settings-back" onClick={onBack} type="button">
          ← 返回
        </button>
      )}
      <header>
        <h1 id="settings-title">设置</h1>
        <p>根据你的创作习惯，配置 AI 服务与偏好，让灵感更快变成故事。</p>
      </header>

      <div className="approved-preference-panel">
        <div>
          <h2>创作偏好</h2>
          <p>这些默认选项保存在本机，并用于新建项目。</p>
        </div>
        <fieldset>
          <legend>默认作品类型</legend>
          {(['每次询问', '漫剧', '短剧'] as const).map((item) => (
            <button
              aria-pressed={preferences.defaultType === item}
              className={preferences.defaultType === item ? 'active' : ''}
              key={item}
              onClick={() => {
                setPreferences((current) => ({ ...current, defaultType: item }));
                setSaveNotice(null);
              }}
              type="button"
            >
              {item}
            </button>
          ))}
        </fieldset>
        <fieldset>
          <legend>默认画面比例</legend>
          {(['竖屏', '横屏'] as const).map((item) => (
            <button
              aria-pressed={preferences.defaultAspect === item}
              className={preferences.defaultAspect === item ? 'active' : ''}
              key={item}
              onClick={() => {
                setPreferences((current) => ({ ...current, defaultAspect: item }));
                setSaveNotice(null);
              }}
              type="button"
            >
              {item}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="approved-service-list">
        {SERVICES.map(([title, copy, icon], index) => {
          const status = index === 0 ? (textReady ? '已设置' : '未设置') : '需要检查';
          return (
            <article key={title}>
              <span className="service-icon">
                <ServiceIcon name={icon} />
              </span>
              <div>
                <strong>{title}</strong>
                <small>{copy}</small>
              </div>
              <span className={status === '已设置' ? 'status-ok' : 'status-warn'}>{status}</span>
              <button
                className="approved-service-manage"
                onClick={() => {
                  setAdvancedOpen(true);
                  globalThis.setTimeout(() => {
                    document
                      .getElementById(`settings-service-${String(index)}`)
                      ?.scrollIntoView({ block: 'nearest' });
                  }, 0);
                }}
                type="button"
              >
                管理
              </button>
            </article>
          );
        })}
      </div>

      <section className="approved-privacy-row">
        <span className="service-icon">
          <ServiceIcon name="privacy" />
        </span>
        <div>
          <h2>数据与隐私</h2>
          <p>作品与素材保存在本机，不会自动上传到云端。</p>
        </div>
        <button
          aria-expanded={showStorageInfo}
          onClick={() => {
            setShowStorageInfo((open) => !open);
          }}
          type="button"
        >
          了解存储方式
        </button>
      </section>
      {showStorageInfo && (
        <p className="approved-storage-info">
          创作偏好保存在本机应用存储中；项目数据由桌面应用管理。为保护本地文件安全，页面不提供直接修改数据库路径的入口。
        </p>
      )}

      <details
        className="approved-service-details"
        onToggle={(event) => {
          setAdvancedOpen(event.currentTarget.open);
        }}
        open={advancedOpen}
      >
        <summary>服务详细配置</summary>
        <ProviderSettings onReadyChange={setTextReady} />
      </details>

      <button
        className="approved-settings-save"
        onClick={() => {
          setSaveNotice(
            saveCreatorPreferences(preferences)
              ? '创作偏好已保存在本机，新建项目时生效。'
              : '保存失败：请检查应用存储权限后重试。',
          );
        }}
        type="button"
      >
        保存设置
      </button>
      {saveNotice !== null && <p role="status">{saveNotice}</p>}
    </section>
  );
};
