# 镜序高保真原型本地视觉资源

- 来源：用户提供的“镜序原型页面.zip”与经用户确认的十页高保真原图。
- 用途：仅用于镜序 Studio 正式 Renderer 的背景、场景、候选与项目缩略图还原。
- 网络依赖：无。所有图片均以 WebP 随桌面应用打包，Renderer 不从外网加载图片。
- 数据边界：这些文件是界面视觉素材，不是视频 Provider 的真实生成结果；真实项目候选仍通过受限 `jingxu://media/*` 地址读取。

文件命名约定：

- `cinematic-train-background.webp`：全局列车创作空间背景。
- `home-*.webp`、`continue-drama.webp`：开始创作页入口与续作卡。
- `project-*.webp`：我的作品缩略图。
- `shot-*.webp`、`candidate-*.webp`：分镜、画面、视频与合成页场景示意。
- `character-ref-*.webp`、`scene-ref.webp`、`heroine-main.webp`：角色和场景参考图。
