/**
 * `jingxu://media/<candidate|asset-version|video-candidate|video-export>/<id>` 受限取媒体协议（design D4）。
 *
 * 纯边界：id 白名单字符集 → Repository 反查落盘引用 → 内容寻址路径解析
 * （拒绝模式外路径、符号链接与 projects 根逃逸）→ 读字节回 Response。
 * 视频段支持单段 Range/206（`<video>` 拖动必经）：起点越界回 416，异常
 * Range 回退 200 全量。全部失败路径统一 404 且不携带任何细节——不存在性
 * 信息泄漏，也不暴露文件系统路径、SQL 或堆栈（design D5）。
 */

import type { MediaStoredFileRef } from '@jingxu/application';

export interface MediaProtocolRequest {
  readonly method: string;
  /** Range 请求头原值（仅 `bytes=` 单段被消费）；缺省/null 视为全量 GET。 */
  readonly rangeHeader?: string | null;
  readonly url: string;
}

/** 按标识反查落盘文件引用（Main 组合根以 MediaUnitOfWork 包装注入）。 */
export interface MediaFileLocator {
  readonly findCandidateMedia: (candidateId: string) => Promise<MediaStoredFileRef | null>;
  readonly findAssetVersionMedia: (versionId: string) => Promise<MediaStoredFileRef | null>;
  readonly findVideoCandidateMedia: (candidateId: string) => Promise<MediaStoredFileRef | null>;
  readonly findVideoExportMedia: (exportJobId: string) => Promise<MediaStoredFileRef | null>;
}

export interface MediaProtocolDependencies {
  readonly locator: MediaFileLocator;
  /** ContentAddressedStore.resolvePathWithinProjects：校验模式 + realpath 防逃逸。 */
  readonly resolveWithinProjects: (storageRelPath: string) => Promise<string>;
  readonly readFile: (absolutePath: string) => Promise<Uint8Array>;
}

export const MEDIA_PROTOCOL_HOST = 'media';

const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const MEDIA_PATH_PATTERN =
  /^\/(candidate|asset-version|video-candidate|video-export)\/([A-Za-z0-9_-]{8,128})$/u;

const notFound = (): Response => new Response('Not found', { status: 404 });

interface ByteRange {
  readonly start: number;
  /** 含端点。 */
  readonly end: number;
}

/**
 * 单段 `bytes=` Range 解析：合法回闭区间，起点越界（≥ 总长）或后缀长 0 回
 * 'unsatisfiable'，其余形状（缺前缀/空区间/多段/end<start）一律 null——调用方
 * 回退 200 全量，不向 Renderer 报细节。
 */
const parseByteRange = (
  rangeHeader: string,
  totalBytes: number,
): ByteRange | 'unsatisfiable' | null => {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
  if (match === null || ((match[1] ?? '') === '' && (match[2] ?? '') === '')) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '') {
    const suffixLength = Number(endText);
    if (suffixLength === 0) return 'unsatisfiable';
    return { start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 };
  }
  const start = Number(startText);
  if (start >= totalBytes) return 'unsatisfiable';
  const end = endText === '' ? totalBytes - 1 : Math.min(Number(endText), totalBytes - 1);
  if (end < start) return null;
  return { start, end };
};

export const handleMediaProtocolRequest = async (
  request: MediaProtocolRequest,
  dependencies: MediaProtocolDependencies,
): Promise<Response> => {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return notFound();
  }
  if (request.method !== 'GET' || requestUrl.hostname !== MEDIA_PROTOCOL_HOST) {
    return notFound();
  }
  const match = MEDIA_PATH_PATTERN.exec(requestUrl.pathname);
  if (match === null) return notFound();
  const identifier = match[2] ?? '';
  if (!MEDIA_ID_PATTERN.test(identifier)) return notFound();

  try {
    const segment = match[1] ?? '';
    const located =
      segment === 'candidate'
        ? await dependencies.locator.findCandidateMedia(identifier)
        : segment === 'asset-version'
          ? await dependencies.locator.findAssetVersionMedia(identifier)
          : segment === 'video-candidate'
            ? await dependencies.locator.findVideoCandidateMedia(identifier)
            : await dependencies.locator.findVideoExportMedia(identifier);
    if (located === null) return notFound();
    const absolutePath = await dependencies.resolveWithinProjects(located.storageRelPath);
    const bytes = await dependencies.readFile(absolutePath);
    const totalBytes = bytes.byteLength;
    // readFile/subarray 结果恒为独占 ArrayBuffer（非共享），收窄 BlobPart 泛型。
    const buffer = bytes as Uint8Array<ArrayBuffer>;

    const rangeHeader = request.rangeHeader ?? null;
    if (rangeHeader !== null) {
      const parsed = parseByteRange(rangeHeader, totalBytes);
      if (parsed === 'unsatisfiable') {
        return new Response('Range Not Satisfiable', {
          headers: { 'Content-Range': `bytes */${String(totalBytes)}` },
          status: 416,
        });
      }
      if (parsed !== null) {
        const slice = buffer.subarray(parsed.start, parsed.end + 1);
        return new Response(new Blob([slice]), {
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(slice.byteLength),
            'Content-Range': `bytes ${String(parsed.start)}-${String(parsed.end)}/${String(totalBytes)}`,
            'Content-Type': located.mimeType,
          },
          status: 206,
        });
      }
      // 异常 Range：按无 Range 处理，回 200 全量。
    }
    return new Response(new Blob([buffer]), {
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalBytes),
        'Content-Type': located.mimeType,
      },
      status: 200,
    });
  } catch {
    return notFound();
  }
};
