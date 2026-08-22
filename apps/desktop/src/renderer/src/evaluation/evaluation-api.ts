import type { EvaluationApi } from '@jingxu/contracts';

/** Renderer 只能取得冻结的 Preload 白名单，不接触 IPC channel 或文件路径。 */
export const getEvaluationClient = (): EvaluationApi => window.jingxu.evaluation;
