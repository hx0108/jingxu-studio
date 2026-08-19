import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';
import { isProviderReadyForGeneration } from './script-ui-policy';

import { ImageProviderCard } from './ImageProviderCard';

const PROFILE_ID = 'profile_qwen_primary';

export interface ProviderSettingsProps {
  readonly onReadyChange: (ready: boolean) => void;
}

export const ProviderSettings = ({ onReadyChange }: ProviderSettingsProps) => {
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

  if (profile === null && error === null) return <p aria-live="polite">正在加载 Qwen 设置…</p>;
  return (
    <>
      <section className="script-card" aria-labelledby="provider-title">
        <h2 id="provider-title">Qwen Provider 设置</h2>
        <p>Workspace 与 API Key 分开保存。完整 Key 不会回显或进入页面长期状态。</p>
        {error !== null && (
          <p className="field-error" role="alert">
            {error.code}：{error.message}
          </p>
        )}
        <label>
          Workspace ID
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
              'Workspace 已保存',
            );
          }}
          type="button"
        >
          保存 Workspace
        </button>
        <label>
          API Key
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
              if (profile === null || !globalThis.confirm('删除已保存的 Qwen 凭据？')) return;
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
        {!ready && <p className="action-hint">保存 Workspace 并通过凭据测试后才能生成阶段内容。</p>}
      </section>
      <ImageProviderCard />
    </>
  );
};
