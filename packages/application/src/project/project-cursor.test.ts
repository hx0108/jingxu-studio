import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, type CursorPayload } from './project-cursor';

const ACTIVE_NO_SEARCH: CursorPayload = {
  v: 1,
  updatedAt: '2026-08-09T12:00:00.000Z',
  id: 'proj_abcdef012345',
  scope: 'ACTIVE',
  searchHash: null,
};

/** 独立 base64url 编码（btoa 路径），用于构造异常 cursor 向量。 */
const toBase64Url = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

describe('cursor — 编解码 round-trip', () => {
  it('encode 后 decode 还原原 payload', () => {
    const encoded = encodeCursor(ACTIVE_NO_SEARCH);
    expect(decodeCursor(encoded, { scope: 'ACTIVE', searchHash: null })).toEqual({
      ok: true,
      payload: ACTIVE_NO_SEARCH,
    });
  });

  it('encode 产出 base64url 字符集（无 +/ 与 padding）', () => {
    expect(encodeCursor(ACTIVE_NO_SEARCH)).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('带 searchHash 的 payload 亦可 round-trip', () => {
    const payload: CursorPayload = { ...ACTIVE_NO_SEARCH, searchHash: 'a'.repeat(64) };
    const encoded = encodeCursor(payload);
    expect(decodeCursor(encoded, { scope: 'ACTIVE', searchHash: 'a'.repeat(64) })).toEqual({
      ok: true,
      payload,
    });
  });
});

describe('cursor — 非法输入严格校验失败', () => {
  it('含非法字符—INVALID_BASE64', () => {
    expect(decodeCursor('!!!!not-base64!!!!', { scope: 'ACTIVE', searchHash: null })).toEqual({
      ok: false,
      failure: { reason: 'INVALID_BASE64' },
    });
  });

  it('合法 base64url 但非 JSON—INVALID_JSON', () => {
    expect(decodeCursor(toBase64Url('not-json'), { scope: 'ACTIVE', searchHash: null })).toEqual({
      ok: false,
      failure: { reason: 'INVALID_JSON' },
    });
  });

  it('版本字段非 1—UNSUPPORTED_VERSION', () => {
    const encoded = toBase64Url(JSON.stringify({ ...ACTIVE_NO_SEARCH, v: 2 }));
    expect(decodeCursor(encoded, { scope: 'ACTIVE', searchHash: null })).toEqual({
      ok: false,
      failure: { reason: 'UNSUPPORTED_VERSION' },
    });
  });

  it('updatedAt 非合法 ISO 时间—INVALID_TIMESTAMP', () => {
    const encoded = toBase64Url(JSON.stringify({ ...ACTIVE_NO_SEARCH, updatedAt: 'not-a-date' }));
    expect(decodeCursor(encoded, { scope: 'ACTIVE', searchHash: null })).toEqual({
      ok: false,
      failure: { reason: 'INVALID_TIMESTAMP' },
    });
  });

  it('cursor scope 与请求 scope 不一致—SCOPE_MISMATCH', () => {
    const encoded = encodeCursor(ACTIVE_NO_SEARCH);
    expect(decodeCursor(encoded, { scope: 'DELETED', searchHash: null })).toEqual({
      ok: false,
      failure: { reason: 'SCOPE_MISMATCH' },
    });
  });

  it('cursor searchHash 与请求 searchHash 不一致—SEARCH_MISMATCH', () => {
    const encoded = encodeCursor({ ...ACTIVE_NO_SEARCH, searchHash: 'a'.repeat(64) });
    expect(decodeCursor(encoded, { scope: 'ACTIVE', searchHash: null })).toEqual({
      ok: false,
      failure: { reason: 'SEARCH_MISMATCH' },
    });
  });
});
