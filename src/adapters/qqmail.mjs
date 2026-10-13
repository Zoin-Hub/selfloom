/**
 * QQ 邮箱适配器（IMAP）
 *
 * 用途：把「转发给自己」的邮件变成可读的思考日志。典型场景是钉钉消息转发到邮箱，
 *      邮件正文就是一份带日期与时间的聊天记录 —— 天然是逐条的日记。
 *
 * 为什么这条路的成本低：
 *  - IMAP 是纯协议，不需要浏览器、不需要图形界面、不需要 Selenium
 *  - 用授权码做凭据，比 Cookie 稳定得多
 *  - 增量靠 UID + UIDVALIDITY，逻辑与微信读书的游标分页同源
 *
 * 对账口径：
 *  - 逐条归因：待处理 = 命中「发给自己」 + 非本人邮件；差额必须为 0
 *  - 硬防线：待处理 > 0 却一封都没解析成功 → 判为失败
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Imap } from '../core/imap.mjs';
import { parseMessage, decodeWords } from '../core/mime.mjs';
import { htmlToText, extractDingtalkJournal } from '../core/html.mjs';
import { getCred } from '../core/secret.mjs';
import { RAW_DIR, HOME, ensureHome, readJson, writeJson, readConfig, toMs, fmtDateTime, shortHash } from '../core/util.mjs';

export const platform = 'qqmail';
export const label = 'QQ 邮箱';

const INDEX_DIR = join(RAW_DIR, 'qqmail');
const INDEX_FILE = join(INDEX_DIR, 'index.json');
const ATTACH_DIR = join(HOME, 'attachments', 'qqmail');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toImapDate(ms) {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/* ---------------- 收取规则（哪些邮件要） ---------------- */

const DEFAULT_MAX_ATTACHMENT_MB = 20;
const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|001|cab|iso)$/i;

function splitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(splitList);
  return String(v)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 收取规则：
 *   1) 发件人 / 收件人 / 抄送 里出现自己的地址  → 一律要（含各种「发给自己」）
 *   2) 发件人命中白名单（如钉钉邮箱域）        → 一律要（哪怕收件人不是自己）
 *   3) --all                                   → 全都要
 * 规则来源：命令行参数 > 本机配置 ~/.selfloom/config.json 的 qqmail 段 > 默认值
 */
export function resolveRules(opts = {}) {
  const cfg = readConfig().qqmail ?? {};
  const stored = getCred(platform) ?? {};

  const selfAddresses = splitList(opts.self ?? cfg.self_addresses ?? stored.self_addresses);
  if (stored.user) selfAddresses.push(stored.user);
  if (opts.user) selfAddresses.push(opts.user);
  if (opts.selfExtra) selfAddresses.push(...splitList(opts.selfExtra));

  const allowSenders = splitList(opts.allowFrom ?? cfg.allow_senders);

  const maxMb = Number(opts.maxAttachmentMb ?? cfg.max_attachment_mb ?? DEFAULT_MAX_ATTACHMENT_MB);

  return {
    all: Boolean(opts.all),
    selfAddresses: [...new Set(selfAddresses.map((s) => s.toLowerCase()))],
    allowSenders: [...new Set(allowSenders.map((s) => s.toLowerCase()))],
    saveAttachments: opts.noAttachments ? false : true,
    saveArchives: Boolean(opts.archiveAttachments ?? cfg.save_archives),
    saveInline: Boolean(opts.inlineAttachments ?? cfg.save_inline),
    matchTo: Boolean(opts.matchTo ?? cfg.match_to),
    maxAttachmentBytes: Math.max(0, (Number.isFinite(maxMb) ? maxMb : DEFAULT_MAX_ATTACHMENT_MB)) * 1024 * 1024,
  };
}

/**
 * 判断一封邮件是否要 —— 默认**只看发件人**。
 *
 * 为什么不能看收件人：这是用户自己的收件箱，几乎所有邮件都是「发给他的」。
 * 一旦把收件人纳入判断，等于把整个收件箱全收进来
 * （实测：4257 封里命中 4245 封）。我们要的是「他写给自己的」，不是「别人发给他的」。
 *
 * 因此规则是：
 *   - 发件人是自己            → 要（写给自己 / 脚本发给自己 / 转发给自己）
 *   - 发件人命中白名单        → 要（如钉钉邮箱域）
 *   - --all                   → 全都要
 * 需要「按收件人收」的特殊场景，显式打开 matchTo（配置 qqmail.match_to 或 --match-to）。
 */
function matchReason(headers, rules) {
  if (rules.all) return { hit: true, reason: 'all' };
  const from = decodeWords(headers.from ?? '').toLowerCase();
  const selfHit = rules.selfAddresses.find((a) => a && from.includes(a));
  if (selfHit) return { hit: true, reason: `from-self:${selfHit}` };
  const allowHit = rules.allowSenders.find((s) => s && from.includes(s));
  if (allowHit) return { hit: true, reason: `from-allowed:${allowHit}` };

  if (rules.matchTo) {
    const to = decodeWords(headers.to ?? '').toLowerCase();
    const cc = decodeWords(headers.cc ?? '').toLowerCase();
    const hay = `${to} ${cc}`;
    const toHit = rules.selfAddresses.find((a) => a && hay.includes(a));
    if (toHit) return { hit: true, reason: `to-self:${toHit}` };
  }
  return { hit: false, reason: 'not-matched' };
}

/** 附件落盘策略：文档类要，压缩包不要，内嵌图片不要，超大不要 */
function attachmentPolicy(filename, bytes, rules, inline) {
  if (!rules.saveAttachments) return { save: false, reason: '按设置关闭' };
  if (inline && !rules.saveInline) return { save: false, reason: '内嵌资源（默认不落盘）' };
  if (ARCHIVE_RE.test(filename) && !rules.saveArchives) return { save: false, reason: '压缩包（默认不落盘）' };
  if (rules.maxAttachmentBytes > 0 && bytes > rules.maxAttachmentBytes) {
    return { save: false, reason: `超过 ${Math.round(rules.maxAttachmentBytes / 1048576)} MB` };
  }
  return { save: true, reason: 'saved' };
}

function resolveCred(opts) {
  const stored = getCred(platform) ?? {};
  const user = opts.user || stored.user;
  const pass = opts.pass || stored.pass;
  if (!user || !pass) {
    throw new Error(
      '还没有配置 QQ 邮箱凭证。\n' +
        '  1) 在 QQ 邮箱 → 设置 → 账户，开启 IMAP 服务并生成授权码（16 位）\n' +
        '  2) 运行：selfloom auth qqmail --user 你的邮箱@qq.com --clipboard\n' +
        '     （先复制授权码；也可用 --pass <授权码> 直接传入）',
    );
  }
  return { user, pass, host: opts.host || stored.host || 'imap.qq.com', port: Number(opts.port || stored.port || 993) };
}

/** 校验凭证是否可用：真连一次 IMAP 并试着打开收件箱 */
export async function verify(opts = {}) {
  const c = resolveCred(opts);
  const imap = new Imap({ ...c, timeout: opts.timeout ?? 30000, debug: opts.debug });
  try {
    await imap.connect();
    await imap.login();
    const box = await imap.select(opts.mailbox || 'INBOX');
    return { user: c.user, host: c.host, mailbox: opts.mailbox || 'INBOX', ...box };
  } finally {
    try {
      await imap.logout();
    } catch {
      imap.destroy();
    }
  }
}

/** 取邮件时间：优先 Date 头；缺失或格式异常时退回 Received 头里的时间戳 */
function dateFromHeaders(headers) {
  const direct = toMs(headers.date);
  if (direct) return direct;
  const recv = String(headers.received ?? '');
  const tail = recv.split(';').pop()?.trim();
  if (tail) {
    const ms = toMs(tail);
    if (ms) return ms;
  }
  return null;
}

function mailToEntries(parsed, headers, uid) {
  const subject = decodeWords(headers.subject ?? '') || '（无主题）';
  const from = decodeWords(headers.from ?? '');
  const dateMs = dateFromHeaders(headers);

  const journal = extractDingtalkJournal(parsed.html);
  if (journal) {
    return {
      template: 'dingtalk-journal',
      entries: journal.map((e) => {
        const time = e.time ?? '00:00';
        const ms = e.date ? toMs(`${e.date}T${time}:00+08:00`) : dateMs;
        return { date: e.date, time: e.time, sender: e.sender, text: e.text, createdMs: ms };
      }),
    };
  }

  const body = (parsed.text || '').trim() || htmlToText(parsed.html);
  if (!body) return { template: 'empty', entries: [] };
  return {
    template: 'plain',
    entries: [{ date: null, time: null, sender: from, text: body, createdMs: dateMs }],
  };
}

/* ---------------- 主流程 ---------------- */

export async function sync(opts = {}) {
  ensureHome();
  mkdirSync(INDEX_DIR, { recursive: true });

  const cred = resolveCred(opts);
  const rules = resolveRules(opts);
  const mailbox = opts.mailbox || 'INBOX';
  const force = Boolean(opts.force);
  const limit = opts.limit ? Number(opts.limit) : null;

  const index = readJson(INDEX_FILE, null) ?? {
    user: cred.user,
    mailbox,
    uidvalidity: null,
    messages: {},
    non_self: {},
    updated_at: null,
  };
  if (!index.non_self) index.non_self = {};

  const imap = new Imap({ ...cred, timeout: opts.timeout ?? 60000, debug: opts.debug });
  const notes = [];
  const privacy = [];

  // 收取规则可能被改过：已缓存但不再匹配的邮件必须移出导出集合，
  // 否则上一次规则的结果会一直留在产物里（改了规则却看不到变化）。
  let pruned = 0;
  for (const [uid, m] of Object.entries(index.messages)) {
    if (!matchReason({ from: m.from, to: m.to, cc: m.cc }, rules).hit) {
      delete index.messages[uid];
      pruned++;
    }
  }
  if (pruned) notes.push(`按当前收取规则，清理了 ${pruned} 封已缓存但不再匹配的邮件。`);

  // 孤儿附件清理：磁盘上有、但已不在导出集合里的 uid 目录（规则变更或中断留下的）
  let orphanDirs = 0;
  try {
    for (const d of readdirSync(ATTACH_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || index.messages[d.name]) continue;
      try {
        rmSync(join(ATTACH_DIR, d.name), { recursive: true, force: true });
        orphanDirs++;
      } catch {
        /* 忽略单个目录失败 */
      }
    }
  } catch {
    /* 附件目录还不存在 */
  }
  if (orphanDirs) notes.push(`清理了 ${orphanDirs} 个孤儿附件目录（对应邮件已不在导出集合中）。`);
  let stats;
  let mailRecords;

  try {
    await imap.connect();
    await imap.login();
    const box = await imap.select(mailbox);

    // 信箱换代（UIDVALIDITY 变化）说明 UID 语义已重置，必须整体重来
    let incrementalOk = index.uidvalidity === box.uidvalidity && !force;
    if (index.uidvalidity != null && index.uidvalidity !== box.uidvalidity) {
      notes.push(`信箱 UIDVALIDITY 由 ${index.uidvalidity} 变为 ${box.uidvalidity}，UID 已重置，本次全量重抓。`);
      index.messages = {};
    }
    index.uidvalidity = box.uidvalidity;
    index.user = cred.user;
    index.mailbox = mailbox;

    const criteria = opts.since ? `SINCE ${toImapDate(toMs(opts.since) ?? Date.now())}` : 'ALL';
    const uids = await imap.uidSearch(criteria);
    // 已入库的邮件 + 已判定「不是发给自己」的邮件，都不再重复拉头部
    const knownNonSelf = index.non_self ?? {};
    const cached = uids.filter((u) => incrementalOk && index.messages[u]);
    const knownNo = uids.filter((u) => incrementalOk && !index.messages[u] && knownNonSelf[u]);
    let pending = uids.filter((u) => !(incrementalOk && (index.messages[u] || knownNonSelf[u])));
    if (limit) pending = pending.slice(-limit);

    const skippedNonSelf = [];
    const matched = [];
    const noHeader = [];

    // 第一遍：只取头部，用于筛「发给自己」的邮件（省流量，不下载正文）
    const HEADER_ITEMS = 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]';
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      const got = await imap.uidFetch(batch, HEADER_ITEMS);
      for (const uid of batch) {
        const raw = got.get(uid);
        if (!raw) {
          noHeader.push(uid); // 服务端没返回头部：显式归因，不能静默跳过
          continue;
        }
        const probe = parseMessage(raw);
        const verdict = matchReason(probe.headers, rules);
        if (verdict.hit) matched.push({ uid, headers: probe.headers, reason: verdict.reason });
        else skippedNonSelf.push(uid);
      }
      if (opts.onProgress) opts.onProgress({ phase: 'headers', done: Math.min(i + 100, pending.length), total: pending.length });
    }
    for (const uid of skippedNonSelf) knownNonSelf[uid] = true;
    index.non_self = knownNonSelf;

    // ---- 防呆闸：命中比例高得离谱时先停下来，别把整个收件箱拖下来 ----
    // 这是设计者自己踩过的坑：规则写宽了，4257 封里命中了 4245 封。
    const broadThreshold = 0.5;
    if (
      !opts.dryRun &&
      !rules.all &&
      !opts.acceptBroad &&
      pending.length > 200 &&
      matched.length > pending.length * broadThreshold
    ) {
      const pct = ((matched.length / pending.length) * 100).toFixed(0);
      throw new Error(
        `本次命中了 ${matched.length}/${pending.length} 封（${pct}%），规则看起来过宽。\n` +
          '  已停止，未下载任何正文。请先检查收取规则：\n' +
          '    selfloom config                      查看当前规则\n' +
          '    selfloom sync qqmail --dry-run --force   只勘探计数，不下载\n' +
          '  确认无误可加 --accept-broad 强制执行；若本就要全收，用 --all。',
      );
    }

    // ---- 勘探模式：只数不下载，先让用户知道规模再决定投入 ----
    if (opts.dryRun) {
      const indexSize = Object.keys(index.messages).length;
      const already = matched.filter((m) => index.messages[m.uid]).length;
      return {
        platform,
        label,
        syncedAt: new Date().toISOString(),
        dryRun: true,
        source: { kind: 'imap', host: cred.host, mailbox, account: cred.user, mailbox_total: box.exists, uidvalidity: box.uidvalidity },
        units: [],
        items: [],
        notes: [
          `勘探完成，未下载任何正文。`,
          `按当前规则命中 ${matched.length} 封：其中 ${already} 封已在本地缓存，${matched.length - already} 封为新增待下载。`,
          `本地缓存共 ${indexSize} 封（缓存可能来自旧规则的同步结果）。`,
          '确认规模后运行：selfloom sync qqmail（去掉 --dry-run）',
        ],
        privacy: [],
        stats: {
          declared: { 信箱邮件总数: box.exists, 符合时间条件: uids.length, 命中缓存: cached.length, 已知非本人: knownNo.length, 本次待处理: pending.length },
          captured: { 命中收取规则: matched.length, 已在缓存: already, 待下载: matched.length - already, 非本人邮件: skippedNonSelf.length, 本地缓存总量: indexSize },
          sanity: { declared_content: pending.length, captured_content: matched.length + skippedNonSelf.length },
          unattributed: pending.length - matched.length - skippedNonSelf.length - noHeader.length,
          reconcileNote: '勘探口径：本次待处理 = 命中规则 + 非本人 + 无头部，差额必须为 0。',
        },
      };
    }

    // 第二遍：只下载命中邮件的完整内容（批量下载以减少往返）
    let parsedOk = 0;
    let failed = 0;
    let emptyBodies = 0;
    const failures = [];
    const templateTally = {};
    const sourceTally = {};
    let attachmentsSaved = 0;
    let attachmentsSkipped = 0;
    let attachmentBytes = 0;

    // 附件按策略落盘：文档/PPT 之类要，压缩包不要，超大不要
    const saveAttachments = (uid, list) => {
      const out = [];
      for (const a of list) {
        const pol = attachmentPolicy(a.filename, a.bytes, rules, a.inline);
        if (!pol.save) {
          attachmentsSkipped++;
          out.push({ filename: a.filename, contentType: a.contentType, bytes: a.bytes, inline: Boolean(a.inline), saved_as: null, skip_reason: pol.reason });
          continue;
        }
        try {
          const dir = join(ATTACH_DIR, String(uid));
          mkdirSync(dir, { recursive: true });
          const dest = join(dir, String(a.filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80));
          writeFileSync(dest, a.data);
          attachmentsSaved++;
          attachmentBytes += a.bytes;
          out.push({ filename: a.filename, contentType: a.contentType, bytes: a.bytes, inline: Boolean(a.inline), saved_as: dest });
        } catch (e) {
          attachmentsSkipped++;
          out.push({ filename: a.filename, contentType: a.contentType, bytes: a.bytes, inline: Boolean(a.inline), saved_as: null, skip_reason: `写入失败：${e.message}` });
        }
      }
      return out;
    };
    const batchSize = Math.max(1, Number(opts.batch || 5));
    for (let i = 0; i < matched.length; i += batchSize) {
      const group = matched.slice(i, i + batchSize);
      let got = new Map();
      try {
        got = await imap.uidFetch(group.map((g) => g.uid), 'BODY.PEEK[]');
      } catch (e) {
        for (const g of group) {
          failed++;
          failures.push({ uid: g.uid, error: `批量下载失败：${e.message}` });
        }
        continue;
      }
      for (const { uid, headers, reason } of group) {
        try {
          const raw = got.get(uid);
          if (!raw) throw new Error('服务端没有返回邮件内容');
          const parsed = parseMessage(raw);
          const { template, entries } = mailToEntries(parsed, headers, uid);
          templateTally[template] = (templateTally[template] ?? 0) + 1;

          const meta = {
            uid,
            message_id: decodeWords(headers['message-id'] ?? '') || null,
            subject: decodeWords(headers.subject ?? '') || '（无主题）',
            from: decodeWords(headers.from ?? ''),
            to: decodeWords(headers.to ?? ''),
            date: headers.date ?? null,
            date_ms: dateFromHeaders(headers),
            bytes: raw.length,
            attachments: parsed.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              bytes: a.bytes,
              saved_as: null,
            })),
            fetched_at: new Date().toISOString(),
          };

          const attRecords = saveAttachments(uid, parsed.attachments);

          if (!entries.length) {
            // 「邮件没有可导出的文本」是一个**已归因的事实**，不是失败：
            // 例如只有附件的通知邮件、或被服务端存成空正文的旧邮件。
            // 关键是要写入缓存，否则每次同步都会把它的附件（可能几十 MB）重新下载一遍。
            emptyBodies++;
            index.messages[uid] = { ...meta, match_reason: reason, template: 'empty', entries: [], empty: true, attachments: attRecords };
            continue;
          }

          index.messages[uid] = { ...meta, match_reason: reason, template, entries, attachments: attRecords };
          sourceTally[reason] = (sourceTally[reason] ?? 0) + 1;
          parsedOk++;
        } catch (e) {
          failed++;
          failures.push({ uid, error: e.message });
        }
      }
      if (opts.onProgress) opts.onProgress({ phase: 'bodies', done: Math.min(i + batchSize, matched.length), total: matched.length });
    }

    // 附件统计用「累计值」：平台层文档应当描述数据集现状，而不是某一次运行
    const allStored = Object.values(index.messages);
    const cumSavedAtt = [];
    const cumSkippedAtt = [];
    for (const m of allStored) {
      for (const a of m.attachments ?? []) (a.saved_as ? cumSavedAtt : cumSkippedAtt).push(a);
    }
    const cumSavedBytes = cumSavedAtt.reduce((s, a) => s + (a.bytes ?? 0), 0);
    if (cumSavedAtt.length || cumSkippedAtt.length) {
      notes.push(
        `附件：已落盘 ${cumSavedAtt.length} 个（${(cumSavedBytes / 1048576).toFixed(1)} MB），未落盘 ${cumSkippedAtt.length} 个。` +
          `策略：不超过 ${Math.round(rules.maxAttachmentBytes / 1048576)} MB、非压缩包、非内嵌图片` +
          `${rules.saveArchives ? '（压缩包例外：已开启保存）' : ''}${rules.saveInline ? '（内嵌图片例外：已开启保存）' : ''}。` +
          `本次运行新落盘 ${attachmentsSaved} 个。`,
      );
    }
    if (skippedNonSelf.length) {
      const ruleText = rules.all
        ? '全部收取'
        : `发件人是自己${rules.allowSenders.length ? ` 或 发件人命中白名单 [${rules.allowSenders.join(', ')}]` : ''}${rules.matchTo ? '，同时按收件人匹配' : ''}`;
      notes.push(`已跳过 ${skippedNonSelf.length} 封不匹配收取规则的邮件（规则：${ruleText}；用 --all 可全部导出）。`);
    }

    mailRecords = Object.values(index.messages)
      .filter((m) => m.entries && m.entries.length)
      .sort((a, b) => (a.date_ms ?? 0) - (b.date_ms ?? 0));
    const noDate = mailRecords.filter((m) => !m.date_ms).length;
    if (noDate) notes.push(`有 ${noDate} 封邮件没有任何可解析的时间头，其条目会集中排在时间线末尾。`);

    stats = {
      declared: {
        信箱邮件总数: box.exists,
        符合时间条件: uids.length,
        命中缓存: cached.length,
        已知非本人: knownNo.length,
        本次待处理: pending.length,
      },
      captured: {
        命中收取规则: matched.length,
        已解析: parsedOk,
        解析失败: failed,
        跳过_正文为空: emptyBodies,
        跳过_非本人邮件: skippedNonSelf.length,
        跳过_无头部: noHeader.length,
        入库邮件总数: mailRecords.length,
        来源命中: sourceTally,
        模板分布: templateTally,
        附件_已落盘: attachmentsSaved,
        附件_未落盘: attachmentsSkipped,
        附件_累计已落盘: cumSavedAtt.length,
        附件_累计未落盘: cumSkippedAtt.length,
      },
      sanity: {
        declared_content: pending.length,
        // 「已解析 + 已归因的正文为空 + 已判定为非本人」都算成功分类
        captured_content: parsedOk + emptyBodies + skippedNonSelf.length,
      },
      unattributed: pending.length - matched.length - skippedNonSelf.length - noHeader.length,
      reconcileNote:
        '对账口径：本次待处理 = 命中本人邮件 + 跳过（非本人邮件），差额必须为 0；' +
        '「信箱邮件总数」来自 IMAP EXISTS，用于交叉核对。',
    };
    if (emptyBodies) {
      notes.push(`有 ${emptyBodies} 封邮件没有可导出的文本（多为只有附件的通知邮件），已记为「正文为空」并缓存，不会重复下载。`);
    }
    if (failures.length) {
      const reasons = {};
      for (const f of failures) {
        const key = String(f.error).slice(0, 70);
        reasons[key] = (reasons[key] ?? 0) + 1;
      }
      notes.push(`有 ${failures.length} 封解析失败（未被当作成功），原因分布：${JSON.stringify(reasons)}`);
      notes.push('失败的邮件不会写入缓存，因此下次 sync 会自动重试。');
    }

    index.updated_at = new Date().toISOString();
    writeJson(INDEX_FILE, index);

    if (failures.length) privacy.push(`解析失败的邮件 UID：${failures.slice(0, 10).map((f) => f.uid).join(', ')}`);
    if (cred.user) privacy.push(`凭证只保存在本机，未写入产物；本次使用账号 ${cred.user}（授权码未记录）。`);

    const result = buildResult({ index, mailRecords, stats, notes, privacy, cred, mailbox, box, rules, uidvalidity: box.uidvalidity });
    result.failures = failures;
    writeJson(join(RAW_DIR, `${platform}.json`), result);
    return result;
  } finally {
    try {
      await imap.logout();
    } catch {
      imap.destroy();
    }
  }
}

/* ---------------- 组装统一结果 ---------------- */

export function buildResult({ mailRecords, stats, notes, privacy, cred, mailbox, box, rules }) {
  const units = [];
  const items = [];

  for (const m of mailRecords) {
    const unitId = `qqmail:${m.uid}`;
    const title = m.subject || '（无主题）';
    const md = [];
    md.push(`## ${title}`);
    md.push('');
    const att = m.attachments?.length ? `　·　附件 ${m.attachments.length} 个` : '';
    md.push(`> ${fmtDateTime(m.date_ms) || '时间未知'}　·　发件人 ${m.from || '未知'}　·　${m.entries.length} 条${att}`);
    if (m.attachments?.length) {
      md.push(
        `> 附件：` +
          m.attachments.map((a) => `${a.filename}（${a.contentType}, ${a.bytes} B）`).join('；'),
      );
    }
    md.push('');

    for (const e of m.entries) {
      if (e.date) md.push(`### ${e.date}${e.time ? ` · ${e.time}` : ''}`);
      else md.push(`### ${fmtDateTime(e.createdMs) || '时间未知'}`);
      if (e.sender) md.push(`*${e.sender}*`);
      md.push('');
      md.push(e.text);
      md.push('');

      items.push({
        id: `${unitId}:${shortHash(`${e.date ?? ''}|${e.time ?? ''}|${e.text.slice(0, 40)}`)}`,
        kind: 'journal_entry',
        role: 'self',
        createdMs: e.createdMs ?? m.date_ms,
        unit_id: unitId,
        unit_title: title,
        text: e.text,
        quote: null,
        url: null,
        timeline: true,
        meta: {
          sender: e.sender ?? null,
          time: e.time ?? null,
          mail_from: m.from,
          mail_subject: title,
          template: m.template,
          attachments: m.attachments?.length ?? 0,
        },
      });
    }

    units.push({
      id: unitId,
      title,
      createdMs: m.date_ms,
      updatedMs: m.date_ms,
      itemCount: m.entries.length,
      markdown: md.join('\n'),
    });
  }

  return {
    platform,
    label,
    syncedAt: new Date().toISOString(),
    source: {
      kind: 'imap',
      host: cred.host,
      mailbox,
      account: cred.user,
      mailbox_total: box.exists,
      uidvalidity: box.uidvalidity,
      index_file: INDEX_FILE,
      rules: rules
        ? {
            self_addresses: rules.selfAddresses,
            allow_senders: rules.allowSenders,
            save_attachments: rules.saveAttachments,
            save_archives: rules.saveArchives,
            max_attachment_mb: Math.round(rules.maxAttachmentBytes / 1048576),
          }
        : null,
    },
    units,
    items,
    notes,
    privacy,
    stats,
  };
}
