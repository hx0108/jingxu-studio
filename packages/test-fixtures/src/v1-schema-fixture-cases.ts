import { V1_SCHEMA_IDS } from '@jingxu/validation';

import type { V1SchemaId } from '@jingxu/validation';

type ValidFixtureCase = Readonly<{
  fixtureName: string;
  schemaId: V1SchemaId;
  expectedValid: true;
}>;

type InvalidFixtureCase = Readonly<{
  fixtureName: string;
  schemaId: V1SchemaId;
  expectedValid: false;
  expectedInstancePath: string;
  expectedKeyword: string;
  expectedMessageCode: string;
}>;

export type V1SchemaFixtureCase = ValidFixtureCase | InvalidFixtureCase;

export const V1_SCHEMA_FIXTURE_CASES: readonly V1SchemaFixtureCase[] = Object.freeze([
  Object.freeze({
    fixtureName: 'script-stage-output.valid.json',
    schemaId: V1_SCHEMA_IDS.scriptStageOutput,
    expectedValid: true,
  }),
  Object.freeze({
    fixtureName: 'script-stage-output.invalid.json',
    schemaId: V1_SCHEMA_IDS.scriptStageOutput,
    expectedValid: false,
    expectedInstancePath: '/data/title',
    expectedKeyword: 'minLength',
    expectedMessageCode: 'SCHEMA_VALIDATION_MINLENGTH',
  }),
  Object.freeze({
    fixtureName: 'shot-contract.valid.json',
    schemaId: V1_SCHEMA_IDS.shotContract,
    expectedValid: true,
  }),
  Object.freeze({
    fixtureName: 'shot-contract.invalid.json',
    schemaId: V1_SCHEMA_IDS.shotContract,
    expectedValid: false,
    expectedInstancePath: '/status',
    expectedKeyword: 'enum',
    expectedMessageCode: 'SCHEMA_VALIDATION_ENUM',
  }),
  Object.freeze({
    fixtureName: 'episode-storyboard-export.valid.json',
    schemaId: V1_SCHEMA_IDS.episodeStoryboardExport,
    expectedValid: true,
  }),
  Object.freeze({
    fixtureName: 'episode-storyboard-export.invalid.json',
    schemaId: V1_SCHEMA_IDS.episodeStoryboardExport,
    expectedValid: false,
    expectedInstancePath: '/shot_contracts/0/status',
    expectedKeyword: 'enum',
    expectedMessageCode: 'SCHEMA_VALIDATION_ENUM',
  }),
  Object.freeze({
    fixtureName: 'project-transfer-bundle.valid.json',
    schemaId: V1_SCHEMA_IDS.projectTransferBundle,
    expectedValid: true,
  }),
  Object.freeze({
    fixtureName: 'project-transfer-bundle.invalid.json',
    schemaId: V1_SCHEMA_IDS.projectTransferBundle,
    expectedValid: false,
    expectedInstancePath: '/story_bible/output/project_id',
    expectedKeyword: 'pattern',
    expectedMessageCode: 'SCHEMA_VALIDATION_PATTERN',
  }),
]);
