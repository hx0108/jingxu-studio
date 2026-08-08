import {
  RUNTIME_IPC_CHANNELS,
  startupStatusSchema,
  type JingxuApi,
  type RestoreBackupCommandDto,
  type StartupCommandDto,
} from '@jingxu/contracts';

export { RUNTIME_IPC_CHANNELS };

export type InvokeIpc = (channel: string, ...arguments_: readonly unknown[]) => Promise<unknown>;

export const createJingxuApi = (invoke: InvokeIpc): JingxuApi =>
  Object.freeze({
    runtime: Object.freeze({
      getStartupStatus: async () =>
        startupStatusSchema.parse(await invoke(RUNTIME_IPC_CHANNELS.getStartupStatus)),
      restoreBackup: async (command: RestoreBackupCommandDto) =>
        startupStatusSchema.parse(await invoke(RUNTIME_IPC_CHANNELS.restoreBackup, command)),
      retryStartup: async (command: StartupCommandDto) =>
        startupStatusSchema.parse(await invoke(RUNTIME_IPC_CHANNELS.retryStartup, command)),
    }),
  });
