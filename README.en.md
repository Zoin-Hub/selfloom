# Self-Loom · selfloom

> **One command to gather your writing from every platform into a single file your AI can actually read.**

[中文](./README.md) · **English**

Self-Loom collects what *you* wrote across platforms — reading notes, journals, conversations — and weaves it into one **local, auditable, AI-readable** personal context.

- 🔒 **Local-first, never asks for your passwords** — it only accepts one-off credentials you copy yourself (an API key, an IMAP app password). Credentials stay on your machine.
- 🧾 **Reconciliation, not wishful thinking** — every adapter reports "claimed by the source vs. actually captured". Every discrepancy must be attributed line by line. **Silently empty results are treated as failure.**
- 📦 **Zero third-party dependencies** — Node built-ins only. Every line is auditable, and `npx` needs no install step.
- 🧵 **One file** — all platforms interleaved chronologically into a **timeline that is yours**.

---

## Quick start

**See the result first, decide about permissions later:**

```bash
npx selfloom demo     # no config, no network, no credentials — 30 seconds to see the output
```

The demo uses built-in fictional sample data. It **never reads or writes your real data**, and writes to `~/.selfloom/demo/`. Then pick a platform:

```bash
npx selfloom doctor            # what's configured, what's missing, what to do next
npx selfloom sync deepseek     # first platform: no credentials needed (export your data from DeepSeek's web app first)
```

## Connecting platforms

### WeRead (微信读书) — reading notes, thoughts, reviews

```bash
# 1) Open https://weread.qq.com/r/weread-skills, sign in, get your API key (starts with wrk-), copy it
# 2) Validate and store it (--clipboard reads your clipboard directly)
npx selfloom auth weread --clipboard
# 3) Sync (first run ~2–3 min; later runs compare per-book counts and only refetch what changed)
npx selfloom sync weread
```

### QQ Mail — turn "forwarded to myself" emails into a journal

```bash
# 1) In QQ Mail → Settings → Account, enable IMAP and generate a 16-character app password; copy it
# 2) Validate and store it
npx selfloom auth qqmail --user you@qq.com --clipboard
# 3) Survey the scale first, without downloading any bodies
npx selfloom sync qqmail --dry-run --force
# 4) Real sync (re-runnable; from the second run on it takes under a second)
npx selfloom sync qqmail
# 5) Build the outputs
npx selfloom export
```

## Outputs

Written to `~/.selfloom/out/` (override with `--out`):

| File | Layer | What it is |
|---|---|---|
| `timeline.md` | **Aggregate · the point** | Everything **you wrote**, interleaved chronologically — this is "you, readable by an AI" |
| `items.jsonl` | Machine | One record per line: filter, search, embed |
| `<platform>.md` | Platform | Keeps each platform's native shape (e.g. WeRead grouped by book/chapter) |
| `manifest.json` | Metadata | Counts, reconciliation results, sources, privacy notes |

## Supported platforms

| Platform | What you provide | Status |
|---|---|---|
| **WeRead (微信读书)** | API key from the official skill page (pure API, no browser) | ✅ Done |
| **DeepSeek** | `deepseek_data-*.zip` exported from the web app (auto-discovered in your Downloads) | ✅ Done |
| **QQ Mail** | IMAP app password (pure protocol, no browser) | ✅ Done |
| **Douban** | — | Planned |
| **Zhihu** | — | Planned |

> All three supported platforms need **no browser automation** — which is why they are
> cross-platform, can run unattended, and stay small.

## Commands

```
selfloom demo               Zero-config preview (sample data, offline, no credentials)
selfloom auth <platform>    Configure and validate credentials (once)
selfloom sync <platform>    Fetch (re-runnable; incremental)
selfloom doctor             Health check: credentials / data volume / next step
selfloom export             Build the unified outputs
selfloom list               Platforms already synced
```

`sync` options:

| Option | Description |
|---|---|
| `--file <path>` | DeepSeek: the export zip or `conversations.json` |
| `--dir <path>` | Extra directory to scan |
| `--include-think` | Include the model's reasoning traces (off by default) |
| `--allow-from <substr>` | QQ Mail: sender allowlist, comma-separated (e.g. `dingtalk.com`) |
| `--self <email>` | QQ Mail: additional addresses treated as "me" |
| `--all` | QQ Mail: no filtering, export every email |
| `--since <date>` | QQ Mail: only messages after this date |
| `--dry-run` | QQ Mail: count only, download nothing |
| `--match-to` | QQ Mail: also match on recipients (default: sender only) |
| `--accept-broad` | QQ Mail: don't stop when the match ratio looks suspiciously high |
| `--no-attachments` / `--max-attachment-mb <n>` / `--archive-attachments` | Attachment policy |
| `--force` | Ignore the cache and refetch everything |
| `--debug` | Protocol / parse diagnostics |

## Design principles

**1. No passwords, ever.**
Credentials *acquisition* cannot be safely automated (WeChat only supports QR login; QQ Mail app passwords require SMS verification). So Self-Loom does the three things that actually save time: **validate on import, speak plainly on failure, and remember for you.**

**2. Reconciliation over optimism.**
The most dangerous failure is not an error — it's **a program that doesn't crash and returns nothing**. Every adapter must answer: how much did the source claim, how much did we actually get, and where did the difference go?

**3. Data never leaves your machine.**
No third-party services, no telemetry.

## Privacy

- The output is your **complete personal writing history** — highly sensitive. Keep it on your own devices.
- The DeepSeek export bundles a `user.json` containing your email and phone number. Self-Loom **reads only `user_id` and discards the rest**.
- Credentials live in `~/.selfloom/credentials.json` (OS keystore integration is planned).

## License

MIT
