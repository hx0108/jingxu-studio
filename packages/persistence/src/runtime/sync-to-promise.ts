/**
 * 把同步求值（可能抛 {@link PersistenceRuntimeError}）桥接为 Promise。
 *
 * Promise executor 内的 throw 自动转为 rejection——这匹配 Port 契约里"持久化错误经
 * reject 传播、由 Application 在事务边界 catch"的语义。node:sqlite 为同步 API，Repository
 * 方法借此满足 `Promise<T>` 返回类型，又不使用 `async` 关键字（避免 require-await）。
 *
 * 仅 persistence 包内部使用，不向 Application 暴露。
 */
export const syncToPromise = <T>(operation: () => T): Promise<T> =>
  new Promise<T>((resolve) => {
    resolve(operation());
  });
