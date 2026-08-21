-- 0015_seedance_video_v2_snapshot.sql
--
-- 2026-08-21 官方核验：0012 锁定的 Seedance 1.0 Lite I2V 已进入停服替换范围。
-- 历史快照与 migration 不可改写，新增 v2 锁定 Seedance 1.5 Pro；当前产品仍仅使用
-- 首帧图生视频、5/10 秒档与无声输出，未借此扩大功能范围。

INSERT INTO provider_capability_snapshots
  (id, provider_profile_id, snapshot_version, valid_from, expires_at,
   capabilities_json, source_url, sha256)
VALUES
  ('volcark-seedance-video/v2', 'profile_video_primary', '2', '2026-08-21', '9999-12-31',
   '{"provider":"volcark-seedance","capability":"VIDEO_GENERATION","model_id":"doubao-seedance-1-5-pro-251215","model_id_alternates":[],"endpoint":{"method":"POST","path":"/api/v3/contents/generations/tasks","poll":{"method":"GET","path":"/api/v3/contents/generations/tasks/{id}"},"base_url_cn_beijing":"https://ark.cn-beijing.volces.com","auth":"Bearer ARK_API_KEY"},"semantics":{"mode":"ASYNCHRONOUS","stream":false,"notes":"首帧图生视频（i2v）：content 数组 text+image_url(data URI)；create task→poll status→download video_url mp4。模型基于 2026-08-21 官方核验锁定为 Seedance 1.5 Pro。"},"request":{"duration_range":[5,10],"resolution":{"tiers":["720p","1080p"],"tier_rule":"短边就近：min(width,height)>=1080 取 1080p 否则 720p","max_edge_px":1920,"ratio":"adaptive"},"first_frame":{"max_bytes":10485760,"formats":["jpeg","png","webp"],"encoding":"data URI（base64）"},"unsupported_params":["seed","guidance_scale"],"client_defaults":{"return_url":true,"watermark":true,"generate_audio":false}},"response":{"task_status_values":["queued","running","succeeded","failed","cancelled"],"video_format":"mp4（ftyp 魔数嗅探，不信任 Content-Type）","video_url_validity_hours":24,"usage_fields":["completion_tokens","generated_video_seconds"],"actual_duration":"usage.generated_video_seconds，未回报记 null 如实"},"rate_limit":{"note":"配额与实际模型可用性由真实探针记录"}}',
   'https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01',
   '2c40f0f6353a270fcb58e2651b68eb60df7ca8b12f76a08a721a24b7abc4a8e6');
