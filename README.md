# douyin-upload-skill

这是一个面向 OpenClaw/Codex 的抖音上传 Skill。

核心能力：
- 本地视频路径输入（支持 Windows 路径自动转换到 WSL）
- 本地语音转文字（ffmpeg + whisper.cpp）
- 调用抖音 OpenAPI 进行授权与发布
- 发布权限受限时自动降级为 outbox 导出

## 仓库根目录约定

本仓库当前就是发布根目录（即 Skill 根目录）。

也就是说：
- `SKILL.md`、`agents/`、`scripts/` 都位于仓库根目录
- 不再使用 `skills/douyin-upload-skill/` 作为嵌套路径

## 目录结构

```text
.
├── README.md
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    ├── douyin.js
    └── lib/
        ├── cli-utils.js
        ├── config.js
        ├── constants.js
        ├── douyin-api.js
        ├── fs-utils.js
        ├── media.js
        ├── path-utils.js
        └── token-store.js
```

## 环境要求

- Node.js >= 20
- ffmpeg / ffprobe
- whisper-cli（来自 whisper.cpp）
- 模型文件：`~/.cache/whisper.cpp/ggml-small.bin`

## 必填环境变量

```bash
export DOUYIN_CLIENT_KEY="..."
export DOUYIN_CLIENT_SECRET="..."
export DOUYIN_REDIRECT_URI="https://your.domain/callback"
```

可选：
- `DOUYIN_SCOPE`
- `DOUYIN_TOKEN_ENC_KEY`
- `DOUYIN_WHISPER_BIN`
- `DOUYIN_WHISPER_MODEL_PATH`

## 常用命令

```bash
# 1) 环境自检
node scripts/douyin.js doctor

# 2) OAuth 授权（手动粘贴 code）
node scripts/douyin.js auth

# 3) 解析视频 + 提取字幕
node scripts/douyin.js prepare --video "E:\\videos\\demo.mp4"

# 4) 发布
node scripts/douyin.js publish \
  --video "E:\\videos\\demo.mp4" \
  --text "最终文案" \
  --private-status 0 \
  --auto-confirm false

# 5) 配置
node scripts/douyin.js config list
node scripts/douyin.js config set autoConfirm true
```

## 当前进度

已完成：
- Skill 结构与 CLI 实现
- doctor/auth/prepare/publish/config 基础流程
- 本地依赖与 ASR 路径验证

未完成：
- 真实抖音账号 OAuth 与真实发布联调（需要真实凭据）
- 分片上传（大文件）
- 更完整的自动化测试

## 注意事项

- `publish` 的 stdout 为 JSON，建议脚本解析 `ok`、`command`、`mode`。
- `mode=official` 表示官方发布成功。
- `mode=fallback` 表示触发降级，结果写入本地 outbox。
