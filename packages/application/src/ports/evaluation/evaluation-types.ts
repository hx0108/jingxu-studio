import type {
  EvaluationAnnotationLabelDto,
  EvaluationAuthorization,
  EvaluationDatasetSplit,
  EvaluationExpectedDto,
  EvaluationRuleHitDto,
  EvaluationSampleInputDto,
  EvaluationSampleType,
} from '@jingxu/contracts';

/**
 * evaluation_samples 行投影（0001 DDL + 0017 rule_hits_json/rule_version）。
 * 0017 之前不存在任何写入路径，ruleHits/ruleVersion 理论上恒非空；列本身可空，
 * 映射保持诚实（NULL 表示迁移前列语义，读侧不虚构）。
 */
export interface EvaluationSampleRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly sampleType: EvaluationSampleType;
  readonly input: EvaluationSampleInputDto;
  readonly expected: EvaluationExpectedDto;
  readonly authorization: EvaluationAuthorization;
  readonly dedupKey: string;
  readonly datasetSplit: EvaluationDatasetSplit;
  readonly ruleHits: readonly EvaluationRuleHitDto[] | null;
  readonly ruleVersion: string | null;
  readonly createdAt: string;
}

/** evaluation_annotations 行投影（追加式，无 UPDATE 路径）。 */
export interface EvaluationAnnotationRecord {
  readonly id: string;
  readonly sampleId: string;
  readonly guidelineVersion: string;
  readonly label: EvaluationAnnotationLabelDto;
  readonly rationale: string;
  readonly annotator: string;
  readonly createdAt: string;
}

/** 列表筛选（安全 IPC 与评测集页面 Requirement）：scope 语义与 DTO 一致。 */
export interface EvaluationSampleFilter {
  readonly scope: 'ALL' | 'GLOBAL' | 'PROJECT';
  readonly projectId?: string | null;
  readonly sampleType?: EvaluationSampleType | null;
  readonly datasetSplit?: EvaluationDatasetSplit | null;
}

/** JSON 批量导入信封（内部格式，非公开契约；整体非法即零入库）。 */
export interface EvaluationImportEnvelopeItem {
  readonly dedupKey: string;
  readonly authorization: EvaluationAuthorization;
  readonly datasetSplit: EvaluationDatasetSplit;
  readonly projectId?: string | null;
  readonly input: EvaluationSampleInputDto;
  readonly expected: EvaluationExpectedDto;
}

export interface EvaluationImportEnvelope {
  readonly version: 1;
  readonly samples: readonly EvaluationImportEnvelopeItem[];
}
