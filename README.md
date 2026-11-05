# 快手去水印解析下载站

粘贴快手分享链接，一键解析并下载无水印视频。移动端优先设计，点「下载视频」会弹出下载提示框，下载完成后一键保存到相册/本地。

## 结构
- `index.html` — 前端单页（与抖音解析站同一套界面，强调色是快手橙）
- `jiexi.css` — 界面样式
- `fonts/` — 标题衬线子集，和数字用的等宽字体
- `_worker.js` — Cloudflare Pages Worker：解析、下载代理、反馈、频控

## 解析通道
1. RedFoxHub `/story/api/parseWork/videoDownload/kuaishou`（需环境变量 `REDFOX_API_KEY`，与其他解析站共用同一个 key）
2. 兜底：快手分享页 HTML 提取（srcNoMark / mainMvUrls），无需 key

## Cloudflare Pages 部署要点
- 框架预设选 None / 静态，构建命令留空，输出目录为根目录
- 环境变量：`REDFOX_API_KEY`（建议配）；可选 `TURNSTILE_SECRET_KEY`
- 可选绑定：KV 命名空间绑为 `FEEDBACK_KV`（与其他站共用同一个 KV 即可，启用反馈+每设备 60 秒冷却+每日 20 次额度）
