import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createContentAddressedStore } from '@jingxu/persistence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVoiceAudioRegistrar } from './voice-audio-registrar';

const resourceDirectory = path.resolve(import.meta.dirname, '../../../resources/ffmpeg');

/** 确定性 PCM WAV（8kHz 单声道 16bit）：ffprobe 可解析、时长精确可期。 */
const wavBytesOf = (durationSec: number): Uint8Array => {
  const sampleRate = 8_000;
  const dataBytes = Math.round(durationSec * sampleRate) * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-voice-registrar-'));
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('VoiceAudioRegistrar（tasks 4.3）', () => {
  it('正常登记—CAS audio 命名空间 + ffprobe 实测 durationMs>0 + 四元组齐', async () => {
    const store = createContentAddressedStore(root);
    const registrar = createVoiceAudioRegistrar({
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      store,
    });
    const registration = await registrar.register(
      { bytes: wavBytesOf(1), mimeType: 'audio/wav' },
      'project_00000001',
    );
    expect(registration.byteSize).toBe(44 + 8_000 * 2);
    expect(registration.durationMs).toBeGreaterThan(0);
    expect(registration.mimeType).toBe('audio/wav');
    expect(registration.fileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(registration.storageRelPath).toMatch(
      /^projects\/project_00000001\/audio\/[0-9a-f]{2}\/[0-9a-f]{64}\.wav$/u,
    );
  });

  it('同 hash 去重—同字节两次登记落同一 CAS 引用', async () => {
    const store = createContentAddressedStore(root);
    const registrar = createVoiceAudioRegistrar({
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      store,
    });
    const bytes = wavBytesOf(0.5);
    const first = await registrar.register({ bytes, mimeType: 'audio/wav' }, 'project_00000002');
    const second = await registrar.register({ bytes, mimeType: 'audio/wav' }, 'project_00000002');
    expect(second.storageRelPath).toBe(first.storageRelPath);
    expect(second.fileSha256).toBe(first.fileSha256);
  });

  it('mime 白名单—白名单外拒绝且不落盘', async () => {
    const store = createContentAddressedStore(root);
    const registrar = createVoiceAudioRegistrar({
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      store,
    });
    await expect(
      registrar.register({ bytes: wavBytesOf(1), mimeType: 'audio/ogg' }, 'project_00000003'),
    ).rejects.toThrow('VOICE_AUDIO_MIME_INVALID');
  });

  it('无效音频—ffprobe 无法解析为音频流时稳定拒绝', async () => {
    const store = createContentAddressedStore(root);
    const registrar = createVoiceAudioRegistrar({
      ffprobePath: path.join(resourceDirectory, 'ffprobe.exe'),
      store,
    });
    await expect(
      registrar.register(
        { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/wav' },
        'project_00000004',
      ),
    ).rejects.toThrow('VOICE_AUDIO_INVALID');
  });
});
