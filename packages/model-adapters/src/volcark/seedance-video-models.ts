/** 火山方舟视频模型受限注册表：仅这些冻结模型可由镜序 Studio 提交。 */
export interface SeedanceVideoModelDefinition {
  readonly id: string;
  readonly label: string;
  readonly maxResolution: '720p' | '1080p';
  readonly selectable: boolean;
  readonly snapshotDate: string;
}

export const SEEDANCE_VIDEO_MODELS = [
  {
    id: 'doubao-seedance-1-5-pro-251215',
    label: 'Seedance-1.5-pro（旧配置）',
    maxResolution: '1080p',
    selectable: false,
    snapshotDate: '2025-12-15',
  },
  {
    id: 'doubao-seedance-2-0-mini-260615',
    label: 'Seedance-2.0-mini',
    maxResolution: '720p',
    selectable: true,
    snapshotDate: '2026-06-15',
  },
  {
    id: 'doubao-seedance-2-0-260128',
    label: 'Seedance-2.0',
    maxResolution: '1080p',
    selectable: true,
    snapshotDate: '2026-01-28',
  },
  {
    id: 'doubao-seedance-2-5-260628',
    label: 'Seedance-2.5',
    maxResolution: '720p',
    selectable: true,
    snapshotDate: '2026-06-28',
  },
] as const satisfies readonly SeedanceVideoModelDefinition[];

export type SeedanceVideoModelId = (typeof SEEDANCE_VIDEO_MODELS)[number]['id'];

export const DEFAULT_SEEDANCE_VIDEO_MODEL_ID: SeedanceVideoModelId = 'doubao-seedance-2-0-260128';

export const isSeedanceVideoModelId = (value: string): value is SeedanceVideoModelId =>
  SEEDANCE_VIDEO_MODELS.some((model) => model.id === value);

export const getSeedanceVideoModel = (value: string): SeedanceVideoModelDefinition | null =>
  SEEDANCE_VIDEO_MODELS.find((model) => model.id === value) ?? null;

export const SELECTABLE_SEEDANCE_VIDEO_MODELS = SEEDANCE_VIDEO_MODELS.filter(
  (model) => model.selectable,
);
