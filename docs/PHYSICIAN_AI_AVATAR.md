# 医师 AI 分身工作室（本地 MVP）

## 产品边界

本模块使用 MiniMax H3 V2 的 `reference_image + reference_audio` 多模态参考生成。它是生成式参考人物视频，不是固定数字人驱动：不承诺逐帧身份完全一致，也不承诺精确 Lip Sync。若后续需要固定形象、精确口型和音频驱动，应另接数字人驱动或 Lip Sync 模型。

## 任务状态

平台状态统一为：

- `queued`：本地任务已创建，等待后台 Worker。
- `processing`：语音合成、H3 提交、供应商生成或媒体归档中。
- `completed`：视频已归档，作品已幂等创建。
- `failed`：生成或归档失败，失败补偿记录只创建一次。
- `cancelled`：本平台停止后续处理；若供应商任务已提交，仍可能产生费用。

终态不可回退。回调和轮询同时到达时，均使用 `providerTaskId` 查询 MiniMax 真实状态，再执行同一套幂等状态归并。

## 稳定关联

- `generationJobId`：平台生成任务。
- `providerTaskId`：MiniMax H3 V2 任务编号。
- `workId`：完成后创建的平台作品。
- `fileId`：参考图片、参考音频等素材。
- `userId`：资源所有者。
- `avatarId / voiceId`：使用的形象与音色资产。

禁止通过标题或创建时间猜测关联关系。

## 本地素材流程

用户素材使用三步流程：

1. `POST /api/local/physician-avatar/assets/prepare`
2. `PUT /api/local/physician-avatar/assets/{fileId}/content`
3. `POST /api/local/physician-avatar/assets/{fileId}/complete`

服务端校验所有者、状态、MIME、大小和二进制签名。打包医师照片已预注册为完成素材。H3 V2 请求使用内联二进制数据，不会把本地相对地址交给 MiniMax。

## 后台处理

`server.mjs` 启动后台 Worker。浏览器关闭后，Worker 仍会继续：

1. 生成 2–15 秒参考语音。
2. 提交 `/v2/video_generation` 并保存 `providerTaskId`。
3. 只使用 `/v2/query/video_generation/{task_id}` 查询 H3 V2。
4. 成功后立即下载临时视频到 `.local-data/physician-avatar/media/`。
5. 优先保存供应商封面；没有封面时从归档视频生成首帧缩略图。
6. 媒体归档成功后幂等创建作品。

## 真实调用开关

真实调用必须同时满足：

1. `MINIMAX_API_KEY` 已配置为轮换后的新密钥。
2. `MINIMAX_REAL_CALL_ENABLED=true`。
3. 当前后端用户在 `MINIMAX_REAL_USER_IDS` 白名单中。
4. 未达到 `MINIMAX_DAILY_REAL_JOB_LIMIT`。

任一条件不满足即走本地模拟，不产生供应商费用。密钥只允许写入 `.env.local`，不得进入前端、日志或版本库。

本地服务启动时由 `server.mjs` 自动读取 `.env.local`，因此正常重启后无需再次手工注入。轮换密钥时，可先把新密钥放入当前终端的 `MINIMAX_API_KEY` 环境变量，再运行 `npm run config:minimax`；脚本会以 `0600` 权限原子更新本地配置且不会输出密钥。自动化测试会强制关闭真实调用，避免测试过程意外产生供应商费用。

中国区开放平台密钥应使用 `https://api.minimaxi.com`；国际区密钥使用 `https://api.minimax.io`。两类密钥不能跨区域端点鉴权。本项目面向国内客户，默认使用中国区端点。

## 生产化缺口

本地 JSON、进程内 Worker 和本地媒体目录只适合单机验证。正式上线需要迁移到 PostgreSQL、Redis/任务队列、独立 Worker、对象存储、正式身份会话、余额/模型权限预检、可观测性、失败重试与人工补偿流程。
