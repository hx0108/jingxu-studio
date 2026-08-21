/**
 * 评测规则命中引擎（design.md D2；spec「确定性规则命中」）。
 *
 * 对样本信封执行零 I/O、零时钟的确定性校验，产出 EVAL_ISSUE_* 稳定命中：
 * - 归因规则（九类问题，PRD §9.9）：必填缺失/枚举非法/时长偏离/角色过多/
 *   复杂动作/DialogueRenderMode 冲突/连续模式错误/能力未登记/锁定冲突；
 * - 引擎级补充：PRODUCIBILITY_WARN（复用 9.5 正脸长对白启发式）与
 *   SCHEMA_INVALID（注入的 Registry 正式校验失败且未被归因吸收）。
 *
 * 阈值与枚举镜像属 jingxu-producibility-rules/1 规则集的组成部分，与
 * ShotContract/EpisodeStoryboardExport 1.1.0 对齐；升级须换 rule_version。
 * 角色/场景未知引用不在此引擎判定（样本自带冻结清单，属人工标注范畴）。
 */

import type {
  EvaluationCandidateDto,
  EvaluationIssueCode,
  EvaluationRuleHitDto,
} from '@jingxu/contracts';

import type { SchemaValidationResult } from '../ports/schema-registry';
import type { EvaluationRulesPort } from '../ports/evaluation';
import {
  collectProducibilityWarns,
  PRODUCIBILITY_RULES_VERSION,
} from '../script/storyboard-export-markdown';
import { validateLockPointer } from '../script/shot-lock-policy';
import { validateShotSetCollection } from '../script/shot-collection-validator';

export interface EvaluationRulesEngineDependencies {
  /** 注入的正式 Registry 校验（Main 组合根由 CompiledSchemaRegistry 接线）。 */
  readonly validateSchema: (schemaId: string, value: unknown) => SchemaValidationResult;
}

const DETAIL_MAX = 280;
const PATH_MAX = 160;

/** PRD §9.9「角色过多」阈值（评测规则集冻结值）。 */
export const EVALUATION_MAX_CHARACTERS_PER_SHOT = 4;
/** PRD §9.9「复杂动作」阈值：字数与句数（评测规则集冻结值）。 */
export const EVALUATION_ACTION_MAX_CHARS = 300;
export const EVALUATION_ACTION_MAX_SENTENCES = 3;
/** 单镜时长硬区间（ShotContract 1.1.0 schema 镜像；归因优先于 SCHEMA_INVALID）。 */
const SHOT_DURATION_MIN = 1;
const SHOT_DURATION_MAX = 20;
/** 整集时长硬区间（shot-collection-validator 镜像）。 */
const EPISODE_DURATION_MIN = 30;
const EPISODE_DURATION_MAX = 180;
/** 整集 Σ 与目标时长的相对偏离容忍（评测规则集冻结值）。 */
const EPISODE_TARGET_DEVIATION_RATIO = 0.5;

const SHOT_REQUIRED_KEYS = [
  'schema_version',
  'shot_id',
  'version_id',
  'contract_version',
  'parent_version_id',
  'derived_from_shot_ids',
  'sequence',
  'status',
  'provenance',
  'format_profile_id',
  'target_duration_sec',
  'narrative_purpose',
  'cinematography',
  'content',
  'dialogue',
  'continuity',
  'generation_constraints',
  'acceptance',
  'locked_paths',
] as const;

const STAGE_REQUIRED_KEYS = [
  'schema_version',
  'project_id',
  'episode_id',
  'source_invocation_id',
  'stage',
  'data',
] as const;

const EPISODE_REQUIRED_KEYS = [
  'schema_version',
  'export_id',
  'exported_at',
  'project_id',
  'episode_id',
  'episode_version',
  'target_duration_sec',
  'lineage_completeness',
  'story_bible_version_id',
  'format_profile',
  'shot_contracts',
  'export_provenance',
] as const;

const KNOWN_STAGE_VALUES = [
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
  'SHOT_CONTRACT',
] as const;

const KNOWN_CAPABILITIES = [
  'FIRST_FRAME',
  'LAST_FRAME',
  'SUBJECT_REFERENCE',
  'REFERENCE_VIDEO',
  'DRIVING_AUDIO',
  'SEED',
] as const;

const KNOWN_ENUMS: Readonly<Record<string, readonly string[]>> = {
  'cinematography.camera_angle': ['EYE_LEVEL', 'HIGH', 'LOW', 'TOP_DOWN', 'DUTCH', 'POV', 'OTHER'],
  'cinematography.camera_motion': ['STATIC', 'PAN', 'TILT', 'TRACK', 'DOLLY', 'HANDHELD'],
  'cinematography.shot_size': [
    'EXTREME_LONG',
    'LONG',
    'FULL',
    'MEDIUM',
    'CLOSE_UP',
    'EXTREME_CLOSE_UP',
  ],
  'continuity.continuity_mode': [
    'CONTINUOUS_ACTION',
    'SAME_SCENE_CUT',
    'REVERSE_SHOT',
    'SCENE_CHANGE',
    'MONTAGE',
  ],
  'dialogue.dialogue_mode_source': ['PROJECT_DEFAULT', 'SHOT_OVERRIDE'],
  'dialogue.dialogue_render_mode': [
    'NARRATION_FIRST',
    'WEAK_LIP_SYNC',
    'PRECISE_LIP_SYNC',
    'SUBTITLE_ONLY',
  ],
  'provenance.last_edit_source': ['AI', 'HUMAN'],
  'provenance.source_type': ['AI_GENERATED', 'AI_ASSISTED', 'HUMAN_CREATED'],
  status: ['DRAFT', 'READY', 'STALE_INPUT'],
};

const SCHEMA_ID_BY_KIND: Readonly<
  Record<EvaluationCandidateDto['kind'], `https://jingxu.studio/schemas/${string}`>
> = {
  EPISODE_STORYBOARD: 'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0',
  SCRIPT_STAGE: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
  SHOT_CONTRACT: 'https://jingxu.studio/schemas/shot-contract/1.1.0',
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const bounded = (text: string): string =>
  text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX - 1) + '…' : text;

const hit = (
  code: EvaluationIssueCode,
  path: string | null,
  detail: string,
): EvaluationRuleHitDto => ({
  code,
  detail: bounded(detail),
  path: path === null ? null : path.slice(0, PATH_MAX),
});

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const shotEnumHits = (
  shot: Readonly<Record<string, unknown>>,
  prefix: string,
): EvaluationRuleHitDto[] => {
  const hits: EvaluationRuleHitDto[] = [];
  for (const [field, allowed] of Object.entries(KNOWN_ENUMS)) {
    const [section, key] = field.split('.');
    let value: unknown = shot;
    if (section !== undefined && key !== undefined) {
      value = (shot[section] as Record<string, unknown> | undefined)?.[key];
    } else {
      value = shot[field];
    }
    if (typeof value === 'string' && !allowed.includes(value)) {
      hits.push(
        hit(
          'EVAL_ISSUE_ENUM_INVALID',
          `${prefix}${field}`,
          `字段 ${field} 的值 ${value} 不在枚举 ${allowed.join('|')} 内`,
        ),
      );
    }
  }
  return hits;
};

const sentenceCount = (text: string): number =>
  text.split(/[。！？!?]/u).filter((part) => part.trim().length > 0).length;

const episodeDurationHits = (
  document: Readonly<Record<string, unknown>>,
  targetDurationSec: number | null,
): EvaluationRuleHitDto[] => {
  const shots = Array.isArray(document.shot_contracts) ? document.shot_contracts : [];
  const total = shots.reduce((sum: number, shot) => {
    const record = isRecord(shot) ? shot : {};
    return sum + (numberOrNull(record.target_duration_sec) ?? 0);
  }, 0);
  const hits: EvaluationRuleHitDto[] = [];
  if (total < EPISODE_DURATION_MIN || total > EPISODE_DURATION_MAX) {
    hits.push(
      hit(
        'EVAL_ISSUE_DURATION_DEVIATION',
        'shot_contracts',
        `整集 Σtarget_duration_sec=${String(total)}s 超出硬区间 ${String(EPISODE_DURATION_MIN)}–${String(EPISODE_DURATION_MAX)}s`,
      ),
    );
  }
  if (targetDurationSec !== null && targetDurationSec > 0) {
    const deviation = Math.abs(total - targetDurationSec) / targetDurationSec;
    if (deviation > EPISODE_TARGET_DEVIATION_RATIO) {
      hits.push(
        hit(
          'EVAL_ISSUE_DURATION_DEVIATION',
          'target_duration_sec',
          `整集 Σ${String(total)}s 偏离目标 ${String(targetDurationSec)}s 达 ${String(Math.round(deviation * 100))}%（>50%）`,
        ),
      );
    }
  }
  return hits;
};

export const createEvaluationRulesEngine = (
  dependencies: EvaluationRulesEngineDependencies,
): EvaluationRulesPort => ({
  evaluate: (input) => {
    const hits: EvaluationRuleHitDto[] = [];
    const { candidate, context } = input;
    const document = candidate.document as Readonly<Record<string, unknown>>;

    // 1 缺失必填字段（含 SCRIPT_STAGE 信封缺阶段标识）。
    const requiredKeys =
      candidate.kind === 'SHOT_CONTRACT'
        ? SHOT_REQUIRED_KEYS
        : candidate.kind === 'EPISODE_STORYBOARD'
          ? EPISODE_REQUIRED_KEYS
          : STAGE_REQUIRED_KEYS;
    for (const key of requiredKeys) {
      if (!(key in document)) {
        hits.push(hit('EVAL_ISSUE_MISSING_REQUIRED', key, `候选文档缺少必填字段 ${key}`));
      }
    }
    if (
      candidate.kind === 'SCRIPT_STAGE' &&
      (candidate.stage === null || candidate.stage === undefined)
    ) {
      hits.push(
        hit('EVAL_ISSUE_MISSING_REQUIRED', 'candidate.stage', 'SCRIPT_STAGE 样本缺少被检阶段标识'),
      );
    }

    // 2 枚举错误（SCRIPT_STAGE 校验 stage 值；其余走镜头枚举表）。
    if (candidate.kind === 'SCRIPT_STAGE') {
      const stageValue = document.stage;
      if (
        typeof stageValue === 'string' &&
        !KNOWN_STAGE_VALUES.includes(stageValue as (typeof KNOWN_STAGE_VALUES)[number])
      ) {
        hits.push(hit('EVAL_ISSUE_ENUM_INVALID', 'stage', `stage 值 ${stageValue} 不在阶段枚举内`));
      }
    }

    const shotDocuments: readonly Readonly<Record<string, unknown>>[] =
      candidate.kind === 'EPISODE_STORYBOARD'
        ? Array.isArray(document.shot_contracts)
          ? document.shot_contracts.filter(isRecord)
          : []
        : [document];

    shotDocuments.forEach((shot, index) => {
      const prefix =
        candidate.kind === 'EPISODE_STORYBOARD' ? `shot_contracts[${String(index)}].` : '';

      if (candidate.kind !== 'SCRIPT_STAGE') {
        hits.push(...shotEnumHits(shot, prefix));
      }

      const content = isRecord(shot.content) ? shot.content : null;
      const dialogue = isRecord(shot.dialogue) ? shot.dialogue : null;
      const cinematography = isRecord(shot.cinematography) ? shot.cinematography : null;
      const continuity = isRecord(shot.continuity) ? shot.continuity : null;
      const constraints = isRecord(shot.generation_constraints)
        ? shot.generation_constraints
        : null;

      // 3 时长偏离（单镜）。
      const duration = numberOrNull(shot.target_duration_sec);
      if (duration !== null && (duration < SHOT_DURATION_MIN || duration > SHOT_DURATION_MAX)) {
        hits.push(
          hit(
            'EVAL_ISSUE_DURATION_DEVIATION',
            `${prefix}target_duration_sec`,
            `镜头时长 ${String(duration)}s 超出 ${String(SHOT_DURATION_MIN)}–${String(SHOT_DURATION_MAX)}s`,
          ),
        );
      }
      const speech =
        dialogue !== null ? numberOrNull(dialogue.estimated_speech_duration_sec) : null;
      if (speech !== null && duration !== null && speech > duration) {
        hits.push(
          hit(
            'EVAL_ISSUE_DURATION_DEVIATION',
            `${prefix}dialogue.estimated_speech_duration_sec`,
            `台词时长 ${String(speech)}s 超过镜头时长 ${String(duration)}s`,
          ),
        );
      }

      // 4 角色过多。
      if (
        content !== null &&
        Array.isArray(content.character_ids) &&
        content.character_ids.length > EVALUATION_MAX_CHARACTERS_PER_SHOT
      ) {
        hits.push(
          hit(
            'EVAL_ISSUE_CHARACTER_OVERFLOW',
            `${prefix}content.character_ids`,
            `单镜头角色 ${String(content.character_ids.length)} 个超过阈值 ${String(EVALUATION_MAX_CHARACTERS_PER_SHOT)}`,
          ),
        );
      }

      // 5 复杂动作。
      if (content !== null && typeof content.action === 'string') {
        const tooLong = content.action.length > EVALUATION_ACTION_MAX_CHARS;
        const tooManySentences = sentenceCount(content.action) > EVALUATION_ACTION_MAX_SENTENCES;
        if (tooLong || tooManySentences) {
          hits.push(
            hit(
              'EVAL_ISSUE_COMPLEX_ACTION',
              `${prefix}content.action`,
              `动作描述过于复杂：${String(content.action.length)} 字 / ${String(sentenceCount(content.action))} 句（阈值 ${String(EVALUATION_ACTION_MAX_CHARS)} 字 / ${String(EVALUATION_ACTION_MAX_SENTENCES)} 句）`,
            ),
          );
        }
      }

      // 6 DialogueRenderMode 冲突。
      if (dialogue !== null) {
        const mode = dialogue.dialogue_render_mode;
        const modeSource = dialogue.dialogue_mode_source;
        const overrideReason = dialogue.override_reason;
        if (
          modeSource === 'SHOT_OVERRIDE' &&
          !(typeof overrideReason === 'string' && overrideReason.length > 0)
        ) {
          hits.push(
            hit(
              'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
              `${prefix}dialogue.override_reason`,
              '镜头覆写对白模式必须填写 override_reason',
            ),
          );
        }
        if (
          mode === 'PRECISE_LIP_SYNC' &&
          !(
            cinematography !== null &&
            cinematography.frontal_face === true &&
            cinematography.mouth_visible === true
          )
        ) {
          hits.push(
            hit(
              'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
              `${prefix}dialogue.dialogue_render_mode`,
              'PRECISE_LIP_SYNC 要求正脸且口型可见',
            ),
          );
        }
        if (
          context.dialogueRenderMode !== null &&
          context.dialogueRenderMode !== undefined &&
          modeSource !== 'SHOT_OVERRIDE' &&
          typeof mode === 'string' &&
          mode !== context.dialogueRenderMode
        ) {
          hits.push(
            hit(
              'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
              `${prefix}dialogue.dialogue_render_mode`,
              `镜头模式 ${mode} 偏离项目默认 ${context.dialogueRenderMode} 且未声明 SHOT_OVERRIDE`,
            ),
          );
        }
      }

      // 7 连续模式错误（单镜：CONTINUOUS_ACTION 必须引用前镜）。
      if (continuity !== null && continuity.continuity_mode === 'CONTINUOUS_ACTION') {
        const previous = continuity.previous_shot_id;
        if (typeof previous !== 'string' || previous.length === 0) {
          hits.push(
            hit(
              'EVAL_ISSUE_CONTINUITY_INVALID',
              `${prefix}continuity.previous_shot_id`,
              'CONTINUOUS_ACTION 必须提供 previous_shot_id',
            ),
          );
        }
      }

      // 8 能力 UNKNOWN/UNAVAILABLE。
      if (constraints !== null && Array.isArray(constraints.capability_requirements)) {
        constraints.capability_requirements.forEach((requirement, requirementIndex) => {
          if (isRecord(requirement)) {
            const capability = requirement.capability;
            if (
              typeof capability === 'string' &&
              !KNOWN_CAPABILITIES.includes(capability as (typeof KNOWN_CAPABILITIES)[number])
            ) {
              hits.push(
                hit(
                  'EVAL_ISSUE_CAPABILITY_UNKNOWN',
                  `${prefix}generation_constraints.capability_requirements[${String(requirementIndex)}].capability`,
                  `能力 ${capability} 未在登记表中（UNKNOWN/UNAVAILABLE）`,
                ),
              );
            }
          }
        });
      }

      // 9 锁定冲突：锁定路径必须能在当前文档解析。
      if (Array.isArray(shot.locked_paths)) {
        shot.locked_paths.forEach((pointer, pointerIndex) => {
          if (typeof pointer === 'string' && !validateLockPointer(pointer, shot).ok) {
            hits.push(
              hit(
                'EVAL_ISSUE_LOCK_CONFLICT',
                `${prefix}locked_paths[${String(pointerIndex)}]`,
                `锁定路径 ${pointer} 无法在镜头文档内解析`,
              ),
            );
          }
        });
      }
    });

    // 整集集合派生：sequence 连续唯一 / previous 引用合法（collection validator）。
    if (candidate.kind === 'EPISODE_STORYBOARD') {
      const collection = validateShotSetCollection(document.shot_contracts, {
        characterIds: context.characters ?? [],
        sceneIds: context.scenes ?? [],
      });
      if (!collection.valid) {
        if (
          collection.code === 'SHOT_SET_PREVIOUS_SHOT_INVALID' ||
          collection.code === 'SHOT_SET_SEQUENCE_INVALID'
        ) {
          for (const detail of collection.details.slice(0, 3)) {
            hits.push(hit('EVAL_ISSUE_CONTINUITY_INVALID', 'shot_contracts', detail));
          }
        }
        // SHOT_SET_DURATION_OUT_OF_RANGE 已由 episodeDurationHits 归因；
        // SHOT_SET_CHARACTER/SCENE_UNKNOWN 属人工标注范畴，不产出命中。
      }
      hits.push(...episodeDurationHits(document, context.targetDurationSec ?? null));
    }

    // 9.5 可生产性 WARN（正脸长对白）。
    const warnEnvelope =
      candidate.kind === 'EPISODE_STORYBOARD' ? document : { shot_contracts: [document] };
    for (const warn of collectProducibilityWarns(warnEnvelope)) {
      hits.push(
        hit(
          'EVAL_ISSUE_PRODUCIBILITY_WARN',
          'dialogue.estimated_speech_duration_sec',
          `镜头 #${String(warn.sequence)} 正脸长对白：台词 ${String(warn.estimatedSpeechDurationSec)}s 超过 ${String(4)}s 阈值（非阻断）`,
        ),
      );
    }

    // 引擎级：Registry 正式校验失败（未被归因吸收的部分以 SCHEMA_INVALID 收口）。
    const schemaResult = dependencies.validateSchema(SCHEMA_ID_BY_KIND[candidate.kind], document);
    if (!schemaResult.valid) {
      const first = schemaResult.issues[0];
      hits.push(
        hit(
          'EVAL_ISSUE_SCHEMA_INVALID',
          first === undefined ? null : first.instancePath.replace(/^\//u, '') || null,
          `Registry 校验未通过：${String(schemaResult.issues.length)} 处问题（首个 ${first?.keyword ?? 'unknown'}）`,
        ),
      );
    }

    return { hits, ruleVersion: PRODUCIBILITY_RULES_VERSION };
  },
});
