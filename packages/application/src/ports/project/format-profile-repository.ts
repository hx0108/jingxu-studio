import type { FormatProfile } from '@jingxu/domain';

/**
 * FormatProfile 版本链的持久化访问契约（Design §6）。
 *
 * 所有方法在 {@link ProjectUnitOfWorkPort} 事务内调用，不自行提交。规格字段整体不可变；
 * 唯一允许的旧行变更是 isCurrent 投影由 true 置 false，新当前版本以 isCurrent=true 通过
 * insert 写入，二者在同一事务内完成以维持 partial unique 约束。
 */
export interface FormatProfileRepository {
  /** 读取项目当前 FormatProfile；无当前版本返回 null。 */
  findCurrent(projectId: string): Promise<FormatProfile | null>;
  /** 读取项目全部 FormatProfile 版本（含当前），按版本号升序。 */
  findAllByProject(projectId: string): Promise<readonly FormatProfile[]>;
  /** 读取项目当前最大版本号；无版本返回 0，使首个版本为 1。 */
  findMaxVersionNo(projectId: string): Promise<number>;
  /**
   * 检查指定 FormatProfile 是否被 ShotContractVersion 引用（Design §6）。
   * @returns true 表示存在下游分镜依赖，画幅变更须返回 FORMAT_PROFILE_DEPENDENCY_BLOCKED。
   */
  isCurrentReferencedByShotContract(projectId: string, formatProfileId: string): Promise<boolean>;
  /** 插入新的 FormatProfile 版本；新当前版本以 isCurrent=true 写入。 */
  insert(profile: FormatProfile): Promise<void>;
  /** 把旧当前版本的 isCurrent 置 false，是唯一允许的旧行变更（Design §6）。 */
  unsetCurrent(projectId: string, formatProfileId: string): Promise<void>;
}
