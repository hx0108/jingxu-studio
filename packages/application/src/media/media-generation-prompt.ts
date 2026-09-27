/**
 * 首帧生成输入组装（shot-first-frame-image-generation §4.1）。
 *
 * 只读纯函数：从冻结的 ShotContract 1.1.0 文档挑选创意字段、从 STORY_BIBLE 挑选
 * 描述、按 FormatProfile 画幅映射尺寸，并计算 generation_input_hash（design D3）。
 * 系统字段（shot_id/status/version_id 等）一律不进入 Prompt 与哈希。
 */

/** ShotContract 文档中与首帧相关的创意字段（系统字段已被挑选规则排除）。 */
export interface ShotCreativeFields {
  readonly action: string | null;
  readonly cameraAngle: string | null;
  readonly characterIds: readonly string[];
  readonly composition: string | null;
  readonly continuityMode: string | null;
  readonly emotion: string | null;
  readonly firstFrameRequirement: string | null;
  readonly focus: string | null;
  readonly imagePrompt: string | null;
  readonly negativeConstraints: readonly string[];
  readonly sceneId: string | null;
  readonly shotSize: string | null;
}

const stringOrNullOrUndefined = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const stringArrayOrEmpty = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];

/**
 * 解析冻结镜头契约文档的创意字段；文档不是合法 JSON 对象时返回 null
 * （READY 文档在确认期已过 schema 校验，null 即行损坏，由调用方报稳定错误）。
 */
export const extractShotCreativeFields = (document: string): ShotCreativeFields | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const shot = parsed as Readonly<Record<string, unknown>>;
  const sectionOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
    typeof value === 'object' && value !== null
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  const content = sectionOf(shot.content);
  const cinematography = sectionOf(shot.cinematography);
  const continuity = sectionOf(shot.continuity);
  const constraints = sectionOf(shot.generation_constraints);
  if (content === null || cinematography === null || continuity === null) return null;
  const negative = constraints?.negative_constraints;
  return {
    action: stringOrNullOrUndefined(content.action),
    cameraAngle: stringOrNullOrUndefined(cinematography.camera_angle),
    characterIds: stringArrayOrEmpty(content.character_ids),
    composition: stringOrNullOrUndefined(cinematography.composition),
    continuityMode: stringOrNullOrUndefined(continuity.continuity_mode),
    emotion: stringOrNullOrUndefined(content.emotion),
    firstFrameRequirement: stringOrNullOrUndefined(continuity.first_frame_requirement),
    focus: stringOrNullOrUndefined(cinematography.focus),
    imagePrompt: stringOrNullOrUndefined(constraints?.image_prompt),
    negativeConstraints: stringArrayOrEmpty(negative),
    sceneId: stringOrNullOrUndefined(content.scene_id),
    shotSize: stringOrNullOrUndefined(cinematography.shot_size),
  };
};

/** FormatProfile 画幅 → Seedream 显式 WxH（0.2 结论 8 映射表；未知画幅返回 null）。 */
const IMAGE_SIZE_BY_ASPECT_RATIO: Readonly<
  Record<string, Readonly<{ height: number; width: number }>>
> = {
  '16:9': { height: 1440, width: 2560 },
  '1:1': { height: 2048, width: 2048 },
  '3:4': { height: 2304, width: 1728 },
  '4:3': { height: 1728, width: 2304 },
  '9:16': { height: 2560, width: 1440 },
};

export const resolveImageSize = (
  aspectRatio: string,
): Readonly<{ height: number; width: number }> | null =>
  IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio] ?? null;

/** Prompt 组装的 STORY_BIBLE 描述输入（绑定解析后按 character_ids/scene_id 挑出）。 */
export interface FirstFramePromptInput {
  readonly boundCharacters: readonly {
    readonly appearance: string;
    readonly name: string;
  }[];
  readonly creative: ShotCreativeFields;
  /**
   * 参考图逐张角色映射（一致性 v2，2026-09-28）：与请求 referenceImages 顺序
   * 一致，让多参考图模型显式绑定「第几张图是谁」——行业通行做法（即梦智能
   * 参考/可灵多图参考/Story2Screen 均为 reference+映射+镜头词三件套）。
   */
  readonly referenceRoles?: readonly {
    readonly kind: 'CHARACTER' | 'SCENE' | 'STYLE';
    readonly label: string;
  }[];
  readonly scene: { readonly description: string; readonly name: string } | null;
  readonly style: { readonly description: string; readonly name: string };
}

export const FIRST_FRAME_PROMPT_TEMPLATE_VERSION = 'first-frame-consistency-v2';

const referenceRolePhrase = (
  role: { readonly kind: 'CHARACTER' | 'SCENE' | 'STYLE'; readonly label: string },
  position: number,
): string => {
  const ordinal = `第${String(position)}张`;
  if (role.kind === 'STYLE') return `${ordinal}为全片画风基准图`;
  if (role.kind === 'SCENE') return `${ordinal}为场景参考图`;
  return `${ordinal}为角色「${role.label}」的标准形象参考`;
};

/**
 * 组装首帧 Prompt（确定性、纯函数）。
 *
 * 主描述优先取镜头自带 image_prompt；缺失时回退 action/emotion 复合。
 * 一致性 v2（2026-09-28）：新增参考图逐张映射句与身份锁定块——多参考图场景下
 * 模型需要显式知道「第几张图是谁」，且身份约束须与参考图绑定（行业通行做法：
 * 定妆图 + 逐张映射 + 身份/场景分离的结构化提示词）。避免项来自 negative_constraints。
 */
export const buildFirstFramePrompt = (input: FirstFramePromptInput): string => {
  const { boundCharacters, creative, referenceRoles, scene, style } = input;
  const fallback = [creative.action, creative.emotion]
    .filter((part): part is string => part !== null)
    .join('，');
  const primary = creative.imagePrompt ?? (fallback.length > 0 ? fallback : null);
  const lines: string[] = [
    `画风锚点：${style.name}——${style.description}。全片保持相同的材质、线条、色彩、光影与渲染方式。`,
  ];
  if (referenceRoles !== undefined && referenceRoles.length > 0) {
    lines.push(
      `参考图说明：${referenceRoles
        .map((role, index) => referenceRolePhrase(role, index + 1))
        .join('；')}。`,
    );
  }
  if (primary !== null) lines.push(primary);
  if (scene !== null) lines.push(`场景：${scene.name}——${scene.description}`);
  if (boundCharacters.length > 0) {
    lines.push(
      `人物身份：${boundCharacters.map((c) => `${c.name}（${c.appearance}）`).join('；')}。`,
    );
    lines.push(
      '身份锁定：以上角色的脸型、五官、发型发色、瞳色、体型、服装与配饰必须与对应角色参考图完全一致；同一角色在任何镜头中不得改变年龄、体格与装扮；角色形象与场景或画风描述冲突时，以角色参考图为准；不新增或替换角色。',
    );
  }
  const framing = [creative.shotSize, creative.cameraAngle].filter((part) => part !== null);
  if (framing.length > 0 || creative.composition !== null || creative.focus !== null) {
    const parts = [
      framing.length > 0 ? framing.join(' / ') : null,
      creative.composition === null ? null : `构图：${creative.composition}`,
      creative.focus === null ? null : `焦点：${creative.focus}`,
    ].filter((part) => part !== null);
    if (parts.length > 0) lines.push(`机位：${parts.join('；')}`);
  }
  if (creative.firstFrameRequirement !== null) {
    lines.push(`首帧要求：${creative.firstFrameRequirement}`);
  }
  if (creative.continuityMode === 'SAME_SCENE_CUT') {
    lines.push(
      '本镜头与前一镜头为同场景切镜：保持人物、服装与场景外观一致，仅按上述机位切换取景。',
    );
  }
  if (creative.negativeConstraints.length > 0) {
    lines.push(`避免：${creative.negativeConstraints.join('、')}`);
  }
  return lines.join('\n');
};

/** generation_input_hash 的输入集（字段集与 contracts generationInputDescriptorSchema 对齐）。 */
export interface GenerationInputDescriptor {
  readonly boundAssetVersionIds: readonly string[];
  readonly modelId: string;
  readonly parametersFingerprint: string;
  readonly shotContentHash: string;
  readonly shotVersionId: string;
}

/**
 * 计算 generation_input_hash（design D3：sha256(shot_version 内容哈希 ‖ 排序后绑定
 * asset_version id 列表 ‖ model_id ‖ 归一化参数)）。键序固定为契约 schema 的字母序，
 * 绑定列表升序排序后参与哈希——解析顺序不影响世代归属。
 */
export const computeGenerationInputHash = (
  descriptor: GenerationInputDescriptor,
  hashPayload: (value: Readonly<Record<string, unknown>>) => string,
): string =>
  hashPayload({
    boundAssetVersionIds: [...descriptor.boundAssetVersionIds].sort(),
    modelId: descriptor.modelId,
    parametersFingerprint: descriptor.parametersFingerprint,
    shotContentHash: descriptor.shotContentHash,
    shotVersionId: descriptor.shotVersionId,
  });
