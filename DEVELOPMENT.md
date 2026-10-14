# 开发与发布环境搭建 SOP

> **目标**：换电脑、换人、换系统，都能按这份文档复现「开发 → 发布 → 上线」的完整流水线。
> **原则**：能力放在服务端（GitHub / npm），不放在某台电脑上；数据与凭证永远只在本机。

---

## 一、这套流水线依赖什么（全景）

| 环节 | 依赖 | 谁提供 | 何时需要 |
|---|---|---|---|
| 运行代码 | **Node.js ≥ 18** | 本机安装 | 必须 |
| 改代码 | 任意编辑器 | 本机 | 必须 |
| 推送代码 | **git** + GitHub 账号 | 本机 + GitHub | 必须 |
| 数据抓取 | 各平台凭证（微信读书 API Key / QQ 邮箱授权码） | 本机 `~/.selfloom/` | 必须 |
| 发布到 npm | npm 账号 + 2FA + **Trusted Publisher** | npm 网站 | 发新版时 |
| 自动发布 | GitHub Actions（OCI D） | GitHub | 配一次，永久生效 |
| 落地页 | GitHub Pages（`main` 分支 + `/docs`） | GitHub | 配一次，永久生效 |
| 自定义域名 | DNS 里加 CNAME → `<用户名>.github.io` | 域名服务商 | 配一次，永久生效 |

### 关键设计：为什么"发布能力"不在你的电脑上

```
你的电脑  ──git push──►  GitHub 仓库
                              │
                        发 Release（点一下）
                              │
                              ▼
                     GitHub Actions（在 GitHub 的机器上跑）
                              │  OIDC 一次性身份
                              ▼
                          npm 注册表
```

**好处**：你的电脑不需要任何 npm 凭证，也就没有令牌可泄露；换电脑、重装系统，发布能力都不受影响。

---

## 二、场景 A：你自己换一台全新电脑

### 第 1 步：装三样东西
1. **Node.js**（LTS 版即可）
2. **Git for Windows**
3. 代理工具（**只在访问 GitHub / npm 时需要**；抓微信读书、QQ 邮箱都是国内域名，不需要）

### 第 2 步：取代码并立刻验证

```powershell
git clone https://github.com/Zoin-Hub/selfloom.git
cd selfloom
node bin/selfloom.mjs demo
```

**看到产物就是环境 OK 了** —— 这一步不需要任何凭证、不需要联网。

### 第 3 步：配置 git 身份

```powershell
git config user.name "Zoin-Hub"
git config user.email "311811064+Zoin-Hub@users.noreply.github.com"
```

（用 GitHub 的 noreply 邮箱，避免真实邮箱进入提交历史）

### 第 4 步：恢复推送能力
- 在 GitHub 生成一个 **fine-grained PAT**：
  - 仓库范围：只选 `Zoin-Hub/selfloom`
  - 权限：**Contents: Read and write** + **Workflows: Read and write**（少任何一个都会推送失败）
- 用它推送（或让 git 的凭据管理器记住）

### 第 5 步：恢复你的个人数据（重要）
你的数据在旧电脑的 `~/.selfloom/`（Windows：`C:\Users\<你>\.selfloom\`），**它不在 git 仓库里——这是刻意的，防止泄露**。

两种做法：
- **a. 整体拷贝**（推荐）：把旧电脑的 `~/.selfloom/` 复制过来，凭证和原始数据都在，直接可用
- **b. 重新接入**：在新电脑重新 `auth` + `sync`（凭证需要重新获取一遍）

### 第 6 步：发布能力 —— **不需要配**
因为发布走 GitHub Actions + Trusted Publishing。**新电脑完全不参与发布。**

### 验收清单
- [ ] `node bin/selfloom.mjs demo` 能出产物
- [ ] `git push` 能成功
- [ ] `~/.selfloom/out/` 里有你的真实数据
- [ ] 在 GitHub 发一个 Release，npm 上出现新版本

---

## 三、场景 B：一个全新的人（刚装好 DSH，什么都没有）

### 先说清楚：他能复现什么、不能复现什么

| 能复现 | 不能复现（需要身份或授权） |
|---|---|
| 拿到并运行这个项目 | 推送到 `Zoin-Hub/selfloom`（需要仓库权限） |
| 跑 `demo`、接入他自己的三个平台 | 发布 `selfloom` 这个包（那是你的账号） |
| 部署他自己的落地页 | 绑定 `selfloom.zoin-tech.com`（那是你的域名） |
| 看到他自己的时间线 | 看到你的数据 |

### 步骤

1. **装 Node.js + Git**
2. **零成本体验**（不需要 clone）：
   ```powershell
   npx selfloom demo
   ```
3. **接入他自己的平台**：
   ```powershell
   npx selfloom auth weread --clipboard
   npx selfloom sync weread
   npx selfloom export
   ```
4. **部署他自己的落地页**：Fork 仓库 → Settings → Pages → `main` + `/docs`
5. **发布他自己的包**（如果要）：改 `package.json` 里的 `name` → 用他自己的 npm 账号 → 配他自己的 Trusted Publisher

### 他要改哪些地方才能变成"他的项目"
| 文件 | 改什么 |
|---|---|
| `package.json` | `name`、`version`、`author`、`homepage`、`repository`、`bugs` |
| `docs/index.html` | 仓库链接、页脚署名、`canonical` / `og:url` |
| `docs/CNAME` | 他自己的域名（或删掉这个文件） |
| `LICENSE` | 版权人 |

---

## 四、每次发新版：固定 4 步

```powershell
# 1) 改代码
# 2) 改版本号（package.json 里的 version，如 0.1.1 → 0.1.2）
# 3) 提交并推送
git add -A
git commit -m "feat: ..."
git push

# 4) 在 GitHub 上：Releases → Draft a new release → 新建 tag（如 v0.1.2）→ Publish release
#    → 流水线自动执行：发布前自检（npm pack → 解包 → 跑 demo）→ 发布到 npm
```

### 流水线里内置的那道"发布前自检"为什么重要
它会先把包打出来、解开、再跑一遍 `demo`，验证通过才发布。

**因为"本地能跑"和"别人 npx 一装就崩"是两件事**——`package.json` 的 `files` 字段少写一个目录（比如 `demo/`），本地一切正常，别人一装就崩，而且崩在最显眼的 `demo` 命令上。

---

## 五、出问题时先看哪里

| 症状 | 先看这里 |
|---|---|
| 流水线失败 | GitHub → **Actions** → 那次运行的日志 |
| npm 上有新版但 `npx` 拉不到 | 等 1–2 分钟（npm 有 CDN 缓存）；或 `npx selfloom@0.1.2` 指定版本 |
| 落地页没更新 | GitHub → **Actions** → `pages build and deployment` |
| 自定义域名打不开 | 仓库 Settings → Pages 看域名状态；DNS 里 CNAME 应为 `<用户名>.github.io` |
| 抓取失败 / 提示凭证无效 | `selfloom doctor`（它会告诉你哪个平台的凭证失效了） |
| 抓取结果比预期少 | 打开 `~/.selfloom/out/manifest.json`，看每个平台的**对账差额**是不是 0 |

---

## 六、安全红线（每次都要守）

1. **`~/.selfloom/` 永不入库**：里面有你的完整创作数据和凭证。`.gitignore` 已经排除，不要手动绕过。
2. **凭证只放本机**：API Key、IMAP 授权码、npm 令牌、GitHub PAT，都不进对话、不进仓库、不进日志。
3. **2FA 恢复码只存自己的密码管理器**：它等于账号的万能钥匙。
4. **推送前扫一遍**：`git status --short` 看清单，确认没有 `.npmrc`、`*.tgz`、`credentials.json`。
5. **PAT 用完就删**：需要时临时生成，任务结束立即撤销（或设很短的过期时间）。

---

## 七、这套体系的"最小可复现核心"（一句话）

> **代码在 git 里，数据在本机，凭证在本机，发布在云端。**
>
> 所以：换电脑只需要装 Node + Git + 拷 `~/.selfloom/`；换人只需要 fork 改四处配置；发布能力从来不在任何一台电脑上。
