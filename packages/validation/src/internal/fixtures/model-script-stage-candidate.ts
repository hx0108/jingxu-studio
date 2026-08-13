export const VALID_MODEL_SCRIPT_STAGE_CANDIDATE_FIXTURES = Object.freeze({
  BEAT_SHEET: { data: { beats: [] } },
  CONCEPT: {
    data: {
      core_conflict: '冲突',
      genre: '悬疑',
      synopsis: '梗概',
      target_audience: '成年观众',
      theme: '选择',
      title: '候选概念',
    },
  },
  EPISODE_OUTLINE: {
    data: {
      climax: '高潮',
      ending_hook: '钩子',
      episode_goal: '候选目标',
      midpoint: '中点',
      opening: '开场',
      target_duration_sec: 90,
    },
  },
  SCENE_SCRIPT: { data: { scenes: [] } },
  STORY_BIBLE: { data: { characters: [], props: [], scenes: [], world_rules: [] } },
});

export const INVALID_MODEL_SCRIPT_STAGE_CANDIDATE_FIXTURES = Object.freeze({
  BEAT_SHEET: { data: [], reason: 'data 必须为对象' },
  CONCEPT: { data: { genre: '悬疑' } },
  EPISODE_OUTLINE: { data: { episode_goal: '目标' } },
  SCENE_SCRIPT: { data: {}, status: 'READY' },
  STORY_BIBLE: { data: { characters: [] }, source_invocation_id: 'forged' },
});
