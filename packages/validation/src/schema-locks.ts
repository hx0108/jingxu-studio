export const SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema' as const;

export const V1_SCHEMA_IDS = {
  scriptStageOutput: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
  shotContract: 'https://jingxu.studio/schemas/shot-contract/1.1.0',
  episodeStoryboardExport: 'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0',
  projectTransferBundle: 'https://jingxu.studio/schemas/project-transfer-bundle/1.0.0',
} as const;

export type V1SchemaId = (typeof V1_SCHEMA_IDS)[keyof typeof V1_SCHEMA_IDS];

export interface V1SchemaLock {
  readonly schemaId: V1SchemaId;
  readonly draft: typeof SCHEMA_DRAFT_2020_12;
  readonly semanticVersion: string;
  readonly resourceName: string;
  readonly sha256: string;
}

export type SchemaRegistryConfigurationErrorCode =
  'SCHEMA_MANIFEST_INVALID' | 'SCHEMA_ID_NOT_REGISTERED';

export class SchemaRegistryConfigurationError extends Error {
  public readonly code: SchemaRegistryConfigurationErrorCode;

  public constructor(code: SchemaRegistryConfigurationErrorCode) {
    super(
      code === 'SCHEMA_ID_NOT_REGISTERED'
        ? 'Schema ID is not registered.'
        : 'Schema manifest is invalid.',
    );
    this.name = 'SchemaRegistryConfigurationError';
    this.code = code;
  }
}

const locks: readonly V1SchemaLock[] = [
  {
    schemaId: V1_SCHEMA_IDS.scriptStageOutput,
    draft: SCHEMA_DRAFT_2020_12,
    semanticVersion: '1.0.0',
    resourceName: 'ScriptStageOutput.schema.json',
    sha256: '128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f',
  },
  {
    schemaId: V1_SCHEMA_IDS.shotContract,
    draft: SCHEMA_DRAFT_2020_12,
    semanticVersion: '1.1.0',
    resourceName: 'ShotContract.schema.json',
    sha256: '3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b',
  },
  {
    schemaId: V1_SCHEMA_IDS.episodeStoryboardExport,
    draft: SCHEMA_DRAFT_2020_12,
    semanticVersion: '1.1.0',
    resourceName: 'EpisodeStoryboardExport.schema.json',
    sha256: '55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13',
  },
  {
    schemaId: V1_SCHEMA_IDS.projectTransferBundle,
    draft: SCHEMA_DRAFT_2020_12,
    semanticVersion: '1.0.0',
    resourceName: 'ProjectTransferBundle.schema.json',
    sha256: '9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb',
  },
];

export const V1_SCHEMA_LOCKS: readonly Readonly<V1SchemaLock>[] = Object.freeze(
  locks.map((lock) => Object.freeze(lock)),
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCompleteLock = (value: unknown): value is V1SchemaLock => {
  if (!isRecord(value)) return false;

  return (
    typeof value.schemaId === 'string' &&
    Object.values(V1_SCHEMA_IDS).includes(value.schemaId as V1SchemaId) &&
    value.draft === SCHEMA_DRAFT_2020_12 &&
    typeof value.semanticVersion === 'string' &&
    /^\d+\.\d+\.\d+$/u.test(value.semanticVersion) &&
    value.schemaId.endsWith(`/${value.semanticVersion}`) &&
    typeof value.resourceName === 'string' &&
    /^[\x20-\x7e]+$/u.test(value.resourceName) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  );
};

export function assertValidSchemaLocks(
  candidate: unknown,
): asserts candidate is readonly V1SchemaLock[] {
  if (!Array.isArray(candidate) || candidate.length !== 4 || !candidate.every(isCompleteLock)) {
    throw new SchemaRegistryConfigurationError('SCHEMA_MANIFEST_INVALID');
  }

  const schemaIds = new Set(candidate.map((lock) => lock.schemaId));
  const resourceNames = new Set(candidate.map((lock) => lock.resourceName));
  if (schemaIds.size !== candidate.length || resourceNames.size !== candidate.length) {
    throw new SchemaRegistryConfigurationError('SCHEMA_MANIFEST_INVALID');
  }
}

assertValidSchemaLocks(V1_SCHEMA_LOCKS);

export const getV1SchemaLock = (schemaId: string): Readonly<V1SchemaLock> => {
  const lock = V1_SCHEMA_LOCKS.find((candidate) => candidate.schemaId === schemaId);
  if (lock === undefined) {
    throw new SchemaRegistryConfigurationError('SCHEMA_ID_NOT_REGISTERED');
  }
  return lock;
};
