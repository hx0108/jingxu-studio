import type {
  ModelErrorCode,
  NormalizedModelError,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelPort,
} from '@jingxu/application';

export type E2eFailureScenario =
  '401' | '429' | '5xx' | 'timeout' | 'invalid-json' | 'repair-failure' | 'stale' | 'late-response';

class E2eScriptModelError extends Error {
  public constructor(public readonly normalized: NormalizedModelError) {
    super(normalized.code);
    this.name = 'E2eScriptModelError';
  }
}

const retryable = new Set<ModelErrorCode>([
  'MODEL_NETWORK_ERROR',
  'MODEL_PROVIDER_ERROR',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
]);

const failure = (code: ModelErrorCode): NormalizedModelError => ({
  code,
  detail: `E2E fixed mock: ${code}`,
  providerRequestId: null,
  retryable: retryable.has(code),
  userAction: null,
});

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
    case 'SHOT_CONTRACT':
      // 与 E2E 链上游对齐：STORY_BIBLE 的 char_lead/scene_train、EPISODE_OUTLINE 的
      // 90s（6 镜 × 15s，每镜 1..20 由 ShotContract 1.1.0 定界）。
      return {
        shots: [
          '开场：车厢全景，无人回应',
          '林夜攥紧怀表起身，动作连贯',
          '空镜：窗外流动的夜色',
          '林夜质问列车长',
          '连续动作：林夜追向车尾',
          '结尾钩子：怀表传出声音',
        ].map((purpose, index) => ({
          acceptance: { must_include: ['午夜列车车厢'], must_not_include: [] },
          cinematography: {
            camera_angle: 'EYE_LEVEL',
            camera_motion: index % 2 === 0 ? 'STATIC' : 'DOLLY',
            composition: '中景，主体居左',
            focus: '人物面部清晰',
            frontal_face: true,
            mouth_visible: index % 3 !== 2,
            shot_size: index % 3 === 2 ? 'LONG' : 'MEDIUM',
          },
          content: {
            action: `镜 ${String(index + 1)}：${purpose}`,
            character_ids: index % 3 === 2 ? [] : ['char_lead'],
            emotion: index === 5 ? '震惊' : '警惕',
            prop_ids: [],
            scene_id: 'scene_train',
            spoken_text: index % 3 === 2 ? '' : '这趟列车，到底要开去哪里？',
          },
          continuity: {
            continuity_mode: index === 1 || index === 4 ? 'CONTINUOUS_ACTION' : 'SCENE_CHANGE',
            first_frame_requirement: `${purpose}起帧`,
            last_frame_requirement: `${purpose}止帧`,
            // 模型无法预知系统注入的兄弟镜头 id；输出 null，由注入器按 sequence 派生。
            previous_shot_id: null,
          },
          dialogue: {
            dialogue_render_mode: 'NARRATION_FIRST',
            estimated_speech_duration_sec: index % 3 === 2 ? 0 : 3,
            // Schema 分支：无台词镜头 speaker 必须为 null。
            speaker_id: index % 3 === 2 ? null : 'narrator',
          },
          generation_constraints: {
            capability_requirements: [{ capability: 'FIRST_FRAME', required: true }],
            image_prompt: '夜行列车车厢，冷色调，中景',
            negative_constraints: ['文字水印'],
            video_prompt: '镜头缓慢推近，人物轻微呼吸起伏',
          },
          narrative_purpose: purpose,
          target_duration_sec: 15,
        })),
      };
    default:
      throw new Error('SCRIPT_STAGE_UNSUPPORTED');
  }
};

/** Deterministic, network-free model used only when Main explicitly enables the E2E harness. */
export class E2eScriptTextModelAdapter implements TextModelPort {
  readonly #scenario: E2eFailureScenario | null;
  #attempt = 0;

  public constructor(scenario: E2eFailureScenario | null = null) {
    this.#scenario = scenario;
  }

  public validateCredential(): Promise<Readonly<{ ok: true }>> {
    return Promise.resolve({ ok: true });
  }

  public generate(
    request: TextGenerationRequest,
    signal: AbortSignal,
  ): Promise<TextGenerationResult> {
    this.#attempt += 1;
    if (signal.aborted) return Promise.reject(new Error('MODEL_CANCELLED'));
    const scenario = this.#scenario;
    if (scenario === '401')
      return Promise.reject(new E2eScriptModelError(failure('MODEL_CREDENTIAL_INVALID')));
    if (scenario === '429' && this.#attempt <= 1)
      return Promise.reject(new E2eScriptModelError(failure('MODEL_RATE_LIMITED')));
    if (scenario === '5xx')
      return Promise.reject(new E2eScriptModelError(failure('MODEL_PROVIDER_ERROR')));
    if (scenario === 'timeout')
      return Promise.reject(new E2eScriptModelError(failure('MODEL_TIMEOUT')));
    if (scenario === 'late-response') {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            finishReason: 'stop',
            modelReported: 'jingxu-e2e-script-model',
            providerRequestId: `e2e-late-${request.invocationId}`,
            rawText: JSON.stringify({ data: candidateData(request.stage) }),
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        }, 1_000);
      });
    }
    if (scenario === 'invalid-json' && this.#attempt === 1)
      return Promise.resolve({
        finishReason: 'stop',
        modelReported: 'jingxu-e2e-script-model',
        providerRequestId: `e2e-invalid-${request.invocationId}`,
        rawText: '{',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    if (scenario === 'repair-failure')
      return Promise.resolve({
        finishReason: 'stop',
        modelReported: 'jingxu-e2e-script-model',
        providerRequestId: `e2e-repair-fail-${request.invocationId}`,
        rawText: '{',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    return Promise.resolve({
      finishReason: 'stop',
      modelReported: 'jingxu-e2e-script-model',
      providerRequestId: `e2e-${request.invocationId}`,
      rawText: JSON.stringify({ data: candidateData(request.stage) }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  public normalizeError(error: unknown): NormalizedModelError {
    if (error instanceof E2eScriptModelError) return error.normalized;
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
