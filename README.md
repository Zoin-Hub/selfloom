# Self-Loom · selfloom

> **一行命令，把你散在各平台的创作，收成一个 AI 能读的文件。**

**中文** · [English](./README.en.md)

Self-Loom 把你自己在各平台写下的东西（读书笔记、思考日志、对话记录…）收集起来，
织成一份**本地、可审计、AI 能直接读**的个人上下文。

- 🔒 **本地运行，不碰你的密码** —— 只接受你主动复制的凭证（API Key / 授权码），凭证只存在你本机
- 🧾 **有对账，不糊弄** —— 每个平台都输出「来源声称的量 vs 实际抓到的量」，差额必须逐项归因，**绝不静默丢数据**
- 📦 **零第三方依赖** —— 只用 Node 内置模块，全部代码可审查，`npx` 真正零安装
- 🧵 **一份文件** —— 所有平台按时间混排成一条**属于你的思考时间线**

---

## 快速开始

**先看结果，再决定要不要授权**：

```bash
npx selfloom demo     # 零配置 · 不联网 · 不需要任何凭证，30 秒看到产物长什么样
```

demo 用的是内置的虚构样例数据，**不读取、不改动你的任何真实数据**，产物落在 `~/.selfloom/demo/`。
看完再决定接哪个平台：

```bash
npx selfloom doctor            # 看看当前状态和下一步
npx selfloom sync deepseek     # 第一个平台：不需要凭证（先在 DeepSeek 网页版导出对话数据）
```

接入微信读书（读书笔记、想法、书评）：

```bash
# 1) 打开 https://weread.qq.com/r/weread-skills 登录后获取 API Key（wrk- 开头）；复制它
# 2) 校验并保存（--clipboard 直接读剪贴板）
npx selfloom auth weread --clipboard
# 3) 抓取（首次约 2–3 分钟；之后逐本比较计数，只重抓变了的书）
npx selfloom sync weread
```

接入 QQ 邮箱（把「转发给自己」的邮件变成思考日志）：

```bash
# 1) 在 QQ 邮箱 → 设置 → 账户，开启 IMAP 并生成 16 位授权码；复制它
# 2) 校验并保存凭证（--clipboard 直接读剪贴板，不用手动粘贴）
npx selfloom auth qqmail --user you@qq.com --clipboard
# 3) 先勘探规模，不下载正文
npx selfloom sync qqmail --dry-run --force
# 4) 正式抓取（可反复运行，第二次起是秒级增量）
npx selfloom sync qqmail
# 5) 生成产物
npx selfloom export
```

## 产物

生成在 `~/.selfloom/out/`（可用 `--out` 指定目录）：

| 文件 | 层次 | 说明 |
|---|---|---|
| `timeline.md` | **汇总层 · 核心** | 所有平台里**你自己写的内容**按时间混排 —— 这就是「AI 能读的你」 |
| `items.jsonl` | 机器层 | 一行一条记录，便于筛选、检索、向量化 |
| `<platform>.md` | 平台层 | 保留各平台原生语义（如微信读书按书/章） |
| `manifest.json` | 元数据 | 计数、对账结果、来源、隐私说明 |

## 已支持的平台

| 平台 | 需要你提供 | 状态 |
|---|---|---|
| **微信读书** | 官方 skill 页面获取的 API Key（纯接口，不需要浏览器） | ✅ 已实现 |
| **DeepSeek** | 网页版导出的 `deepseek_data-*.zip`（自动扫描下载目录） | ✅ 已实现 |
| **QQ 邮箱** | IMAP 授权码（收取你转发给自己的记录；纯协议，不需要浏览器） | ✅ 已实现 |

> 计划中：豆瓣、知乎。这两个平台需要浏览器自动化，稳定性和隐私成本都更高，
> 会在核心三平台稳定后再评估。

## 命令

```
selfloom demo               零配置看效果（样例数据，不联网、不需要凭证）
selfloom auth <platform>    配置并校验凭证（一次性）
selfloom sync <platform>    抓取（可反复运行做增量）
selfloom doctor             体检：凭证 / 数据规模 / 下一步
selfloom export             生成统一产物
selfloom list               已同步的平台与规模
```

`sync` 选项：

| 选项 | 说明 |
|---|---|
| `--file <路径>` | 指定数据文件（DeepSeek：导出 zip 或 `conversations.json`） |
| `--dir <目录>` | 指定扫描目录（默认扫描 `~/Downloads` 和 `~/Desktop`） |
| `--include-think` | 包含模型的思考过程（默认**不导出**，否则产物体积会明显变大） |

## 设计原则

**1. 不索取密码。**
凭证的*获取*无法安全自动化（微信只支持扫码、QQ 邮箱授权码需要短信验证）。
所以 Self-Loom 只做三件对用户真正省时间的事：**导入即校验、失败时说人话、并替你记住凭证。**

**2. 对账高于一切。**
最容易骗人的失败不是报错，而是**程序不报错、结果却是空的**。
因此每个适配器都必须回答：来源声称多少、实际抓到多少、差额去哪了。

**3. 数据永不出本机。**
不发往任何第三方服务，不做遥测。

## 隐私

- 产物属于你的**完整个人创作史**，是高度敏感数据。请只放在自己的设备上。
- DeepSeek 导出包里的 `user.json` 含邮箱与手机号 —— Self-Loom **只读取 user_id，其余一律丢弃**。
- 凭证保存在 `~/.selfloom/credentials.json`（系统级密钥库加密支持在计划中）。

## License

MIT
