import { createHash } from 'node:crypto';

import {
  createCreatorGuideService,
  createCreatorPreparationService,
  createMediaConsistencyService,
} from '@jingxu/application';
import type {
  AppResultDto,
  CreatorDemoResultDto,
  CreatorPreparationResultDto,
  StartCreatorDemoInputDto,
} from '@jingxu/contracts';

import { createDemoSeeder } from './create-demo-seeder';
import { demoProjectRegistry } from './demo-project-registry';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createCreatorGuideQuery } from './create-creator-guide-query';
import { createCreatorPreparationQuery } from './create-creator-preparation-query';
import {
  registerCreatorGuideIpc,
  type CreatorGuideIpcRegistrar,
  type CreatorGuideIpcService,
} from '../ipc/creator-guide-ipc';

export interface CreatorGuideFeatureRegistration {
  ensureRegistered(): boolean;
}

export const createCreatorGuideFeatureRegistration = (options: {
  readonly demoResourceRoot: string;
  readonly ipcRegistrar: CreatorGuideIpcRegistrar;
  readonly managedRoot: string;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}): CreatorGuideFeatureRegistration => {
  let service: CreatorGuideIpcService | null = null;
  // 启动即预载演示项目登记（重启恢复）；种子创建/恢复时亦会写入。
  void demoProjectRegistry.prime(options.persistenceRuntime);

  const unavailable = <T>(traceId: string): Promise<AppResultDto<T>> =>
    Promise.resolve({
      ok: false,
      error: {
        code: 'STARTUP_WRITE_BLOCKED',
        fieldErrors: null,
        message: '应用尚未完成启动检查',
        retryable: true,
        traceId,
        userAction: '请处理启动故障后重试',
      },
    });
  const demoUnavailable = (traceId: string): Promise<AppResultDto<CreatorDemoResultDto>> =>
    Promise.resolve({
      ok: false,
      error: {
        code: 'DEMO_INITIALIZATION_FAILED',
        fieldErrors: null,
        message: '应用尚未完成启动检查',
        retryable: true,
        traceId,
        userAction: '请处理启动故障后重试',
      },
    });
  const startDemo = (
    input: StartCreatorDemoInputDto,
    traceId: string,
  ): Promise<AppResultDto<CreatorDemoResultDto>> =>
    service?.startDemo(input, traceId) ?? demoUnavailable(traceId);

  registerCreatorGuideIpc(
    options.ipcRegistrar,
    {
      getNextAction: (input, traceId) =>
        service?.getNextAction(input, traceId) ?? unavailable(traceId),
      getPreparation: (input, traceId): Promise<AppResultDto<CreatorPreparationResultDto>> =>
        service?.getPreparation(input, traceId) ?? unavailable(traceId),
      startDemo,
    },
    options.trustedUrl,
  );

  return {
    ensureRegistered: () => {
      if (service !== null || !options.persistenceRuntime.startupService.getStatus().writeEnabled) {
        return false;
      }
      const projects = options.persistenceRuntime.getProjectUnitOfWork();
      const scripts = options.persistenceRuntime.getScriptWorkspaceQuery();
      const media = options.persistenceRuntime.getMediaUnitOfWork();
      const profiles = options.persistenceRuntime.getProviderProfileRepository();
      const scriptUnitOfWork = options.persistenceRuntime.getScriptUnitOfWork();
      const videoPreferences = options.persistenceRuntime.getVideoProviderPreferences();
      if (
        projects === null ||
        scripts === null ||
        media === null ||
        profiles === null ||
        scriptUnitOfWork === null ||
        videoPreferences === null
      )
        return false;
      const consistency = createMediaConsistencyService({
        mediaUnitOfWork: media,
        workspaceQuery: scripts,
      });
      // 仅 E2E 注入一次可恢复失败，用于验证首页不会遗留半初始化体验项目。
      let injectedDemoFailure = false;
      const guideQuery = createCreatorGuideQuery({ consistency, media, projects, scripts });
      const guide = createCreatorGuideService(
        guideQuery,
        createDemoSeeder({
          demoResourceRoot: options.demoResourceRoot,
          managedRoot: options.managedRoot,
          onProgress: (event) => {
            if (
              process.env.JINGXU_E2E === '1' &&
              process.env.JINGXU_E2E_DEMO_FAIL_ONCE_AT === event &&
              !injectedDemoFailure
            ) {
              injectedDemoFailure = true;
              return Promise.reject(new Error('E2E_DEMO_SEED_FAILURE'));
            }
            return Promise.resolve();
          },
          persistenceRuntime: options.persistenceRuntime,
        }),
      );
      const preparation = createCreatorPreparationService(
        createCreatorPreparationQuery({
          consistency,
          creatorGuide: guideQuery,
          projects,
          providerProfiles: profiles,
          scripts,
          scriptUnitOfWork,
          videoPreferences,
        }),
        {
          hashPayload: (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
          now: () => new Date().toISOString(),
        },
      );
      service = {
        ...guide,
        getPreparation: (input, traceId) => preparation.getPreparation(input, traceId),
      };
      return true;
    },
  };
};
