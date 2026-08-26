/**
 * 配音生成输入组装（v2-voice-audio-timeline tasks 4.2，design D2/D3）。
 *
 * 只读纯函数：镜头文档台词字段提取（audio_required / speaker_id / spoken_text）
 * 与 generation_input_hash 计算。零 I/O；哈希函数与图片/视频侧同构注入。
 * 哈希输入集 = {modelId, shotVersionId, spokenTextSha256, voiceId}——镜头版本行
 * id 参与哈希，因此「改文或版本变更」都必然改变哈希（spec R2 STALE_INPUT 判据）。
 */

/** 配音所需的冻结镜头文档字段（ShotContract 1.1.0 台词节）。 */
export interface VoiceShotDialogueFields {
  readonly audioRequired: boolean;
  readonly speakerId: string | null;
  readonly spokenText: string | null;
}

const sectionOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const stringOrNullOrUndefined = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * 解析冻结镜头文档的台词字段；文档不是合法 JSON 对象或缺少 content/dialogue 节
 * 时返回 null（READY 文档确认期已过校验，null 即行损坏，由调用方按稳定路径处理）。
 */
export const extractVoiceShotFields = (document: string): VoiceShotDialogueFields | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  const shot = sectionOf(parsed);
  const content = sectionOf(shot?.content);
  const dialogue = sectionOf(shot?.dialogue);
  if (content === null || dialogue === null) return null;
  return {
    audioRequired: dialogue.audio_required === true,
    speakerId: stringOrNullOrUndefined(dialogue.speaker_id),
    spokenText: stringOrNullOrUndefined(content.spoken_text),
  };
};

/** generation_input_hash 的输入集（design D3：候选冻结的音色/模型/文本/版本）。 */
export interface VoiceGenerationInputDescriptor {
  readonly modelId: string;
  readonly shotVersionId: string;
  readonly spokenTextSha256: string;
  readonly voiceId: string;
}

/**
 * 计算 generation_input_hash = sha256(canonical JSON)；键序固定字母序（与契约
 * schema 对齐），字段集与漂移由金样单测锁死。
 */
export const computeVoiceGenerationInputHash = (
  descriptor: VoiceGenerationInputDescriptor,
  hashPayload: (value: Readonly<Record<string, unknown>>) => string,
): string =>
  hashPayload({
    modelId: descriptor.modelId,
    shotVersionId: descriptor.shotVersionId,
    spokenTextSha256: descriptor.spokenTextSha256,
    voiceId: descriptor.voiceId,
  });
