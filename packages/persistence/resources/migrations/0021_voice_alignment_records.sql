-- 0021_voice_alignment_records.sql
-- 对齐记录随时间线版本冻结（v2-voice-audio-timeline design D4；PRD §10.7.1）。
-- 每镜头一行：四要素（音频实际时长/镜头实际时长/对齐方式/是否分镜层回退）
-- + extendedMs（tpad 静帧延展，仅 FREEZE_EXTEND 为正）+ 人工覆盖与规则版本。
-- 口径：audio_duration_ms 为混音有效占用（trim_out-trim_in），非候选整段实测时长；
-- FAR_LONG 默认阻断导出（storyboard_fallback=1），FORCE_TRIM 覆盖落行后放行。

CREATE TABLE video_timeline_alignment_items (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  -- 分类与策略为版本化规则输出（rules_version 同源），DB 只做白名单约束。
  category TEXT NOT NULL CHECK (
    category IN ('ALIGNED', 'SLIGHTLY_LONG', 'FAR_LONG', 'SHORTER')
  ),
  strategy TEXT NOT NULL CHECK (
    strategy IN (
      'DIRECT_MIX',
      'FREEZE_EXTEND',
      'BLOCK_STORYBOARD_FALLBACK',
      'TAIL_SILENCE',
      'MANUAL_TRIM_AUDIO',
      'FORCE_TRIM_DIALOGUE_INCOMPLETE',
      'EARLY_CUT_NEXT'
    )
  ),
  manual_override TEXT CHECK (
    manual_override IS NULL OR manual_override IN ('TRIM_AUDIO', 'FORCE_TRIM', 'EARLY_CUT_NEXT')
  ),
  audio_duration_ms INTEGER NOT NULL CHECK (audio_duration_ms > 0),
  shot_duration_ms INTEGER NOT NULL CHECK (shot_duration_ms > 0),
  extended_ms INTEGER NOT NULL CHECK (extended_ms >= 0),
  dialogue_complete INTEGER NOT NULL CHECK (dialogue_complete IN (0, 1)),
  storyboard_fallback INTEGER NOT NULL CHECK (storyboard_fallback IN (0, 1)),
  rules_version TEXT NOT NULL CHECK (length(rules_version) > 0),
  PRIMARY KEY (timeline_version_id, shot_id)
);
