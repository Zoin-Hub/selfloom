/**
 * demo —— 零配置、不联网、30 秒看到产物长什么样。
 *
 * 设计原则：**走真实管线，不另写一套假的**。
 *  - 微信读书：fixture 转成接口原样的数据 → 复用真实的 normalizeBook / renderBook
 *  - DeepSeek：fixture 写成一份真实的 conversations.json → 直接跑真实适配器（dryRun，不落盘）
 *  - QQ 邮箱：fixture 转成入库记录 → 复用真实的 buildResult
 * 汇总层（timeline.md / items.jsonl / manifest.json）由真实 runExport 生成。
 *
 * 隐私：全部为虚构样例数据（demo/sample.json），不读取、不写入用户的任何真实数据。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExport } from './render.mjs';
import { toMs } from './util.mjs';
import * as weread from '../adapters/weread.mjs';
import * as deepseek from '../adapters/deepseek.mjs';
import * as qqmail from '../adapters/qqmail.mjs';

const SAMPLE = JSON.parse(readFileSync(new URL('../../demo/sample.json', import.meta.url), 'utf8'));

export const BANNER =
  '⚠️ 这是 demo 样例数据（全部虚构），用来预览产物长什么样。' +
  '要生成你自己的数据：selfloom auth <platform> → selfloom sync <platform> → selfloom export';

const sec = (v) => Math.floor(toMs(v) / 1000);
const isoAt = (date, hhmm = '10:00') => `${date}T${hhmm}:00+08:00`;

/* ---------------- 微信读书 ---------------- */

function buildWeread() {
  const units = [];
  const items = [];
  const tally = { highlight: 0, thought: 0, chapter_review: 0, book_review: 0 };
  let records = 0;
  let merged = 0;

  for (const book of SAMPLE.weread.books) {
    const chapters = book.chapters.map((title, i) => ({ chapterUid: i + 1, chapterIdx: i + 1, title }));
    const highlights = [];
    const reviews = [];
    let seq = 0;
    let r = 0;
    const bookMeta = {
      bookId: book.bookId,
      format: 'epub',
      title: book.title,
      author: book.author,
      translator: book.translator,
      cover: '',
    };

    for (const e of book.entries) {
      const makeHighlight = (chapterUid, text, date) => {
        seq += 1;
        const range = `${seq * 1000}-${seq * 1000 + 60}`;
        highlights.push({
          bookmarkId: `${book.bookId}_${seq}`,
          bookId: book.bookId,
          chapterUid,
          markText: text,
          createTime: sec(isoAt(date)),
          type: 1,
          range,
        });
        return range;
      };

      if (e.kind === 'highlight') {
        makeHighlight(e.chapter, e.text, e.date);
      } else if (e.kind === 'thought') {
        // 同时生成一条 range 相同的划线：这样能真实地走一遍「去重合并」逻辑
        const range = makeHighlight(e.chapter, e.quote, e.date);
        r += 1;
        reviews.push({
          reviewId: `${book.bookId}_r${r}`,
          review: {
            bookId: book.bookId,
            content: e.text,
            abstract: e.quote,
            range,
            type: 1,
            chapterUid: e.chapter,
            chapterIdx: e.chapter,
            chapterTitle: chapters[e.chapter - 1]?.title ?? '',
            reviewId: `${book.bookId}_r${r}`,
            userVid: 1,
            createTime: sec(isoAt(e.date)),
            star: -1,
            book: bookMeta,
          },
          likesCount: 3,
          commentsCount: 0,
        });
      } else if (e.kind === 'chapter_review') {
        r += 1;
        reviews.push({
          reviewId: `${book.bookId}_r${r}`,
          review: {
            bookId: book.bookId,
            content: e.text,
            type: 1,
            chapterUid: e.chapter,
            chapterIdx: e.chapter,
            chapterTitle: chapters[e.chapter - 1]?.title ?? '',
            reviewId: `${book.bookId}_r${r}`,
            userVid: 1,
            createTime: sec(isoAt(e.date)),
            star: -1,
            book: bookMeta,
          },
          likesCount: 1,
        });
      } else if (e.kind === 'book_review') {
        r += 1;
        reviews.push({
          reviewId: `${book.bookId}_r${r}`,
          review: {
            bookId: book.bookId,
            content: e.text,
            type: 4,
            reviewId: `${book.bookId}_r${r}`,
            userVid: 1,
            createTime: sec(isoAt(e.date)),
            star: e.star,
            book: bookMeta,
          },
          likesCount: 12,
        });
      }
    }

    const thoughts = reviews.filter((x) => x.review.abstract).length;
    const pureHighlights = highlights.length - thoughts;
    const lastDate = book.entries[book.entries.length - 1]?.date ?? '2024-01-01';
    const entry = {
      bookId: book.bookId,
      book: bookMeta,
      reviewCount: reviews.length,
      noteCount: pureHighlights,
      bookmarkCount: 0,
      readingProgress: book.progress,
      markedStatus: book.finished ? 1 : 0,
      sort: sec(isoAt(lastDate)),
    };

    const b = weread.normalizeBook(entry, { highlights, chapters, reviews });
    records += b.records;
    merged += b.mergedHighlights;

    for (const e of b.entries) {
      tally[e.kind] += 1;
      items.push({
        id: `weread:${b.bookId}:${e.reviewId ?? `${e.kind}:${e.range || e.createdTs}`}`,
        kind: e.kind,
        role: e.role,
        createdMs: toMs(e.createdTs),
        unit_id: `weread:${b.bookId}`,
        unit_title: b.title,
        text: e.text,
        quote: e.quote || null,
        url: null,
        timeline: e.kind !== 'highlight',
        meta: { author: b.author, chapter: e.chapter?.title ?? null },
      });
    }

    units.push({
      id: `weread:${b.bookId}`,
      title: b.title,
      createdMs: toMs(b.sort),
      updatedMs: toMs(b.sort),
      itemCount: b.entries.length,
      markdown: weread.renderBook(b, units.length + 1),
    });
  }

  return {
    platform: 'weread',
    label: '微信读书',
    syncedAt: new Date().toISOString(),
    source: { kind: 'demo', note: '样例数据' },
    units,
    items,
    notes: [BANNER, '书签仅计数、不提供内容，因此 demo 里 bookmarkCount 设为 0。'],
    privacy: ['demo 数据全部虚构，不含任何真实账号内容。'],
    stats: {
      declared: { 有笔记的书: units.length, 可导出记录_划线加想法: records, 本次重抓: units.length, 命中缓存: 0 },
      captured: { 实抓原始记录: records, 导出条目: items.length, ...tally, 去重跳过: merged },
      sanity: { declared_content: records, captured_content: records },
      unattributed: 0,
      reconcileNote: 'demo 数据由 fixture 构造，因此差额恒为 0；真实平台的对账口径见各自适配器。',
    },
  };
}

/* ---------------- DeepSeek ---------------- */

function conversationsFixture() {
  return SAMPLE.deepseek.conversations.map((c, ci) => {
    const id = `demo-ds-${ci + 1}`;
    const mapping = {
      root: { id: 'root', parent: null, children: ['1'], message: null },
    };
    let nodeId = 0;
    let parent = 'root';
    for (const turn of c.turns) {
      nodeId += 1;
      const userNode = String(nodeId);
      nodeId += 1;
      const asstNode = String(nodeId);
      mapping[userNode] = {
        id: userNode,
        parent,
        children: [asstNode],
        message: {
          model: 'deepseek-chat',
          inserted_at: isoAt(c.date, '10:00'),
          fragments: [{ type: 'REQUEST', content: turn.user }],
        },
      };
      const fragments = [];
      if (turn.reasoning) fragments.push({ type: 'THINK', content: turn.reasoning });
      fragments.push({ type: 'RESPONSE', content: turn.assistant });
      mapping[asstNode] = {
        id: asstNode,
        parent: userNode,
        children: [],
        message: { model: 'deepseek-reasoner', inserted_at: isoAt(c.date, '10:01'), fragments },
      };
      parent = asstNode;
    }
    return { id, title: c.title, inserted_at: isoAt(c.date, '10:00'), updated_at: isoAt(c.date, '10:02'), mapping };
  });
}

function buildDeepseek() {
  const dir = mkdtempSync(join(tmpdir(), 'selfloom-demo-'));
  const file = join(dir, 'conversations.json');
  try {
    writeFileSync(file, JSON.stringify(conversationsFixture()), 'utf8');
    // 直接跑真实适配器：dryRun 保证不碰用户的真实数据目录
    const r = deepseek.sync({ file, dryRun: true });
    r.notes = [BANNER, ...(r.notes ?? [])];
    r.privacy = ['demo 数据全部虚构，不含任何真实账号内容。'];
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- QQ 邮箱 ---------------- */

function buildQqmail() {
  const mailRecords = SAMPLE.qqmail.mails.map((m) => ({
    uid: m.uid,
    message_id: `<demo-${m.uid}@demo.local>`,
    subject: m.subject,
    from: m.from,
    to: m.to,
    date: `${m.date} 10:00:00 +0800`,
    date_ms: toMs(m.date),
    template: m.template,
    entries: m.entries.map((e) => ({
      date: e.date,
      time: e.time,
      sender: e.sender,
      text: e.text,
      createdMs: toMs(e.date ? isoAt(e.date, e.time ?? '00:00') : m.date),
    })),
    attachments: (m.attachments ?? []).map((a) => ({ ...a, saved_as: null })),
  }));

  const entries = mailRecords.reduce((n, m) => n + m.entries.length, 0);
  const rules = {
    selfAddresses: ['demo@qq.com'],
    allowSenders: ['dingtalk.com'],
    saveAttachments: true,
    saveArchives: false,
    saveInline: false,
    maxAttachmentBytes: 20 * 1024 * 1024,
  };

  const r = qqmail.buildResult({
    mailRecords,
    cred: { host: 'imap.qq.com', user: 'demo@qq.com' },
    mailbox: 'INBOX',
    box: { exists: mailRecords.length, uidvalidity: 1 },
    rules,
    notes: [BANNER, '真实使用时：附件按策略落盘、压缩包与内嵌图片默认不落盘。'],
    privacy: ['demo 数据全部虚构，不含任何真实账号内容。'],
    stats: {
      declared: { 信箱邮件总数: mailRecords.length, 符合时间条件: mailRecords.length, 本次待处理: mailRecords.length },
      captured: { 命中收取规则: mailRecords.length, 已解析: mailRecords.length, 导出条目: entries },
      sanity: { declared_content: mailRecords.length, captured_content: mailRecords.length },
      unattributed: 0,
      reconcileNote: 'demo 数据由 fixture 构造，差额恒为 0；真实邮箱的对账口径见 qqmail 适配器。',
    },
  });
  return r;
}

/* ---------------- 入口 ---------------- */

export function runDemo({ outDir }) {
  const results = [buildDeepseek(), buildWeread(), buildQqmail()];
  const summary = runExport({ outDir, results, banner: BANNER, mirrorDir: null });
  return { ...summary, results };
}
