import {
  appResultSchema,
  assetViewSchema,
  cancelBatchInputSchema,
  EVENTS_IPC_CHANNELS,
  generateCandidatesForShotsInputSchema,
  generateCandidatesInputSchema,
  getMediaTaskInputSchema,
  IMAGE_IPC_CHANNELS,
  imageCandidateViewSchema,
  jobCreateInputSchema,
  jobGetInputSchema,
  JOB_IPC_CHANNELS,
  jobListInputSchema,
  jobMutationInputSchema,
  jobSummarySchema,
  jobUpdatesSubscriptionSchema,
  listAssetsInputSchema,
  listCandidatesInputSchema,
  listStoryboardImageStatesInputSchema,
  mediaBatchViewSchema,
  mediaTaskViewSchema,
  createProjectInputSchema,
  deleteProjectInputSchema,
  PROJECT_IPC_CHANNELS,
  providerCredentialCommandSchema,
  providerGetInputSchema,
  PROVIDER_IPC_CHANNELS,
  providerMutationInputSchema,
  providerProfileCommandSchema,
  providerProfileSchema,
  projectDetailSchema,
  projectGetInputSchema,
  projectListInputSchema,
  projectListResultSchema,
  restoreProjectInputSchema,
  RUNTIME_IPC_CHANNELS,
  SCRIPT_IPC_CHANNELS,
  selectCandidateInputSchema,
  confirmScriptVersionInputSchema,
  getScriptWorkspaceInputSchema,
  initializeOriginalInputSchema,
  restoreScriptVersionInputSchema,
  saveScriptDraftInputSchema,
  shotEditLockSummarySchema,
  storyboardEditShotInputSchema,
  storyboardLockShotInputSchema,
  storyboardUnlockShotInputSchema,
  STORYBOARD_IPC_CHANNELS,
  scriptMutationResultSchema,
  scriptVersionSchema,
  scriptWorkspaceSchema,
  startupStatusSchema,
  storyboardImageStatesSchema,
  subscriptionResultSchema,
  updateProjectInputSchema,
  uploadAssetReferenceInputSchema,
  uploadAssetReferenceResultSchema,
  type CreateProjectInputDto,
  type GenerateCandidatesForShotsInputDto,
  type GenerateCandidatesInputDto,
  type GetMediaTaskInputDto,
  type JobCreateInputDto,
  type JobGetInputDto,
  type JobListInputDto,
  type JobMutationInputDto,
  type JobUpdatesSubscriptionDto,
  type CancelBatchInputDto,
  type DeleteProjectInputDto,
  type JingxuApi,
  type ConfirmScriptVersionInputDto,
  type GetScriptWorkspaceInputDto,
  type InitializeOriginalInputDto,
  type ListAssetsInputDto,
  type ListCandidatesInputDto,
  type ListStoryboardImageStatesInputDto,
  type ProjectGetInputDto,
  type ProjectListInputDto,
  type ProviderCredentialCommandDto,
  type ProviderGetInputDto,
  type ProviderMutationInputDto,
  type ProviderProfileCommandDto,
  type RestoreBackupCommandDto,
  type RestoreProjectInputDto,
  type RestoreScriptVersionInputDto,
  type SaveScriptDraftInputDto,
  type StoryboardEditShotInputDto,
  type StoryboardLockShotInputDto,
  type StoryboardUnlockShotInputDto,
  type SelectCandidateInputDto,
  type StartupCommandDto,
  type UpdateProjectInputDto,
  type UploadAssetReferenceInputDto,
} from '@jingxu/contracts';

export {
  EVENTS_IPC_CHANNELS,
  IMAGE_IPC_CHANNELS,
  JOB_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  RUNTIME_IPC_CHANNELS,
  SCRIPT_IPC_CHANNELS,
  STORYBOARD_IPC_CHANNELS,
};

export type InvokeIpc = (channel: string, ...arguments_: readonly unknown[]) => Promise<unknown>;

export const createJingxuApi = (invoke: InvokeIpc): JingxuApi =>
  Object.freeze({
    events: Object.freeze({
      subscribeJobUpdates: async (input: JobUpdatesSubscriptionDto) => {
        const validated = jobUpdatesSubscriptionSchema.parse(input);
        return appResultSchema(subscriptionResultSchema).parse(
          await invoke(EVENTS_IPC_CHANNELS.subscribeJobUpdates, validated),
        );
      },
    }),
    image: Object.freeze({
      generateCandidates: async (input: GenerateCandidatesInputDto) =>
        appResultSchema(mediaTaskViewSchema).parse(
          await invoke(
            IMAGE_IPC_CHANNELS.generateCandidates,
            generateCandidatesInputSchema.parse(input),
          ),
        ),
      listCandidates: async (input: ListCandidatesInputDto) =>
        appResultSchema(imageCandidateViewSchema.array()).parse(
          await invoke(IMAGE_IPC_CHANNELS.listCandidates, listCandidatesInputSchema.parse(input)),
        ),
      selectCandidate: async (input: SelectCandidateInputDto) =>
        appResultSchema(imageCandidateViewSchema.array()).parse(
          await invoke(IMAGE_IPC_CHANNELS.selectCandidate, selectCandidateInputSchema.parse(input)),
        ),
      listAssets: async (input: ListAssetsInputDto) =>
        appResultSchema(assetViewSchema.array()).parse(
          await invoke(IMAGE_IPC_CHANNELS.listAssets, listAssetsInputSchema.parse(input)),
        ),
      uploadAssetReference: async (input: UploadAssetReferenceInputDto) =>
        appResultSchema(uploadAssetReferenceResultSchema).parse(
          await invoke(
            IMAGE_IPC_CHANNELS.uploadAssetReference,
            uploadAssetReferenceInputSchema.parse(input),
          ),
        ),
      getMediaTask: async (input: GetMediaTaskInputDto) =>
        appResultSchema(mediaTaskViewSchema).parse(
          await invoke(IMAGE_IPC_CHANNELS.getTask, getMediaTaskInputSchema.parse(input)),
        ),
      generateCandidatesForShots: async (input: GenerateCandidatesForShotsInputDto) =>
        appResultSchema(mediaBatchViewSchema).parse(
          await invoke(
            IMAGE_IPC_CHANNELS.generateCandidatesForShots,
            generateCandidatesForShotsInputSchema.parse(input),
          ),
        ),
      cancelBatch: async (input: CancelBatchInputDto) =>
        appResultSchema(mediaBatchViewSchema).parse(
          await invoke(IMAGE_IPC_CHANNELS.cancelBatch, cancelBatchInputSchema.parse(input)),
        ),
      listStoryboardImageStates: async (input: ListStoryboardImageStatesInputDto) =>
        appResultSchema(storyboardImageStatesSchema).parse(
          await invoke(
            IMAGE_IPC_CHANNELS.listStoryboardImageStates,
            listStoryboardImageStatesInputSchema.parse(input),
          ),
        ),
    }),
    job: Object.freeze({
      create: async (input: JobCreateInputDto) =>
        appResultSchema(jobSummarySchema).parse(
          await invoke(JOB_IPC_CHANNELS.create, jobCreateInputSchema.parse(input)),
        ),
      get: async (input: JobGetInputDto) =>
        appResultSchema(jobSummarySchema).parse(
          await invoke(JOB_IPC_CHANNELS.get, jobGetInputSchema.parse(input)),
        ),
      list: async (input: JobListInputDto) =>
        appResultSchema(jobSummarySchema.array()).parse(
          await invoke(JOB_IPC_CHANNELS.list, jobListInputSchema.parse(input)),
        ),
      cancel: async (input: JobMutationInputDto) =>
        appResultSchema(jobSummarySchema).parse(
          await invoke(JOB_IPC_CHANNELS.cancel, jobMutationInputSchema.parse(input)),
        ),
      retry: async (input: JobMutationInputDto) =>
        appResultSchema(jobSummarySchema).parse(
          await invoke(JOB_IPC_CHANNELS.retry, jobMutationInputSchema.parse(input)),
        ),
    }),
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
    provider: Object.freeze({
      getProfile: async (input: ProviderGetInputDto) =>
        appResultSchema(providerProfileSchema).parse(
          await invoke(PROVIDER_IPC_CHANNELS.getProfile, providerGetInputSchema.parse(input)),
        ),
      saveProfile: async (input: ProviderProfileCommandDto) =>
        appResultSchema(providerProfileSchema).parse(
          await invoke(
            PROVIDER_IPC_CHANNELS.saveProfile,
            providerProfileCommandSchema.parse(input),
          ),
        ),
      saveCredential: async (input: ProviderCredentialCommandDto) =>
        appResultSchema(providerProfileSchema).parse(
          await invoke(
            PROVIDER_IPC_CHANNELS.saveCredential,
            providerCredentialCommandSchema.parse(input),
          ),
        ),
      testCredential: async (input: ProviderMutationInputDto) =>
        appResultSchema(providerProfileSchema).parse(
          await invoke(
            PROVIDER_IPC_CHANNELS.testCredential,
            providerMutationInputSchema.parse(input),
          ),
        ),
      deleteCredential: async (input: ProviderMutationInputDto) =>
        appResultSchema(providerProfileSchema).parse(
          await invoke(
            PROVIDER_IPC_CHANNELS.deleteCredential,
            providerMutationInputSchema.parse(input),
          ),
        ),
    }),
    script: Object.freeze({
      initializeOriginal: async (input: InitializeOriginalInputDto) =>
        appResultSchema(scriptWorkspaceSchema).parse(
          await invoke(
            SCRIPT_IPC_CHANNELS.initializeOriginal,
            initializeOriginalInputSchema.parse(input),
          ),
        ),
      getWorkspace: async (input: GetScriptWorkspaceInputDto) =>
        appResultSchema(scriptWorkspaceSchema).parse(
          await invoke(
            SCRIPT_IPC_CHANNELS.getWorkspace,
            getScriptWorkspaceInputSchema.parse(input),
          ),
        ),
      saveDraft: async (input: SaveScriptDraftInputDto) =>
        appResultSchema(scriptVersionSchema).parse(
          await invoke(SCRIPT_IPC_CHANNELS.saveDraft, saveScriptDraftInputSchema.parse(input)),
        ),
      confirmVersion: async (input: ConfirmScriptVersionInputDto) =>
        appResultSchema(scriptMutationResultSchema).parse(
          await invoke(
            SCRIPT_IPC_CHANNELS.confirmVersion,
            confirmScriptVersionInputSchema.parse(input),
          ),
        ),
      restoreVersion: async (input: RestoreScriptVersionInputDto) =>
        appResultSchema(scriptMutationResultSchema).parse(
          await invoke(
            SCRIPT_IPC_CHANNELS.restoreVersion,
            restoreScriptVersionInputSchema.parse(input),
          ),
        ),
    }),
    storyboard: Object.freeze({
      editShot: async (input: StoryboardEditShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.editShot,
            storyboardEditShotInputSchema.parse(input),
          ),
        ),
      lockShot: async (input: StoryboardLockShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.lockShot,
            storyboardLockShotInputSchema.parse(input),
          ),
        ),
      unlockShot: async (input: StoryboardUnlockShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.unlockShot,
            storyboardUnlockShotInputSchema.parse(input),
          ),
        ),
    }),
  });
