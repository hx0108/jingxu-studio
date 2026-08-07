import type { StartupState, StartupStatusDto } from '@jingxu/contracts';

const LEGAL_TRANSITIONS: Readonly<Record<StartupState, readonly StartupState[]>> = {
  BOOTING: ['CHECKING'],
  CHECKING: ['READY', 'READ_ONLY_FAULT'],
  READY: [],
  READ_ONLY_FAULT: ['CHECKING', 'RESTORING'],
  RESTORING: ['CHECKING', 'READ_ONLY_FAULT'],
};

export class StartupStateMachine {
  public transition(status: StartupStatusDto, nextState: StartupState): StartupStatusDto {
    if (!LEGAL_TRANSITIONS[status.state].includes(nextState)) {
      throw new Error(`非法启动状态转换：${status.state} -> ${nextState}`);
    }

    return {
      ...status,
      revision: status.revision + 1,
      state: nextState,
      writeEnabled: nextState === 'READY',
    };
  }
}
