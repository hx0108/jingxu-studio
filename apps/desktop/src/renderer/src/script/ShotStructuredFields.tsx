import { useState } from 'react';

export interface ShotEditableFields {
  readonly action: string;
  readonly imagePrompt: string;
  readonly spokenText: string;
  readonly videoPrompt: string;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

export const readShotStructuredFields = (document: Record<string, unknown>): ShotEditableFields => {
  const content = recordOf(document.content);
  const generation = recordOf(document.generation_constraints);
  return {
    action: textOf(content.action),
    imagePrompt: textOf(generation.image_prompt),
    spokenText: textOf(content.spoken_text),
    videoPrompt: textOf(generation.video_prompt),
  };
};

export const applyShotStructuredFields = (
  document: Record<string, unknown>,
  fields: ShotEditableFields,
): Record<string, unknown> => ({
  ...document,
  content: {
    ...recordOf(document.content),
    action: fields.action,
    spoken_text: fields.spokenText,
  },
  generation_constraints: {
    ...recordOf(document.generation_constraints),
    image_prompt: fields.imagePrompt,
    video_prompt: fields.videoPrompt,
  },
});

const equals = (left: ShotEditableFields, right: ShotEditableFields): boolean =>
  left.action === right.action &&
  left.imagePrompt === right.imagePrompt &&
  left.spokenText === right.spokenText &&
  left.videoPrompt === right.videoPrompt;

export interface ShotStructuredFieldsProps {
  readonly disabled: boolean;
  readonly document: Record<string, unknown>;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSave: (document: Record<string, unknown>) => void;
}

export const ShotStructuredFields = ({
  disabled,
  document,
  onDirtyChange,
  onSave,
}: ShotStructuredFieldsProps) => {
  const [initial] = useState(() => readShotStructuredFields(document));
  const [fields, setFields] = useState(initial);
  const dirty = !equals(initial, fields);
  const [error, setError] = useState<string | null>(null);

  const update = (key: keyof ShotEditableFields, value: string): void => {
    const next = { ...fields, [key]: value };
    setFields(next);
    setError(null);
    onDirtyChange(!equals(initial, next));
  };

  return (
    <form
      className="shot-structured-fields"
      id="script-stage-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !dirty) return;
        if (fields.action.trim() === '') {
          setError('人物与动作不能为空。');
          return;
        }
        onSave(applyShotStructuredFields(document, fields));
      }}
    >
      <label>
        画面内容
        <textarea
          disabled={disabled}
          maxLength={4000}
          onChange={(event) => {
            update('imagePrompt', event.target.value);
          }}
          rows={2}
          value={fields.imagePrompt}
        />
      </label>
      <label>
        人物与动作
        <textarea
          disabled={disabled}
          maxLength={1000}
          onChange={(event) => {
            update('action', event.target.value);
          }}
          required
          rows={2}
          value={fields.action}
        />
      </label>
      <label>
        台词
        <textarea
          disabled={disabled}
          maxLength={1000}
          onChange={(event) => {
            update('spokenText', event.target.value);
          }}
          rows={2}
          value={fields.spokenText}
        />
      </label>
      <label>
        镜头运动
        <textarea
          disabled={disabled}
          maxLength={4000}
          onChange={(event) => {
            update('videoPrompt', event.target.value);
          }}
          rows={2}
          value={fields.videoPrompt}
        />
      </label>
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="shot-structured-actions">
        <p>保存后会创建新的镜头版本；未保存的修改不会进入画面生成。</p>
        <button disabled={disabled || !dirty} name="save-shot-structured" type="submit">
          保存镜头修改
        </button>
      </div>
    </form>
  );
};
