import { useState } from 'react';

import type { ScriptStage } from '@jingxu/contracts';

import { createStableBusinessKey, type StageData } from './stage-form-contract';

type Stage = Exclude<ScriptStage, 'SHOT_CONTRACT'>;

export interface StageStructuredFormProps {
  readonly data: StageData;
  readonly disabled: boolean;
  readonly errors?: Readonly<Record<string, string>> | undefined;
  readonly onChange: (data: StageData) => void;
  readonly referenceData?: StageData | undefined;
  readonly stage: Stage;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
const arrayOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? (value as unknown[]).slice() : [];
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number | '' => (typeof value === 'number' ? value : '');
const SCENE_ORDINALS = [
  '一',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '十',
  '十一',
  '十二',
  '十三',
  '十四',
  '十五',
  '十六',
  '十七',
  '十八',
  '十九',
  '二十',
] as const;

const sceneOrdinal = (index: number): string => SCENE_ORDINALS[index] ?? String(index + 1);

const FieldError = ({ message }: { readonly message?: string | undefined }) =>
  message === undefined ? null : <span className="field-error">{message}</span>;

const TextField = ({
  disabled,
  label,
  multiline = false,
  onChange,
  value,
  error,
}: {
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly label: string;
  readonly multiline?: boolean;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) => (
  <label>
    {label}
    {multiline ? (
      <textarea
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        rows={3}
        value={value}
      />
    ) : (
      <input
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        value={value}
      />
    )}
    <FieldError message={error} />
  </label>
);

const NumberField = ({
  disabled,
  label,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number | '';
}) => (
  <label>
    {label}
    <input
      disabled={disabled}
      min={0}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
      type="number"
      value={value}
    />
  </label>
);

const patchRoot = (data: StageData, key: string, value: unknown): StageData => ({
  ...data,
  [key]: value,
});

const ConceptForm = (props: StageStructuredFormProps) => {
  const labels: readonly [string, string, boolean][] = [
    ['title', '作品名', false],
    ['genre', '故事类型', false],
    ['core_conflict', '核心冲突', true],
    ['synopsis', '故事梗概', true],
    ['target_audience', '目标观众', false],
    ['theme', '主题表达', true],
  ];
  return (
    <div className="stage-structured-fields">
      {labels.map(([key, label, multiline]) => (
        <TextField
          disabled={props.disabled}
          error={props.errors?.[`/data/${key}`]}
          key={key}
          label={label}
          multiline={multiline}
          onChange={(value) => {
            props.onChange(patchRoot(props.data, key, value));
          }}
          value={textOf(props.data[key])}
        />
      ))}
    </div>
  );
};

const DictionaryEditor = ({
  data,
  disabled,
  field,
  itemFields,
  label,
  onChange,
  prefix,
}: {
  readonly data: StageData;
  readonly disabled: boolean;
  readonly field: string;
  readonly itemFields: readonly [string, string][];
  readonly label: string;
  readonly onChange: (data: StageData) => void;
  readonly prefix: 'char' | 'scene' | 'prop';
}) => {
  const entries = recordOf(data[field]);
  const update = (next: Record<string, unknown>): void => {
    onChange(patchRoot(data, field, next));
  };
  return (
    <fieldset className="repeatable-stage-field">
      <legend>{label}</legend>
      {Object.entries(entries).map(([id, raw]) => {
        const item = recordOf(raw);
        return (
          <article key={id}>
            <strong>{id}</strong>
            {itemFields.map(([key, itemLabel]) => (
              <TextField
                disabled={disabled}
                key={key}
                label={itemLabel}
                multiline={key === 'description' || key === 'motivation'}
                onChange={(value) => {
                  update({ ...entries, [id]: { ...item, [key]: value } });
                }}
                value={textOf(item[key])}
              />
            ))}
            <button
              disabled={disabled}
              onClick={() => {
                const { [id]: removed, ...next } = entries;
                void removed;
                update(next);
              }}
              type="button"
            >
              删除{label}
            </button>
          </article>
        );
      })}
      <button
        disabled={disabled}
        onClick={() => {
          const id = createStableBusinessKey(prefix, Object.keys(entries));
          update({ ...entries, [id]: Object.fromEntries(itemFields.map(([key]) => [key, ''])) });
        }}
        type="button"
      >
        添加{label}
      </button>
    </fieldset>
  );
};

const StoryBibleForm = (props: StageStructuredFormProps) => {
  const rules = arrayOf(props.data.world_rules).map(textOf);
  return (
    <div className="stage-structured-fields">
      <DictionaryEditor
        {...props}
        field="characters"
        itemFields={[
          ['name', '姓名'],
          ['appearance', '外观'],
          ['personality', '性格'],
          ['motivation', '动机'],
        ]}
        label="角色"
        prefix="char"
      />
      <fieldset className="repeatable-stage-field">
        <legend>世界规则</legend>
        {rules.map((rule, index) => (
          <div key={`rule-${String(index)}`}>
            <TextField
              disabled={props.disabled}
              label={`规则 ${String(index + 1)}`}
              onChange={(value) => {
                const next = [...rules];
                next[index] = value;
                props.onChange(patchRoot(props.data, 'world_rules', next));
              }}
              value={rule}
            />
            <button
              disabled={props.disabled}
              onClick={() => {
                props.onChange(
                  patchRoot(
                    props.data,
                    'world_rules',
                    rules.filter((_, cursor) => cursor !== index),
                  ),
                );
              }}
              type="button"
            >
              删除规则
            </button>
          </div>
        ))}
        <button
          disabled={props.disabled}
          onClick={() => {
            props.onChange(patchRoot(props.data, 'world_rules', [...rules, '']));
          }}
          type="button"
        >
          添加规则
        </button>
      </fieldset>
      <DictionaryEditor
        {...props}
        field="scenes"
        itemFields={[
          ['name', '名称'],
          ['description', '描述'],
        ]}
        label="场景"
        prefix="scene"
      />
      <DictionaryEditor
        {...props}
        field="props"
        itemFields={[
          ['name', '名称'],
          ['description', '描述'],
        ]}
        label="道具"
        prefix="prop"
      />
    </div>
  );
};

const OutlineForm = (props: StageStructuredFormProps) => (
  <div className="stage-structured-fields">
    {(
      [
        ['episode_goal', '本集目标'],
        ['opening', '开场'],
        ['midpoint', '中点'],
        ['climax', '高潮'],
        ['ending_hook', '结尾钩子'],
      ] as const
    ).map(([key, label]) => (
      <TextField
        disabled={props.disabled}
        key={key}
        label={label}
        multiline
        onChange={(value) => {
          props.onChange(patchRoot(props.data, key, value));
        }}
        value={textOf(props.data[key])}
      />
    ))}
    <NumberField
      disabled={props.disabled}
      label="目标时长（秒）"
      onChange={(value) => {
        props.onChange(patchRoot(props.data, 'target_duration_sec', value));
      }}
      value={numberOf(props.data.target_duration_sec)}
    />
  </div>
);

const BeatSheetForm = (props: StageStructuredFormProps) => {
  const beats = arrayOf(props.data.beats).map(recordOf);
  const update = (next: readonly unknown[]): void => {
    props.onChange(patchRoot(props.data, 'beats', next));
  };
  return (
    <fieldset className="repeatable-stage-field">
      <legend>剧情节拍（3–20 项）</legend>
      {beats.map((beat, index) => (
        <article key={textOf(beat.beat_id) || `beat-${String(index)}`}>
          <strong>节拍 {String(index + 1)}</strong>
          <TextField
            disabled={props.disabled}
            label="作用"
            onChange={(value) => {
              update(
                beats.map((item, cursor) =>
                  cursor === index ? { ...item, purpose: value } : item,
                ),
              );
            }}
            value={textOf(beat.purpose)}
          />
          <TextField
            disabled={props.disabled}
            label="内容"
            multiline
            onChange={(value) => {
              update(
                beats.map((item, cursor) =>
                  cursor === index ? { ...item, description: value } : item,
                ),
              );
            }}
            value={textOf(beat.description)}
          />
          <NumberField
            disabled={props.disabled}
            label="预计时长（秒）"
            onChange={(value) => {
              update(
                beats.map((item, cursor) =>
                  cursor === index ? { ...item, estimated_duration_sec: value } : item,
                ),
              );
            }}
            value={numberOf(beat.estimated_duration_sec)}
          />
          <button
            disabled={props.disabled || beats.length <= 3}
            onClick={() => {
              update(
                beats
                  .filter((_, cursor) => cursor !== index)
                  .map((item, cursor) => ({ ...item, sequence: cursor + 1 })),
              );
            }}
            type="button"
          >
            删除节拍
          </button>
        </article>
      ))}
      <button
        disabled={props.disabled || beats.length >= 20}
        onClick={() => {
          update([
            ...beats,
            {
              beat_id: createStableBusinessKey(
                'beat',
                beats.map((item) => textOf(item.beat_id)),
              ),
              description: '',
              estimated_duration_sec: 1,
              purpose: '',
              sequence: beats.length + 1,
            },
          ]);
        }}
        type="button"
      >
        添加节拍
      </button>
    </fieldset>
  );
};

const SceneScriptForm = (props: StageStructuredFormProps) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const scenes = arrayOf(props.data.scenes).map(recordOf);
  const sceneReferences = Object.entries(recordOf(props.referenceData?.scenes)).map(
    ([id, value]) => ({ id, name: textOf(recordOf(value).name) || '未命名场景' }),
  );
  const characterReferences = Object.entries(recordOf(props.referenceData?.characters)).map(
    ([id, value]) => ({ id, name: textOf(recordOf(value).name) || '未命名人物' }),
  );
  const sceneName = (id: string): string =>
    sceneReferences.find((item) => item.id === id)?.name ?? '未关联场景';
  const update = (next: readonly unknown[]): void => {
    props.onChange(patchRoot(props.data, 'scenes', next));
  };
  const selectedScene = scenes[Math.min(selectedIndex, scenes.length - 1)];
  const selectedSceneIndex = Math.min(selectedIndex, scenes.length - 1);
  const updateSelected = (patch: Record<string, unknown>): void => {
    update(
      scenes.map((item, index) => (index === selectedSceneIndex ? { ...item, ...patch } : item)),
    );
  };
  const lines =
    selectedScene === undefined ? [] : arrayOf(selectedScene.spoken_lines).map(recordOf);
  const totalSeconds = scenes.reduce(
    (sum, scene) => sum + (numberOf(scene.estimated_duration_sec) || 0),
    0,
  );
  const populatedScenes = scenes.filter((scene) => textOf(scene.action).trim().length > 0).length;
  const dialogueCount = scenes.reduce((sum, scene) => sum + arrayOf(scene.spoken_lines).length, 0);
  return (
    <div className="scene-script-form">
      <div className="scene-script-summary">
        <strong>场景剧本</strong>
        <span>
          共 {scenes.length} 个场景 · 预计 {Math.ceil(totalSeconds / 60)} 分钟
        </span>
      </div>
      <div className="scene-script-layout">
        <aside aria-label="场景目录" className="scene-script-list">
          <h3>场景目录</h3>
          {scenes.map((scene, index) => (
            <button
              aria-current={selectedSceneIndex === index ? 'true' : undefined}
              className={selectedSceneIndex === index ? 'active' : ''}
              key={textOf(scene.script_scene_id) || `scene-${String(index)}`}
              onClick={() => {
                setSelectedIndex(index);
              }}
              type="button"
            >
              <strong>
                场景{String(index + 1)} · {sceneName(textOf(scene.scene_id))}
              </strong>
              <small>约 {numberOf(scene.estimated_duration_sec) || 0} 秒</small>
            </button>
          ))}
          <button
            disabled={props.disabled || scenes.length >= 20 || sceneReferences.length === 0}
            onClick={() => {
              const nextIndex = scenes.length;
              update([
                ...scenes,
                {
                  action: '',
                  character_ids: [],
                  estimated_duration_sec: 1,
                  scene_id: sceneReferences[0]?.id ?? '',
                  script_scene_id: createStableBusinessKey(
                    'script_scene',
                    scenes.map((item) => textOf(item.script_scene_id)),
                  ),
                  sequence: nextIndex + 1,
                  spoken_lines: [],
                },
              ]);
              setSelectedIndex(nextIndex);
            }}
            type="button"
          >
            新增场景
          </button>
        </aside>
        <section aria-label="场景正文编辑" className="scene-script-editor">
          {selectedScene === undefined ? (
            <p>还没有场景，请先新增场景。</p>
          ) : (
            <>
              <header className="scene-script-editor-heading">
                <h3 aria-label={`场景${String(selectedSceneIndex + 1)}`}>
                  场景{sceneOrdinal(selectedSceneIndex)}　
                  {sceneName(textOf(selectedScene.scene_id))}
                </h3>
                <span>约 {numberOf(selectedScene.estimated_duration_sec) || 0} 秒</span>
              </header>
              <label>
                场景设定
                <select
                  disabled={props.disabled || sceneReferences.length === 0}
                  onChange={(event) => {
                    updateSelected({ scene_id: event.target.value });
                  }}
                  value={textOf(selectedScene.scene_id)}
                >
                  {sceneReferences.length === 0 && <option value="">请先完成人物与场景设定</option>}
                  {sceneReferences.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="scene-script-characters">
                <legend>出场人物</legend>
                {characterReferences.length === 0 ? (
                  <p>请先完成人物设定。</p>
                ) : (
                  characterReferences.map((item) => (
                    <label key={item.id}>
                      <input
                        checked={arrayOf(selectedScene.character_ids).includes(item.id)}
                        disabled={props.disabled}
                        onChange={(event) => {
                          const chosen = arrayOf(selectedScene.character_ids).map(textOf);
                          updateSelected({
                            character_ids: event.target.checked
                              ? [...chosen, item.id]
                              : chosen.filter((id) => id !== item.id),
                          });
                        }}
                        type="checkbox"
                      />
                      {item.name}
                    </label>
                  ))
                )}
              </fieldset>
              <TextField
                disabled={props.disabled}
                label="动作与画面"
                multiline
                onChange={(value) => {
                  updateSelected({ action: value });
                }}
                value={textOf(selectedScene.action)}
              />
              <div className="scene-script-lines">
                <h4>对白与旁白</h4>
                {lines.map((line, index) => (
                  <div className="scene-script-line" key={index}>
                    <label>
                      类型
                      <select
                        disabled={props.disabled}
                        onChange={(event) => {
                          updateSelected({
                            spoken_lines: lines.map((item, cursor) =>
                              cursor === index ? { ...item, line_type: event.target.value } : item,
                            ),
                          });
                        }}
                        value={textOf(line.line_type) || 'DIALOGUE'}
                      >
                        <option value="DIALOGUE">对白</option>
                        <option value="NARRATION">旁白</option>
                        <option value="SUBTITLE">字幕</option>
                      </select>
                    </label>
                    <label>
                      说话人
                      <select
                        disabled={props.disabled || characterReferences.length === 0}
                        onChange={(event) => {
                          updateSelected({
                            spoken_lines: lines.map((item, cursor) =>
                              cursor === index
                                ? { ...item, speaker_id: event.target.value || null }
                                : item,
                            ),
                          });
                        }}
                        value={textOf(line.speaker_id)}
                      >
                        <option value="">无指定说话人</option>
                        {characterReferences.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <TextField
                      disabled={props.disabled}
                      label="内容"
                      onChange={(value) => {
                        updateSelected({
                          spoken_lines: lines.map((item, cursor) =>
                            cursor === index ? { ...item, text: value } : item,
                          ),
                        });
                      }}
                      value={textOf(line.text)}
                    />
                    <button
                      disabled={props.disabled}
                      onClick={() => {
                        updateSelected({
                          spoken_lines: lines.filter((_, cursor) => cursor !== index),
                        });
                      }}
                      type="button"
                    >
                      删除此行
                    </button>
                  </div>
                ))}
                <button
                  disabled={props.disabled}
                  onClick={() => {
                    updateSelected({
                      spoken_lines: [
                        ...lines,
                        { line_type: 'DIALOGUE', speaker_id: null, text: '' },
                      ],
                    });
                  }}
                  type="button"
                >
                  添加对白或旁白
                </button>
              </div>
              <NumberField
                disabled={props.disabled}
                label="预计时长（秒）"
                onChange={(value) => {
                  updateSelected({ estimated_duration_sec: value });
                }}
                value={numberOf(selectedScene.estimated_duration_sec)}
              />
              <button
                disabled={props.disabled}
                onClick={() => {
                  if (
                    !globalThis.confirm(
                      '删除当前场景？保存后将创建新版本，原版本仍可在历史中查看。',
                    )
                  )
                    return;
                  update(
                    scenes
                      .filter((_, index) => index !== selectedSceneIndex)
                      .map((scene, index) => ({ ...scene, sequence: index + 1 })),
                  );
                  setSelectedIndex(Math.max(0, selectedSceneIndex - 1));
                }}
                type="button"
              >
                删除当前场景
              </button>
            </>
          )}
        </section>
        <aside className="scene-script-check">
          <h3>本步检查</h3>
          <p>以下仅检查当前填写情况，不代表剧情质量已通过。</p>
          <div>
            <strong>场景内容</strong>
            <small>
              {populatedScenes} / {scenes.length} 个场景已填写动作与画面
            </small>
          </div>
          <div>
            <strong>对白内容</strong>
            <small>已填写 {dialogueCount} 行对白、旁白或字幕</small>
          </div>
          <div>
            <strong>预计时长</strong>
            <small>当前合计 {totalSeconds} 秒</small>
          </div>
        </aside>
      </div>
    </div>
  );
};

export const StageStructuredForm = (props: StageStructuredFormProps) => {
  if (props.stage === 'CONCEPT') return <ConceptForm {...props} />;
  if (props.stage === 'STORY_BIBLE') return <StoryBibleForm {...props} />;
  if (props.stage === 'EPISODE_OUTLINE') return <OutlineForm {...props} />;
  if (props.stage === 'BEAT_SHEET') return <BeatSheetForm {...props} />;
  return <SceneScriptForm {...props} />;
};
