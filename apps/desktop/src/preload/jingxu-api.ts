import {
  appResultSchema,
  assetViewSchema,
  cancelBatchInputSchema,
  EVENTS_IPC_CHANNELS,
  EVALUATION_IPC_CHANNELS,
  evaluationAddAnnotationInputSchema,
  evaluationAddAnnotationResultSchema,
  evaluationCreateFromEpisodeInputSchema,
  evaluationCreateFromEpisodeResultSchema,
  evaluationCreateSampleInputSchema,
  evaluationDeleteSampleInputSchema,
  evaluationDeleteSampleResultSchema,
  evaluationGetSampleInputSchema,
  evaluationImportBatchInputSchema,
  evaluationImportBatchResultSchema,
  evaluationListSamplesInputSchema,
  evaluationListSamplesResultSchema,
  evaluationSampleDetailSchema,
  evaluationSampleSummarySchema,
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
  PRODUCIBILITY_IPC_CHANNELS,
  providerCredentialCommandSchema,
  providerGetInputSchema,
  PROVIDER_IPC_CHANNELS,
  providerMutationInputSchema,
  providerProfileCommandSchema,
  providerProfileSchema,
  producibilityGetReportInputSchema,
  producibilityOverrideFindingInputSchema,
  producibilityReportSchema,
  producibilityRunInputSchema,
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
  initializeInputSchema,
  importInputSchema,
  restoreScriptVersionInputSchema,
  saveScriptDraftInputSchema,
  rewriteSelectionInputSchema,
  scriptLockInputSchema,
  scriptLockListInputSchema,
  scriptLockSummarySchema,
  shotEditLockSummarySchema,
  storyboardEditShotInputSchema,
  storyboardExportEpisodeInputSchema,
  storyboardExportResultSchema,
  storyboardLockShotInputSchema,
  storyboardUnlockShotInputSchema,
  storyboardSplitShotInputSchema,
  storyboardMergeShotsInputSchema,
  storyboardCopyShotInputSchema,
  storyboardReorderShotsInputSchema,
  storyboardDeleteShotInputSchema,
  storyboardRestoreShotInputSchema,
  STORYBOARD_IPC_CHANNELS,
  scriptMutationResultSchema,
  scriptVersionSchema,
  scriptWorkspaceSchema,
  startupStatusSchema,
  storyboardImageStatesSchema,
  storyboardVideoStatesSchema,
  subscriptionResultSchema,
  updateProjectInputSchema,
  uploadAssetReferenceInputSchema,
  uploadAssetReferenceResultSchema,
  VIDEO_IPC_CHANNELS,
  TRANSFER_IPC_CHANNELS,
  cancelVideoBatchInputSchema,
  cancelVideoExportInputSchema,
  createVideoTimelineInputSchema,
  generateVideoCandidatesInputSchema,
  generateVideosForShotsInputSchema,
  getVideoTaskInputSchema,
  getVideoExportJobInputSchema,
  getVideoTimelineInputSchema,
  importVideoBackgroundMusicInputSchema,
  listStoryboardVideoStatesInputSchema,
  listVideoCandidatesInputSchema,
  selectVideoCandidateInputSchema,
  startVideoExportInputSchema,
  updateVideoTimelineInputSchema,
  videoCandidateViewSchema,
  videoAudioAssetSummarySchema,
  videoExportJobSchema,
  videoTimelineSummarySchema,
  transferExportProjectInputSchema,
  transferImportProjectInputSchema,
  transferExportResultSchema,
  transferImportResultSchema,
  type CancelVideoBatchInputDto,
  type CancelVideoExportInputDto,
  type CreateVideoTimelineInputDto,
  type EvaluationAddAnnotationInputDto,
  type EvaluationCreateFromEpisodeInputDto,
  type EvaluationCreateSampleInputDto,
  type EvaluationDeleteSampleInputDto,
  type EvaluationGetSampleInputDto,
  type EvaluationImportBatchInputDto,
  type EvaluationListSamplesInputDto,
  type GenerateVideoCandidatesInputDto,
  type GenerateVideosForShotsInputDto,
  type GetVideoTaskInputDto,
  type GetVideoExportJobInputDto,
  type GetVideoTimelineInputDto,
  type ImportVideoBackgroundMusicInputDto,
  type ListStoryboardVideoStatesInputDto,
  type ListVideoCandidatesInputDto,
  type SelectVideoCandidateInputDto,
  type StartVideoExportInputDto,
  type UpdateVideoTimelineInputDto,
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
  type InitializeInputDto,
  type ImportInputDto,
  type ListAssetsInputDto,
  type ListCandidatesInputDto,
  type ListStoryboardImageStatesInputDto,
  type ProjectGetInputDto,
  type ProjectListInputDto,
  type ProviderCredentialCommandDto,
  type ProviderGetInputDto,
  type ProviderMutationInputDto,
  type ProviderProfileCommandDto,
  type ProducibilityGetReportInputDto,
  type ProducibilityOverrideFindingInputDto,
  type ProducibilityRunInputDto,
  type RestoreBackupCommandDto,
  type RestoreProjectInputDto,
  type RestoreScriptVersionInputDto,
  type SaveScriptDraftInputDto,
  type RewriteSelectionInputDto,
  type ScriptLockInputDto,
  type ScriptLockListInputDto,
  type StoryboardEditShotInputDto,
  type StoryboardExportEpisodeInputDto,
  type StoryboardLockShotInputDto,
  type StoryboardUnlockShotInputDto,
  type StoryboardSplitShotInputDto,
  type StoryboardMergeShotsInputDto,
  type StoryboardCopyShotInputDto,
  type StoryboardReorderShotsInputDto,
  type StoryboardDeleteShotInputDto,
  type StoryboardRestoreShotInputDto,
  type SelectCandidateInputDto,
  type StartupCommandDto,
  type UpdateProjectInputDto,
  type UploadAssetReferenceInputDto,
  type TransferExportProjectInputDto,
  type TransferImportProjectInputDto,
} from '@jingxu/contracts';

export {
  EVENTS_IPC_CHANNELS,
  EVALUATION_IPC_CHANNELS,
  IMAGE_IPC_CHANNELS,
  JOB_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  RUNTIME_IPC_CHANNELS,
  SCRIPT_IPC_CHANNELS,
  STORYBOARD_IPC_CHANNELS,
  VIDEO_IPC_CHANNELS,
  TRANSFER_IPC_CHANNELS,
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
    evaluation: Object.freeze({
      listSamples: async (input: EvaluationListSamplesInputDto) =>
        appResultSchema(evaluationListSamplesResultSchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.listSamples,
            evaluationListSamplesInputSchema.parse(input),
          ),
        ),
      getSample: async (input: EvaluationGetSampleInputDto) =>
        appResultSchema(evaluationSampleDetailSchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.getSample,
            evaluationGetSampleInputSchema.parse(input),
          ),
        ),
      createSample: async (input: EvaluationCreateSampleInputDto) =>
        appResultSchema(evaluationSampleSummarySchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.createSample,
            evaluationCreateSampleInputSchema.parse(input),
          ),
        ),
      createFromEpisode: async (input: EvaluationCreateFromEpisodeInputDto) =>
        appResultSchema(evaluationCreateFromEpisodeResultSchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.createFromEpisode,
            evaluationCreateFromEpisodeInputSchema.parse(input),
          ),
        ),
      importBatch: async (input: EvaluationImportBatchInputDto) =>
        appResultSchema(evaluationImportBatchResultSchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.importBatch,
            evaluationImportBatchInputSchema.parse(input),
          ),
        ),
      deleteSample: async (input: EvaluationDeleteSampleInputDto) =>
        appResultSchema(evaluationDeleteSampleResultSchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.deleteSample,
            evaluationDeleteSampleInputSchema.parse(input),
          ),
        ),
      addAnnotation: async (input: EvaluationAddAnnotationInputDto) =>
        appResultSchema(evaluationAddAnnotationResultSchema).parse(
          await invoke(
            EVALUATION_IPC_CHANNELS.addAnnotation,
            evaluationAddAnnotationInputSchema.parse(input),
          ),
        ),
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
    producibility: Object.freeze({
      run: async (input: ProducibilityRunInputDto) =>
        appResultSchema(producibilityReportSchema).parse(
          await invoke(PRODUCIBILITY_IPC_CHANNELS.run, producibilityRunInputSchema.parse(input)),
        ),
      getReport: async (input: ProducibilityGetReportInputDto) =>
        appResultSchema(producibilityReportSchema).parse(
          await invoke(
            PRODUCIBILITY_IPC_CHANNELS.getReport,
            producibilityGetReportInputSchema.parse(input),
          ),
        ),
      overrideFinding: async (input: ProducibilityOverrideFindingInputDto) =>
        appResultSchema(producibilityReportSchema).parse(
          await invoke(
            PRODUCIBILITY_IPC_CHANNELS.overrideFinding,
            producibilityOverrideFindingInputSchema.parse(input),
          ),
        ),
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
      initializeInput: async (input: InitializeInputDto) =>
        appResultSchema(scriptWorkspaceSchema).parse(
          await invoke(SCRIPT_IPC_CHANNELS.initializeInput, initializeInputSchema.parse(input)),
        ),
      importInput: async (input: ImportInputDto) =>
        appResultSchema(scriptWorkspaceSchema).parse(
          await invoke(SCRIPT_IPC_CHANNELS.importInput, importInputSchema.parse(input)),
        ),
      rewriteSelection: async (input: RewriteSelectionInputDto) =>
        appResultSchema(scriptVersionSchema).parse(
          await invoke(
            SCRIPT_IPC_CHANNELS.rewriteSelection,
            rewriteSelectionInputSchema.parse(input),
          ),
        ),
      lockPath: async (input: ScriptLockInputDto) =>
        appResultSchema(scriptLockSummarySchema).parse(
          await invoke(SCRIPT_IPC_CHANNELS.lockPath, scriptLockInputSchema.parse(input)),
        ),
      listLocks: async (input: ScriptLockListInputDto) =>
        appResultSchema(scriptLockSummarySchema).parse(
          await invoke(SCRIPT_IPC_CHANNELS.listLocks, scriptLockListInputSchema.parse(input)),
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
      exportEpisode: async (input: StoryboardExportEpisodeInputDto) =>
        appResultSchema(storyboardExportResultSchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.exportEpisode,
            storyboardExportEpisodeInputSchema.parse(input),
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
      splitShot: async (input: StoryboardSplitShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.splitShot,
            storyboardSplitShotInputSchema.parse(input),
          ),
        ),
      mergeShots: async (input: StoryboardMergeShotsInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.mergeShots,
            storyboardMergeShotsInputSchema.parse(input),
          ),
        ),
      copyShot: async (input: StoryboardCopyShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.copyShot,
            storyboardCopyShotInputSchema.parse(input),
          ),
        ),
      reorderShots: async (input: StoryboardReorderShotsInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.reorderShots,
            storyboardReorderShotsInputSchema.parse(input),
          ),
        ),
      deleteShot: async (input: StoryboardDeleteShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.deleteShot,
            storyboardDeleteShotInputSchema.parse(input),
          ),
        ),
      restoreShot: async (input: StoryboardRestoreShotInputDto) =>
        appResultSchema(shotEditLockSummarySchema).parse(
          await invoke(
            STORYBOARD_IPC_CHANNELS.restoreShot,
            storyboardRestoreShotInputSchema.parse(input),
          ),
        ),
    }),
    video: Object.freeze({
      generateVideoCandidates: async (input: GenerateVideoCandidatesInputDto) =>
        appResultSchema(mediaTaskViewSchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.generateVideoCandidates,
            generateVideoCandidatesInputSchema.parse(input),
          ),
        ),
      listVideoCandidates: async (input: ListVideoCandidatesInputDto) =>
        appResultSchema(videoCandidateViewSchema.array()).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.listVideoCandidates,
            listVideoCandidatesInputSchema.parse(input),
          ),
        ),
      selectVideoCandidate: async (input: SelectVideoCandidateInputDto) =>
        appResultSchema(videoCandidateViewSchema.array()).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.selectVideoCandidate,
            selectVideoCandidateInputSchema.parse(input),
          ),
        ),
      getVideoTask: async (input: GetVideoTaskInputDto) =>
        appResultSchema(mediaTaskViewSchema).parse(
          await invoke(VIDEO_IPC_CHANNELS.getVideoTask, getVideoTaskInputSchema.parse(input)),
        ),
      generateVideosForShots: async (input: GenerateVideosForShotsInputDto) =>
        appResultSchema(mediaBatchViewSchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.generateVideosForShots,
            generateVideosForShotsInputSchema.parse(input),
          ),
        ),
      cancelVideoBatch: async (input: CancelVideoBatchInputDto) =>
        appResultSchema(mediaBatchViewSchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.cancelVideoBatch,
            cancelVideoBatchInputSchema.parse(input),
          ),
        ),
      listStoryboardVideoStates: async (input: ListStoryboardVideoStatesInputDto) =>
        appResultSchema(storyboardVideoStatesSchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.listStoryboardVideoStates,
            listStoryboardVideoStatesInputSchema.parse(input),
          ),
        ),
      createTimeline: async (input: CreateVideoTimelineInputDto) =>
        appResultSchema(videoTimelineSummarySchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.createTimeline,
            createVideoTimelineInputSchema.parse(input),
          ),
        ),
      getTimeline: async (input: GetVideoTimelineInputDto) =>
        appResultSchema(videoTimelineSummarySchema).parse(
          await invoke(VIDEO_IPC_CHANNELS.getTimeline, getVideoTimelineInputSchema.parse(input)),
        ),
      updateTimeline: async (input: UpdateVideoTimelineInputDto) =>
        appResultSchema(videoTimelineSummarySchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.updateTimeline,
            updateVideoTimelineInputSchema.parse(input),
          ),
        ),
      importBackgroundMusic: async (input: ImportVideoBackgroundMusicInputDto) =>
        appResultSchema(videoAudioAssetSummarySchema).parse(
          await invoke(
            VIDEO_IPC_CHANNELS.importBackgroundMusic,
            importVideoBackgroundMusicInputSchema.parse(input),
          ),
        ),
      startExport: async (input: StartVideoExportInputDto) =>
        appResultSchema(videoExportJobSchema).parse(
          await invoke(VIDEO_IPC_CHANNELS.startExport, startVideoExportInputSchema.parse(input)),
        ),
      getExportJob: async (input: GetVideoExportJobInputDto) =>
        appResultSchema(videoExportJobSchema).parse(
          await invoke(VIDEO_IPC_CHANNELS.getExportJob, getVideoExportJobInputSchema.parse(input)),
        ),
      cancelExport: async (input: CancelVideoExportInputDto) =>
        appResultSchema(videoExportJobSchema).parse(
          await invoke(VIDEO_IPC_CHANNELS.cancelExport, cancelVideoExportInputSchema.parse(input)),
        ),
    }),
    transfer: Object.freeze({
      exportProject: async (input: TransferExportProjectInputDto) =>
        appResultSchema(transferExportResultSchema).parse(
          await invoke(
            TRANSFER_IPC_CHANNELS.exportProject,
            transferExportProjectInputSchema.parse(input),
          ),
        ),
      importProject: async (input: TransferImportProjectInputDto) =>
        appResultSchema(transferImportResultSchema).parse(
          await invoke(
            TRANSFER_IPC_CHANNELS.importProject,
            transferImportProjectInputSchema.parse(input),
          ),
        ),
    }),
  });
