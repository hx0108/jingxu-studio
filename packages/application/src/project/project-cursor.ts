import type { ProjectListScope } from '@jingxu/contracts';

/**
 * 版本化列表游标载荷（Design §7）。
 *
 * 编码为 base64url JSON；searchHash 为 null 表示无搜索。updatedAt/id 为 keyset 定位点
 * （updated_at DESC, id DESC），scope/searchHash 与请求不一致时旧游标作废。
 */
export interface CursorPayload {
  readonly v: 1;
  readonly updatedAt: string;
  readonly id: string;
  readonly scope: ProjectListScope;
  readonly searchHash: string | null;
}

/** 游标解码失败原因。 */
export type CursorDecodeFailure =
  | { readonly reason: 'INVALID_BASE64' }
  | { readonly reason: 'INVALID_JSON' }
  | { readonly reason: 'UNSUPPORTED_VERSION' }
  | { readonly reason: 'INVALID_TIMESTAMP' }
  | { readonly reason: 'INVALID_ID' }
  | { readonly reason: 'INVALID_SCOPE' }
  | { readonly reason: 'SCOPE_MISMATCH' }
  | { readonly reason: 'SEARCH_MISMATCH' };

export type CursorDecodeResult =
  | { readonly ok: true; readonly payload: CursorPayload }
  | { readonly ok: false; readonly failure: CursorDecodeFailure };

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const ID_RE = /^[A-Za-z0-9_-]{12,64}$/u;
const SCOPES: readonly ProjectListScope[] = ['ACTIVE', 'DELETED'];

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_INDEX = new Map<string, number>(
  Array.from(BASE64URL_CHARS, (char, index) => [char, index] as const),
);

const encodeBase64Url = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += BASE64URL_CHARS[b0 >> 2] ?? '';
    out += BASE64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)] ?? '';
    out += BASE64URL_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] ?? '';
    out += BASE64URL_CHARS[b2 & 0x3f] ?? '';
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i] ?? 0;
    out += BASE64URL_CHARS[b0 >> 2] ?? '';
    out += BASE64URL_CHARS[(b0 & 0x03) << 4] ?? '';
  } else if (remaining === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    out += BASE64URL_CHARS[b0 >> 2] ?? '';
    out += BASE64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)] ?? '';
    out += BASE64URL_CHARS[(b1 & 0x0f) << 2] ?? '';
  }
  return out;
};

const decodeBase64Url = (input: string): string | null => {
  if (!BASE64URL_RE.test(input)) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input) {
    const index = BASE64URL_INDEX.get(char);
    if (index === undefined) return null;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  const decoded = new TextDecoder().decode(new Uint8Array(bytes));
  return encodeBase64Url(decoded) === input ? decoded : null;
};

/** 编码游标载荷为 base64url 字符串。 */
export const encodeCursor = (payload: CursorPayload): string =>
  encodeBase64Url(JSON.stringify(payload));

/**
 * 解码并严格校验游标（Design §7）。
 *
 * 先校验结构（base64url、JSON、版本、时间、id、scope、searchHash 类型），再比对请求的
 * scope/searchHash：任一不一致返回对应失败，使 Renderer 据此返回 IPC_INVALID_REQUEST
 * 并重新请求第一页。
 */
export const decodeCursor = (
  cursor: string,
  expected: { readonly scope: ProjectListScope; readonly searchHash: string | null },
): CursorDecodeResult => {
  const json = decodeBase64Url(cursor);
  if (json === null) return { ok: false, failure: { reason: 'INVALID_BASE64' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, failure: { reason: 'INVALID_JSON' } };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, failure: { reason: 'INVALID_JSON' } };
  }
  const record = parsed as Record<string, unknown>;

  if (record.v !== 1) return { ok: false, failure: { reason: 'UNSUPPORTED_VERSION' } };

  const updatedAt = record.updatedAt;
  if (
    typeof updatedAt !== 'string' ||
    !ISO_RE.test(updatedAt) ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return { ok: false, failure: { reason: 'INVALID_TIMESTAMP' } };
  }

  const id = record.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return { ok: false, failure: { reason: 'INVALID_ID' } };
  }

  const scope = record.scope;
  if (typeof scope !== 'string' || !SCOPES.includes(scope as ProjectListScope)) {
    return { ok: false, failure: { reason: 'INVALID_SCOPE' } };
  }

  const searchHash = record.searchHash;
  if (typeof searchHash !== 'string' && searchHash !== null) {
    return { ok: false, failure: { reason: 'INVALID_JSON' } };
  }

  if (scope !== expected.scope) return { ok: false, failure: { reason: 'SCOPE_MISMATCH' } };
  if (searchHash !== expected.searchHash) {
    return { ok: false, failure: { reason: 'SEARCH_MISMATCH' } };
  }

  return {
    ok: true,
    payload: {
      v: 1,
      updatedAt,
      id,
      scope: scope,
      searchHash: searchHash,
    },
  };
};
