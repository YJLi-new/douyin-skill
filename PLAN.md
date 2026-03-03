下面给你一份“能真正落地”的 **OpenClaw skill 规划**，目标是：**用户选本地视频 → 自动做语音转文字 → 生成标题/简介（抖音文案）→ 用户确认 → 调用抖音开放平台接口发布**。我会把方案按“官方合规优先”的路线来设计，避免走网页自动化脚本（抖音登录/验证码/风控会非常不稳定，而且容易触发合规/权限回收）。

---

## 0. 先把可行性讲清楚（避免做到一半发现发不出去）

你想要的“自动发布到抖音（中国大陆版）”，**官方可行路线**是抖音开放平台的 **OAuth 授权** + **视频上传/创建视频** OpenAPI：

* 获取授权码（code）：浏览器访问 `https://open.douyin.com/platform/oauth/connect/`，用户扫码/登录授权，回跳 `redirect_uri` 带回 `code`。([抖音开放平台][1])
* 用 `code` 换 `access_token`：POST `https://open.douyin.com/oauth/access_token/`。 ([抖音开放平台][2])
* 上传视频拿到加密 `video_id`：POST `https://open.douyin.com/api/douyin/v1/video/upload_video/`（大文件走分片）。 ([抖音开放平台][3])
* 创建视频发布：POST `https://open.douyin.com/api/douyin/v1/video/create_video/`，正文用 `text` 字段（可含话题/#、@）。([抖音开放平台][4])

但这里有两个现实约束必须纳入你的计划：

1. **“代替用户发布内容到抖音”属于能力实验室/准入受限**
   文档里明确要求在控制台的“能力实验室”申请，并且在一些解决方案里写了准入条件（企业/党政/事业单位、正式网站应用、特定场景等）。([抖音开放平台][4])

2. 过去确实出现过“代投稿能力（video.create.bind）将被禁用”的通知
   开发者社区里有帖提到邮件通知：预计 2024-07-20 起全面禁用 video.create.bind。([抖音开放平台][5])
   同时，旧站点文档也强调：**代用户创建视频，每次调用都要让用户明确感知，否则可能回收权限并处罚。**([抖音开放平台][6])

所以你的 skill 规划里要有 **两条发布路径**：

* **A 路径（理想）：拿到 video.create.bind 权限 → 真正“服务端发布”**
* **B 路径（兜底）：走“抖音分享与发布” → 用户在抖音发布页点确认**（不等于静默自动发布，但更容易拿到权限/更合规）([抖音开放平台][7])

---

## 1. 总体架构（OpenClaw skill + 本地发布器 CLI + 可选 OAuth 回调服务）

建议拆成三层，后期维护会轻松很多：

### 1.1 OpenClaw Skill（对话/编排层）

负责：

* 收集参数（文件路径、发布可见范围、风格偏好）
* 调用本地 CLI 做转写/生成文案/上传发布
* 把关键结果（生成文案、发布 item_id）回显给用户并记录

OpenClaw 的 skill 本质是一个目录，包含 `SKILL.md`（YAML frontmatter + 指令），并且会从 `<workspace>/skills`、`~/.openclaw/skills` 等位置加载。([OpenClaw][8])

### 1.2 本地发布器 CLI（能力实现层）

负责真正执行：

* 语音转文字（从视频提取音频 → ASR）
* 文案生成（标题/简介/话题）
* OAuth 引导/Token 管理
* 调用抖音 OpenAPI 上传/创建

### 1.3 可选：OAuth 回调服务（体验增强）

因为 `redirect_uri` 要求 **必须是 https** 且需匹配你在开放平台配置的重定向地址，并且不支持自定义 query 参数。([抖音开放平台][1])
因此“纯本地 localhost 回调”往往不可用（除非你有域名 + https + 反代到本地，或用固定公网 https 服务）。

你可以两种方式选其一：

* **简化版（推荐先做）：手动复制 code**
  Skill 打开授权 URL → 用户授权后浏览器跳到你的 `redirect_uri?code=...` → 用户复制 code 粘贴回 OpenClaw。
* **体验版：自建一个轻量 HTTPS 回调服务**
  回调服务收到 code 后直接换 token 并存储，然后 OpenClaw 通过一次性 pairing key 去取 token。

---

## 2. 你要实现的用户交互流程（保证“用户明确感知”）

### 2.1 `/douyin_auth` 授权登录

1. Skill 生成授权 URL（connect）并打开浏览器
2. 用户扫码/登录授权，获得 `code`（回跳 URL）([抖音开放平台][1])
3. CLI 用 `code` 调用 `oauth/access_token` 换取 `access_token / refresh_token / open_id`([抖音开放平台][2])
4. 安全存储 token（建议本地加密 / 系统钥匙串；至少不要明文写日志）

> token 维护：
>
> * `access_token` 过期 15 天，可用 `refresh_token` 刷新；([抖音开放平台][9])
> * `refresh_token` 过期 30 天；还可以调用 `renew_refresh_token` 延长，但旧 refresh_token 会失效，且最多只能刷新 5 次，之后需要重新授权。([抖音开放平台][10])

### 2.2 `/douyin_publish <video_path>` 发布

1. 用户提供本地视频路径（或拖拽给 OpenClaw，最终还是落到一个文件路径）
2. CLI 读取视频元数据：时长、大小、分辨率（用于判断上传方式与提示）
3. 音频转写（ASR）得到 transcript
4. 文案生成：输出“标题 + 简介 + 话题建议”
5. **必须给用户预览并让用户确认/可编辑**

   * 这不仅是产品体验，也是对“每次代发需要用户明确感知”的风险控制点。([抖音开放平台][6])
6. 用户确认后才开始上传/发布
7. 发布成功回传 `item_id` 等信息（create_video 响应里会有 item_id / video_id）。([抖音开放平台][4])

---

## 3. 抖音 OpenAPI 对接细节（你要实现哪些接口与逻辑）

下面这些 URL 我放在代码块里，方便你后面直接抄到实现里（同时不影响阅读）：

```text
OAuth 获取授权码（前端页面）:
GET https://open.douyin.com/platform/oauth/connect/

OAuth 换 token:
POST https://open.douyin.com/oauth/access_token/
POST https://open.douyin.com/oauth/refresh_token/
POST https://open.douyin.com/oauth/renew_refresh_token/

上传视频（小文件）:
POST https://open.douyin.com/api/douyin/v1/video/upload_video/

分片上传（大文件）:
POST https://open.douyin.com/api/douyin/v1/video/init_video_part_upload/
POST https://open.douyin.com/api/douyin/v1/video/upload_video_part/
POST https://open.douyin.com/api/douyin/v1/video/complete_video_part_upload/

创建/发布视频:
POST https://open.douyin.com/api/douyin/v1/video/create_video/
```

### 3.1 OAuth connect（拿 code）

* 文档明确这是“浏览器直接访问的前端页面”，打开后出现二维码，用户扫码授权。([抖音开放平台][1])
* 关键参数：

  * `client_key`
  * `response_type=code`
  * `scope`（你需要申请对应 scope；发视频相关会涉及发布能力）
  * `redirect_uri`：必须 https，必须匹配控制台配置，且不支持自定义 query 参数。([抖音开放平台][1])

### 3.2 access_token / refresh

* `access_token` 接口要求 `application/x-www-form-urlencoded`，不是 JSON。([抖音开放平台][2])
* access/refresh 的有效期与刷新规则见上面第 2.1。([抖音开放平台][9])

### 3.3 上传视频：小文件直传 vs 大文件分片

* 直传 `upload_video`：上传视频文件 → 返回加密 `video_id`。([抖音开放平台][3])

* 文档建议：

  * > 50MB 建议分片（降低超时失败）
  * > 300MB 必须分片
  * 总大小 4GB 以内
  * 分片建议 20MB，最小 5MB ([抖音开放平台][3])

* 分片上传你需要实现三步：

  1. init 获取 `upload_id`([抖音开放平台][11])
  2. upload part（带 `part_number`、`upload_id`），并控制单片大小：错误码提示分片不能小于 5MB、不能大于 100MB。([抖音开放平台][12])
  3. complete，获得最终 `video_id`([抖音开放平台][13])

* 时长限制：错误码里明确“视频时长不能超过 15 分钟”。([抖音开放平台][3])

> 额外风险提示：分片上传文档还提示“带品牌 logo/水印的视频可能命中审核逻辑，存在推荐降权风险”。你不一定要做处理，但至少要在日志/提示里把这个风险告知用户。([抖音开放平台][12])

### 3.4 创建视频（发布）

`create_video` 的关键点：

* `text`：视频标题/文案，可带 `#话题`、`@nickname`，总字数不超过 1000。([抖音开放平台][4])
* `private_status`：可见范围（0 全部人可见 / 1 自见 / 2 好友可见）。([抖音开放平台][4])
* 发布数量限制：错误码说明“一个用户在一个应用下，一天最多发布 75 个作品”。([抖音开放平台][4])
* 需要申请权限：路径写在文档里（控制台 > 能力管理 > 能力实验室 > 代替用户发布内容到抖音）。([抖音开放平台][4])

---

## 4. 语音转文字（ASR）与文案生成设计

### 4.1 ASR：只做“配音转文字”就足够可用

流水线：

1. `ffmpeg` 从视频抽取音轨（wav/16k）
2. ASR 模型转写（中文）
3. 得到：

   * 完整转写文本
   * 时间戳段落（可选，用于更强的摘要/提炼）

工程上建议做两点：

* 对长视频做分段（按静音/固定时长切片），避免单次转写超长
* 结果缓存：同一个文件（hash）只转写一次

> 模型选择你可以先用离线 Whisper 系列（快且稳定），后面再替换为云 ASR（更快/更准/成本可控）。

### 4.2 文案生成：把“标题”和“简介”变成一个可发布的 `text`

抖音的发布接口核心是一个 `text` 字段([抖音开放平台][4])，你可以把它组织成：

* 第 1 行：标题（强钩子）
* 第 2–3 行：简介（摘要 + 价值点/步骤）
* 最后：#话题1 #话题2（2–5 个就够）

建议你在 skill 里提供 2 个“可控开关”：

* 文案风格：严肃科普 / 情绪共鸣 / 搞笑反转 / 干货清单
* 强度：保守（少夸张）/ 标准 / 强营销（带 CTA）

并做硬性校验：

* 字数 ≤ 1000（接口限制）([抖音开放平台][4])
* 敏感词/强导流风险提示（至少本地做简单规则，真正的审核还是平台）

---

## 5. OpenClaw Skill 的目录结构与配置（怎么“做成 skill”）

### 5.1 Skill 结构（最小可用）

OpenClaw 的 skill 是一个目录，核心文件是 `SKILL.md`（带 YAML frontmatter）。([OpenClaw][8])

建议结构：

```text
skills/
  douyin-publisher/
    SKILL.md
    README.md
    bin/
      douyin_auth
      douyin_publish
    src/
      douyin_api.py
      token_store.py
      transcribe.py
      caption_gen.py
```

### 5.2 SKILL.md 里要写什么

OpenClaw 文档给的要点：

* `SKILL.md` frontmatter 至少要有 `name` / `description`([OpenClaw][8])
* 你可以用 `metadata.openclaw.requires` 做加载门槛（比如必须有 `ffmpeg`、必须有环境变量），并能声明安装方式。([OpenClaw][8])
* 你可以用 `user-invocable` 暴露成用户 slash command。([OpenClaw][8])

你可以把 skill 做成三个命令（体验最好）：

* `/douyin_auth`：授权/刷新 token
* `/douyin_publish <path>`：发布
* `/douyin_config`：设置默认风格、默认可见范围

### 5.3 Secret / Token 放哪里

OpenClaw 支持在 `~/.openclaw/openclaw.json` 里给 skill 注入 env/apiKey，并且每次 agent run 会临时注入到进程环境，结束后恢复。([OpenClaw][8])
同时文档也提醒：**第三方 skill 要当成不可信代码、避免把 secrets 写进 prompt 或日志。**([OpenClaw][8])

在你的实现里我建议：

* `client_secret`：放 OpenClaw env 注入或系统 keychain（不要写进仓库）
* `refresh_token/access_token`：本地加密存储（至少 chmod 600 + 简单加密；更好是系统钥匙串）
* 日志里永远不打印 token（只打印 token 的前 6 位 + hash）

---

## 6. 里程碑拆解（按“能跑起来”逐步加功能）

### Milestone 1：骨架跑通

* 创建 `douyin-publisher` skill 目录 + `SKILL.md`
* 实现 CLI 框架（auth/publish 两个入口）
* 打通 OAuth：connect URL → 手动粘贴 code → access_token 落盘 ([抖音开放平台][1])

### Milestone 2：发布链路跑通（先不做 ASR/文案）

* 固定文案 “test”
* 上传（小文件直传）→ create_video → 拿到 item_id ([抖音开放平台][3])
* 处理常见失败：token 过期、超时、15 分钟限制、日发布上限 ([抖音开放平台][9])

### Milestone 3：加入 ASR

* ffmpeg 抽音轨 + Whisper 转写
* 缓存 transcript（按文件 hash）
* 失败降级：ASR 失败 → 仍可发布（让用户手写文案）

### Milestone 4：加入“标题/简介生成 + 用户确认”

* 用 transcript 生成 3 套候选文案
* 用户选择/编辑 → 确认发布（满足“用户明确感知”设计）([抖音开放平台][6])

### Milestone 5：大文件分片上传

* init → 分片上传 → complete
* 分片大小控制（>=5MB 且 <=100MB，建议 20MB）([抖音开放平台][3])

---

## 7. 兜底方案（拿不到 video.create.bind 权限时怎么办）

如果你没法申请到“代替用户发布内容到抖音”，那你大概率只能走 **“抖音分享与发布”**：你的应用把内容“分享到抖音发布页”，由用户在抖音端完成最终发布确认。([抖音开放平台][7])

它的缺点是：**做不到完全静默自动发**；
但优点是：通常更容易合规接入、权限门槛更低（文档里写“已开放/免审”的场景）。([抖音开放平台][7])

你可以把 skill 做成“双模式”：

* 有 `video.create.bind`：走服务端发布
* 没权限：退化为“生成文案 + 打开分享入口/导出发布素材”，让用户最后点发布

---

## 8. 你现在可以直接开始的“落地清单”

按优先级从高到低：

1. 抖音开放平台：创建“移动/网站应用”，把 `redirect_uri`（https 域名）配置好 ([抖音开放平台][1])
2. 申请你需要的 scopes / 能力（尤其是发布相关能力）([抖音开放平台][4])
3. 先做 `douyin_auth`（手动粘贴 code 最快）([抖音开放平台][1])
4. 再做最小发布（固定文案 + 小文件直传）([抖音开放平台][3])
5. 最后加 ASR + 文案生成 + 分片上传

---

[1]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/douyin-get-permission-code "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/douyin-get-permission-code"
[2]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token"
[3]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video"
[4]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create"
[5]: https://developer.open-douyin.com/forum/question/post/6674d24ca8928af3de905411 "https://developer.open-douyin.com/forum/question/post/6674d24ca8928af3de905411"
[6]: https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/create/create-video "https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/create/create-video"
[7]: https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/solutions/Life-Service-Solutions/marketing "https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/solutions/Life-Service-Solutions/marketing"
[8]: https://docs.openclaw.ai/tools/skills "https://docs.openclaw.ai/tools/skills"
[9]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/refresh-access-token "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/refresh-access-token"
[10]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/refresh-token "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/refresh-token"
[11]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload-init "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload-init"
[12]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload"
[13]: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload-complete "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload-complete"
