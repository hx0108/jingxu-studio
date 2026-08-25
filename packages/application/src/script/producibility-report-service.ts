import type {
  AppResultDto,
  ProducibilityFindingDto,
  ProducibilityOverrideFindingInputDto,
  ProducibilityReportDto,
  ProducibilityRunInputDto,
} from '@jingxu/contracts';
import type {
  ProducibilityFindingRecord,
  ProducibilityReportRecord,
  ProducibilityReportSnapshot,
  ProducibilityRepositoryPort,
  ScriptUnitOfWorkPort,
} from '../ports/script';
import { PRODUCIBILITY_RULES_VERSION } from './storyboard-export-markdown';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const modes = new Set(['NARRATION_FIRST', 'WEAK_LIP_SYNC', 'PRECISE_LIP_SYNC', 'SUBTITLE_ONLY']);
const capabilities = new Set([
  'FIRST_FRAME',
  'LAST_FRAME',
  'SUBJECT_REFERENCE',
  'REFERENCE_VIDEO',
  'DRIVING_AUDIO',
  'SEED',
]);

const findingsFor = (
  document: Record<string, unknown>,
  newId: () => string,
  now: string,
): ProducibilityFindingRecord[] => {
  const shots = Array.isArray(document.shot_contracts)
    ? document.shot_contracts.filter(isRecord)
    : [document];
  const findings: ProducibilityFindingRecord[] = [];
  const add = (
    value: Omit<ProducibilityFindingRecord, 'id' | 'createdAt' | 'reportId' | 'evidenceJson'>,
  ): void => {
    findings.push({
      ...value,
      createdAt: now,
      evidenceJson: JSON.stringify({ jsonPointer: value.jsonPointer, ruleId: value.ruleId }),
      id: `finding_${newId()}`,
      reportId: '',
    });
  };
  if (shots.length < 6 || shots.length > 10)
    add({
      ruleId: 'SHOT_COUNT_TARGET',
      ruleVersion: PRODUCIBILITY_RULES_VERSION,
      severity: 'WARN',
      jsonPointer: '/shot_contracts',
      observation: `当前 ${String(shots.length)} 个镜头偏离 6–10 镜头目标。`,
      recommendation: '请检查镜头拆分和叙事节奏。',
      sourceType: 'RULE',
    });
  const total = shots.reduce(
    (sum, shot) =>
      sum + (typeof shot.target_duration_sec === 'number' ? shot.target_duration_sec : 0),
    0,
  );
  if (total < 60 || total > 120)
    add({
      ruleId: 'EPISODE_DURATION_TARGET',
      ruleVersion: PRODUCIBILITY_RULES_VERSION,
      severity: 'WARN',
      jsonPointer: '/shot_contracts',
      observation: `总时长 ${String(total)} 秒偏离 60–120 秒目标。`,
      recommendation: '请调整镜头目标时长后再导出。',
      sourceType: 'RULE',
    });
  shots.forEach((shot, index) => {
    const dialogue = isRecord(shot.dialogue) ? shot.dialogue : {};
    const cinematography = isRecord(shot.cinematography) ? shot.cinematography : {};
    const speech =
      typeof dialogue.estimated_speech_duration_sec === 'number'
        ? dialogue.estimated_speech_duration_sec
        : 0;
    if (
      cinematography.frontal_face === true &&
      speech > 4 &&
      dialogue.dialogue_render_mode === 'WEAK_LIP_SYNC'
    )
      add({
        ruleId: 'WEAK_LIP_SYNC_LONG_DIALOGUE',
        ruleVersion: PRODUCIBILITY_RULES_VERSION,
        severity: 'WARN',
        jsonPointer: `/shot_contracts/${String(index)}/dialogue`,
        observation: '正脸对白超过 4 秒且使用 WEAK_LIP_SYNC。',
        recommendation: '缩短对白、调整镜头或改用 PRECISE_LIP_SYNC。',
        sourceType: 'RULE',
      });
    if (
      typeof dialogue.dialogue_render_mode === 'string' &&
      !modes.has(dialogue.dialogue_render_mode)
    )
      add({
        ruleId: 'DIALOGUE_MODE_INVALID',
        ruleVersion: PRODUCIBILITY_RULES_VERSION,
        severity: 'BLOCK',
        jsonPointer: `/shot_contracts/${String(index)}/dialogue/dialogue_render_mode`,
        observation: '对白渲染模式不在 V1 枚举内。',
        recommendation: '选择四种 V1 DialogueRenderMode 之一。',
        sourceType: 'RULE',
      });
    const requirements =
      isRecord(shot.generation_constraints) &&
      Array.isArray(shot.generation_constraints.capability_requirements)
        ? shot.generation_constraints.capability_requirements
        : [];
    if (
      requirements.some(
        (item) =>
          isRecord(item) &&
          typeof item.capability === 'string' &&
          !capabilities.has(item.capability),
      )
    )
      add({
        ruleId: 'CAPABILITY_UNKNOWN',
        ruleVersion: PRODUCIBILITY_RULES_VERSION,
        severity: 'WARN',
        jsonPointer: `/shot_contracts/${String(index)}/generation_constraints/capability_requirements`,
        observation: '镜头引用了能力登记表之外的 UNKNOWN 能力。',
        recommendation: '确认 Provider 能力或移除该要求。',
        sourceType: 'RULE',
      });
  });
  return findings;
};
const statusOf = (
  findings: readonly ProducibilityFindingDto[],
): ProducibilityReportDto['status'] =>
  findings.some((finding) => finding.severity === 'BLOCK' && !finding.overridden)
    ? 'BLOCK'
    : findings.some((finding) => finding.severity === 'WARN' && !finding.overridden)
      ? 'WARN'
      : 'PASS';

export interface ProducibilityReportService {
  run(
    input: ProducibilityRunInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProducibilityReportDto>>;
  getReport(reportId: string, traceId: string): Promise<AppResultDto<ProducibilityReportDto>>;
  overrideFinding(
    input: ProducibilityOverrideFindingInputDto,
    traceId: string,
  ): Promise<AppResultDto<ProducibilityReportDto>>;
}
export const createProducibilityReportService = (dependencies: {
  readonly newId: () => string;
  readonly now: () => string;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}): ProducibilityReportService => {
  const toDto = (snapshot: ProducibilityReportSnapshot): ProducibilityReportDto => {
    const overrides = new Map(
      snapshot.overrides.map((override) => [override.findingId, override.reason]),
    );
    const findings = snapshot.findings.map((finding): ProducibilityFindingDto => ({
      id: finding.id,
      jsonPointer: finding.jsonPointer,
      observation: finding.observation,
      overrideReason: overrides.get(finding.id) ?? null,
      overridden: overrides.has(finding.id),
      recommendation: finding.recommendation,
      ruleId: finding.ruleId,
      ruleVersion: finding.ruleVersion,
      severity: finding.severity,
      sourceType: finding.sourceType,
    }));
    return {
      capabilitySnapshotId: snapshot.report.capabilitySnapshotId,
      createdAt: snapshot.report.createdAt,
      disclaimer: snapshot.report.disclaimer,
      episodeId: snapshot.report.episodeId,
      episodeVersionId: snapshot.report.episodeVersionId,
      findings,
      id: snapshot.report.id,
      projectId: snapshot.report.projectId,
      referencePriceSnapshotId: snapshot.report.referencePriceSnapshotId,
      ruleSetVersion: snapshot.report.ruleSetVersion,
      status: statusOf(findings),
    };
  };
  const load = async (
    id: string,
    traceId: string,
  ): Promise<AppResultDto<ProducibilityReportDto>> => {
    const snapshot = await dependencies.unitOfWork.run(({ producibility }) =>
      producibility === undefined
        ? Promise.resolve<ProducibilityReportSnapshot | null>(null)
        : producibility.findReport(id),
    );
    return snapshot === null
      ? scriptFailure('SCRIPT_VERSION_NOT_FOUND', '可生产性报告不存在', traceId)
      : { data: toDto(snapshot), ok: true };
  };
  return {
    run: async (input, traceId) => {
      try {
        const [capabilitySnapshotId, referencePriceSnapshotId] = await dependencies.unitOfWork.run(
          ({ producibility }) =>
            producibility === undefined
              ? Promise.resolve<[string | null, string | null]>([null, null])
              : Promise.all([
                  producibility.findLatestCapabilitySnapshotId(),
                  producibility.findLatestReferencePriceSnapshotId(),
                ]),
        );
        if (capabilitySnapshotId === null)
          return scriptFailure(
            'PROJECT_PERSISTENCE_FAILED',
            '缺少 Provider 能力快照，无法生成报告',
            traceId,
            null,
            true,
          );
        const at = dependencies.now();
        const reportBase: ProducibilityReportRecord = {
          capabilitySnapshotId,
          createdAt: at,
          disclaimer: '可生产性报告是规则提示，不代表视觉生成成功或质量保证。',
          episodeId: input.episodeId,
          episodeVersionId: input.expectedVersionId,
          id: `report_${dependencies.newId()}`,
          projectId: input.projectId,
          referencePriceSnapshotId,
          ruleSetVersion: PRODUCIBILITY_RULES_VERSION,
          scope: 'EPISODE',
          shotVersionId: null,
          status: 'PASS',
        };
        const findings = findingsFor(input.document, dependencies.newId, at).map((finding) => ({
          ...finding,
          reportId: reportBase.id,
        }));
        const report: ProducibilityReportRecord = {
          ...reportBase,
          status: findings.some((finding) => finding.severity === 'BLOCK')
            ? 'BLOCK'
            : findings.some((finding) => finding.severity === 'WARN')
              ? 'WARN'
              : 'PASS',
        };
        await dependencies.unitOfWork.run(async ({ producibility, audit }) => {
          if (producibility === undefined) throw new Error('PRODUCIBILITY_REPOSITORY_UNAVAILABLE');
          await producibility.insertReport(report);
          await producibility.insertFindings(findings);
          await audit.record({
            action: 'PRODUCIBILITY_REPORT_CREATED',
            actor: 'SYSTEM',
            afterSha256: null,
            beforeSha256: null,
            createdAt: at,
            id: `audit_${dependencies.newId()}`,
            metadata: { findingCount: findings.length, ruleSetVersion: report.ruleSetVersion },
            objectId: report.id,
            objectType: 'PRODUCIBILITY_REPORT',
            objectVersionId: report.episodeVersionId,
            projectId: report.projectId,
            traceId,
          });
        });
        return await load(report.id, traceId);
      } catch (_caught: unknown) {
        return scriptPersistenceFailure(traceId);
      }
    },
    getReport: (reportId, traceId) => load(reportId, traceId),
    overrideFinding: async (input, traceId) => {
      try {
        const found = await dependencies.unitOfWork.run(({ producibility }) =>
          producibility === undefined
            ? Promise.resolve<Awaited<
                ReturnType<ProducibilityRepositoryPort['findFinding']>
              > | null>(null)
            : producibility.findFinding(input.findingId),
        );
        if (found === null)
          return scriptFailure('SCRIPT_VERSION_NOT_FOUND', '可生产性 finding 不存在', traceId);
        if (found.finding.severity === 'BLOCK')
          return scriptFailure('EXPORT_COLLECTION_INVALID', 'BLOCK finding 不可覆盖', traceId);
        const at = dependencies.now();
        await dependencies.unitOfWork.run(async ({ producibility, audit }) => {
          if (producibility === undefined) throw new Error('PRODUCIBILITY_REPOSITORY_UNAVAILABLE');
          await producibility.insertOverride({
            actor: input.actor,
            createdAt: at,
            decision: 'ACCEPT_RISK',
            findingId: input.findingId,
            id: `override_${dependencies.newId()}`,
            reason: input.reason,
          });
          await audit.record({
            action: 'PRODUCIBILITY_FINDING_OVERRIDDEN',
            actor: input.actor === 'USER' ? 'USER' : 'SYSTEM',
            afterSha256: null,
            beforeSha256: null,
            createdAt: at,
            id: `audit_${dependencies.newId()}`,
            metadata: { findingId: input.findingId, reasonLength: input.reason.length },
            objectId: input.findingId,
            objectType: 'PRODUCIBILITY_FINDING',
            objectVersionId: null,
            projectId: found.report.projectId,
            traceId,
          });
        });
        return await load(found.report.id, traceId);
      } catch (_caught: unknown) {
        return scriptPersistenceFailure(traceId);
      }
    },
  };
};
