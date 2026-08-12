/**
 * Application 层 Job 编排公开入口。
 *
 * 具体 JobRunner 将在 OpenSpec task 4.2 落地；本入口仅固定包边界，禁止在此
 * 实例化 Persistence、Electron 或 Provider Adapter。
 */
export {};
export * from './candidate-contract/index';
