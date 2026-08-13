import type { ScriptUnitOfWorkPort, ScriptWorkspaceQueryPort } from '@jingxu/application';

import {
  registerScriptIpc,
  type ScriptIpcRegistrar,
  type ScriptIpcService,
  type ScriptIpcTraceIds,
} from '../ipc/script-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

export interface ScriptRuntimeHandles {
  readonly unitOfWork: ScriptUnitOfWorkPort;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface RegisterScriptFeaturesOptions {
  readonly createService: (handles: ScriptRuntimeHandles) => ScriptIpcService;
  readonly ipcRegistrar: ScriptIpcRegistrar;
  readonly newTraceId?: ScriptIpcTraceIds['newTraceId'];
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly trustedUrl: string;
}

export interface ScriptFeatureRegistration {
  /** Registers the five Script-only IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
}

/**
 * Pure Script composition boundary. It deliberately does not register or wrap Job/Provider channels;
 * the main owner must pass the same persistence runtime and call this after startup reaches READY.
 */
export const createScriptFeatureRegistration = ({
  createService,
  ipcRegistrar,
  newTraceId,
  persistenceRuntime,
  trustedUrl,
}: RegisterScriptFeaturesOptions): ScriptFeatureRegistration => {
  let registered = false;
  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getScriptUnitOfWork();
      const workspaceQuery = persistenceRuntime.getScriptWorkspaceQuery();
      if (unitOfWork === null || workspaceQuery === null) return false;
      const service = createService({ unitOfWork, workspaceQuery });
      registerScriptIpc(
        ipcRegistrar,
        service,
        { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
        trustedUrl,
        ...(newTraceId === undefined ? [] : [{ newTraceId }]),
      );
      registered = true;
      return true;
    },
  };
};
