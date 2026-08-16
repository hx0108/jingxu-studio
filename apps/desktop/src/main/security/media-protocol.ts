/**
 * `jingxu://media/<candidate|asset-version>/<id>` 受限取图协议（design D4）。
 *
 * 纯边界：id 白名单字符集 → Repository 反查落盘引用 → 内容寻址路径解析
 * （拒绝模式外路径、符号链接与 projects 根逃逸）→ 读字节回 Response。
 * 全部失败路径统一 404 且不携带任何细节——不存在性信息泄漏，也不暴露
 * 文件系统路径、SQL 或堆栈（design D5）。
 */

import type { MediaStoredFileRef } from '@jingxu/application';

export interface MediaProtocolRequest {
  method: string;
  url: string;
}

/** 按标识反查落盘文件引用（Main 组合根以 MediaUnitOfWork 包装注入）。 */
export interface MediaFileLocator {
  readonly findCandidateMedia: (candidateId: string) => Promise<MediaStoredFileRef | null>;
  readonly findAssetVersionMedia: (versionId: string) => Promise<MediaStoredFileRef | null>;
}

export interface MediaProtocolDependencies {
  readonly locator: MediaFileLocator;
  /** ContentAddressedStore.resolvePathWithinProjects：校验模式 + realpath 防逃逸。 */
  readonly resolveWithinProjects: (storageRelPath: string) => Promise<string>;
  readonly readFile: (absolutePath: string) => Promise<Uint8Array>;
}

export const MEDIA_PROTOCOL_HOST = 'media';

const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const MEDIA_PATH_PATTERN = /^\/(candidate|asset-version)\/([A-Za-z0-9_-]{8,128})$/u;

const notFound = (): Response => new Response('Not found', { status: 404 });

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
    const located =
      (match[1] ?? '') === 'candidate'
        ? await dependencies.locator.findCandidateMedia(identifier)
        : await dependencies.locator.findAssetVersionMedia(identifier);
    if (located === null) return notFound();
    const absolutePath = await dependencies.resolveWithinProjects(located.storageRelPath);
    const bytes = await dependencies.readFile(absolutePath);
    // readFile 结果恒为独占 ArrayBuffer（非共享），收窄 BlobPart 泛型。
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
      headers: { 'Content-Length': String(bytes.byteLength), 'Content-Type': located.mimeType },
      status: 200,
    });
  } catch {
    return notFound();
  }
};
