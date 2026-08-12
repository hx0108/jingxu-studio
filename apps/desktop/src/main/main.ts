import path from 'node:path';
import os from 'node:os';

import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session } from 'electron';
import { deriveWindowsProductionRoot } from '@jingxu/persistence';

import { deriveSchemaResourceDirectory } from './adapters/schema-resource-adapter';
import type { SafeStorageFacade } from './adapters/credential';
import { createSecureMainWindow } from './composition/create-main-window';
import {
  createDesktopPersistenceRuntime,
  initializePersistenceAfterSingleInstanceLock,
  type DesktopPersistenceRuntime,
} from './composition/create-persistence-runtime';
import {
  createJobProviderFeatureRegistration,
  type JobProviderFeatureRegistration,
} from './composition/register-job-provider-features';
import {
  createProjectFeatureRegistration,
  type ProjectFeatureRegistration,
} from './composition/register-project-features';
import { registerRuntimeIpc } from './ipc/runtime-ipc';
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
let projectFeatureRegistration: ProjectFeatureRegistration | null = null;
let jobProviderFeatureRegistration: JobProviderFeatureRegistration | null = null;

const createSafeStorageFacade = (): SafeStorageFacade => ({
  decryptString: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted)),
  encryptString: (plaintext) => safeStorage.encryptString(plaintext),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
});

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

const getManagedRoot = (): string => {
  const testRoot = process.env.JINGXU_E2E_DATA_ROOT;
  if (process.env.JINGXU_E2E === '1' && testRoot !== undefined) {
    const resolvedTestRoot = path.resolve(testRoot);
    const relativeToTemporaryRoot = path.relative(os.tmpdir(), resolvedTestRoot);
    if (
      relativeToTemporaryRoot === '..' ||
      relativeToTemporaryRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToTemporaryRoot)
    ) {
      throw new Error('E2E_DATA_ROOT_INVALID');
    }
    return resolvedTestRoot;
  }
  return deriveWindowsProductionRoot(process.env.LOCALAPPDATA ?? '', process.platform);
};

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
      const managedRoot = getManagedRoot();
      persistenceRuntime = await initializePersistenceAfterSingleInstanceLock(true, () =>
        createDesktopPersistenceRuntime({
          clock: () => new Date().toISOString(),
          managedRoot,
          migrationDirectory: getMigrationDirectory(),
          schemaResourceDirectory: deriveSchemaResourceDirectory({
            appPath: app.getAppPath(),
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
          }),
        }),
      );
      if (persistenceRuntime !== null) {
        const ipcRegistrar = {
          handle: (
            channel: string,
            listener: (
              event: {
                readonly sender: { readonly mainFrame: { readonly url: string } };
                readonly senderFrame: { readonly url: string } | null;
              },
              ...arguments_: readonly unknown[]
            ) => Promise<unknown>,
          ) => {
            ipcMain.handle(channel, (event, ...arguments_: readonly unknown[]) =>
              listener(
                {
                  sender: { mainFrame: event.sender.mainFrame },
                  senderFrame: event.senderFrame,
                },
                ...arguments_,
              ),
            );
          },
        };
        projectFeatureRegistration = createProjectFeatureRegistration({
          ipcRegistrar,
          managedRoot,
          persistenceRuntime,
          trustedUrl: getTrustedUrl(),
        });
        jobProviderFeatureRegistration = createJobProviderFeatureRegistration({
          clock: () => new Date().toISOString(),
          ipcRegistrar,
          managedRoot,
          persistenceRuntime,
          safeStorage: createSafeStorageFacade(),
          trustedUrl: getTrustedUrl(),
        });
        registerRuntimeIpc(ipcRegistrar, persistenceRuntime.startupService, getTrustedUrl(), () => {
          projectFeatureRegistration?.ensureRegistered();
          jobProviderFeatureRegistration?.ensureRegistered();
        });
        projectFeatureRegistration.ensureRegistered();
        jobProviderFeatureRegistration.ensureRegistered();
      }
      await createMainWindow();
    })
    .catch(() => {
      process.stderr.write('镜序 Studio 启动失败：STARTUP_FATAL\n');
      app.exit(1);
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });

  app.on('before-quit', () => {
    projectFeatureRegistration = null;
    jobProviderFeatureRegistration = null;
    persistenceRuntime?.close();
    persistenceRuntime = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
