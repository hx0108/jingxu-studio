/**
 * VoiceMappingService（v2-voice-audio-timeline tasks 3.2，spec R3）。
 *
 * 项目级 speaker→voice 映射：
 * - `narrator` 固定映射注册表旁白默认音色（不可改；保存其他音色属非法值）。
 * - `char_*` 必须引用当前 STORY_BIBLE 中存在的角色，音色必须在注册表内
 *   （注册表白名单由组合根注入——application 不依赖 model-adapters）。
 * - 全部校验先于写入：任一非法值稳定拒绝（IPC_INVALID_REQUEST）且不改动
 *   任何既有映射行（spec R1「非法音色值被拒绝」场景）。
 * - 生成/导出侧的完整性闸门：`voiceMappingGapFailure` 以稳定错误
 *   VOICE_MAPPING_MISSING 列出缺口说话人清单（不静默顶默认音色）。
 * - `buildMappingSnapshot` 供导出记录冻结映射快照（spec R3/D4）。
 */

import type {
  AppResultDto,
  GetVoiceMappingsInputDto,
  SaveVoiceMappingInputDto,
  VoiceMappingDto,
} from '@jingxu/contracts';

import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type {
  VoiceMappingRecord,
  VoiceMappingRepositoryPort,
} from '../ports/voice/voice-mapping-repository';
import { extractShotCollectionBibleKeys } from '../script/shot-collection-validator';

/** 与 contracts voiceSpeakerIdSchema / ShotContract SPEAKER_ID_PATTERN 同源。 */
const SPEAKER_ID_PATTERN = /^(narrator|char_[A-Za-z0-9_-]{1,64})$/u;

/** 缺口清单在错误消息中的展示上限（防无界字符串；超出以计数收尾）。 */
const GAP_LIST_LIMIT = 8;

export interface VoiceMappingServiceDependencies {
  /** 注册表内可选音色 id 全集（组合根注入 QWEN_TTS_VOICES）。 */
  readonly allowedVoiceIds: readonly string[];
  readonly clock: () => string;
  readonly mappings: VoiceMappingRepositoryPort;
  /** narrator 固定音色（组合根注入 NARRATOR_DEFAULT_VOICE_ID）。 */
  readonly narratorDefaultVoiceId: string;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface VoiceMappingService {
  /** 读取项目映射视图：narrator 固定行恒在列；char 行按当前 STORY_BIBLE 过滤。 */
  getMappings(
    input: GetVoiceMappingsInputDto,
    traceId: string,
  ): Promise<AppResultDto<VoiceMappingDto[]>>;
  /** 集合保存：全部校验通过后整体替换（含 narrator 固定行）。 */
  saveMapping(
    input: SaveVoiceMappingInputDto,
    traceId: string,
  ): Promise<AppResultDto<VoiceMappingDto[]>>;
  /** 生成分支的生效解析：narrator→固定音色（无论行内容），其余按行。 */
  resolveEffectiveMappings(projectId: string): Promise<ReadonlyMap<string, string>>;
  /** 导出冻结用的有序快照（narrator 在前，其余按 speakerId 排序）。 */
  buildMappingSnapshot(projectId: string): Promise<readonly VoiceMappingDto[]>;
}

const failure = <T>(
  code: 'IPC_INVALID_REQUEST' | 'SCRIPT_WORKSPACE_NOT_INITIALIZED' | 'VOICE_MAPPING_MISSING',
  message: string,
  traceId: string,
  retryable = false,
  userAction: string | null = null,
): AppResultDto<T> => ({
  error: { code, fieldErrors: null, message, retryable, traceId, userAction },
  ok: false,
});

/** 当前 STORY_BIBLE 的角色键集合；无版本或形状不符时为空集（如实反映）。 */
const bibleCharacterIdsOf = async (
  workspaceQuery: ScriptWorkspaceQueryPort,
  projectId: string,
): Promise<ReadonlySet<string>> => {
  const workspace = await workspaceQuery.getWorkspace(projectId);
  if (workspace === null) return new Set();
  const current = workspace.stages.find((stage) => stage.stage === 'STORY_BIBLE')?.current;
  if (current === null || current === undefined) return new Set();
  try {
    const keys = extractShotCollectionBibleKeys(JSON.parse(current.document));
    return new Set(keys?.characterIds ?? []);
  } catch {
    return new Set();
  }
};

/** 视图组装：narrator 固定行置顶，其余按 speakerId 排序（确定性输出）。 */
const buildView = (
  records: readonly VoiceMappingRecord[],
  narratorDefaultVoiceId: string,
  fallbackUpdatedAt: string,
): VoiceMappingDto[] => {
  const narrator = records.find((record) => record.speakerId === 'narrator');
  const characters = records
    .filter((record) => record.speakerId !== 'narrator')
    .map((record) => ({
      speakerId: record.speakerId,
      updatedAt: record.updatedAt,
      voiceId: record.voiceId,
    }))
    .sort((left, right) => (left.speakerId < right.speakerId ? -1 : 1));
  return [
    {
      speakerId: 'narrator',
      updatedAt: narrator?.updatedAt ?? fallbackUpdatedAt,
      voiceId: narratorDefaultVoiceId,
    },
    ...characters,
  ];
};

/** VOICE_MAPPING_MISSING 阻断（spec R3 缺口清单场景）；调用方保证 gaps 非空。 */
export const voiceMappingGapFailure = <T>(
  gaps: readonly string[],
  traceId: string,
): AppResultDto<T> => {
  const listed = gaps.slice(0, GAP_LIST_LIMIT);
  const suffix =
    gaps.length > listed.length ? ` 等 ${String(gaps.length)} 个说话人` : `：${listed.join('、')}`;
  return failure<T>(
    'VOICE_MAPPING_MISSING',
    `以下说话人尚未配置音色映射，请先在配音面板完成映射${suffix}`,
    traceId,
    false,
    '请在音色映射中为缺口说话人选择注册表内音色后重试。',
  );
};

/** 纯缺口计算：required 中不在生效映射内的说话人（保持输入顺序）。 */
export const collectMappingGaps = (
  requiredSpeakerIds: readonly string[],
  effective: ReadonlyMap<string, string>,
): readonly string[] => requiredSpeakerIds.filter((speakerId) => !effective.has(speakerId));

export const createVoiceMappingService = (
  dependencies: VoiceMappingServiceDependencies,
): VoiceMappingService => {
  const { mappings, workspaceQuery } = dependencies;

  const readRecords = async (projectId: string): Promise<readonly VoiceMappingRecord[]> => {
    const stored = await mappings.listByProject(projectId);
    // narrator 固定行钉住默认音色：历史行即便被外部写歪也不外溢（防御性归一）。
    return stored.some((record) => record.speakerId === 'narrator')
      ? stored
      : [
          ...stored,
          {
            projectId,
            speakerId: 'narrator',
            updatedAt: dependencies.clock(),
            voiceId: dependencies.narratorDefaultVoiceId,
          },
        ];
  };

  return {
    getMappings: async (input, traceId) => {
      try {
        const workspace = await workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return failure(
            'SCRIPT_WORKSPACE_NOT_INITIALIZED',
            '剧本工作区尚未初始化，无法读取音色映射',
            traceId,
          );
        }
        const records = await readRecords(input.projectId);
        const characters = await bibleCharacterIdsOf(workspaceQuery, input.projectId);
        // 已被 STORY_BIBLE 移除的角色行不再外显（行保留，角色回归后自然恢复）。
        const visible = records.filter(
          (record) => record.speakerId === 'narrator' || characters.has(record.speakerId),
        );
        return {
          data: buildView(visible, dependencies.narratorDefaultVoiceId, dependencies.clock()),
          ok: true,
        };
      } catch {
        return failure(
          'SCRIPT_WORKSPACE_NOT_INITIALIZED',
          '音色映射暂时无法读取，请重试',
          traceId,
          true,
        );
      }
    },

    saveMapping: async (input, traceId) => {
      try {
        const workspace = await workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return failure(
            'SCRIPT_WORKSPACE_NOT_INITIALIZED',
            '剧本工作区尚未初始化，无法保存音色映射',
            traceId,
          );
        }
        // 先全量校验后写入：任一非法值都不改动既有行（spec R1）。
        const characters = await bibleCharacterIdsOf(workspaceQuery, input.projectId);
        const seen = new Set<string>();
        const invalidSpeakers: string[] = [];
        const unknownVoices: string[] = [];
        const unknownCharacters: string[] = [];
        for (const mapping of input.mappings) {
          if (!SPEAKER_ID_PATTERN.test(mapping.speakerId) || seen.has(mapping.speakerId)) {
            invalidSpeakers.push(mapping.speakerId);
            continue;
          }
          seen.add(mapping.speakerId);
          if (mapping.speakerId === 'narrator') {
            // narrator 固定音色：提交默认值视为幂等确认，其余一律拒绝。
            if (mapping.voiceId !== dependencies.narratorDefaultVoiceId)
              unknownVoices.push('narrator');
            continue;
          }
          if (!dependencies.allowedVoiceIds.includes(mapping.voiceId)) {
            unknownVoices.push(mapping.speakerId);
          } else if (!characters.has(mapping.speakerId)) {
            unknownCharacters.push(mapping.speakerId);
          }
        }
        if (invalidSpeakers.length > 0) {
          return failure(
            'IPC_INVALID_REQUEST',
            '存在非法或重复的说话人 ID，音色映射未保存',
            traceId,
          );
        }
        if (unknownVoices.length > 0) {
          return failure(
            'IPC_INVALID_REQUEST',
            `以下说话人的音色不在注册表内（narrator 固定使用旁白默认音色）：${unknownVoices.join('、')}`,
            traceId,
            false,
            '请选择配音设置中列出的音色后重试。',
          );
        }
        if (unknownCharacters.length > 0) {
          return failure(
            'IPC_INVALID_REQUEST',
            `以下说话人不在当前故事圣经角色中：${unknownCharacters.join('、')}`,
            traceId,
            false,
            '请先在故事圣经中确认角色，或刷新后重试。',
          );
        }
        const updatedAt = dependencies.clock();
        const next: VoiceMappingRecord[] = [
          {
            projectId: input.projectId,
            speakerId: 'narrator',
            updatedAt,
            voiceId: dependencies.narratorDefaultVoiceId,
          },
          ...input.mappings
            .filter((mapping) => mapping.speakerId !== 'narrator')
            .map((mapping) => ({
              projectId: input.projectId,
              speakerId: mapping.speakerId,
              updatedAt,
              voiceId: mapping.voiceId,
            })),
        ];
        const saved = await mappings.replaceAll(input.projectId, next);
        return {
          data: buildView(saved, dependencies.narratorDefaultVoiceId, updatedAt),
          ok: true,
        };
      } catch {
        return failure(
          'SCRIPT_WORKSPACE_NOT_INITIALIZED',
          '音色映射暂时无法保存，请重试',
          traceId,
          true,
        );
      }
    },

    resolveEffectiveMappings: async (projectId) => {
      const records = await readRecords(projectId);
      const effective = new Map<string, string>();
      for (const record of records) {
        effective.set(
          record.speakerId,
          // narrator 恒为固定音色（防御历史行漂移）；char 行原样生效。
          record.speakerId === 'narrator' ? dependencies.narratorDefaultVoiceId : record.voiceId,
        );
      }
      effective.set('narrator', dependencies.narratorDefaultVoiceId);
      return effective;
    },

    buildMappingSnapshot: async function (projectId) {
      const effective = await this.resolveEffectiveMappings(projectId);
      const narratorVoice = effective.get('narrator') ?? dependencies.narratorDefaultVoiceId;
      const characters = [...effective.entries()]
        .filter(([speakerId]) => speakerId !== 'narrator' && SPEAKER_ID_PATTERN.test(speakerId))
        .sort(([left], [right]) => (left < right ? -1 : 1));
      const frozenAt = dependencies.clock();
      return [
        { speakerId: 'narrator', updatedAt: frozenAt, voiceId: narratorVoice },
        ...characters.map(([speakerId, voiceId]) => ({
          speakerId,
          updatedAt: frozenAt,
          voiceId,
        })),
      ];
    },
  };
};
