/**
 * 微信读书适配器
 *
 * 通道：官方 Agent API（POST https://i.weread.qq.com/api/agent/gateway）
 * 鉴权：API Key（wrk- 开头），在 weread.qq.com/r/weread-skills 登录后获取
 *
 * 需要说清的三件事（都是实测踩出来的）：
 *  1. `/book/bookmarklist` 用 `bookId`，`/review/list/mine` 用 `bookid` —— 大小写不同。
 *  2. `star`（评分）官方文档写 0–5，实测是 **0–100 的推荐值**；按文档写会直接把程序搞崩。
 *  3. 书签只在统计里给数量，**官方不提供书签内容**，属于已归因的缺失。
 *
 * 增量策略：先拉笔记本列表，逐本比较「计数 + sort（最近笔记时间）」，
 * 只有变了的书才重抓；`--force` 则全部重抓。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR, ensureHome, readJson, writeJson, toMs, fmtDate, fmtDateTime, sleep, fetchRetry } from '../core/util.mjs';
import { getCred } from '../core/secret.mjs';

export const platform = 'weread';
export const label = '微信读书';

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const SKILL_VERSION = '1.0.5';
const WEREAD_DIR = join(RAW_DIR, 'weread');
const BOOKS_DIR = join(WEREAD_DIR, 'books');
const INDEX_FILE = join(WEREAD_DIR, 'index.json');
const HELP_URL = 'https://weread.qq.com/r/weread-skills';

const NO_KEY_MSG =
  '还没有配置微信读书 API Key。\n' +
  `  1) 打开 ${HELP_URL} 登录后获取 API Key（wrk- 开头）\n` +
  '  2) 复制它，然后运行：selfloom auth weread --clipboard\n' +
  '     （也可用 --key <API Key> 直接传入）';

function resolveKey(opts) {
  const stored = getCred(platform) ?? {};
  const key = opts.apiKey || stored.api_key;
  if (!key) throw new Error(NO_KEY_MSG);
  if (!String(key).startsWith('wrk-')) throw new Error(`API Key 格式不对（应以 wrk- 开头）：${String(key).slice(0, 6)}…`);
  return key;
}

/** 调一次网关。所有业务参数必须平铺在 body 顶层，并带 skill_version。 */
async function call(apiName, params, key, debug) {
  // 用带重试的请求：网络抖动不该让用户以为自己 Key 失效
  const res = await fetchRetry(
    GATEWAY,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VERSION }),
    },
    { retries: 3, timeoutMs: 20000, debug },
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 160)}`);
  }
  if (debug) console.error(`[weread] ${apiName} HTTP ${res.status}`);
  if (res.status === 401) throw new Error('鉴权失败（401）：API Key 无效或已重置，请重新运行 selfloom auth weread');
  if (json.upgrade_info) throw new Error(`服务端要求升级 skill：${JSON.stringify(json.upgrade_info)}`);
  if (typeof json.errcode === 'number' && json.errcode !== 0) {
    throw new Error(`errcode=${json.errcode} ${json.errmsg ?? ''}`);
  }
  await sleep(220);
  return json;
}

/** 校验 API Key：拉一次最小的笔记本列表，顺带报出账号规模 */
export async function verify(opts = {}) {
  const key = resolveKey(opts);
  const json = await call('/user/notebooks', { count: 1 }, key, opts.debug);
  return {
    totalBookCount: json.totalBookCount ?? null,
    totalNoteCount: json.totalNoteCount ?? null,
    hasMore: json.hasMore ?? 0,
  };
}

/* ---------------- 抓取 ---------------- */

async function fetchNotebooks(key, debug) {
  const books = [];
  let lastSort;
  let hasMore = 1;
  let pages = 0;
  let totalBookCount = null;
  let totalNoteCount = null;

  while (hasMore === 1 && pages < 60) {
    const params = { count: 100 };
    if (lastSort !== undefined) params.lastSort = lastSort;
    const json = await call('/user/notebooks', params, key, debug);
    pages += 1;
    totalBookCount = json.totalBookCount ?? totalBookCount;
    totalNoteCount = json.totalNoteCount ?? totalNoteCount;
    const list = json.books ?? [];
    books.push(...list);
    hasMore = json.hasMore ?? 0;
    if (!list.length) break;
    lastSort = list[list.length - 1].sort;
  }
  return { books, totalBookCount, totalNoteCount, pages };
}

async function fetchOneBook(bookId, key, debug) {
  const bl = await call('/book/bookmarklist', { bookId }, key, debug);
  const reviews = [];
  let synckey;
  let hasMore = 1;
  let pages = 0;
  while (hasMore === 1 && pages < 100) {
    const params = { bookid: bookId, count: 100 }; // 注意：这里是小写 bookid
    if (synckey !== undefined) params.synckey = synckey;
    const json = await call('/review/list/mine', params, key, debug);
    pages += 1;
    const list = json.reviews ?? [];
    reviews.push(...list);
    hasMore = json.hasMore ?? 0;
    if (!list.length) break;
    synckey = json.synckey;
  }
  return { highlights: bl.updated ?? [], chapters: bl.chapters ?? [], reviews };
}

/* ---------------- 归一化 ---------------- */

const pad2 = (n) => String(n).padStart(2, '0');

function starLabel(star) {
  if (typeof star !== 'number' || star < 0) return '';
  if (star >= 90) return '强烈推荐';
  if (star >= 70) return '推荐';
  if (star >= 50) return '一般';
  if (star > 0) return '不推荐';
  return '';
}

function rangeStart(range) {
  const n = parseInt(String(range ?? '').split('-')[0], 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * 一本书 → 一个 unit + 若干 item
 *
 * 去重规则：若某条想法与某条划线的 range 相同，视为同一条目
 * （微信读书 App 会把「带想法的划线」在划线列表里再记一次，不去重就会出现重复）。
 */
export function normalizeBook(entry, raw) {
  const bookId = String(entry.bookId);
  const meta = raw.reviews?.[0]?.review?.book ?? entry.book ?? {};

  const chapters = new Map();
  for (const c of raw.chapters ?? []) {
    chapters.set(String(c.chapterUid), { uid: c.chapterUid, idx: c.chapterIdx ?? 9999, title: c.title ?? '未知章节' });
  }
  for (const r of raw.reviews ?? []) {
    const v = r.review ?? {};
    if (v.chapterUid === undefined) continue;
    const key = String(v.chapterUid);
    const prev = chapters.get(key);
    chapters.set(key, {
      uid: v.chapterUid,
      idx: Math.min(prev?.idx ?? 9999, v.chapterIdx ?? 9999),
      title: prev?.title ?? v.chapterTitle ?? '未知章节',
    });
  }
  const chapterOf = (uid) => chapters.get(String(uid)) ?? { uid, idx: 9999, title: '未知章节' };

  const entries = [];
  const userVids = new Set();

  const highlightRanges = new Map();
  for (const h of raw.highlights ?? []) {
    if (h.range) highlightRanges.set(h.range, h);
  }
  const mergedKeys = new Set();
  let pairs = 0;

  for (const r of raw.reviews ?? []) {
    const v = r.review ?? {};
    if (v.userVid !== undefined) userVids.add(v.userVid);
    const quote = v.abstract ?? '';
    const isBookReview = !quote && !v.chapterName && !v.chapterTitle;
    if (quote && v.range && highlightRanges.has(v.range)) {
      mergedKeys.add(highlightRanges.get(v.range).bookmarkId);
      pairs += 1;
    }
    entries.push({
      kind: isBookReview ? 'book_review' : quote ? 'thought' : 'chapter_review',
      role: 'self',
      createdTs: v.createTime ?? 0,
      quote,
      text: v.content ?? '',
      range: v.range ?? '',
      chapter: chapterOf(v.chapterUid),
      star: typeof v.star === 'number' ? v.star : -1,
      reviewId: v.reviewId ?? null,
      likes: r.likesCount ?? null,
      comments: r.commentsCount ?? null,
    });
  }

  for (const h of raw.highlights ?? []) {
    if (mergedKeys.has(h.bookmarkId)) continue;
    entries.push({
      kind: 'highlight',
      role: 'book',
      createdTs: h.createTime ?? 0,
      quote: '',
      text: h.markText ?? '',
      range: h.range ?? '',
      chapter: chapterOf(h.chapterUid),
      star: -1,
      reviewId: null,
      likes: null,
      comments: null,
    });
  }

  entries.sort((a, b) => {
    if (a.chapter.idx !== b.chapter.idx) return a.chapter.idx - b.chapter.idx;
    const ra = rangeStart(a.range);
    const rb = rangeStart(b.range);
    if (ra !== rb) return ra - rb;
    return (a.createdTs ?? 0) - (b.createdTs ?? 0);
  });

  return {
    bookId,
    title: meta.title ?? entry.book?.title ?? '未知书名',
    author: meta.author ?? entry.book?.author ?? '',
    translator: meta.translator ?? '',
    markedStatus: entry.markedStatus ?? null,
    readingProgress: entry.readingProgress ?? null,
    sort: entry.sort ?? 0,
    declared: {
      reviewCount: entry.reviewCount ?? 0,
      noteCount: entry.noteCount ?? 0,
      bookmarkCount: entry.bookmarkCount ?? 0,
    },
    entries,
    chapterCount: chapters.size,
    mergedHighlights: mergedKeys.size,
    pairs,
    userVids: [...userVids],
    records: (raw.highlights?.length ?? 0) + (raw.reviews?.length ?? 0),
  };
}

/* ---------------- 渲染 ---------------- */

const quote = (s) => String(s ?? '').split('\n').map((l) => `> ${l}`).join('\n');
const selfText = (e) => e.text.trim() || (e.star >= 0 ? '*（只有评分，未写文字）*' : '*（无文字内容）*');

export function renderBook(b, index) {
  const tally = b.entries.reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
  const last = b.entries.reduce((mx, e) => Math.max(mx, e.createdTs ?? 0), 0);
  const out = [];
  out.push(`## ${index}. 《${b.title}》`);
  out.push('');
  const bits = [`**作者**：${b.author || '未知'}`];
  if (b.translator) bits.push(`**译者**：${b.translator}`);
  if (b.markedStatus === 1) bits.push('**状态**：已读完');
  if (b.readingProgress !== null && b.readingProgress !== undefined) bits.push(`**进度**：${b.readingProgress}%`);
  bits.push(`**bookId**：${b.bookId}`);
  out.push(bits.join('　·　'));
  out.push('');
  out.push(
    `**条目**：${b.entries.length} 条（划线 ${tally.highlight ?? 0} · 想法 ${tally.thought ?? 0} · 章节点评 ${tally.chapter_review ?? 0} · 书评 ${tally.book_review ?? 0}）　**最近**：${fmtDate(last) || '未知'}`,
  );
  out.push('');

  const bookReviews = b.entries.filter((e) => e.kind === 'book_review');
  if (bookReviews.length) {
    out.push('### 📖 整本书评');
    out.push('');
    for (const e of bookReviews) {
      const s = starLabel(e.star);
      out.push(`**（${fmtDate(e.createdTs) || '日期未知'}）**${s ? `　推荐值 ${e.star}/100 · ${s}` : ''}`);
      out.push('');
      out.push(selfText(e));
      out.push('');
    }
  }

  const hasNamed = b.entries.some((e) => e.chapter?.title && e.chapter.title !== '未知章节');
  let current = null;
  for (const e of b.entries) {
    if (e.kind === 'book_review') continue;
    const title = e.chapter.title;
    if (title !== current) {
      current = title;
      if (hasNamed || title !== '未知章节') {
        out.push(`### ${title}`);
        out.push('');
      }
    }
    if (e.kind === 'chapter_review') {
      out.push(`**📝 章节点评**（${fmtDate(e.createdTs) || '日期未知'}）`);
      out.push('');
      out.push(selfText(e));
      out.push('');
      continue;
    }
    if (e.kind === 'thought' && e.quote) {
      out.push(quote(e.quote.trim()));
      out.push('');
      out.push(`**💭 想法**（${fmtDate(e.createdTs) || '日期未知'}）`);
      out.push('');
      out.push(selfText(e));
      out.push('');
      continue;
    }
    // 纯划线
    out.push(quote(e.text.trim()));
    out.push('');
    out.push(`*（${fmtDate(e.createdTs) || '日期未知'} 划线）*`);
    out.push('');
  }
  return out.join('\n');
}

/* ---------------- 主流程 ---------------- */

export async function sync(opts = {}) {
  ensureHome();
  const key = resolveKey(opts);
  const force = Boolean(opts.force);
  const debug = Boolean(opts.debug);
  const notes = [];
  const privacy = [];

  const index = readJson(INDEX_FILE, null) ?? { books: {}, updated_at: null };
  if (!index.books) index.books = {};

  const { books: listed, totalBookCount, totalNoteCount, pages } = await fetchNotebooks(key, debug);
  if (opts.onProgress) opts.onProgress({ phase: 'list', done: pages, total: pages });

  let cachedCount = 0;
  let refetched = 0;
  const failures = [];

  for (let i = 0; i < listed.length; i++) {
    const entry = listed[i];
    const bookId = String(entry.bookId);
    const title = entry.book?.title ?? bookId;
    const declared = {
      reviewCount: entry.reviewCount ?? 0,
      noteCount: entry.noteCount ?? 0,
      bookmarkCount: entry.bookmarkCount ?? 0,
    };
    const prev = index.books[bookId];
    const same =
      prev &&
      !force &&
      prev.declared?.reviewCount === declared.reviewCount &&
      prev.declared?.noteCount === declared.noteCount &&
      prev.declared?.bookmarkCount === declared.bookmarkCount &&
      prev.sort === (entry.sort ?? 0);

    if (same) {
      cachedCount += 1;
      continue;
    }

    try {
      const raw = await fetchOneBook(bookId, key, debug);
      writeJson(join(BOOKS_DIR, `${bookId}.json`), raw);
      index.books[bookId] = { bookId, title, declared, sort: entry.sort ?? 0, fetched_at: new Date().toISOString() };
      refetched += 1;
    } catch (e) {
      failures.push({ bookId, title, error: e.message });
      if (debug) console.error(`[weread] 《${title}》抓取失败：${e.message}`);
    }
    if (opts.onProgress && (i + 1) % 20 === 0) opts.onProgress({ phase: 'books', done: i + 1, total: listed.length });
  }

  if (opts.onProgress) opts.onProgress({ phase: 'books', done: listed.length, total: listed.length });
  writeJson(INDEX_FILE, { ...index, updated_at: new Date().toISOString() });

  // ---- 由缓存组装产物 ----
  const units = [];
  const items = [];
  const tally = { highlight: 0, thought: 0, chapter_review: 0, book_review: 0 };
  const allVids = new Set();
  const mismatches = [];
  let declaredExportable = 0;
  let declaredBookmark = 0;
  let recordsFetched = 0;
  let mergedPairs = 0;
  const missingRaw = [];

  for (const entry of listed) {
    const bookId = String(entry.bookId);
    const file = join(BOOKS_DIR, `${bookId}.json`);
    if (!existsSync(file)) {
      missingRaw.push({ bookId, title: entry.book?.title ?? '' });
      continue;
    }
    const raw = readJson(file, null);
    if (!raw) {
      missingRaw.push({ bookId, title: entry.book?.title ?? '' });
      continue;
    }
    const b = normalizeBook(entry, raw);

    const exportable = b.declared.noteCount + b.declared.reviewCount;
    declaredExportable += exportable;
    declaredBookmark += b.declared.bookmarkCount;
    recordsFetched += b.records;
    mergedPairs += b.mergedHighlights;
    for (const v of b.userVids) allVids.add(v);
    if (b.records !== exportable) {
      mismatches.push({ bookId, title: b.title, declared: exportable, fetched: b.records, delta: b.records - exportable });
    }

    for (const e of b.entries) {
      tally[e.kind] += 1;
      items.push({
        id: `${platform}:${b.bookId}:${e.reviewId ?? `${e.kind}:${e.range || e.createdTs}`}`,
        kind: e.kind,
        role: e.role,
        createdMs: toMs(e.createdTs),
        unit_id: `${platform}:${b.bookId}`,
        unit_title: b.title,
        text: e.text,
        quote: e.quote || null,
        url: null,
        // 时间线只收「我自己写下的」：划线是书里的文字，不算我的创作
        timeline: e.kind !== 'highlight',
        meta: {
          author: b.author,
          chapter: e.chapter?.title ?? null,
          星: e.star >= 0 ? e.star : undefined,
          likes: e.likes ?? undefined,
          comments: e.comments ?? undefined,
        },
      });
    }

    units.push({
      id: `${platform}:${b.bookId}`,
      title: b.title,
      createdMs: toMs(b.sort),
      updatedMs: toMs(b.sort),
      itemCount: b.entries.length,
      markdown: renderBook(b, units.length + 1),
    });
  }

  const entryTotal = items.length;

  if (declaredBookmark) {
    notes.push(`书签 ${declaredBookmark} 条：官方只在统计里提供数量，**不提供书签内容**，属已归因的缺失。`);
  }
  if (mergedPairs) {
    notes.push(`合并了 ${mergedPairs} 段重复划线（同一段划线在「划线」和「想法」里被各记一次）。`);
  }
  if (missingRaw.length) notes.push(`有 ${missingRaw.length} 本书没有本地数据（多为抓取失败），见 manifest 的 missing_raw。`);
  if (failures.length) notes.push(`有 ${failures.length} 本书抓取失败，未写入缓存，下次 sync 会自动重试。`);
  if (mismatches.length) notes.push(`有 ${mismatches.length} 本书的「声明计数 ≠ 实抓记录」，见 manifest 的 mismatches。`);
  if (allVids.size > 1) notes.push(`⚠ 出现多个账号 userVid（${[...allVids].join(', ')}），请检查是否混入了他人内容。`);
  notes.push('时间线只收本人想法/点评/书评；划线是书里的原文，保留在平台层与 items.jsonl，但不进时间线。');
  privacy.push('API Key 只保存在本机，未写入任何产物。');

  const exportFinished = listed.length - cachedCount - refetched;
  const result = {
    platform,
    label,
    syncedAt: new Date().toISOString(),
    source: {
      kind: 'weread-agent-api',
      gateway: GATEWAY,
      skill_version: SKILL_VERSION,
      total_book_count: totalBookCount,
      total_note_count: totalNoteCount,
      pages,
    },
    account: { userVids: [...allVids] },
    units,
    items,
    notes,
    privacy,
    stats: {
      declared: {
        有笔记的书: totalBookCount ?? listed.length,
        笔记总数_统计口径: totalNoteCount,
        可导出记录_划线加想法: declaredExportable,
        书签_官方不提供内容: declaredBookmark,
        本次扫描书数: listed.length,
        命中缓存: cachedCount,
        本次重抓: refetched,
      },
      captured: {
        实抓原始记录: recordsFetched,
        导出条目: entryTotal,
        划线: tally.highlight,
        想法: tally.thought,
        章节点评: tally.chapter_review,
        书评: tally.book_review,
        去重跳过: mergedPairs,
        有条目的书: units.length,
      },
      sanity: { declared_content: declaredExportable, captured_content: recordsFetched },
      unattributed: declaredExportable - recordsFetched,
      reconcileNote:
        '对账口径：接口声明的「划线+想法」必须等于实抓原始记录，差额为 0；' +
        '书签为官方明确不提供内容的项，单独计数。',
    },
    failures,
    mismatches,
    missing_raw: missingRaw,
  };
  if (exportFinished > 0) result.notes.push(`有 ${exportFinished} 本书在列表里但没有任何数据，已跳过。`);

  writeJson(join(RAW_DIR, `${platform}.json`), result);
  return result;
}

/** 供 doctor 用：已缓存多少本书 */
export function cachedBookCount() {
  try {
    const idx = readJson(INDEX_FILE, null);
    return idx?.books ? Object.keys(idx.books).length : 0;
  } catch {
    return 0;
  }
}

export function storedBookFiles() {
  try {
    return readdirSync(BOOKS_DIR).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
