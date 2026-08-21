import type { TransferApi } from '@jingxu/contracts';

export const getTransferClient = (): TransferApi => window.jingxu.transfer;
