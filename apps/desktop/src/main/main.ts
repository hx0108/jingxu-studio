import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session } from 'electron';
import { createContentAddressedStore, deriveWindowsProductionRoot } from '@jingxu/persistence';

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
  createImageFeatureRegistration,
  type ImageFeatureRegistration,
} from './composition/register-image-features';
import {
  createVideoFeatureRegistration,
  type VideoFeatureRegistration,
} from './composition/register-video-features';
import {
  createProjectFeatureRegistration,
  type ProjectFeatureRegistration,
} from './composition/register-project-features';
import {
  createProductionScriptService,
  createScriptFeatureRegistration,
  type ScriptFeatureRegistration,
} from './composition/register-script-features';
import {
  createProductionStoryboardService,
  createStoryboardFeatureRegistration,
  type StoryboardFeatureRegistration,
} from './composition/register-storyboard-features';
import { createDialogStoryboardExportSink } from './composition/storyboard-export-file-sink';
import { registerRuntimeIpc } from './ipc/runtime-ipc';
import { registerAppProtocol } from './security/app-protocol';
import { handleMediaProtocolRequest } from './security/media-protocol';

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
let scriptFeatureRegistration: ScriptFeatureRegistration | null = null;
let storyboardFeatureRegistration: StoryboardFeatureRegistration | null = null;
let imageFeatureRegistration: ImageFeatureRegistration | null = null;
let videoFeatureRegistration: VideoFeatureRegistration | null = null;
let shutdownStarted = false;

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

/**
 * Electron 43.x 在 `electron <dir>` 开发/e2e 启动时可能把 `app.isPackaged` 报成 true（即便此时
 * `process.defaultApp === true`）。以 `process.defaultApp === true` 作为可信开发态信号：仅当真正
 * 打包（defaultApp 非 true）且 isPackaged 为 true 时，才解析到 resourcesPath 下的资源目录。
 */
const resolveIsPackaged = (): boolean => app.isPackaged && !process.defaultApp;

const getMigrationDirectory = (): string =>
  resolveIsPackaged()
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
      handleMediaRequest: (request) =>
        handleMediaProtocolRequest(request, {
          locator: {
            // 运行时不可读（启动故障）时反查直接落空，协议统一 404——不区分存在性。
            findAssetVersionMedia: async (versionId) => {
              const unitOfWork = persistenceRuntime?.getMediaUnitOfWork() ?? null;
              if (unitOfWork === null) return null;
              try {
                return await unitOfWork.run(({ media }) =>
                  media.findAssetVersionMediaById(versionId),
                );
              } catch {
                return null;
              }
            },
            findCandidateMedia: async (candidateId) => {
              const unitOfWork = persistenceRuntime?.getMediaUnitOfWork() ?? null;
              if (unitOfWork === null) return null;
              try {
                return await unitOfWork.run(({ media }) =>
                  media.findCandidateMediaById(candidateId),
                );
              } catch {
                return null;
              }
            },
          },
          readFile: (absolutePath) => readFile(absolutePath),
          resolveWithinProjects:
            createContentAddressedStore(getManagedRoot()).resolvePathWithinProjects,
        }),
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
            isPackaged: resolveIsPackaged(),
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
          useE2eMock: process.env.JINGXU_E2E === '1',
        });
        scriptFeatureRegistration = createScriptFeatureRegistration({
          createService: createProductionScriptService,
          ipcRegistrar,
          persistenceRuntime,
          trustedUrl: getTrustedUrl(),
        });
        storyboardFeatureRegistration = createStoryboardFeatureRegistration({
          appVersion: app.getVersion(),
          createService: createProductionStoryboardService,
          exportSink: createDialogStoryboardExportSink({
            exportDir: process.env.JINGXU_E2E_EXPORT_DIR,
          }),
          ipcRegistrar,
          persistenceRuntime,
          trustedUrl: getTrustedUrl(),
        });
        imageFeatureRegistration = createImageFeatureRegistration({
          clock: () => new Date().toISOString(),
          ipcRegistrar,
          managedRoot,
          persistenceRuntime,
          safeStorage: createSafeStorageFacade(),
          trustedUrl: getTrustedUrl(),
          useE2eMock: process.env.JINGXU_E2E === '1',
        });
        videoFeatureRegistration = createVideoFeatureRegistration({
          clock: () => new Date().toISOString(),
          ipcRegistrar,
          managedRoot,
          persistenceRuntime,
          safeStorage: createSafeStorageFacade(),
          trustedUrl: getTrustedUrl(),
          useE2eMock: process.env.JINGXU_E2E === '1',
        });
        registerRuntimeIpc(ipcRegistrar, persistenceRuntime.startupService, getTrustedUrl(), () => {
          projectFeatureRegistration?.ensureRegistered();
          jobProviderFeatureRegistration?.ensureRegistered();
          scriptFeatureRegistration?.ensureRegistered();
          storyboardFeatureRegistration?.ensureRegistered();
          imageFeatureRegistration?.ensureRegistered();
          videoFeatureRegistration?.ensureRegistered();
        });
        projectFeatureRegistration.ensureRegistered();
        jobProviderFeatureRegistration.ensureRegistered();
        scriptFeatureRegistration.ensureRegistered();
        storyboardFeatureRegistration.ensureRegistered();
        imageFeatureRegistration.ensureRegistered();
        videoFeatureRegistration.ensureRegistered();
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

  app.on('before-quit', (event) => {
    if (!shutdownStarted && jobProviderFeatureRegistration !== null) {
      event.preventDefault();
      shutdownStarted = true;
      void imageFeatureRegistration?.stop();
      void videoFeatureRegistration?.stop();
      void jobProviderFeatureRegistration.stop().finally(() => {
        app.quit();
      });
      return;
    }
    projectFeatureRegistration = null;
    jobProviderFeatureRegistration = null;
    scriptFeatureRegistration = null;
    storyboardFeatureRegistration = null;
    imageFeatureRegistration = null;
    videoFeatureRegistration = null;
    persistenceRuntime?.close();
    persistenceRuntime = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
