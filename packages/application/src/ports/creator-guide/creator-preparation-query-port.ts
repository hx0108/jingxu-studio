import type { CreatorPreparationOperation } from '@jingxu/contracts';

export interface CreatorPreparationFacts {
  readonly consistencyMissing: readonly ('CHARACTER' | 'STYLE')[];
  readonly estimatedDurationSec: number | null;
  readonly exportReady: boolean;
  readonly imagesReady: boolean;
  readonly isDemo: boolean;
  readonly price: {
    readonly currency: string;
    readonly effectiveAt: string;
    readonly expiresAt: string;
    readonly max: number;
    readonly min: number;
  } | null;
  readonly referenceLimitExceeded: boolean;
  readonly serviceReady: boolean;
  readonly videosReady: boolean;
  readonly voiceReady: boolean;
}

export interface CreatorPreparationQueryPort {
  getFacts(input: {
    readonly episodeId: string | null;
    readonly operation: CreatorPreparationOperation;
    readonly projectId: string;
    readonly shotIds: readonly string[];
  }): Promise<CreatorPreparationFacts | null>;
}
