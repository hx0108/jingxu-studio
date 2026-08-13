import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import type { AppErrorDto, ProjectDetailDto } from '@jingxu/contracts';

import { describeProjectError } from './project-error';

export interface ProjectFormValues {
  name: string;
  genre: string;
  style: string;
  creationMode: 'AI_ORIGINAL' | 'AUTHORIZED_ADAPTATION' | 'AI_OPTIMIZATION';
  dialogueRenderMode: 'NARRATION_FIRST' | 'WEAK_LIP_SYNC' | 'PRECISE_LIP_SYNC' | 'SUBTITLE_ONLY';
  aspectRatio: '9:16' | '16:9';
  subtitleSafeArea: { top: number; right: number; bottom: number; left: number };
}

export type ProjectFormSubmitResult =
  | { readonly ok: true; readonly data: ProjectDetailDto }
  | { readonly ok: false; readonly error: AppErrorDto };

export const createProjectFormDefaults = (detail?: ProjectDetailDto): ProjectFormValues => ({
  name: detail?.name ?? '',
  genre: detail?.genre ?? '',
  style: detail?.style ?? '',
  creationMode: detail?.creationMode ?? 'AI_ORIGINAL',
  dialogueRenderMode: detail?.dialogueRenderMode ?? 'NARRATION_FIRST',
  aspectRatio: detail?.currentFormatProfile.aspectRatio ?? '9:16',
  subtitleSafeArea: detail?.currentFormatProfile.subtitleSafeArea ?? {
    top: 5,
    right: 5,
    bottom: 12,
    left: 5,
  },
});

export interface ProjectFormViewProps {
  readonly formId?: string;
  readonly defaults: ProjectFormValues;
  readonly submitLabel?: string;
  readonly onSubmit: (
    values: ProjectFormValues,
  ) => Promise<ProjectFormSubmitResult> | ProjectFormSubmitResult;
  readonly onCancel: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onCommitted?: (detail: ProjectDetailDto) => void;
}

export const ProjectFormView = ({
  formId,
  defaults,
  submitLabel = '保存项目',
  onSubmit,
  onCancel,
  onDirtyChange,
  onCommitted,
}: ProjectFormViewProps) => {
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ProjectFormValues>({ defaultValues: defaults });
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const submit = handleSubmit(async (values) => {
    setFeedback('正在保存…');
    const result = await onSubmit(values);
    if (!result.ok) {
      const view = describeProjectError(result.error);
      if (view.fieldErrors !== null) {
        for (const [field, message] of Object.entries(view.fieldErrors)) {
          if (field === 'name' || field === 'genre' || field === 'style')
            setError(field, { message });
        }
      }
      setFeedback(`${view.summary}。${view.nextAction}（追踪号 ${view.traceId}）`);
      return;
    }
    const committed = createProjectFormDefaults(result.data);
    reset(committed);
    onDirtyChange?.(false);
    setFeedback('已保存到本地数据库');
    onCommitted?.(result.data);
  });

  return (
    <form
      className="project-form"
      id={formId}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label>
        项目名称
        <input
          aria-invalid={errors.name === undefined ? undefined : true}
          autoFocus
          {...register('name', {
            required: '请输入项目名称',
            maxLength: { value: 100, message: '项目名称不能超过 100 个字符' },
          })}
        />
      </label>
      {errors.name?.message !== undefined && (
        <p className="field-error" role="alert">
          {errors.name.message}
        </p>
      )}
      <div className="field-row">
        <label>
          题材
          <input {...register('genre', { maxLength: 60 })} />
        </label>
        <label>
          风格
          <input {...register('style', { maxLength: 60 })} />
        </label>
      </div>
      <fieldset>
        <legend>画幅</legend>
        <label>
          <input type="radio" value="9:16" {...register('aspectRatio')} />
          竖屏 9:16
        </label>
        <label>
          <input type="radio" value="16:9" {...register('aspectRatio')} />
          横屏 16:9
        </label>
      </fieldset>
      <label>
        创作模式
        <select {...register('creationMode')}>
          <option value="AI_ORIGINAL">AI 原创</option>
          <option value="AUTHORIZED_ADAPTATION">授权改编</option>
          <option value="AI_OPTIMIZATION">AI 优化</option>
        </select>
      </label>
      <label>
        对白呈现
        <select {...register('dialogueRenderMode')}>
          <option value="NARRATION_FIRST">旁白优先</option>
          <option value="WEAK_LIP_SYNC">弱口型同步</option>
          <option value="PRECISE_LIP_SYNC">精确口型同步</option>
          <option value="SUBTITLE_ONLY">仅字幕</option>
        </select>
      </label>
      <fieldset>
        <legend>字幕安全区（百分比）</legend>
        <div className="safe-area-grid">
          {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
            <label key={edge}>
              {{ top: '上', right: '右', bottom: '下', left: '左' }[edge]}
              <input
                max="30"
                min="0"
                type="number"
                {...register(`subtitleSafeArea.${edge}`, { valueAsNumber: true, min: 0, max: 30 })}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <p className="system-note">
        分辨率、帧率、语言和本地目录由系统根据画幅安全派生，不能在 Renderer 伪造。
      </p>
      {feedback !== null && (
        <p
          aria-live="polite"
          className={feedback.includes('已保存') ? 'success-text' : 'feedback-text'}
        >
          {feedback}
        </p>
      )}
      <div className="form-actions">
        <button className="secondary-button" onClick={onCancel} type="button">
          取消
        </button>
        <button disabled={isSubmitting} type="submit">
          {isSubmitting ? '正在保存…' : submitLabel}
        </button>
      </div>
    </form>
  );
};
