import type {
  NormalizedModelError,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelPort,
} from '@jingxu/application';

const candidateData = (
  stage: TextGenerationRequest['stage'],
): Readonly<Record<string, unknown>> => {
  switch (stage) {
    case 'CONCEPT':
      return {
        core_conflict: '主角必须在真相与亲情之间做出选择',
        genre: '悬疑',
        synopsis: '主角追查失窃的记忆，并在终点前找到幕后操控者。',
        target_audience: '喜欢悬疑漫剧的成年观众',
        theme: '记忆与身份',
        title: '午夜列车',
      };
    case 'STORY_BIBLE':
      return {
        characters: {
          char_lead: {
            appearance: '黑色风衣，随身携带旧怀表',
            motivation: '找回被窃取的记忆',
            name: '林夜',
            personality: '谨慎而执着',
          },
        },
        props: {},
        scenes: { scene_train: { description: '穿行在夜色中的旧列车', name: '午夜列车' } },
        world_rules: ['记忆可以被提取，但每次交易都会留下可追踪的回声'],
      };
    case 'EPISODE_OUTLINE':
      return {
        climax: '林夜揭穿列车长的记忆交易',
        ending_hook: '旧怀表中传出另一个自己的声音',
        episode_goal: '找到第一条记忆失窃线索',
        midpoint: '同车乘客承认所有人都遗失了同一天',
        opening: '林夜在没有终点站名的列车中醒来',
        target_duration_sec: 90,
      };
    case 'BEAT_SHEET':
      return {
        beats: [
          {
            beat_id: 'beat_1',
            description: '主角醒来',
            estimated_duration_sec: 20,
            purpose: '建立悬念',
            sequence: 1,
          },
          {
            beat_id: 'beat_2',
            description: '发现共同失忆',
            estimated_duration_sec: 35,
            purpose: '升级冲突',
            sequence: 2,
          },
          {
            beat_id: 'beat_3',
            description: '揭穿交易',
            estimated_duration_sec: 35,
            purpose: '高潮与钩子',
            sequence: 3,
          },
        ],
      };
    case 'SCENE_SCRIPT':
      return {
        scenes: [
          {
            action: '林夜在摇晃的车厢中睁开眼睛，握紧旧怀表。',
            character_ids: ['char_lead'],
            estimated_duration_sec: 30,
            scene_id: 'scene_train',
            script_scene_id: 'script_scene_1',
            sequence: 1,
            spoken_lines: [
              { line_type: 'DIALOGUE', speaker_id: 'char_lead', text: '这趟列车要开往哪里？' },
            ],
          },
        ],
      };
    default:
      throw new Error('SCRIPT_STAGE_UNSUPPORTED');
  }
};

/** Deterministic, network-free model used only when Main explicitly enables the E2E harness. */
export class E2eScriptTextModelAdapter implements TextModelPort {
  public validateCredential(): Promise<Readonly<{ ok: true }>> {
    return Promise.resolve({ ok: true });
  }

  public generate(
    request: TextGenerationRequest,
    signal: AbortSignal,
  ): Promise<TextGenerationResult> {
    if (signal.aborted) return Promise.reject(new Error('MODEL_CANCELLED'));
    return Promise.resolve({
      finishReason: 'stop',
      modelReported: 'jingxu-e2e-script-model',
      providerRequestId: `e2e-${request.invocationId}`,
      rawText: JSON.stringify({ data: candidateData(request.stage) }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  public normalizeError(error: unknown): NormalizedModelError {
    return {
      code:
        error instanceof Error && error.message === 'MODEL_CANCELLED'
          ? 'MODEL_CANCELLED'
          : 'MODEL_UNKNOWN',
      detail: null,
      providerRequestId: null,
      retryable: false,
      userAction: null,
    };
  }
}
