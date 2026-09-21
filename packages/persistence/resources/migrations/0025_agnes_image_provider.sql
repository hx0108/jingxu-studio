-- 0025_agnes_image_provider.sql
-- 图片 Provider 切换 Agnes Image（2026-09-21）：播种 agnes-image/v1 能力快照
-- （agnes-image-2.5-flash 主档 + 2.1-flash 备选，canonical JSON + sha256 三处可核）。
-- 图片任务表无 provider_kind 约束列（与视频 0024 不同）：单适配器按请求
-- model_id 分发、候选行 model_id 自由文本承载溯源，故仅播种快照、不重建表。
-- 旧 volcark-seedream-image/v1 快照与 profile-image-primary 行保留为历史，
-- 不迁移（旧 Ark Key 对 Agnes 无效，用户在新档 profile-image-agnes-primary
-- 重填一次 Key 或经 JINGXU_IMAGE_CREDENTIAL_FILE 引导写入）。

INSERT INTO provider_capability_snapshots
  (id, provider_profile_id, snapshot_version, valid_from, expires_at,
   capabilities_json, source_url, sha256)
VALUES
  ('agnes-image/v1', 'profile-image-agnes-primary', '1', '2026-09-21', '9999-12-31',
   '{"provider":"agnes-ai","capability":"IMAGE_GENERATION","model_id":"agnes-image-2.5-flash","model_id_alternates":["agnes-image-2.1-flash"],"endpoint":{"method":"POST","path":"/v1/images/generations","base_url":"https://apihub.agnes-ai.com","auth":"Bearer AGNES_API_KEY"},"semantics":{"mode":"SYNCHRONOUS","stream":false,"notes":"文生图/图生图（参考图 extra_body.image，data URL 直接可用）。双模型请求形状一致，按请求 model 分发；response_format 必须嵌在 extra_body 内（顶层会被服务端拒绝）。官方文档+2026-09-21 受控探针冻结：响应 {created,task_id,data:[{url,b64_json,revised_prompt}]}，url 模式下 b64_json/revised_prompt 为空串。"},"request":{"resolution":{"tiers":["1K","2K","3K","4K"],"tier_rule":"按总像素分桶：≤1.1MP→1K，≤4.3MP→2K，≤9.6MP→3K，超出→4K（官方矩阵点全部正确落桶）"},"ratios":["1:1","3:4","4:3","16:9","9:16","2:3","3:2","21:9"],"ratio_rule":"W:H 约分精确匹配；无命中取对数空间最近邻","reference_images":{"encoding":"data URL（data:<mime>;base64,...）","formats":["jpeg","png","webp"],"note":"前 3 张免费（牌价口径），当前促销 $0"}},"response":{"image_format":"png/jpeg/webp（魔数嗅探，不信任 Content-Type）","download_domain_suffixes":["agnes-ai.cn","agnes-ai.space"],"client_timeout_ms_range":[60000,360000]},"pricing":{"promo":"全线 $0（2026-09-21 快照，limited time）","list":{"1K":0.010,"2K":0.018,"3K":0.021,"4K":0.024},"currency":"USD/图","input_ref_from_4th":0.003},"rate_limit":{"note":"免费档限流未文档化；429 归一 MODEL_RATE_LIMITED（可重试）交调度器退避"}}',
   'https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash',
   '1f57e5b6a571a116556246a0ceb8da64585113a7fc8580da17cda104e17fccd5');
