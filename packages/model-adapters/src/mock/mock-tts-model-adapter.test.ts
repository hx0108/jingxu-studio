import { describe, expect, it } from 'vitest';

import type { CredentialCheck } from '@jingxu/application';

import { createMockModelError } from './mock-text-model-adapter';
import {
  encodeMockWav,
  MOCK_TTS_MIME_TYPE,
  MOCK_TTS_MS_PER_CHAR,
  MOCK_TTS_SAMPLE_RATE,
  MockTtsModelAdapter,
} from './mock-tts-model-adapter';

const request = (invocationId: string, spokenText: string) => ({
  invocationId,
  modelId: 'mock-tts-model',
  spokenText,
  voiceId: 'mock-tts-voice',
});

const wavFacts = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    chunkSize: view.getUint32(40, true),
    magic: new TextDecoder().decode(bytes.subarray(0, 4)),
    sampleRate: view.getUint32(24, true),
  };
};

/** 本包不引 node: 模块——字节逐位比较用纯函数。 */
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

describe('MockTtsModelAdapter', () => {
  it('同步成功—返回可解析 WAV 且时长等于字符数×每字符毫秒', async () => {
    const adapter = new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] });
    const result = await adapter.synthesize(
      request('inv-001', '六个字的台词呢'),
      new AbortController().signal,
    );
    expect(result.audio.mimeType).toBe(MOCK_TTS_MIME_TYPE);
    expect(result.httpStatus).toBe(200);
    expect(result.usage?.outputCharacters).toBe(7);
    expect(result.providerRequestId).toBeNull();
    const facts = wavFacts(result.audio.bytes);
    expect(facts.magic).toBe('RIFF');
    expect(facts.sampleRate).toBe(MOCK_TTS_SAMPLE_RATE);
    // 7 字符 × 200ms = 1400ms → 样本数 22400 → data 块 44800 字节。
    expect(facts.chunkSize).toBe(7 * MOCK_TTS_MS_PER_CHAR * (MOCK_TTS_SAMPLE_RATE / 1_000) * 2);
  });

  it('确定性—同 invocationId 同台词跨实例字节逐位一致', async () => {
    const first = await new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] }).synthesize(
      request('inv-002', '一样的台词'),
      new AbortController().signal,
    );
    const second = await new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] }).synthesize(
      request('inv-002', '一样的台词'),
      new AbortController().signal,
    );
    expect(bytesEqual(first.audio.bytes, second.audio.bytes)).toBe(true);
  });

  it('种子可区分—不同 invocationId 同台词字节不同', async () => {
    const first = await new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] }).synthesize(
      request('inv-003', '一样的台词'),
      new AbortController().signal,
    );
    const second = await new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] }).synthesize(
      request('inv-004', '一样的台词'),
      new AbortController().signal,
    );
    expect(bytesEqual(first.audio.bytes, second.audio.bytes)).toBe(false);
  });

  it('步骤显式 durationMs—供对齐场景构造远长/短于镜头的音频', async () => {
    const adapter = new MockTtsModelAdapter({ steps: [{ durationMs: 10_000, kind: 'SYNC' }] });
    const result = await adapter.synthesize(request('inv-005', '短'), new AbortController().signal);
    expect(wavFacts(result.audio.bytes).chunkSize).toBe(10 * MOCK_TTS_SAMPLE_RATE * 2);
  });

  it('signal 已中止—归一化 MODEL_CANCELLED 且不消耗后续步骤语义', async () => {
    const adapter = new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.synthesize(request('inv-006', '台词'), controller.signal),
    ).rejects.toMatchObject({ normalized: { code: 'MODEL_CANCELLED' } });
  });

  it('ERROR 步骤—抛归一化错误且 evidenceOf 提取原始证据', async () => {
    const adapter = new MockTtsModelAdapter({
      steps: [{ error: createMockModelError('MODEL_RATE_LIMITED'), kind: 'ERROR' }],
    });
    const error = await adapter
      .synthesize(request('inv-007', '台词'), new AbortController().signal)
      .catch((thrown: unknown) => thrown);
    expect(adapter.normalizeError(error)).toMatchObject({ code: 'MODEL_RATE_LIMITED' });
    expect(adapter.evidenceOf(error)).toMatchObject({ httpStatus: 429 });
    expect(adapter.evidenceOf(error)?.bodyText).toContain('inv-007');
  });

  it('TIMEOUT 步骤与步骤耗尽—分别归一化 MODEL_TIMEOUT / MODEL_UNKNOWN', async () => {
    const timeoutAdapter = new MockTtsModelAdapter({ steps: [{ afterMs: 1, kind: 'TIMEOUT' }] });
    await expect(
      timeoutAdapter.synthesize(request('inv-008', '台词'), new AbortController().signal),
    ).rejects.toMatchObject({ normalized: { code: 'MODEL_TIMEOUT' } });
    const exhausted = new MockTtsModelAdapter({ steps: [] });
    await expect(
      exhausted.synthesize(request('inv-009', '台词'), new AbortController().signal),
    ).rejects.toMatchObject({ normalized: { code: 'MODEL_UNKNOWN' } });
  });

  it('归一化边界—非本适配器错误回 MODEL_UNKNOWN 且证据为 null', () => {
    const adapter = new MockTtsModelAdapter({ steps: [{ kind: 'SYNC' }] });
    expect(adapter.normalizeError(new Error('别的错误'))).toMatchObject({ code: 'MODEL_UNKNOWN' });
    expect(adapter.evidenceOf(new Error('别的错误'))).toBeNull();
  });

  it('validateCredential—注入档位原样透传', async () => {
    const failed: CredentialCheck = {
      detail: null,
      errorCode: 'MODEL_CREDENTIAL_INVALID',
      ok: false,
    };
    await expect(
      new MockTtsModelAdapter({
        credentialCheck: failed,
        steps: [{ kind: 'SYNC' }],
      }).validateCredential(),
    ).resolves.toEqual(failed);
  });

  it('encodeMockWav 头部—fmt 块为 PCM 单声道 16 位且总长含头 44 字节', () => {
    const bytes = encodeMockWav('seed', 100);
    expect(bytes.length).toBe(44 + Math.round((100 * MOCK_TTS_SAMPLE_RATE) / 1_000) * 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint16(34, true)).toBe(16); // 位深
  });
});
