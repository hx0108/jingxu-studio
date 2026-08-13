import type { AppResultDto } from '@jingxu/contracts';

import type {
  ConsentRecord,
  Episode,
  ScriptAuditEntry,
  ScriptCommandReceipt,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  ScriptWorkspaceSnapshot,
  SourceInput,
} from '../ports/script/index';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';

export interface OriginalInitializationCommand {
  readonly creativeText: string;
  readonly dataProcessingConsent: boolean;
  readonly projectId: string;
  readonly requestId: string;
}

export interface OriginalInitializationDependencies {
  readonly unitOfWork: ScriptUnitOfWorkPort;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
  readonly newId: () => string;
  readonly now: () => string;
  readonly hashText: (text: string) => string;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly getProjectDefaults: (
    projectId: string,
  ) => Promise<Readonly<{ targetDurationSec: number }> | null>;
}

export interface OriginalInitializationService {
  initialize(
    command: OriginalInitializationCommand,
    traceId: string,
  ): Promise<AppResultDto<ScriptWorkspaceSnapshot>>;
}

const DATA_PROCESSING_STATEMENT =
  '我已知悉原创内容将发送给当前文本模型 Provider，并同意本次数据处理。';

/** Creates SourceInput, consent, and the single Episode in one short transaction. */
export const createOriginalInitializationService = (
  dependencies: OriginalInitializationDependencies,
): OriginalInitializationService => ({
  initialize: async (command, traceId) => {
    const charCount = Array.from(command.creativeText).length;
    if (charCount < 20 || charCount > 2_000 || command.creativeText.trim().length === 0) {
      return scriptFailure(
        'SCRIPT_INPUT_LENGTH_INVALID',
        '原创输入必须包含 20–2,000 个 Unicode 字符',
        traceId,
        { creativeText: '请输入 20–2,000 个字符，内容不会被自动裁剪' },
      );
    }
    if (!command.dataProcessingConsent) {
      return scriptFailure(
        'SCRIPT_INPUT_CONSENT_REQUIRED',
        '请先确认文本模型数据处理说明',
        traceId,
        { dataProcessingConsent: '需要明确确认后才能初始化' },
      );
    }

    const projectDefaults = await dependencies.getProjectDefaults(command.projectId);
    if (projectDefaults === null) {
      return scriptFailure('PROJECT_NOT_FOUND', '项目不存在或已删除', traceId);
    }

    const payloadSha256 = dependencies.hashPayload({
      creativeText: command.creativeText,
      dataProcessingConsent: true,
      projectId: command.projectId,
    });

    try {
      await dependencies.unitOfWork.run(async (repositories) => {
        const existingReceipt = await repositories.receipts.findByRequestId(command.requestId);
        if (existingReceipt !== null) {
          if (
            existingReceipt.commandName !== 'INITIALIZE_ORIGINAL' ||
            existingReceipt.projectId !== command.projectId ||
            existingReceipt.payloadSha256 !== payloadSha256
          ) {
            throw new Error('REQUEST_ID_REUSED');
          }
          return;
        }
        const at = dependencies.now();
        const sourceInputId = `source_${dependencies.newId()}`;
        const consentId = `consent_${dependencies.newId()}`;
        const episodeId = `episode_${dependencies.newId()}`;
        const auditId = `audit_${dependencies.newId()}`;
        const source: SourceInput = {
          charCount,
          content: command.creativeText,
          createdAt: at,
          encoding: null,
          fileName: null,
          id: sourceInputId,
          inputKind: 'CREATIVE',
          projectId: command.projectId,
          sha256: dependencies.hashText(command.creativeText),
        };
        const consent: ConsentRecord = {
          confirmedAt: at,
          consentType: 'DATA_PROCESSING',
          contentSource: 'SELF_OWNED',
          id: consentId,
          projectId: command.projectId,
          revokedAt: null,
          scope: 'SOURCE_INPUT',
          sourceInputId,
          statement: DATA_PROCESSING_STATEMENT,
        };
        const episode: Episode = {
          createdAt: at,
          currentVersionId: null,
          deletedAt: null,
          id: episodeId,
          projectId: command.projectId,
          targetDurationSec: projectDefaults.targetDurationSec,
          title: '第 1 集',
          updatedAt: at,
        };
        const audit: ScriptAuditEntry = {
          action: 'SCRIPT_ORIGINAL_INITIALIZED',
          actor: 'USER',
          afterSha256: source.sha256,
          beforeSha256: null,
          createdAt: at,
          id: auditId,
          metadata: { charCount, consentType: 'DATA_PROCESSING' },
          objectId: sourceInputId,
          objectType: 'SOURCE_INPUT',
          objectVersionId: null,
          projectId: command.projectId,
          traceId,
        };
        const newReceipt: ScriptCommandReceipt = {
          commandName: 'INITIALIZE_ORIGINAL',
          committedAt: at,
          payloadSha256,
          projectId: command.projectId,
          requestId: command.requestId,
          resultRef: { episodeId, sourceInputId },
          traceId,
        };
        if ((await repositories.sourceInputs.findCreativeByProjectId(command.projectId)) !== null) {
          throw new Error('SCRIPT_WORKSPACE_ALREADY_INITIALIZED');
        }
        await repositories.sourceInputs.insert(source);
        await repositories.consents.insert(consent);
        await repositories.episodes.insert(episode);
        await repositories.audit.record(audit);
        await repositories.receipts.insert(newReceipt);
      });
      const workspace = await dependencies.workspaceQuery.getWorkspace(command.projectId);
      return workspace === null ? scriptPersistenceFailure(traceId) : { data: workspace, ok: true };
    } catch (caught: unknown) {
      if (caught instanceof Error && caught.message === 'REQUEST_ID_REUSED') {
        return scriptFailure('REQUEST_ID_REUSED', 'requestId 已用于不同命令', traceId);
      }
      if (caught instanceof Error && caught.message === 'SCRIPT_WORKSPACE_ALREADY_INITIALIZED') {
        return scriptFailure('SCRIPT_VERSION_CONFLICT', '剧本工作区已经初始化', traceId);
      }
      return scriptPersistenceFailure(traceId);
    }
  },
});
