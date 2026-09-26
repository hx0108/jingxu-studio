import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';
import { isProviderReadyForGeneration } from './script-ui-policy';

import { ImageProviderCard } from './ImageProviderCard';
import { AgnesVideoProviderCard } from './VideoProviderCard';
import { VoiceProviderCard } from './VoiceProviderCard';

const PROFILE_ID = 'profile_qwen_primary';

/** 设置页按创作任务分组；具体厂商和模型只在展开对应配置后出现。 */
export const GENERATION_SERVICE_GROUPS = ['文本生成', '画面生成', '视频生成', '配音'] as const;

export interface ProviderSettingsProps {
  readonly onReadyChange: (ready: boolean) => void;
  readonly mode?: 'settings' | 'status';
  readonly onOpenSettings?: () => void;
}

export const ProviderSettings = ({
  onReadyChange,
  mode = 'settings',
  onOpenSettings,
}: ProviderSettingsProps) => {
  const [profile, setProfile] = useState<ProviderProfileDto | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getProviderClient()
      .getProfile({ profileId: PROFILE_ID })
      .then((result) => {
        if (!active) return;
        if (!result.ok) setError(result.error);
        else {
          setProfile(result.data);
          setWorkspaceId(result.data.workspaceId);
        }
      })
      .catch(() => {
        if (active) setError(rendererTransportError());
      });
    return () => {
      active = false;
    };
  }, [onReadyChange]);

  const apply = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
    setPending(true);
    setError(null);
    setFeedback('正在处理…');
    try {
      const result = (await operation()) as
        | { readonly ok: true; readonly data: ProviderProfileDto }
        | { readonly ok: false; readonly error: AppErrorDto };
      if (!result.ok) {
        setError(result.error);
        setFeedback('');
        return false;
      }
      setProfile(result.data);
      setWorkspaceId(result.data.workspaceId);
      setFeedback(success);
      return true;
    } catch {
      setError(rendererTransportError());
      setFeedback('');
      return false;
    } finally {
      setPending(false);
    }
  };

  const ready = isProviderReadyForGeneration(
    profile === null ? null : { ...profile, workspaceId: workspaceId.trim() },
  );

  useEffect(() => {
    onReadyChange(ready);
  }, [onReadyChange, ready]);

  if (profile === null && error === null)
    return <p aria-live="polite">正在读取文本生成服务状态…</p>;
  if (mode === 'status') {
    return (
      <section className="model-status-card" aria-labelledby="model-status-title">
        <div className="section-heading-compact">
          <div>
            <small>生成服务</small>
            <h3 id="model-status-title">创作能力状态</h3>
          </div>
          <button className="text-button" onClick={onOpenSettings} type="button">
            前往配置
          </button>
        </div>
        <ul className="model-status-list">
          <li>
            <span>文本生成</span>
            <strong>{ready ? '已配置' : '未配置'}</strong>
          </li>
          <li>
            <span>画面生成</span>
            <strong>在设置中管理</strong>
          </li>
          <li>
            <span>视频生成</span>
            <strong>在设置中管理</strong>
          </li>
        </ul>
        {!ready && <p className="action-hint">连接并验证文本生成服务后才能生成剧本内容。</p>}
        {error !== null && (
          <details className="technical-details">
            <summary>查看连接问题</summary>
            <p>{error.message}</p>
            <code>{error.code}</code>
          </details>
        )}
      </section>
    );
  }
  return (
    <div className="model-service-list">
      <section
        aria-labelledby="text-generation-service-title"
        className="generation-service-group"
        id="settings-service-0"
      >
        <h2 id="text-generation-service-title">{GENERATION_SERVICE_GROUPS[0]}</h2>
        <p>用于将创意发展成剧本与分镜。</p>
        <details className="script-card model-service-card">
          <summary className="model-service-heading">
            <span aria-hidden="true" className="model-service-mark">
              文
            </span>
            <div>
              <p className="eyebrow">文本模型</p>
              <h2 id="provider-title">通义千问</h2>
            </div>
            <span
              className={`model-configuration-status${profile?.configured === true ? ' configured' : ''}`}
            >
              {profile?.configured === true ? '已配置' : '未配置'}
            </span>
            <span className="model-current-summary">
              <small>当前模型</small>
              <strong>通义千问增强版</strong>
            </span>
            <span className="model-credential-summary">
              <small>凭据</small>
              <strong>
                {profile?.configured === true
                  ? `已安全保存 · 末四位 ${profile.last4 ?? '不可用'}`
                  : '尚未保存'}
              </strong>
            </span>
            <span className="model-manage-label">管理配置</span>
          </summary>
          <div className="model-service-body" aria-labelledby="provider-title">
            <p>工作空间与服务密钥分开保存。完整密钥不会回显或进入页面长期状态。</p>
            {error !== null && (
              <p className="field-error" role="alert">
                {error.code}：{error.message}
              </p>
            )}
            <label>
              工作空间标识
              <input
                autoComplete="off"
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                }}
                value={workspaceId}
              />
            </label>
            <button
              disabled={pending || profile === null || workspaceId.trim() === ''}
              onClick={() => {
                if (profile === null) return;
                void apply(
                  () =>
                    getProviderClient().saveProfile({
                      enabled: true,
                      expectedVersionId: profile.versionId,
                      profileId: PROFILE_ID,
                      requestId: createScriptRequestId('provider-profile'),
                      workspaceId: workspaceId.trim(),
                    }),
                  '工作空间已保存',
                );
              }}
              type="button"
            >
              保存工作空间
            </button>
            <label>
              服务密钥
              <input
                autoComplete="new-password"
                onChange={(event) => {
                  setApiKey(event.target.value);
                }}
                type="password"
                value={apiKey}
              />
            </label>
            <div className="script-actions">
              <button
                disabled={pending || profile === null || apiKey === ''}
                onClick={() => {
                  if (profile === null) return;
                  const credential = apiKey;
                  setApiKey('');
                  void apply(
                    () =>
                      getProviderClient().saveCredential({
                        apiKey: credential,
                        expectedVersionId: profile.versionId,
                        profileId: PROFILE_ID,
                        requestId: createScriptRequestId('provider-key'),
                      }),
                    '凭据已安全保存，请执行连通性测试',
                  );
                }}
                type="button"
              >
                保存凭据
              </button>
              <button
                disabled={pending || profile?.configured !== true}
                onClick={() => {
                  if (profile === null) return;
                  void apply(
                    () =>
                      getProviderClient().testCredential({
                        expectedVersionId: profile.versionId,
                        profileId: PROFILE_ID,
                        requestId: createScriptRequestId('provider-test'),
                      }),
                    '凭据验证成功',
                  );
                }}
                type="button"
              >
                测试凭据
              </button>
              <button
                className="danger-button"
                disabled={pending || profile?.configured !== true}
                onClick={() => {
                  if (profile === null || !globalThis.confirm('删除已保存的通义千问凭据？')) return;
                  void apply(
                    () =>
                      getProviderClient().deleteCredential({
                        expectedVersionId: profile.versionId,
                        profileId: PROFILE_ID,
                        requestId: createScriptRequestId('provider-delete'),
                      }),
                    '凭据已删除',
                  );
                }}
                type="button"
              >
                删除凭据
              </button>
            </div>
            <p aria-live="polite">
              {profile?.configured === true
                ? `已配置（末四位 ${profile.last4 ?? '不可用'}）`
                : '未配置'}
              {feedback === '' ? '' : ` · ${feedback}`}
            </p>
            {!ready && (
              <p className="action-hint">保存工作空间并通过凭据测试后才能生成阶段内容。</p>
            )}
          </div>
        </details>
      </section>
      <section
        aria-labelledby="image-generation-service-title"
        className="generation-service-group"
        id="settings-service-1"
      >
        <h2 id="image-generation-service-title">{GENERATION_SERVICE_GROUPS[1]}</h2>
        <p>用于生成镜头首帧与创作参考图。</p>
        <ImageProviderCard />
      </section>
      <section
        aria-labelledby="video-generation-service-title"
        className="generation-service-group"
        id="settings-service-2"
      >
        <h2 id="video-generation-service-title">{GENERATION_SERVICE_GROUPS[2]}</h2>
        <p>用于将已确认的镜头发展为视频候选。</p>
        <AgnesVideoProviderCard />
      </section>
      <section
        aria-labelledby="voice-generation-service-title"
        className="generation-service-group"
        id="settings-service-3"
      >
        <h2 id="voice-generation-service-title">{GENERATION_SERVICE_GROUPS[3]}</h2>
        <p>用于为镜头对白生成配音候选。</p>
        <VoiceProviderCard />
      </section>
    </div>
  );
};
