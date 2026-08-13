import { describe, expect, it } from 'vitest';

import {
  INVALID_MODEL_SCRIPT_STAGE_CANDIDATE_FIXTURES,
  VALID_MODEL_SCRIPT_STAGE_CANDIDATE_FIXTURES,
} from './fixtures/model-script-stage-candidate';
import {
  validateModelScriptStageCandidate,
  type ModelScriptCandidateStage,
} from './model-script-stage-candidate';

describe('ModelScriptStageCandidate', () => {
  it.each(Object.entries(VALID_MODEL_SCRIPT_STAGE_CANDIDATE_FIXTURES))(
    '条件—%s 候选只含 data—通过模型层契约',
    (stage, candidate) => {
      expect(
        validateModelScriptStageCandidate(stage as ModelScriptCandidateStage, candidate),
      ).toEqual({
        errorCode: null,
        ok: true,
      });
    },
  );

  it.each(Object.entries(INVALID_MODEL_SCRIPT_STAGE_CANDIDATE_FIXTURES))(
    '条件—%s 单一错误候选—严格拒绝',
    (stage, candidate) => {
      expect(
        validateModelScriptStageCandidate(stage as ModelScriptCandidateStage, candidate).ok,
      ).toBe(false);
    },
  );
});
