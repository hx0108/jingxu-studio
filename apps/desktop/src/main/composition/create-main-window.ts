import type { BrowserWindowConstructorOptions } from 'electron';

import {
  createMainWindowOptions,
  createPermissionRequestHandler,
  createWindowOpenHandler,
  shouldPreventNavigation,
  type PermissionRequestHandler,
} from '../security/window-policy';

export interface NavigationEvent {
  preventDefault(): void;
}

export interface SecureWindow {
  loadURL(url: string): Promise<void>;
  once(eventName: 'ready-to-show', listener: () => void): void;
  show(): void;
  webContents: {
    on(eventName: 'will-navigate', listener: (event: NavigationEvent, url: string) => void): void;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  };
}

export interface PermissionSession {
  setPermissionRequestHandler: (handler: PermissionRequestHandler) => void;
}

export interface CreateSecureMainWindowDependencies {
  createWindow: (options: BrowserWindowConstructorOptions) => SecureWindow;
  permissionSession: PermissionSession;
  preloadPath: string;
  trustedUrl: string;
}

export const createSecureMainWindow = async ({
  createWindow,
  permissionSession,
  preloadPath,
  trustedUrl,
}: CreateSecureMainWindowDependencies): Promise<SecureWindow> => {
  const window = createWindow(createMainWindowOptions(preloadPath));

  window.webContents.setWindowOpenHandler(createWindowOpenHandler());
  window.webContents.on('will-navigate', (event, url) => {
    if (shouldPreventNavigation(url, trustedUrl)) {
      event.preventDefault();
    }
  });
  permissionSession.setPermissionRequestHandler(createPermissionRequestHandler());
  window.once('ready-to-show', () => {
    window.show();
  });

  await window.loadURL(trustedUrl);
  return window;
};
