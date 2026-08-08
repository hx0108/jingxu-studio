import { useEffect, useState } from 'react';

import type { StartupStatusDto } from '@jingxu/contracts';

import { StartupGate } from './StartupGate';

const INITIAL_STATUS: StartupStatusDto = {
  allowedActions: [],
  backups: [],
  completedPhases: [],
  currentPhase: 'DATABASE_OPEN',
  errorCode: null,
  retryable: false,
  revision: 0,
  state: 'BOOTING',
  summary: null,
  writeEnabled: false,
};

const createRequestId = (operation: string): string =>
  `${operation}_${globalThis.crypto.randomUUID()}`;

export const App = () => {
  const [pendingAction, setPendingAction] = useState(false);
  const [status, setStatus] = useState<StartupStatusDto>(INITIAL_STATUS);
  const [transportFailed, setTransportFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void window.jingxu.runtime
      .getStartupStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch(() => {
        if (active) setTransportFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const retry = (): void => {
    setPendingAction(true);
    void window.jingxu.runtime
      .retryStartup({
        expectedRevision: status.revision,
        requestId: createRequestId('retry'),
      })
      .then((nextStatus) => {
        setStatus(nextStatus);
        setTransportFailed(false);
      })
      .catch(() => {
        setTransportFailed(true);
      })
      .finally(() => {
        setPendingAction(false);
      });
  };

  const restore = (backupId: string): void => {
    if (
      !globalThis.confirm(
        '恢复会替换当前数据库。当前数据库和 WAL/SHM 将先保留为诊断证据。是否继续？',
      )
    ) {
      return;
    }
    setPendingAction(true);
    void window.jingxu.runtime
      .restoreBackup({
        backupId,
        expectedRevision: status.revision,
        requestId: createRequestId('restore'),
      })
      .then((nextStatus) => {
        setStatus(nextStatus);
        setTransportFailed(false);
      })
      .catch(() => {
        setTransportFailed(true);
      })
      .finally(() => {
        setPendingAction(false);
      });
  };

  return (
    <StartupGate
      onRestore={restore}
      onRetry={retry}
      pendingAction={pendingAction}
      status={status}
      transportFailed={transportFailed}
    />
  );
};
