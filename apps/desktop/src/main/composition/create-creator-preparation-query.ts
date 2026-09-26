import type {
  CreatorGuideQueryPort,
  CreatorPreparationQueryPort,
  MediaConsistencyService,
  ProjectUnitOfWorkPort,
  ProviderProfileRepositoryPort,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  VideoProviderPreferencesPort,
} from '@jingxu/application';

const PROFILE_BY_OPERATION = {
  IMAGE: 'profile-image-agnes-primary',
  VOICE: 'profile-voice-primary',
} as const;

export const createCreatorPreparationQuery = (dependencies: {
  readonly consistency: MediaConsistencyService;
  readonly creatorGuide: CreatorGuideQueryPort;
  readonly projects: ProjectUnitOfWorkPort;
  readonly providerProfiles: ProviderProfileRepositoryPort;
  readonly scripts: ScriptWorkspaceQueryPort;
  readonly scriptUnitOfWork: ScriptUnitOfWorkPort;
  readonly videoPreferences: VideoProviderPreferencesPort;
}): CreatorPreparationQueryPort => ({
  async getFacts(input) {
    const project = await dependencies.projects.run(({ projects }) =>
      projects.findById(input.projectId, 'ACTIVE'),
    );
    if (project === null) return null;
    const workspace = await dependencies.scripts.getWorkspace(input.projectId);
    if (
      workspace === null ||
      workspace.storyboard.current?.status !== 'READY' ||
      (input.episodeId !== null && workspace.episode?.id !== input.episodeId)
    ) {
      return null;
    }
    const currentById = new Map(
      workspace.storyboard.currentShots.map((shot) => [shot.shotId, shot]),
    );
    if (input.shotIds.some((shotId) => !currentById.has(shotId))) return null;
    const scopedShots =
      input.shotIds.length === 0
        ? workspace.storyboard.currentShots
        : workspace.storyboard.currentShots.filter((shot) => input.shotIds.includes(shot.shotId));
    const shotIds = scopedShots.map((shot) => shot.shotId);
    const preflight = await dependencies.consistency.getPreflight(
      { projectId: input.projectId, shotIds },
      `creator-preparation-${input.projectId}`,
    );
    const snapshot = await dependencies.creatorGuide.getProjectSnapshot(input.projectId);
    if (snapshot === null) return null;
    const videoProfileId =
      (await dependencies.videoPreferences.get())?.providerProfileId ?? 'profile-video-primary';
    const profileId =
      input.operation === 'VIDEO'
        ? videoProfileId
        : input.operation === 'EXPORT'
          ? null
          : PROFILE_BY_OPERATION[input.operation];
    const profile =
      profileId === null ? null : await dependencies.providerProfiles.findById(profileId);
    const price = await dependencies.scriptUnitOfWork.run(
      ({ producibility }) =>
        producibility?.findLatestReferencePriceSnapshot?.() ?? Promise.resolve(null),
    );
    const consistencyMissing = preflight.ok
      ? [...new Set(preflight.data.missingItems.map((item) => item.kind))]
      : [];
    return {
      consistencyMissing,
      estimatedDurationSec: scopedShots.reduce(
        (total, shot) => total + shot.version.targetDurationSec,
        0,
      ),
      exportReady: snapshot.exportReady,
      imagesReady: snapshot.imagesReady,
      isDemo: project.experienceMode === 'DEMO',
      price,
      referenceLimitExceeded:
        preflight.ok && preflight.data.warnings.some((warning) => warning.includes('超过上限')),
      serviceReady:
        project.experienceMode === 'DEMO' ||
        input.operation === 'EXPORT' ||
        (profile !== null &&
          profile.enabled &&
          profile.credentialRef !== null &&
          profile.config.lastValidatedAt !== null),
      videosReady: snapshot.videosReady,
      voiceReady: snapshot.voiceReady,
    };
  },
});
