import type {
  RestoreBackupCommandDto,
  StartupCommandDto,
  StartupStatusDto,
} from '@jingxu/contracts';

import type {
  PersistenceCheckResult,
  PersistenceFailure,
  PersistenceRuntimePort,
} from '../ports/persistence/persistence-runtime-port';
import type {
  SchemaRegistryCheckResult,
  SchemaRegistryStartupPort,
} from '../ports/schema-registry';
import { StartupStateMachine } from './startup-state-machine';

const INITIAL_STATUS: StartupStatusDto = {
  allowedActions: [],
  backups: [],
  completedPhases: [],
  currentPhase: null,
  errorCode: null,
  retryable: false,
  revision: 0,
  state: 'BOOTING',
  summary: null,
  writeEnabled: false,
};

export class StartupService {
  readonly #commandResults = new Map<string, Promise<StartupStatusDto>>();
  readonly #port: PersistenceRuntimePort;
  readonly #schemaPort: SchemaRegistryStartupPort;
  readonly #stateMachine = new StartupStateMachine();
  #operationTail: Promise<void> = Promise.resolve();
  #status: StartupStatusDto = INITIAL_STATUS;

  public constructor(port: PersistenceRuntimePort, schemaPort: SchemaRegistryStartupPort) {
    this.#port = port;
    this.#schemaPort = schemaPort;
  }

  public close(): void {
    this.#port.close();
  }

  public getStatus(): StartupStatusDto {
    return {
      ...this.#status,
      allowedActions: [...this.#status.allowedActions],
      backups: this.#status.backups.map((backup) => ({ ...backup })),
      completedPhases: [...this.#status.completedPhases],
    };
  }

  public async start(): Promise<StartupStatusDto> {
    if (this.#status.state !== 'BOOTING') {
      return this.getStatus();
    }

    return this.#enqueue(async () => this.#checkFromCurrentState());
  }

  public retryStartup(command: StartupCommandDto): Promise<StartupStatusDto> {
    return this.#runIdempotent(command.requestId, async () => {
      const conflict = this.#getConflict(command.expectedRevision);
      if (conflict !== null) return conflict;
      if (this.#status.state !== 'READ_ONLY_FAULT') return this.#stateConflict();
      return this.#checkFromCurrentState();
    });
  }

  public restoreBackup(command: RestoreBackupCommandDto): Promise<StartupStatusDto> {
    return this.#runIdempotent(command.requestId, async () => {
      const conflict = this.#getConflict(command.expectedRevision);
      if (conflict !== null) return conflict;
      if (this.#status.state !== 'READ_ONLY_FAULT') return this.#stateConflict();
      if (!this.#status.allowedActions.includes('RESTORE')) return this.#stateConflict();

      this.#status = this.#stateMachine.transition(this.#clearFault(this.#status), 'RESTORING');
      const restoreResult = await this.#port.restoreBackup(command.backupId, command.requestId);
      if (!restoreResult.ok) {
        this.#status = this.#toFault(this.#status, restoreResult.failure, []);
        return this.getStatus();
      }

      return this.#checkFromCurrentState();
    });
  }

  #runIdempotent(
    requestId: string,
    operation: () => Promise<StartupStatusDto>,
  ): Promise<StartupStatusDto> {
    const existing = this.#commandResults.get(requestId);
    if (existing !== undefined) return existing;

    const result = this.#enqueue(operation);
    this.#commandResults.set(requestId, result);
    return result;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #checkFromCurrentState(): Promise<StartupStatusDto> {
    this.#status = this.#stateMachine.transition(this.#clearFault(this.#status), 'CHECKING');
    this.#status = {
      ...this.#status,
      currentPhase: 'DATABASE_OPEN',
    };

    const result = await this.#port.prepare();
    if (!result.ok) {
      this.#applyPersistenceFailure(result);
      return this.getStatus();
    }

    this.#status = {
      ...this.#status,
      backups: [...result.backups],
      completedPhases: [...result.completedPhases],
      currentPhase: 'SCHEMA_REGISTRY',
    };

    let schemaResult: SchemaRegistryCheckResult;
    try {
      schemaResult = await this.#schemaPort.prepare();
    } catch {
      schemaResult = {
        failure: {
          allowedActions: ['RETRY'],
          errorCode: 'SCHEMA_COMPILE_FAILED',
          phase: 'SCHEMA_REGISTRY',
          retryable: true,
          summary: 'Schema 启动检查未完成，请重试。',
        },
        ok: false,
      };
    }
    this.#applySchemaResult(schemaResult);
    return this.getStatus();
  }

  #applyPersistenceFailure(result: Extract<PersistenceCheckResult, { ok: false }>): void {
    this.#status = this.#toFault(this.#status, result.failure, result.completedPhases);
  }

  #applySchemaResult(result: SchemaRegistryCheckResult): void {
    if (!result.ok) {
      const fault = this.#stateMachine.transition(this.#status, 'READ_ONLY_FAULT');
      this.#status = {
        ...fault,
        allowedActions: [...result.failure.allowedActions],
        currentPhase: result.failure.phase,
        errorCode: result.failure.errorCode,
        retryable: result.failure.retryable,
        summary: result.failure.summary,
      };
      return;
    }

    this.#status = this.#stateMachine.transition(
      {
        ...this.#status,
        completedPhases: [...this.#status.completedPhases, 'SCHEMA_REGISTRY'],
        currentPhase: null,
      },
      'READY',
    );
  }

  #toFault(
    status: StartupStatusDto,
    failure: PersistenceFailure,
    completedPhases: readonly StartupStatusDto['completedPhases'][number][],
  ): StartupStatusDto {
    const fault = this.#stateMachine.transition(status, 'READ_ONLY_FAULT');
    return {
      ...fault,
      allowedActions: [...failure.allowedActions],
      backups: [...failure.backups],
      completedPhases: [...completedPhases],
      currentPhase: failure.phase,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      summary: failure.summary,
    };
  }

  #clearFault(status: StartupStatusDto): StartupStatusDto {
    return {
      ...status,
      allowedActions: [],
      errorCode: null,
      retryable: false,
      summary: null,
    };
  }

  #getConflict(expectedRevision: number): StartupStatusDto | null {
    return expectedRevision === this.#status.revision ? null : this.#stateConflict();
  }

  #stateConflict(): StartupStatusDto {
    return {
      ...this.getStatus(),
      errorCode: 'STARTUP_STATE_CONFLICT',
      retryable: true,
      summary: '启动状态已经变化，请刷新后重试。',
    };
  }
}
