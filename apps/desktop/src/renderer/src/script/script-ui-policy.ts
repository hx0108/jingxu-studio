import type { JobSummaryDto, ProviderProfileDto } from '@jingxu/contracts';

export const countUnicodeCharacters = (value: string): number => Array.from(value).length;

export const isOriginalCreativeValid = (value: string): boolean => {
  const count = countUnicodeCharacters(value);
  return count >= 20 && count <= 2_000 && value.trim() !== '';
};

export const isProviderReadyForGeneration = (profile: ProviderProfileDto | null): boolean =>
  profile?.configured === true &&
  profile.enabled &&
  profile.validated &&
  profile.workspaceId.trim() !== '' &&
  !profile.workspaceId.toLowerCase().includes('placeholder');

export const isTerminalJob = (job: JobSummaryDto | null): boolean =>
  job !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status);

export const episodeScopeForStage = (
  stage: 'CONCEPT' | 'STORY_BIBLE' | 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT',
  episodeId: string,
): string | null => (stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : episodeId);
