import type { EvaluationIssueCode, EvaluationSampleInputDto } from '@jingxu/contracts';
import { describe, expect, it } from 'vitest';

import type { SchemaValidationResult } from '../ports/schema-registry';

import { createEvaluationRulesEngine } from './evaluation-rules-engine';

/** Registry 校验桩：默认放行；schemaInvalid=true 时返回单条 enum issue（模拟正式 Registry 失败形态）。 */
const schemaStub =
  (schemaInvalid = false) =>
  (schemaId: string): SchemaValidationResult =>
    schemaInvalid
      ? {
          schemaId,
          valid: false,
          issues: [
            { instancePath: '/status', keyword: 'enum', messageCode: 'SCHEMA_VALIDATION_ENUM' },
          ],
        }
      : { schemaId, valid: true, issues: [] };

/**
 * 基线镜头：与 packages/test-fixtures/src/fixtures/v1/shot-contract.valid.json 同构的
 * 最小合法 ShotContract 1.1.0 文档（引擎单测用 Registry 桩，真实 Registry 判定由
 * test-fixtures 契约测试与集成矩阵覆盖）。
 */
const baseShot = (): Record<string, unknown> => ({
  acceptance: { human_review_required: true, must_include: ['主角'], must_not_include: [] },
  cinematography: {
    camera_angle: 'EYE_LEVEL',
    camera_motion: 'DOLLY',
    composition: '主角位于画面右侧三分线',
    focus: '主角背影与雨幕中的车站入口',
    frontal_face: false,
    mouth_visible: false,
    shot_size: 'LONG',
  },
  content: {
    action: '主角撑伞站在站台边缘，缓慢抬头看向轨道',
    character_ids: ['char_lin'],
    emotion: '克制的失落',
    prop_ids: ['prop_red_umbrella'],
    scene_id: 'scene_old_station_night',
    spoken_text: '她等了整整十年，等来的却只有一场雨。',
  },
  contract_version: 1,
  continuity: {
    asset_version_ids: [],
    continuity_mode: 'SCENE_CHANGE',
    first_frame_requirement: '雨夜旧车站全景',
    last_frame_requirement: '镜头靠近主角肩部',
    previous_shot_id: null,
  },
  derived_from_shot_ids: [],
  dialogue: {
    audio_required: true,
    dialogue_mode_source: 'PROJECT_DEFAULT',
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 5.5,
    lip_sync_required: false,
    override_reason: null,
    speaker_id: 'narrator',
  },
  format_profile_id: 'format_vertical_1080p',
  generation_constraints: {
    budget_estimate: null,
    capability_requirements: [{ capability: 'FIRST_FRAME', required: true }],
    image_prompt: '竖屏构图，雨夜旧车站',
    negative_constraints: ['晴天'],
    video_prompt: '镜头缓慢向前推进',
  },
  locked_paths: [],
  narrative_purpose: '建立雨夜旧车站与主角等待失约之人的情绪基调',
  parent_version_id: null,
  provenance: {
    last_edit_source: 'HUMAN',
    source_invocation_id: 'invocation_ep01_storyboard_001',
    source_type: 'AI_ASSISTED',
  },
  schema_version: '1.1.0',
  sequence: 1,
  shot_id: 'shot_ep01_001',
  status: 'READY',
  target_duration_sec: 6,
  version_id: 'scv_shot_ep01_001_v1',
});

const baseEpisode = (shots: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  episode_id: 'episode_0001',
  episode_version: 1,
  exported_at: '2026-08-22T00:00:00+08:00',
  export_id: 'export_eval_0001',
  export_provenance: {},
  format_profile: {},
  lineage_completeness: 'FULL',
  project_id: 'project_eval_0001',
  schema_version: '1.1.0',
  shot_contracts: [...shots],
  story_bible_version_id: 'sbv_0001',
  target_duration_sec: 90,
});

const shotInput = (
  document: Record<string, unknown>,
  context: Record<string, unknown> = {},
): EvaluationSampleInputDto =>
  ({
    candidate: { document, kind: 'SHOT_CONTRACT' },
    context: {
      characters: ['char_lin'],
      dialogueRenderMode: 'NARRATION_FIRST',
      previousShotSummary: null,
      scenes: ['scene_old_station_night'],
      ...context,
    },
  }) as unknown as EvaluationSampleInputDto;

const codesOf = (hits: readonly { code: EvaluationIssueCode }[]): readonly string[] => [
  ...new Set(hits.map((hit) => hit.code)),
];

describe('评测规则命中引擎（Registry + 9.5 可生产性 + 集合派生）', () => {
  const engine = createEvaluationRulesEngine({ validateSchema: schemaStub() });
  const strictEngine = createEvaluationRulesEngine({ validateSchema: schemaStub(true) });

  it('可接受样本—Registry 放行 + 全部派生规则零命中', () => {
    const { hits, ruleVersion } = engine.evaluate(shotInput(baseShot()));
    expect(hits).toEqual([]);
    expect(ruleVersion).toBe('jingxu-producibility-rules/1');
  });

  it('九类问题—每类单一错误 Fixture 命中且仅命中对应稳定码（结构干净的违规）', () => {
    // 3 时长偏离：台词时长 8s 超过镜头 6s（schema 内合法）。
    const duration = baseShot();
    (duration.dialogue as Record<string, unknown>).estimated_speech_duration_sec = 8;
    expect(codesOf(engine.evaluate(shotInput(duration)).hits)).toEqual([
      'EVAL_ISSUE_DURATION_DEVIATION',
    ]);

    // 4 角色过多：单镜头 5 个角色。
    const characters = baseShot();
    (characters.content as Record<string, unknown>).character_ids = [
      'char_lin',
      'char_a',
      'char_b',
      'char_c',
      'char_d',
    ];
    expect(codesOf(engine.evaluate(shotInput(characters)).hits)).toEqual([
      'EVAL_ISSUE_CHARACTER_OVERFLOW',
    ]);

    // 5 复杂动作：动作描述 301 字。
    const action = baseShot();
    (action.content as Record<string, unknown>).action = '主'.repeat(301);
    expect(codesOf(engine.evaluate(shotInput(action)).hits)).toEqual(['EVAL_ISSUE_COMPLEX_ACTION']);

    // 6 DialogueRenderMode 冲突：PRECISE_LIP_SYNC 但非正脸（口型不可见）。
    const precise = baseShot();
    const preciseDialogue = precise.dialogue as Record<string, unknown>;
    preciseDialogue.dialogue_render_mode = 'PRECISE_LIP_SYNC';
    preciseDialogue.dialogue_mode_source = 'SHOT_OVERRIDE';
    preciseDialogue.override_reason = '特写口型同步';
    expect(codesOf(engine.evaluate(shotInput(precise)).hits)).toEqual([
      'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
    ]);

    // 7 连续模式错误：CONTINUOUS_ACTION 但缺前镜引用。
    const continuity = baseShot();
    (continuity.continuity as Record<string, unknown>).continuity_mode = 'CONTINUOUS_ACTION';
    expect(codesOf(engine.evaluate(shotInput(continuity)).hits)).toEqual([
      'EVAL_ISSUE_CONTINUITY_INVALID',
    ]);

    // 9 锁定冲突：锁定路径无法在文档内解析。
    const lock = baseShot();
    lock.locked_paths = ['/narrative_purpose/inner'];
    expect(codesOf(engine.evaluate(shotInput(lock)).hits)).toEqual(['EVAL_ISSUE_LOCK_CONFLICT']);
  });

  it('九类问题—必填缺失/枚举非法/能力未登记的违规同时伴随 SCHEMA_INVALID（归因码在前）', () => {
    // 1 缺失必填字段。
    const missing = baseShot();
    delete missing.narrative_purpose;
    expect(codesOf(strictEngine.evaluate(shotInput(missing)).hits)).toEqual([
      'EVAL_ISSUE_MISSING_REQUIRED',
      'EVAL_ISSUE_SCHEMA_INVALID',
    ]);

    // 2 枚举错误。
    const enm = baseShot();
    enm.status = 'PUBLISHED';
    expect(codesOf(strictEngine.evaluate(shotInput(enm)).hits)).toEqual([
      'EVAL_ISSUE_ENUM_INVALID',
      'EVAL_ISSUE_SCHEMA_INVALID',
    ]);

    // 8 能力 UNKNOWN：未登记的能力字面量。
    const capability = baseShot();
    const constraints = capability.generation_constraints as Record<string, unknown>;
    const requirements = constraints.capability_requirements as Record<string, unknown>[];
    requirements[0] = { capability: 'TELEPORT', required: true };
    expect(codesOf(strictEngine.evaluate(shotInput(capability)).hits)).toEqual([
      'EVAL_ISSUE_CAPABILITY_UNKNOWN',
      'EVAL_ISSUE_SCHEMA_INVALID',
    ]);
  });

  it('未归因的结构违规—仅 SCHEMA_INVALID 单命中', () => {
    expect(codesOf(strictEngine.evaluate(shotInput(baseShot())).hits)).toEqual([
      'EVAL_ISSUE_SCHEMA_INVALID',
    ]);
  });

  it('正脸长对白 WARN—命中 EVAL_ISSUE_PRODUCIBILITY_WARN（非阻断）', () => {
    const warn = baseShot();
    const cinematography = warn.cinematography as Record<string, unknown>;
    cinematography.frontal_face = true;
    cinematography.mouth_visible = true;
    (warn.dialogue as Record<string, unknown>).estimated_speech_duration_sec = 6;
    expect(codesOf(engine.evaluate(shotInput(warn)).hits)).toEqual([
      'EVAL_ISSUE_PRODUCIBILITY_WARN',
    ]);
  });

  it('上下文冲突—镜头模式偏离项目默认且未声明 SHOT_OVERRIDE', () => {
    const override = baseShot();
    (override.dialogue as Record<string, unknown>).dialogue_render_mode = 'SUBTITLE_ONLY';
    expect(
      codesOf(engine.evaluate(shotInput(override, { dialogueRenderMode: 'NARRATION_FIRST' })).hits),
    ).toEqual(['EVAL_ISSUE_DIALOGUE_MODE_CONFLICT']);
  });

  it('SCRIPT_STAGE—合法阶段信封零命中；缺 stage 标识命中 MISSING_REQUIRED', () => {
    const stageDocument = {
      schema_version: '1.0.0',
      project_id: 'project_eval_0001',
      episode_id: 'episode_0001',
      source_invocation_id: 'inv-0001',
      stage: 'BEAT_SHEET',
      data: { beats: [] },
    };
    const valid = engine.evaluate({
      candidate: { document: stageDocument, kind: 'SCRIPT_STAGE', stage: 'BEAT_SHEET' },
      context: {},
    } as unknown as EvaluationSampleInputDto);
    expect(valid.hits).toEqual([]);

    const noStage = engine.evaluate({
      candidate: { document: stageDocument, kind: 'SCRIPT_STAGE' },
      context: {},
    } as unknown as EvaluationSampleInputDto);
    expect(codesOf(noStage.hits)).toEqual(['EVAL_ISSUE_MISSING_REQUIRED']);
  });

  it('EPISODE_STORYBOARD—集合序列/时长规则生效且可接受整集零命中', () => {
    // 用合法镜头复制出 4×20s=80s 的整集（硬区间 30–180 且偏离目标 90s ≤50%）。
    const shots = [1, 2, 3, 4].map((index) => {
      const shot = baseShot();
      shot.shot_id = `shot_ep01_${String(index).padStart(3, '0')}`;
      shot.version_id = `scv_shot_ep01_${String(index).padStart(3, '0')}_v1`;
      shot.sequence = index;
      shot.target_duration_sec = 20;
      return shot;
    });
    const episode = baseEpisode(shots);
    const context = {
      characters: ['char_lin'],
      scenes: ['scene_old_station_night'],
      targetDurationSec: 90,
    };
    const acceptable = engine.evaluate({
      candidate: { document: episode, kind: 'EPISODE_STORYBOARD' },
      context,
    } as unknown as EvaluationSampleInputDto);
    expect(acceptable.hits).toEqual([]);

    // sequence 重复 → 集合派生 CONTINUITY_INVALID。
    const duplicated = baseEpisode(
      shots.map((shot) => ({ ...shot, sequence: shot.sequence === 3 ? 1 : shot.sequence })),
    );
    const sequenceBroken = engine.evaluate({
      candidate: { document: duplicated, kind: 'EPISODE_STORYBOARD' },
      context,
    } as unknown as EvaluationSampleInputDto);
    expect(codesOf(sequenceBroken.hits)).toContain('EVAL_ISSUE_CONTINUITY_INVALID');

    // Σ 时长越界（4×2s=8s < 30s）→ DURATION_DEVIATION。
    const short = baseEpisode(shots.map((shot) => ({ ...shot, target_duration_sec: 2 })));
    const tooShort = engine.evaluate({
      candidate: { document: short, kind: 'EPISODE_STORYBOARD' },
      context,
    } as unknown as EvaluationSampleInputDto);
    expect(codesOf(tooShort.hits)).toContain('EVAL_ISSUE_DURATION_DEVIATION');
  });

  it('命中明细—detail 有界（≤280）且 path 指向稳定字段路径', () => {
    const missing = baseShot();
    delete missing.narrative_purpose;
    const { hits } = engine.evaluate(shotInput(missing));
    const missingHit = hits.find((hit) => hit.code === 'EVAL_ISSUE_MISSING_REQUIRED');
    expect(missingHit?.path).toBe('narrative_purpose');
    for (const hit of hits) {
      expect(hit.detail.length).toBeLessThanOrEqual(280);
    }
  });
});
