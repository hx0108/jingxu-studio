import { createCreatorGuideService } from '@jingxu/application';
import type { AppResultDto, CreatorNextActionResultDto } from '@jingxu/contracts';

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

  registerCreatorGuideIpc(
    options.ipcRegistrar,
    {
      getNextAction: (input, traceId) =>
        service?.getNextAction(input, traceId) ?? unavailable(traceId),
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
      service = createCreatorGuideService(createCreatorGuideQuery({ projects, scripts }));
      return true;
    },
  };
};
