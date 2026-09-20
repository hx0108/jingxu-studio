-- 0023_video_provider_preferences.sql
-- 视频当前 Provider 偏好单例（low-cost-video-provider-integration D2/D7 切片）：
-- 人工显式选择，固定 mode→Profile 映射，禁止自动路由；MOCK 为开发环境注入，
-- 不入库。缺省 Seedance 保持既有行为不变。

CREATE TABLE video_provider_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('SEEDANCE', 'WAN', 'AGNES')),
  provider_profile_id TEXT NOT NULL CHECK (length(provider_profile_id) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  CHECK (
    (mode = 'SEEDANCE' AND provider_profile_id = 'profile-video-primary')
    OR (mode = 'WAN' AND provider_profile_id = 'profile-video-wan-primary')
    OR (mode = 'AGNES' AND provider_profile_id = 'profile-video-agnes-primary')
  )
);

INSERT INTO video_provider_preferences (id, mode, provider_profile_id, updated_at)
VALUES (1, 'SEEDANCE', 'profile-video-primary', '2026-09-19T00:00:00.000Z');
