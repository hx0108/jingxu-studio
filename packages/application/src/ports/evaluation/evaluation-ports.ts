import type { EvaluationRuleHitDto, EvaluationSampleInputDto } from '@jingxu/contracts';

import type { ProjectRepository } from '../project/project-repository';
import type {
  EpisodeRepositoryPort,
  EpisodeVersionRepositoryPort,
  ShotContractVersionRepositoryPort,
} from '../script/script-repositories';
import type { ScriptAuditRepositoryPort } from '../script/script-repositories';
import type {
  EvaluationAnnotationRecord,
  EvaluationImportEnvelope,
  EvaluationSampleFilter,
  EvaluationSampleRecord,
} from './evaluation-types';

/**
 * 确定性规则命中引擎 Port（design.md D2）：零 I/O、零时钟，同一输入恒同结果。
 * Registry Schema 校验失败同样以 EVAL_ISSUE_SCHEMA_INVALID 命中返回，不抛错。
 */
export interface EvaluationRulesPort {
  evaluate(input: EvaluationSampleInputDto): Readonly<{
    hits: readonly EvaluationRuleHitDto[];
    ruleVersion: string;
  }>;
}

/** evaluation_samples 仓储（0001 两表 + 0017 命中列）。 */
export interface EvaluationSampleRepositoryPort {
  list(filter: EvaluationSampleFilter): Promise<readonly EvaluationSampleRecord[]>;
  findById(id: string): Promise<EvaluationSampleRecord | null>;
  findByDedupKey(dedupKey: string): Promise<EvaluationSampleRecord | null>;
  insert(record: EvaluationSampleRecord): Promise<void>;
  /** 删除样本并级联删除其标注，返回被删标注行数；样本不存在返回 null。 */
  deleteById(id: string): Promise<number | null>;
}

/** evaluation_annotations 仓储（追加式；无 UPDATE 方法即历史不可变）。 */
export interface EvaluationAnnotationRepositoryPort {
  listBySampleId(sampleId: string): Promise<readonly EvaluationAnnotationRecord[]>;
  insert(record: EvaluationAnnotationRecord): Promise<void>;
  deleteBySampleId(sampleId: string): Promise<number>;
}

/**
 * Main 侧导入文件 Port（路径红线）：系统 Open Dialog + 受管理读取，
 * 路径只存在于 Port 实现内部，向 Application 仅暴露字节；用户取消返回 null。
 */
export interface EvaluationImportFilePort {
  readSelectedJson(): Promise<Readonly<{ bytes: Uint8Array }> | null>;
}

/** 解析后的导入信封（staging 在事务外完成，见 EvaluationService.importBatch）。 */
export type EvaluationImportStaging = EvaluationImportEnvelope;

/**
 * Evaluation 事务内可用的仓储聚合：评测两表 + 审计 + 项目派生只读投影
 * （episode/episode_version/shot_contract_version 快照冻结读取）。
 */
export interface EvaluationRepositories {
  readonly samples: EvaluationSampleRepositoryPort;
  readonly annotations: EvaluationAnnotationRepositoryPort;
  readonly audit: ScriptAuditRepositoryPort;
  readonly projects: Pick<ProjectRepository, 'findById'>;
  readonly episodes: Pick<EpisodeRepositoryPort, 'findById'>;
  readonly episodeVersions: Pick<EpisodeVersionRepositoryPort, 'findById' | 'listShotLinks'>;
  readonly shotContractVersions: Pick<ShotContractVersionRepositoryPort, 'findById'>;
}

/** runtime 级 FIFO 单连接短事务边界（与 Project/Script/Transfer UoW 同一 coordinator）。 */
export interface EvaluationUnitOfWorkPort {
  run<T>(work: (repositories: EvaluationRepositories) => Promise<T>): Promise<T>;
}
