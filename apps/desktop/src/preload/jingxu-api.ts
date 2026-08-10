import {
  appResultSchema,
  createProjectInputSchema,
  deleteProjectInputSchema,
  PROJECT_IPC_CHANNELS,
  projectDetailSchema,
  projectGetInputSchema,
  projectListInputSchema,
  projectListResultSchema,
  restoreProjectInputSchema,
  RUNTIME_IPC_CHANNELS,
  startupStatusSchema,
  updateProjectInputSchema,
  type CreateProjectInputDto,
  type DeleteProjectInputDto,
  type JingxuApi,
  type ProjectGetInputDto,
  type ProjectListInputDto,
  type RestoreBackupCommandDto,
  type RestoreProjectInputDto,
  type StartupCommandDto,
  type UpdateProjectInputDto,
} from '@jingxu/contracts';

export { PROJECT_IPC_CHANNELS, RUNTIME_IPC_CHANNELS };

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
    project: Object.freeze({
      list: async (input: ProjectListInputDto) => {
        const validated = projectListInputSchema.parse(input);
        return appResultSchema(projectListResultSchema).parse(
          await invoke(PROJECT_IPC_CHANNELS.list, validated),
        );
      },
      get: async (input: ProjectGetInputDto) => {
        const validated = projectGetInputSchema.parse(input);
        return appResultSchema(projectDetailSchema).parse(
          await invoke(PROJECT_IPC_CHANNELS.get, validated),
        );
      },
      create: async (input: CreateProjectInputDto) => {
        const validated = createProjectInputSchema.parse(input);
        return appResultSchema(projectDetailSchema).parse(
          await invoke(PROJECT_IPC_CHANNELS.create, validated),
        );
      },
      update: async (input: UpdateProjectInputDto) => {
        const validated = updateProjectInputSchema.parse(input);
        return appResultSchema(projectDetailSchema).parse(
          await invoke(PROJECT_IPC_CHANNELS.update, validated),
        );
      },
      delete: async (input: DeleteProjectInputDto) => {
        const validated = deleteProjectInputSchema.parse(input);
        return appResultSchema(projectDetailSchema).parse(
          await invoke(PROJECT_IPC_CHANNELS.delete, validated),
        );
      },
      restore: async (input: RestoreProjectInputDto) => {
        const validated = restoreProjectInputSchema.parse(input);
        return appResultSchema(projectDetailSchema).parse(
          await invoke(PROJECT_IPC_CHANNELS.restore, validated),
        );
      },
    }),
  });
