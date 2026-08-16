export {
  buildFirstFramePrompt,
  computeGenerationInputHash,
  extractShotCreativeFields,
  resolveImageSize,
} from './media-generation-prompt';
export type {
  FirstFramePromptInput,
  GenerationInputDescriptor,
  ShotCreativeFields,
} from './media-generation-prompt';
export { createMediaGenerationService } from './media-generation-service';
export type {
  MediaGenerationService,
  MediaGenerationServiceDependencies,
} from './media-generation-service';
export { InMemoryMediaRepository } from './in-memory-media-repository';
export { createMediaRequestBlueprintBuilder } from './media-request-blueprint';
export type {
  MediaReferenceImageReader,
  MediaRequestBlueprint,
  MediaRequestBlueprintBuilder,
  MediaRequestBlueprintBuilderDependencies,
} from './media-request-blueprint';
export { createMediaTaskScheduler } from './media-task-scheduler';
export type {
  MediaFileStorePort,
  MediaRecoveryAction,
  MediaRecoveryOutcome,
  MediaTaskScheduler,
  MediaTaskSchedulerDependencies,
} from './media-task-scheduler';
export { mediaFailure, mediaPersistenceFailure } from './media-service-error';
