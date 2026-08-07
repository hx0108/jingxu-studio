import path from 'node:path';

import { app, BrowserWindow, net, protocol, session } from 'electron';
import { deriveWindowsProductionRoot } from '@jingxu/persistence';

import { createSecureMainWindow } from './composition/create-main-window';
import {
  createDesktopPersistenceRuntime,
  initializePersistenceAfterSingleInstanceLock,
  type DesktopPersistenceRuntime,
} from './composition/create-persistence-runtime';
import { registerAppProtocol } from './security/app-protocol';

const APP_SCHEME = 'jingxu';
const APP_HOST = 'app';
const PRODUCTION_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
const devServerUrl =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const rendererName =
  typeof MAIN_WINDOW_VITE_NAME === 'string' ? MAIN_WINDOW_VITE_NAME : 'main_window';
let appProtocolRegistered = false;
let persistenceRuntime: DesktopPersistenceRuntime | null = null;

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      corsEnabled: false,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
    scheme: APP_SCHEME,
  },
]);
app.enableSandbox();
const singleInstanceLockAcquired = app.requestSingleInstanceLock();

const getTrustedUrl = (): string => devServerUrl ?? PRODUCTION_URL;

const getMigrationDirectory = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.resolve(
        app.getAppPath(),
        '..',
        '..',
        'packages',
        'persistence',
        'resources',
        'migrations',
      );

const createMainWindow = async (): Promise<void> => {
  if (devServerUrl === undefined && !appProtocolRegistered) {
    registerAppProtocol({
      fetchResource: (url) => net.fetch(url),
      protocol,
      rendererRoot: path.join(__dirname, '..', 'renderer', rendererName),
      trustedHost: APP_HOST,
    });
    appProtocolRegistered = true;
  }

  await createSecureMainWindow({
    createWindow: (options) => new BrowserWindow(options),
    permissionSession: session.defaultSession,
    preloadPath: path.join(__dirname, 'preload.js'),
    trustedUrl: getTrustedUrl(),
  });
};

if (!singleInstanceLockAcquired) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      const managedRoot = deriveWindowsProductionRoot(
        process.env.LOCALAPPDATA ?? '',
        process.platform,
      );
      persistenceRuntime = await initializePersistenceAfterSingleInstanceLock(true, () =>
        createDesktopPersistenceRuntime({
          clock: () => new Date().toISOString(),
          managedRoot,
          migrationDirectory: getMigrationDirectory(),
        }),
      );
      await createMainWindow();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '未知启动错误';
      process.stderr.write(`镜序 Studio 启动失败：${message}\n`);
      app.exit(1);
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });

  app.on('before-quit', () => {
    persistenceRuntime?.close();
    persistenceRuntime = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
