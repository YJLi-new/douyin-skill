# douyin-upload-skill 项目进展记录

更新时间：2026-03-01

## 1. 目标范围（当前约定）

- 在 OpenClaw/Codex skill 中实现抖音视频发布流程：
  - 本地视频路径输入（支持 Windows 路径转 WSL）
  - 视频配音转文字（ASR）
  - 生成/确认发布文案
  - 调用抖音 OpenAPI 发布
- 当前里程碑策略：先完成 OAuth + 小文件直传发布，分片上传放后续。

## 2. 当前进展（已完成）

### 2.1 Skill 与代码结构已落地

- 新增 skill 目录：
  - `skills/douyin-upload-skill/SKILL.md`
  - `skills/douyin-upload-skill/agents/openai.yaml`
  - `skills/douyin-upload-skill/scripts/douyin.js`
  - `skills/douyin-upload-skill/scripts/lib/*.js`
- 已通过 skill 校验（`quick_validate.py`）。

### 2.2 CLI 功能已实现

- `doctor`：依赖/环境检查
- `auth`：OAuth 链接生成 + 手动粘贴 code 换 token
- `prepare`：视频元数据读取 + ASR + transcript 输出
- `publish`：小文件上传 + 创建视频发布 + 权限不足时 fallback outbox
- `config`：配置读取/设置（如默认可见性、autoConfirm 等）

### 2.3 核心能力已实现

- 路径兼容：支持 `E:\xxx\video.mp4` 自动转换为 `/mnt/e/...`
- Token 安全：本地 AES-256-GCM 加密存储
- ASR：`ffmpeg` 抽音 + `whisper.cpp` 转写 + transcript 缓存
- 发布模式：官方发布 + 权限异常自动 fallback 导出素材

### 2.4 本机环境已配置完成

- `ffmpeg` / `ffprobe` / `cmake` / `jq` 已安装
- `nvidia-cuda-toolkit`（`nvcc`）已安装
  - `Cuda compilation tools, release 12.0, V12.0.140`
- `whisper.cpp` 已编译，`whisper-cli` 可用
- 模型已下载：
  - `~/.cache/whisper.cpp/ggml-small.bin`
- `doctor` 当前结果为 `ok: true`（依赖全绿）

### 2.5 运行验证结果

- `prepare` 在测试视频上可成功返回 metadata + transcript
- `auth` 当前会被环境变量缺失拦截（符合预期）
- `publish` 在未授权时返回 `TOKEN_NOT_FOUND`（符合预期）

## 3. 当前阻塞

缺少抖音开放平台凭据环境变量，无法继续真实联调：

- `DOUYIN_CLIENT_KEY`
- `DOUYIN_CLIENT_SECRET`
- `DOUYIN_REDIRECT_URI`

## 4. TODO（按优先级）

1. 配置抖音凭据并执行真实 OAuth 授权
2. 完成真实账号 `auth` 联调（获取并持久化 token）
3. 使用真实抖音账号跑通 `publish` 小文件直传链路
4. 验证并记录 fallback 路径（权限不足时 outbox 产物）
5. 在 skill 编排层补齐“自动生成 3 套标题/简介候选”并固化输出模板
6. 增加真实接口错误码映射与回放日志（便于排障）
7. 二期实现：大文件分片上传（init/upload/complete）

## 5. 未做事项（明确未完成）

- 尚未完成真实抖音 OAuth 成功授权（因缺少凭据）
- 尚未完成真实 API 发布成功验证（item_id 未拿到）
- 尚未完成分片上传实现
- 尚未沉淀自动化测试脚本（当前为手工 smoke test）
- 尚未将“3 套候选文案生成”做成固定程序化步骤（目前主要靠 skill 指令层）

## 6. 建议下一步执行顺序

1. 导出 3 个抖音环境变量
2. 运行 `node skills/douyin-upload-skill/scripts/douyin.js auth`
3. 用真实视频执行 `prepare`
4. 生成并确认文案后执行 `publish --auto-confirm true`
5. 记录返回的 `itemId/videoId` 与接口响应，补齐验收记录

