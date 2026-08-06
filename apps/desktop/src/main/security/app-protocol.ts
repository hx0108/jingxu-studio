import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AppProtocolRequest {
  method: string;
  url: string;
}

export interface AppProtocolHost {
  handle: (
    scheme: string,
    handler: (request: AppProtocolRequest) => Promise<Response> | Response,
  ) => void;
}

export interface RegisterAppProtocolDependencies {
  protocol: AppProtocolHost;
  rendererRoot: string;
  trustedHost: string;
  fetchResource: (url: string) => Promise<Response>;
}

const notFound = (): Response => new Response('Not found', { status: 404 });

export const registerAppProtocol = ({
  protocol,
  rendererRoot,
  trustedHost,
  fetchResource,
}: RegisterAppProtocolDependencies): void => {
  const normalizedRoot = path.resolve(rendererRoot);

  protocol.handle('jingxu', async (request) => {
    const requestUrl = new URL(request.url);
    if (request.method !== 'GET' || requestUrl.hostname !== trustedHost) {
      return notFound();
    }

    let rawPath: string;
    try {
      rawPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      return notFound();
    }
    const relativePath = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const resourcePath = path.resolve(normalizedRoot, relativePath);
    const relativeToRoot = path.relative(normalizedRoot, resourcePath);

    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return notFound();
    }

    return fetchResource(pathToFileURL(resourcePath).toString());
  });
};
