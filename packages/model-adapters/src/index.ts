/**
 * 文本模型 Adapter 包（TECH_DESIGN v1.1 §3.3、§6.2）。
 *
 * 本包只容纳纯净、无 Electron、无持久化的 Provider Adapter 实现（如
 * `QwenTextModelAdapter`、`MockTextModelAdapter`），它们实现 Application 的
 * `TextModelPort`。凭据（Electron safeStorage）与 IPC 编排属于 Main 基础设施，
 * 不放入本包。具体 Adapter 在本 Change 的 Section 3（Mock）与 Section 6（Qwen）
 * 接入。
 *
 * 边界由 `eslint.config.mjs` 的 `packages/model-adapters/src/**` zone 强制：
 * 禁止导入 `electron`、`better-sqlite3`、`node:sqlite`、`@jingxu/persistence`。
 */
export {};
