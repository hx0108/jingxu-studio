import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const keyPath = process.env.JINGXU_REAL_SEEDANCE_VIDEO_KEY_FILE;
if (keyPath === undefined || keyPath === '') throw new Error('REAL_VIDEO_KEY_FILE_REQUIRED');

const key = (await readFile(keyPath, 'utf8')).trim();
if (key.length < 16) throw new Error('REAL_VIDEO_KEY_INVALID');

const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const safeTaskId = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12);
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const submitted = await fetch(endpoint, {
  body: JSON.stringify({
    content: [
      { type: 'text', text: '动画风格侦探在雨夜街头缓慢转身，镜头平稳推进，无声。' },
      {
        image_url: {
          url: 'https://ark-project.tos-cn-beijing.volces.com/doc_image/r2v_tea_pic1.jpg',
        },
        type: 'image_url',
      },
    ],
    duration: 5,
    generate_audio: false,
    model: 'doubao-seedance-1-5-pro-251215',
    ratio: 'adaptive',
    resolution: '720p',
    return_url: true,
  }),
  headers,
  method: 'POST',
});
const submitJson = await submitted.json().catch(() => null);
if (!submitted.ok || typeof submitJson?.id !== 'string') {
  report({
    httpStatus: submitted.status,
    providerCode: submitJson?.error?.code ?? null,
    status: 'SUBMIT_FAILED',
  });
  process.exitCode = 1;
} else {
  let terminal = null;
  for (let polls = 1; polls <= 120; polls += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await fetch(`${endpoint}/${encodeURIComponent(submitJson.id)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const result = await response.json().catch(() => null);
    const state = result?.status;
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(state)) {
      terminal = { polls, result, state };
      break;
    }
  }
  if (
    terminal === null ||
    terminal.state !== 'succeeded' ||
    typeof terminal.result?.content?.video_url !== 'string'
  ) {
    report({
      polls: terminal?.polls ?? 120,
      providerCode: terminal?.result?.error?.code ?? null,
      status: terminal?.state ?? 'POLL_TIMEOUT',
      taskIdHash: safeTaskId(submitJson.id),
    });
    process.exitCode = 1;
  } else {
    const video = await fetch(terminal.result.content.video_url);
    const bytes = new Uint8Array(await video.arrayBuffer());
    const mp4 = bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
    report({
      bytes: bytes.length,
      downloadStatus: video.status,
      mp4,
      polls: terminal.polls,
      status: 'SUCCEEDED',
      taskIdHash: safeTaskId(submitJson.id),
    });
    if (!video.ok || !mp4) process.exitCode = 1;
  }
}
