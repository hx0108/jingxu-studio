import { describe, expect, it } from 'vitest';

import type { FormatProfile } from '@jingxu/domain';

import { assembleStoryboardExport } from './storyboard-export-service';
import {
  PRODUCIBILITY_RULES_VERSION,
  SPEECH_DURATION_WARN_SEC,
  renderProducibilityReport,
  renderStoryboardMarkdownTable,
} from './storyboard-export-markdown';

/**
 * storyboard-export-deliverables 渲染金样：输入经 assembleStoryboardExport
 * 组装（与 JSON 导出同源），人读文本不得另立事实源。
 */
const NOW = '2026-08-20T00:00:00.000Z';
const PROJECT_ID = 'project_export1';
const EPISODE_ID = 'episode_export1';

const formatProfile: FormatProfile = {
  createdAt: NOW,
  id: 'format_export1',
  isCurrent: true,
  parentId: null,
  projectId: PROJECT_ID,
  spec: {
    aspectRatio: '9:16',
    fps: 30,
    height: 1920,
    language: 'zh-CN',
    subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    width: 1080,
  },
  versionNo: 1,
};

const shotDocument = (
  shotId: string,
  sequence: number,
  durationSec: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  acceptance: { human_review_required: true, must_include: [], must_not_include: [] },
  cinematography: {
    camera_motion: 'STATIC',
    frontal_face: false,
    mouth_visible: false,
    shot_size: 'MEDIUM',
  },
  content: {
    action: '主角避雨',
    character_ids: ['char_lin'],
    emotion: '紧张',
    prop_ids: [],
    scene_id: 'scene_street',
    spoken_text: '雨越下越大了。',
  },
  contract_version: 1,
  continuity: {
    asset_version_ids: [],
    continuity_mode: 'NONE',
    first_frame_requirement: null,
    last_frame_requirement: null,
    previous_shot_id: null,
  },
  derived_from_shot_ids: [],
  dialogue: {
    audio_required: true,
    dialogue_mode_source: 'PROJECT_DEFAULT',
    dialogue_render_mode: 'NARRATION_FIRST',
    estimated_speech_duration_sec: 2,
    lip_sync_required: false,
    override_reason: null,
    speaker_id: 'narrator',
  },
  format_profile_id: formatProfile.id,
  generation_constraints: {
    budget_estimate: null,
    capability_requirements: [],
    image_prompt: '雨夜街道',
    negative_constraints: [],
    video_prompt: null,
  },
  locked_paths: [],
  narrative_purpose: '建立雨夜氛围',
  parent_version_id: null,
  provenance: {
    last_edit_source: 'AI',
    source_invocation_id: 'inv-0001',
    source_type: 'AI_GENERATED',
  },
  schema_version: '1.1.0',
  sequence,
  shot_id: shotId,
  status: 'READY',
  target_duration_sec: durationSec,
  version_id: `scv_${shotId}_v1`,
  ...overrides,
});

const envelopeOf = (
  shotDocuments: readonly Record<string, unknown>[],
): Readonly<Record<string, unknown>> =>
  assembleStoryboardExport({
    appVersion: '0.1.0-test',
    episodeId: EPISODE_ID,
    episodeVersionNo: 3,
    exportedAt: NOW,
    exportId: 'export_newid-1',
    formatProfile,
    projectId: PROJECT_ID,
    shotDocuments,
    storyBibleVersionId: 'bible-0001',
    targetDurationSec: 90,
  });

const sixShots = [15, 15, 15, 15, 15, 15].map((duration, index) =>
  shotDocument(`shot_000${String(index + 1)}`, index + 1, duration),
);

describe('renderStoryboardMarkdownTable 分镜表金样', () => {
  const table = renderStoryboardMarkdownTable(envelopeOf(sixShots));

  it('9 列表头与分隔行精确呈现，6 条数据行逐镜头一行', () => {
    expect(table).toContain(
      '| 镜头号 | 景别 | 运镜 | 时长(s) | 叙事目的 | 台词/旁白 | 角色 | 场景 | 锁定 |',
    );
    expect(table).toContain('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    expect(table.match(/^\| #/gmu)).toHaveLength(6);
    expect(table).toContain(
      '| #1 | MEDIUM | STATIC | 15 | 建立雨夜氛围 | 雨越下越大了。 | char_lin | scene_street | — |',
    );
  });

  it('表头上方版本事实：versionNo / Σ / export_id / exported_at', () => {
    expect(table).toContain('- 整集版本：v3');
    expect(table).toContain('- 镜头时长合计：90s（软带 60–120s）');
    expect(table).toContain('- 导出 ID：export_newid-1');
    expect(table).toContain(`- 导出时间：${NOW}`);
    expect(table).toContain(`# 分镜表：${PROJECT_ID}/${EPISODE_ID}`);
  });

  it('单元格转义：竖线转义、换行压空格；锁定列按 locked_paths 数量呈现', () => {
    const escaped = renderStoryboardMarkdownTable(
      envelopeOf([
        shotDocument('shot_0001', 1, 15, {
          content: {
            action: '主角避雨',
            character_ids: ['char_lin', 'char_ye'],
            emotion: '紧张',
            prop_ids: [],
            scene_id: 'scene_street',
            spoken_text: '带|竖线\n换行台词',
          },
          locked_paths: ['/dialogue', '/content'],
        }),
      ]),
    );
    expect(escaped).toContain('| 带\\|竖线 换行台词 |');
    expect(escaped).toContain('| char_lin,char_ye |');
    expect(escaped).toContain('| 2 |');
  });
});

describe('renderProducibilityReport 报告金样', () => {
  it('六章节齐备：规则版本 / 判定式 / 无 WARN / AI 参与度 / Σ 事实 / 镜头清单', () => {
    const report = renderProducibilityReport(envelopeOf(sixShots), null);
    expect(report).toContain(`# 可生产性报告：${PROJECT_ID}/${EPISODE_ID}`);
    expect(report).toContain('## 头部事实');
    expect(report).toContain('- 画幅：9:16 · 1080×1920 · 30fps · zh-CN');
    expect(report).toContain('- 可生产性规则版本：jingxu-producibility-rules/1');
    expect(report).toContain('- 镜头时长合计：90s（软带 60–120s）');
    expect(report).toContain('- 偏离确认：无（Σ 在软带内）');
    expect(report).toContain('## 集合校验结论');
    expect(report).toContain('READY_EXPORT 门禁复跑通过');
    expect(report).toContain('- contains_ai_assisted_content：true');
    expect(report).toContain('- AI 参与镜头：6/6');
    expect(report).toContain(
      `- 判定式：frontal_face=true 且 mouth_visible=true 且 estimated_speech_duration_sec > ${String(
        SPEECH_DURATION_WARN_SEC,
      )}（正脸长对白 WEAK_LIP_SYNC 风险，PRD 9.5）`,
    );
    expect(report).toContain(
      `- WARN：无命中（全部镜头对白时长 ≤ ${String(SPEECH_DURATION_WARN_SEC)}s）`,
    );
    expect(report).toContain('| 镜头号 | shot_id | 时长(s) | 对白时长(s) | 渲染模式 |');
    expect(report).toContain('| #1 | shot_0001 | 15 | 2 | NARRATION_FIRST |');
  });

  it('正脸长对白命中 WARN：镜头号 + shot_id + 时长逐行输出（非阻断）', () => {
    const report = renderProducibilityReport(
      envelopeOf([
        shotDocument('shot_0001', 1, 15, {
          cinematography: {
            camera_motion: 'STATIC',
            frontal_face: true,
            mouth_visible: true,
            shot_size: 'MEDIUM',
          },
          dialogue: {
            audio_required: true,
            dialogue_mode_source: 'PROJECT_DEFAULT',
            dialogue_render_mode: 'SUBTITLE_ONLY',
            estimated_speech_duration_sec: 5,
            lip_sync_required: false,
            override_reason: null,
            speaker_id: 'char_lin',
          },
        }),
        ...sixShots.slice(1),
      ]),
      null,
    );
    expect(report).toContain(
      `- WARN #1（shot_0001）：正脸长对白 5s > ${String(SPEECH_DURATION_WARN_SEC)}s（WEAK_LIP_SYNC 风险）`,
    );
    expect(report.match(/^- WARN #/gmu)).toHaveLength(1);
  });

  it('偏离导出：报告如实携带已确认原因', () => {
    const deviating = renderProducibilityReport(
      envelopeOf([shotDocument('shot_0001', 1, 10), shotDocument('shot_0002', 2, 10)]),
      '快闪节奏整集',
    );
    expect(deviating).toContain('- 镜头时长合计：20s（软带 60–120s）');
    expect(deviating).toContain('- 偏离确认：已确认偏离，原因：快闪节奏整集');
  });

  it('规则版本常量与阈值可追溯（PRD 9.5 配置化）', () => {
    expect(PRODUCIBILITY_RULES_VERSION).toBe('jingxu-producibility-rules/1');
    expect(SPEECH_DURATION_WARN_SEC).toBe(4);
  });
});
