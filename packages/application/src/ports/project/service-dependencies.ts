/**
 * ProjectService 的可注入基础设施依赖（Design §1）。
 *
 * 时间、ID 与稳定 hash 抽象为接口，使 ProjectService 的行为可重复测试
 * （AGENTS §15.3：时间、ID、随机数可注入或固定）。生产实现由 Electron Main
 * Composition Root 注入；测试使用确定性 Fake。
 */

/**
 * 单调时间源，返回 Unix epoch 毫秒。
 *
 * ProjectService 用它计算 `updatedAt = max(clock.now, previous + 1ms)`，避免固定
 * 或低分辨率时钟在同一次连续写入中产生相同 revision（Design §6）。
 */
export interface Clock {
  /** 当前 Unix epoch 毫秒数。 */
  now(): number;
}

/**
 * 系统标识符生成器。
 *
 * 生成的 ID 必须匹配 Contract 的安全字符集 `[A-Za-z0-9_-]{12,64}`，禁止路径分隔符、
 * SQL 与空白。用于系统派生的 projectId/formatProfileId；调用方无法伪造 ID（Design §2）。
 */
export interface IdGenerator {
  /** 生成一个新的系统标识符。 */
  newId(): string;
}

/**
 * 稳定序列化 + SHA-256 哈希。
 *
 * 对同一逻辑值在任意属性顺序下产出同一 64 位小写十六进制摘要，用于 Command 幂等
 * 回执的 payloadSha256（Design §4）与列表游标的 searchHash（Design §7）。序列化
 * 规则为 v1 canonical JSON，具体实现与编解码测试见稳定序列化模块（§2.5）。
 */
export interface StableHasher {
  /**
   * 对任意对象做稳定序列化后计算 SHA-256。
   * @returns 64 位小写十六进制摘要。
   */
  hash(value: object): string;
}
