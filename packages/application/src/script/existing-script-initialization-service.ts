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

export interface ExistingScriptInitializationCommand {
  readonly content: string;
  readonly creationMode: 'AI_OPTIMIZATION' | 'AUTHORIZED_ADAPTATION';
  readonly dataProcessingConsent: boolean;
  readonly fileName: string | null;
  readonly inputKind: 'TXT' | 'MARKDOWN';
  readonly authorizationSource: string | null;
  readonly authorizationStatement: string | null;
  readonly projectId: string;
  readonly requestId: string;
}

export interface ExistingScriptInitializationDependencies {
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

const DATA_PROCESSING_STATEMENT =
  '我已知悉已有剧本内容将发送给当前文本模型 Provider，并同意本次数据处理。';

export const createExistingScriptInitializationService = (
  dependencies: ExistingScriptInitializationDependencies,
) => ({
  initialize: async (
    command: ExistingScriptInitializationCommand,
    traceId: string,
  ): Promise<AppResultDto<ScriptWorkspaceSnapshot>> => {
    const charCount = Array.from(command.content).length;
    if (charCount < 1 || charCount > 30_000 || command.content.trim().length === 0) {
      return scriptFailure(
        'SCRIPT_INPUT_LENGTH_INVALID',
        '已有剧本必须包含 1–30,000 个 Unicode 字符且不能只有空白',
        traceId,
      );
    }
    if (!command.dataProcessingConsent) {
      return scriptFailure(
        'SCRIPT_INPUT_CONSENT_REQUIRED',
        '请先确认文本模型数据处理说明',
        traceId,
      );
    }
    if (command.fileName !== null) {
      const expected = command.inputKind === 'TXT' ? '.txt' : '.md';
      if (!command.fileName.toLowerCase().endsWith(expected)) {
        return scriptFailure(
          'SCRIPT_INPUT_FORMAT_INVALID',
          '仅支持与输入类型匹配的 .txt 或 .md 文件',
          traceId,
        );
      }
    }
    if (
      command.creationMode === 'AUTHORIZED_ADAPTATION' &&
      (command.authorizationSource === null || command.authorizationStatement === null)
    ) {
      return scriptFailure(
        'SCRIPT_INPUT_AUTHORIZATION_REQUIRED',
        '授权改编必须填写授权来源和授权声明',
        traceId,
      );
    }
    const defaults = await dependencies.getProjectDefaults(command.projectId);
    if (defaults === null) return scriptFailure('PROJECT_NOT_FOUND', '项目不存在或已删除', traceId);
    const payloadSha256 = dependencies.hashPayload({ ...command, dataProcessingConsent: true });
    try {
      await dependencies.unitOfWork.run(async (repositories) => {
        const existingReceipt = await repositories.receipts.findByRequestId(command.requestId);
        if (existingReceipt !== null) {
          if (
            existingReceipt.commandName !== 'INITIALIZE_INPUT' ||
            existingReceipt.payloadSha256 !== payloadSha256
          ) {
            throw new Error('REQUEST_ID_REUSED');
          }
          return;
        }
        const existingSource =
          repositories.sourceInputs.findLatestByProjectId === undefined
            ? await repositories.sourceInputs.findCreativeByProjectId(command.projectId)
            : await repositories.sourceInputs.findLatestByProjectId(command.projectId);
        if (existingSource !== null) {
          throw new Error('SCRIPT_WORKSPACE_ALREADY_INITIALIZED');
        }
        const at = dependencies.now();
        const sourceInputId = `source_${dependencies.newId()}`;
        const episodeId = `episode_${dependencies.newId()}`;
        const source: SourceInput = {
          charCount,
          content: command.content,
          createdAt: at,
          encoding: 'UTF-8',
          fileName: command.fileName,
          id: sourceInputId,
          inputKind: command.inputKind,
          projectId: command.projectId,
          sha256: dependencies.hashText(command.content),
        };
        const processingConsent: ConsentRecord = {
          confirmedAt: at,
          consentType: 'DATA_PROCESSING',
          contentSource:
            command.creationMode === 'AUTHORIZED_ADAPTATION' ? 'AUTHORIZED' : 'SELF_OWNED',
          id: `consent_${dependencies.newId()}`,
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
          targetDurationSec: defaults.targetDurationSec,
          title: '第 1 集',
          updatedAt: at,
        };
        await repositories.sourceInputs.insert(source);
        await repositories.consents.insert(processingConsent);
        if (command.creationMode === 'AUTHORIZED_ADAPTATION') {
          await repositories.consents.insert({
            ...processingConsent,
            consentType: 'ADAPTATION_AUTHORIZATION',
            id: `consent_${dependencies.newId()}`,
            statement: `${command.authorizationSource ?? ''}: ${command.authorizationStatement ?? ''}`,
          });
        }
        const audit: ScriptAuditEntry = {
          action: 'SCRIPT_EXISTING_INPUT_INITIALIZED',
          actor: 'USER',
          afterSha256: source.sha256,
          beforeSha256: null,
          createdAt: at,
          id: `audit_${dependencies.newId()}`,
          metadata: { charCount, inputKind: command.inputKind, creationMode: command.creationMode },
          objectId: sourceInputId,
          objectType: 'SOURCE_INPUT',
          objectVersionId: null,
          projectId: command.projectId,
          traceId,
        };
        await repositories.episodes.insert(episode);
        await repositories.audit.record(audit);
        const receipt: ScriptCommandReceipt = {
          commandName: 'INITIALIZE_INPUT',
          committedAt: at,
          payloadSha256,
          projectId: command.projectId,
          requestId: command.requestId,
          resultRef: { episodeId, sourceInputId },
          traceId,
        };
        await repositories.receipts.insert(receipt);
      });
      const workspace = await dependencies.workspaceQuery.getWorkspace(command.projectId);
      return workspace === null ? scriptPersistenceFailure(traceId) : { data: workspace, ok: true };
    } catch (caught: unknown) {
      if (caught instanceof Error && caught.message === 'REQUEST_ID_REUSED')
        return scriptFailure('REQUEST_ID_REUSED', 'requestId 已用于不同命令', traceId);
      if (caught instanceof Error && caught.message === 'SCRIPT_WORKSPACE_ALREADY_INITIALIZED')
        return scriptFailure('SCRIPT_VERSION_CONFLICT', '剧本工作区已经初始化', traceId);
      return scriptPersistenceFailure(traceId);
    }
  },
});
