/**
 * storyboard-export-deliverables：Markdown 交付物渲染纯函数（PRD 9.8 分镜表 / 9.5 可生产性）。
 *
 * 输入恒为 assembleStoryboardExport 组装并过 Registry 校验的 envelope——
 * 人读文本与 JSON 导出同源同门禁，渲染零 I/O、零时钟。
 */

/** PRD 9.5「阈值必须配置化并记录规则版本」：随报告输出，变更即升版。 */
export const PRODUCIBILITY_RULES_VERSION = 'jingxu-producibility-rules/1';
export const SPEECH_DURATION_WARN_SEC = 4;

type Envelope = Readonly<Record<string, unknown>>;

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/** unknown → 文本：仅 string/number/boolean 可呈现，对象等形态落空串（不出现 [object Object]）。 */
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};

/** Markdown 单元格转义：竖线转义、换行压空格。 */
const cell = (value: unknown): string => text(value).replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

const stringList = (value: unknown): string =>
  Array.isArray(value) ? value.map((item) => cell(item)).join(',') : '';

const shotsOf = (envelope: Envelope): readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(envelope.shot_contracts)
    ? (envelope.shot_contracts as readonly Record<string, unknown>[])
    : [];

const totalDurationOf = (envelope: Envelope): number =>
  shotsOf(envelope).reduce((sum, shot) => sum + Number(shot.target_duration_sec ?? 0), 0);

/** 表头上方事实行：整集版本 / Σ 时长 / 导出 ID / 导出时间（spec：版本事实必须呈现）。 */
const factLines = (envelope: Envelope): readonly string[] => [
  `- 整集版本：v${text(envelope.episode_version)}`,
  `- 镜头时长合计：${String(totalDurationOf(envelope))}s（软带 60–120s）`,
  `- 导出 ID：${text(envelope.export_id)}`,
  `- 导出时间：${text(envelope.exported_at)}`,
];

/** PRD 9.5 正脸长对白 WARN 判定式（确定性，无 LLM）：三条件全真才命中。 */
export interface ProducibilityWarn {
  readonly estimatedSpeechDurationSec: number;
  readonly sequence: number;
  readonly shotId: string;
}

export const collectProducibilityWarns = (envelope: Envelope): readonly ProducibilityWarn[] => {
  const warns: ProducibilityWarn[] = [];
  for (const shot of shotsOf(envelope)) {
    const cinematography = recordOf(shot.cinematography);
    const dialogue = recordOf(shot.dialogue);
    if (cinematography === null || dialogue === null) continue;
    const duration = dialogue.estimated_speech_duration_sec;
    if (
      cinematography.frontal_face === true &&
      cinematography.mouth_visible === true &&
      typeof duration === 'number' &&
      duration > SPEECH_DURATION_WARN_SEC
    ) {
      warns.push({
        estimatedSpeechDurationSec: duration,
        sequence: Number(shot.sequence ?? 0),
        shotId: text(shot.shot_id),
      });
    }
  }
  return warns;
};

const tableRow = (cells: readonly unknown[]): string => `| ${cells.map(cell).join(' | ')} |`;

/** Markdown 分镜表（spec：9 列表头 + 逐镜头行 + 表头上方版本事实）。 */
export const renderStoryboardMarkdownTable = (envelope: Envelope): string => {
  const rows = shotsOf(envelope).map((shot) => {
    const cinematography = recordOf(shot.cinematography) ?? {};
    const content = recordOf(shot.content) ?? {};
    const lockedCount = Array.isArray(shot.locked_paths) ? shot.locked_paths.length : 0;
    return tableRow([
      `#${text(shot.sequence)}`,
      cinematography.shot_size,
      cinematography.camera_motion,
      shot.target_duration_sec,
      shot.narrative_purpose,
      content.spoken_text,
      stringList(content.character_ids),
      content.scene_id,
      lockedCount > 0 ? String(lockedCount) : '—',
    ]);
  });
  return [
    `# 分镜表：${text(envelope.project_id)}/${text(envelope.episode_id)}`,
    '',
    ...factLines(envelope),
    '',
    '| 镜头号 | 景别 | 运镜 | 时长(s) | 叙事目的 | 台词/旁白 | 角色 | 场景 | 锁定 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
};

/** 可生产性报告（spec：结构事实 + 正脸长对白 WARN 单条启发式，非阻断）。 */
export const renderProducibilityReport = (
  envelope: Envelope,
  deviationReason: string | null,
): string => {
  const provenance = recordOf(envelope.export_provenance) ?? {};
  const formatProfile = recordOf(envelope.format_profile) ?? {};
  const shots = shotsOf(envelope);
  const aiShotCount = shots.filter((shot) => {
    const shotProvenance = recordOf(shot.provenance);
    return shotProvenance !== null && shotProvenance.source_type !== 'HUMAN_CREATED';
  }).length;
  const total = totalDurationOf(envelope);
  const deviates = total < 60 || total > 120;
  const warns = collectProducibilityWarns(envelope);
  const warnLines =
    warns.length === 0
      ? [`- WARN：无命中（全部镜头对白时长 ≤ ${String(SPEECH_DURATION_WARN_SEC)}s）`]
      : warns.map(
          (warn) =>
            `- WARN #${String(warn.sequence)}（${warn.shotId}）：正脸长对白 ${String(
              warn.estimatedSpeechDurationSec,
            )}s > ${String(SPEECH_DURATION_WARN_SEC)}s（WEAK_LIP_SYNC 风险）`,
        );
  const listingRows = shots.map((shot) => {
    const dialogue = recordOf(shot.dialogue) ?? {};
    return tableRow([
      `#${text(shot.sequence)}`,
      shot.shot_id,
      shot.target_duration_sec,
      dialogue.estimated_speech_duration_sec ?? '—',
      dialogue.dialogue_render_mode,
    ]);
  });
  return [
    `# 可生产性报告：${text(envelope.project_id)}/${text(envelope.episode_id)}`,
    '',
    '## 头部事实',
    '',
    `- 整集版本：v${text(envelope.episode_version)}`,
    `- 故事圣经版本：${text(envelope.story_bible_version_id)}`,
    `- 画幅：${text(formatProfile.aspect_ratio)} · ${text(formatProfile.width)}×${text(
      formatProfile.height,
    )} · ${text(formatProfile.fps)}fps · ${text(formatProfile.language)}`,
    `- 导出 ID：${text(envelope.export_id)}`,
    `- 导出时间：${text(envelope.exported_at)}`,
    `- 可生产性规则版本：${PRODUCIBILITY_RULES_VERSION}`,
    '',
    '## 时长事实',
    '',
    factLines(envelope)[1],
    deviates
      ? `- 偏离确认：已确认偏离，原因：${deviationReason ?? ''}`
      : '- 偏离确认：无（Σ 在软带内）',
    '',
    '## 集合校验结论',
    '',
    '- READY_EXPORT 门禁复跑通过（整集 READY + 集合校验 + envelope 1.1.0 Registry 校验）。',
    '',
    '## AI 参与度',
    '',
    `- contains_ai_assisted_content：${text(provenance.contains_ai_assisted_content)}`,
    `- AI 参与镜头：${String(aiShotCount)}/${String(shots.length)}`,
    '',
    '## 可生产性规则',
    '',
    `- 规则版本：${PRODUCIBILITY_RULES_VERSION}`,
    `- 判定式：frontal_face=true 且 mouth_visible=true 且 estimated_speech_duration_sec > ${String(
      SPEECH_DURATION_WARN_SEC,
    )}（正脸长对白 WEAK_LIP_SYNC 风险，PRD 9.5）`,
    ...warnLines,
    '',
    '## 镜头清单',
    '',
    '| 镜头号 | shot_id | 时长(s) | 对白时长(s) | 渲染模式 |',
    '| --- | --- | --- | --- | --- |',
    ...listingRows,
    '',
  ].join('\n');
};
