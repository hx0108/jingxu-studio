export interface StoryBibleDescriptions {
  readonly characters: Readonly<Record<string, Readonly<{ appearance: string; name: string }>>>;
  readonly scenes: Readonly<Record<string, Readonly<{ description: string; name: string }>>>;
}

export type StoryBibleDescriptionResult =
  Readonly<{ descriptions: StoryBibleDescriptions; kind: 'ok' }> | Readonly<{ kind: 'invalid' }>;

const sectionOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

/**
 * 读取正式 ScriptStageOutput/STORY_BIBLE 信封；仅对没有任何信封标志的历史裸 data
 * 对象兼容。出现 stage/data 等信封标志但结构错误时必须失败，不能静默降级为空描述。
 */
export const parseStoryBibleDescriptions = (
  document: string | null,
): StoryBibleDescriptionResult => {
  if (document === null) return { kind: 'invalid' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return { kind: 'invalid' };
  }
  const root = sectionOf(parsed);
  if (root === null) return { kind: 'invalid' };
  const hasEnvelopeMarker = 'stage' in root || 'data' in root || 'schema_version' in root;
  let data: Readonly<Record<string, unknown>>;
  if (hasEnvelopeMarker) {
    if (root.stage !== 'STORY_BIBLE') return { kind: 'invalid' };
    const envelopeData = sectionOf(root.data);
    if (envelopeData === null) return { kind: 'invalid' };
    data = envelopeData;
  } else {
    data = root;
  }

  const characterSection = sectionOf(data.characters);
  const sceneSection = sectionOf(data.scenes);
  if (characterSection === null || sceneSection === null) return { kind: 'invalid' };

  const characters: Record<string, Readonly<{ appearance: string; name: string }>> = {};
  for (const [id, entry] of Object.entries(characterSection)) {
    const character = sectionOf(entry);
    const name = character?.name;
    const appearance = character?.appearance;
    if (
      typeof name === 'string' &&
      name.length > 0 &&
      typeof appearance === 'string' &&
      appearance.length > 0
    ) {
      characters[id] = { appearance, name };
    }
  }
  const scenes: Record<string, Readonly<{ description: string; name: string }>> = {};
  for (const [id, entry] of Object.entries(sceneSection)) {
    const scene = sectionOf(entry);
    const name = scene?.name;
    const description = scene?.description;
    if (
      typeof name === 'string' &&
      name.length > 0 &&
      typeof description === 'string' &&
      description.length > 0
    ) {
      scenes[id] = { description, name };
    }
  }
  return { descriptions: { characters, scenes }, kind: 'ok' };
};
