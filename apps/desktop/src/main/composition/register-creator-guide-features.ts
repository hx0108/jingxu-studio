import { createCreatorGuideService } from '@jingxu/application';
import type {
  AppResultDto,
  CreatorDemoResultDto,
  CreatorNextActionResultDto,
  StartCreatorDemoInputDto,
} from '@jingxu/contracts';

import { createDemoSeeder } from './create-demo-seeder';
import { demoProjectRegistry } from './demo-project-registry';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createCreatorGuideQuery } from './create-creator-guide-query';
import {
  registerCreatorGuideIpc,
  type CreatorGuideIpcRegistrar,
  type CreatorGuideIpcService,
} from '../ipc/creator-guide-ipc';

export interface CreatorGuideFeatureRegistration {
  ensureRegistered(): boolean;
}

export const createCreatorGuideFeatureRegistration = (options: {
  readonly ipcRegistrar: CreatorGuideIpcRegistrar;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}): CreatorGuideFeatureRegistration => {
  let service: CreatorGuideIpcService | null = null;
  // 启动即预载演示项目登记（重启恢复）；种子创建/恢复时亦会写入。
  void demoProjectRegistry.prime(options.persistenceRuntime);

  const unavailable = (traceId: string): Promise<AppResultDto<CreatorNextActionResultDto>> =>
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
      if (projects === null || scripts === null) return false;
      service = createCreatorGuideService(
        createCreatorGuideQuery({ projects, scripts }),
        createDemoSeeder({ persistenceRuntime: options.persistenceRuntime }),
      );
      return true;
    },
  };
};
