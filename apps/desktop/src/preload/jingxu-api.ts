import {
  RUNTIME_IPC_CHANNELS,
  startupStatusSchema,
  type JingxuApi,
  type RestoreBackupCommandDto,
  type StartupCommandDto,
} from '@jingxu/contracts';

export { RUNTIME_IPC_CHANNELS };

export type InvokeIpc = (channel: string, ...arguments_: readonly unknown[]) => Promise<unknown>;

/**
 * project IPC 桥接占位：§7 实现真正的 main↔preload 桥接前，冻结的
 * `window.jingxu.project.*` 调用一律 reject（不静默返回错数据）。
 * 返回 Promise<never> 协变到各方法的 Promise<AppResultDto<…>>。
 */
const projectNotBridged =
  (method: string): (() => Promise<never>) =>
  () =>
    Promise.reject(new Error(`jingxu.project.${method} 尚未桥接（§7 IPC 集成时实现）`));

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
    // §7 实现 list/get/create/update/delete/restore 真 IPC 桥接；当前一律 reject 占位
    project: Object.freeze({
      list: projectNotBridged('list'),
      get: projectNotBridged('get'),
      create: projectNotBridged('create'),
      update: projectNotBridged('update'),
      delete: projectNotBridged('delete'),
      restore: projectNotBridged('restore'),
    }),
  });
