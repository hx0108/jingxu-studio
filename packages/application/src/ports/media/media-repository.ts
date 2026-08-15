/**
 * V2 图片切片的媒体资产与候选持久化访问契约（shot-first-frame-image-generation design D3）。
 *
 * 所有方法在 MediaUnitOfWorkPort 的事务内调用，Repository 不自行提交或回滚；
 * 返回纯记录，不泄漏 Row、Statement、连接或 SQL。图片字节不经过本契约——
 * 内容寻址文件由 ContentAddressedStore 落盘，这里只登记哈希与元数据。
 */

export type MediaAssetType = 'CHARACTER' | 'SCENE';

export type MediaAssetProvenance = 'UPLOADED';

export interface MediaAssetRecord {
  readonly assetType: MediaAssetType;
  readonly bibleRefId: string;
  readonly createdAt: string;
  readonly displayName: string;
  readonly id: string;
  readonly projectId: string;
  readonly updatedAt: string;
}

export interface MediaAssetVersionRecord {
  readonly assetId: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly description: string | null;
  readonly fileSha256: string;
  readonly height: number | null;
  readonly id: string;
  readonly mimeType: string;
  readonly parentVersionId: string | null;
  readonly provenance: MediaAssetProvenance;
  readonly versionNo: number;
  readonly width: number | null;
}

/** listAssets 的聚合形态：版本链按 versionNo 升序，至少含一个版本。 */
export interface MediaAssetWithVersions {
  readonly asset: MediaAssetRecord;
  readonly versions: readonly MediaAssetVersionRecord[];
}

export type MediaCandidateStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'STALE_INPUT';

export interface MediaCandidateRecord {
  readonly byteSize: number | null;
  readonly createdAt: string;
  readonly errorCode: string | null;
  readonly fileSha256: string | null;
  readonly generationInputHash: string;
  readonly height: number | null;
  readonly id: string;
  readonly indexInRound: number;
  readonly mimeType: string | null;
  readonly modelId: string;
  readonly roundNo: number;
  readonly selectedAt: string | null;
  readonly shotId: string;
  readonly storageRelPath: string | null;
  readonly shotVersionId: string;
  readonly status: MediaCandidateStatus;
  readonly updatedAt: string;
  readonly width: number | null;
}

/** STALE_INPUT 传播后按镜头聚合的受影响摘要（design D3：向用户列出受影响镜头清单）。 */
export interface MediaStaleAffectedShot {
  readonly candidateCount: number;
  readonly shotId: string;
}

/** media_generation_tasks 的 phase 单字段状态机（design D3；含三个终态）。 */
export type MediaTaskPhase =
  'SUBMITTED' | 'POLLING' | 'DOWNLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface MediaTaskRecord {
  readonly candidateCount: number;
  readonly createdAt: string;
  readonly errorCode: string | null;
  readonly generationInputHash: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly phase: MediaTaskPhase;
  readonly projectId: string;
  readonly providerTaskId: string | null;
  readonly shotId: string;
  readonly shotVersionId: string;
  readonly updatedAt: string;
}

export interface MediaRepository {
  /** 按 (projectId, assetType, bibleRefId) 业务键查资产；不存在返回 null。 */
  findAssetByIdentity(
    projectId: string,
    assetType: MediaAssetType,
    bibleRefId: string,
  ): Promise<MediaAssetRecord | null>;

  /** 建档；业务键冲突时抛持久化层冲突错误（service 先查再建，约束兜底并发）。 */
  createAsset(input: {
    readonly assetType: MediaAssetType;
    readonly bibleRefId: string;
    readonly displayName: string;
    readonly id: string;
    readonly projectId: string;
  }): Promise<MediaAssetRecord>;

  /**
   * 追加不可变参考图版本；version_no 由仓储在事务内取 max+1，
   * parentVersionId 自动指向当前最新版本。
   */
  appendAssetVersion(input: {
    readonly assetId: string;
    readonly byteSize: number;
    readonly description?: string | null;
    readonly fileSha256: string;
    readonly height?: number | null;
    readonly id: string;
    readonly mimeType: string;
    readonly width?: number | null;
  }): Promise<MediaAssetVersionRecord>;

  /** 列出项目全部资产及其版本链（版本升序）。 */
  listAssets(projectId: string): Promise<readonly MediaAssetWithVersions[]>;

  /**
   * 绑定解析：按业务键取资产当前（最新）参考图版本。
   * 资产不存在或从未上传参考图返回 null（调用方跳过该项，不阻断生成）。
   */
  findCurrentAssetVersion(
    projectId: string,
    assetType: MediaAssetType,
    bibleRefId: string,
  ): Promise<MediaAssetVersionRecord | null>;

  /**
   * 批量预落库一轮 PENDING 候选：round_no 取该镜头 max+1，index_in_round 为 0..count-1。
   * candidateIds 长度必须等于 count。
   */
  insertCandidates(input: {
    readonly candidateIds: readonly string[];
    readonly generationInputHash: string;
    readonly modelId: string;
    readonly projectId: string;
    readonly shotId: string;
    readonly shotVersionId: string;
  }): Promise<readonly MediaCandidateRecord[]>;

  /** 候选完成（成功形态）：文件四元组 + 调用证据引用一次性落位。 */
  completeCandidateSucceeded(
    candidateId: string,
    result: {
      readonly byteSize: number;
      readonly fileSha256: string;
      readonly height: number | null;
      readonly invocationEvidenceRef: string;
      readonly mimeType: string;
      readonly storageRelPath: string;
      readonly width: number | null;
    },
  ): Promise<MediaCandidateRecord>;

  /** 候选完成（失败形态）：错误码 + 调用证据引用。 */
  completeCandidateFailed(
    candidateId: string,
    result: {
      readonly errorCode: string;
      readonly invocationEvidenceRef: string;
    },
  ): Promise<MediaCandidateRecord>;

  /** 列出镜头全部候选（轮次与轮内索引升序），世代分组由上层按 hash 归并。 */
  listCandidates(shotId: string): Promise<readonly MediaCandidateRecord[]>;

  /**
   * 原子切换选择指针：同镜头先清后设。仅 SUCCEEDED 候选可被选择；
   * 候选不存在、不属于该镜头或不可选时抛稳定错误。
   */
  selectCandidate(shotId: string, candidateId: string): Promise<void>;

  /** 新 ShotContract READY 版本确认后的 STALE 传播；返回受影响镜头摘要。 */
  markCandidatesStaleByShotVersion(
    shotVersionId: string,
  ): Promise<readonly MediaStaleAffectedShot[]>;

  /** 资产升版后的 STALE 传播（按旧输入世代哈希定位）；返回受影响镜头摘要。 */
  markCandidatesStaleByGenerationInputHash(
    generationInputHash: string,
  ): Promise<readonly MediaStaleAffectedShot[]>;

  /**
   * 幂等重放查询：UNIQUE(project_id, idempotency_key) 的读侧入口
   * （idempotency_key = IPC requestId；新 requestId 同输入 = 新一轮候选）。
   */
  findTaskByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<MediaTaskRecord | null>;

  findTaskById(projectId: string, taskId: string): Promise<MediaTaskRecord | null>;

  /** 建任务行（phase=SUBMITTED，provider_task_id 为 null）；幂等键冲突抛稳定错误。 */
  insertTask(input: {
    readonly candidateCount: number;
    readonly generationInputHash: string;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly shotId: string;
    readonly shotVersionId: string;
  }): Promise<MediaTaskRecord>;

  /**
   * SUBMITTED→POLLING，同时持久化 provider_task_id（spec：首次 poll 前必须持久化）。
   * 已处于目标相位且 taskId 一致时幂等返回；否则抛 MEDIA_TASK_ALREADY_TERMINAL。
   */
  markTaskPolling(taskId: string, providerTaskId: string): Promise<MediaTaskRecord>;

  /** SUBMITTED|POLLING→DOWNLOADING（同步 Provider 从 SUBMITTED 直达）。 */
  markTaskDownloading(taskId: string): Promise<MediaTaskRecord>;

  /** 任一非终态→COMPLETED；终态后调用抛 MEDIA_TASK_ALREADY_TERMINAL。 */
  completeTask(taskId: string): Promise<MediaTaskRecord>;

  /** 任一非终态→FAILED 并记录稳定错误码。 */
  failTask(taskId: string, errorCode: string): Promise<MediaTaskRecord>;

  /** 任一非终态→CANCELLED。 */
  cancelTask(taskId: string): Promise<MediaTaskRecord>;

  /** 调度与恢复扫描（4.2）：非终态任务按创建序返回。 */
  listUnfinishedTasks(projectId: string): Promise<readonly MediaTaskRecord[]>;
}

/** 媒体读写事务边界：单一 `BEGIN IMMEDIATE`，work 抛出即回滚（沿 ProjectUnitOfWorkPort 语义）。 */
export interface MediaUnitOfWorkPort {
  run<T>(work: (media: MediaRepository) => Promise<T>): Promise<T>;
}
