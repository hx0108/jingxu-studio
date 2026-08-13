import type { BrowserWindowConstructorOptions } from 'electron';

export type PermissionCallback = (allowed: boolean) => void;
export type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: PermissionCallback,
) => void;

export const createMainWindowOptions = (preloadPath: string): BrowserWindowConstructorOptions => ({
  height: 800,
  show: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: preloadPath,
    sandbox: true,
    webSecurity: true,
  },
  width: 1280,
});

export const createWindowOpenHandler = () => () => ({ action: 'deny' as const });

export const createPermissionRequestHandler =
  (): PermissionRequestHandler => (_webContents, _permission, callback) => {
    callback(false);
  };

const getTrustIdentity = (url: URL): string =>
  `${url.protocol}//${url.hostname.toLowerCase()}${url.port === '' ? '' : `:${url.port}`}`;

export const isTrustedAppUrl = (candidate: string, trustedUrl: string): boolean => {
  try {
    return getTrustIdentity(new URL(candidate)) === getTrustIdentity(new URL(trustedUrl));
  } catch {
    return false;
  }
};

export const shouldPreventNavigation = (candidate: string, trustedUrl: string): boolean =>
  !isTrustedAppUrl(candidate, trustedUrl);
