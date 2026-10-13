/**
 * 统一产物层：把各适配器的归一化结果渲染成四类产物。
 *
 *   items.jsonl    机器层：一行一条记录（所有平台混排，按时间排序）
 *   <platform>.md  平台层：保留各平台原生语义（微信读书按书/章，QQ邮箱按日期…）
 *   timeline.md    汇总层：★ 所有平台按时间混排的「我的思考时间线」
 *   manifest.json  元数据：计数、对账、来源、隐私说明
 */
import { join } from 'node:path';
import { readdirSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { RAW_DIR, OUT_DIR, ensureHome, readJson, writeJson, fmtDate, fmtDateTime } from './util.mjs';

/* ---------------- 对账 ---------------- */

/**
 * 每个适配器都必须回答：来源声称的量 vs 实际抓到的量，差额去哪了。
 * 差额必须被逐项归因（跳过/不支持/空），否则视为静默丢失。
 */
export function reconcile(result) {
  const d = result.stats?.declared ?? {};
  const c = result.stats?.captured ?? {};
  const unattributed = result.stats?.unattributed ?? null;

  // 规则一：差额必须为 0（差额必须被逐项归因）
  const deltaOk = unattributed === 0;

  // 规则二：文件/接口里明明有内容，却一条都没抓到 —— 必须判失败。
  // 这是最容易骗过人的失败模式：程序不报错，结果却是空的。
  // 适配器可提供 stats.sanity = { declared_content, captured_content } 做精确判定；
  // 未提供时退化为「declared 里有正数、captured 里全是 0」。
  const s = result.stats?.sanity ?? null;
  const declaredPositive = Object.values(d).some((v) => typeof v === 'number' && v > 0);
  const capturedPositive = Object.values(c).some((v) => typeof v === 'number' && v > 0);
  const emptyResult = s
    ? Number(s.declared_content) > 0 && Number(s.captured_content) === 0
    : declaredPositive && !capturedPositive;

  const reasons = [];
  if (!deltaOk && unattributed !== null) reasons.push(`有 ${unattributed} 条无法归因`);
  if (emptyResult) reasons.push('来源声明有数据，但一条都没抓到（静默的空数据）');

  return {
    platform: result.platform,
    label: result.label,
    declared: d,
    captured: c,
    unattributed,
    empty_result: emptyResult,
    ok: deltaOk && !emptyResult,
    reason: reasons.join('；'),
    note: result.stats?.reconcileNote ?? '',
  };
}

/* ---------------- 平台层 Markdown ---------------- */

function renderPlatformMd(r) {
  const out = [];
  out.push(`# ${r.label} · 导出结果`);
  out.push('');
  out.push(`> 同步时间：${fmtDateTime(Date.parse(r.syncedAt))}`);
  if (r.source?.path) out.push(`> 数据来源：\`${r.source.path}\``);
  out.push(`> 单元 ${r.units.length} 个 · 记录 ${r.items.length} 条`);
  out.push('');
  for (const note of r.notes ?? []) out.push(`> ℹ️ ${note}`);
  for (const p of r.privacy ?? []) out.push(`> 🔒 ${p}`);
  out.push('');
  out.push('---');
  out.push('');
  for (const u of r.units) {
    out.push(u.markdown.trim());
    out.push('');
    out.push('---');
    out.push('');
  }
  return out.join('\n');
}

/* ---------------- 汇总层：时间线 ---------------- */

function renderTimeline(results, banner = null) {
  const items = [];
  for (const r of results) {
    for (const it of r.items) {
      if (it.timeline && it.text) items.push({ ...it, label: r.label });
    }
  }
  // 没有日期的条目不能污染时间范围，集中排到末尾单独成节
  const dated = items.filter((it) => it.createdMs).sort((a, b) => b.createdMs - a.createdMs);
  const undated = items.filter((it) => !it.createdMs);
  const ordered = [...dated, ...undated];

  const minMs = dated.length ? dated[dated.length - 1].createdMs : null;
  const maxMs = dated.length ? dated[0].createdMs : null;
  const range = minMs ? `${fmtDate(minMs)} ~ ${fmtDate(maxMs)}` : '（没有任何可用的日期信息）';

  // 有些「想法」的正文与它引用的原文完全相同（微信读书里确实存在这种数据形态），
  // 直接渲染会把同一句话显示两遍。这里只显示一次，并把数量如实报出来。
  const isDup = (it) => Boolean(it.quote && it.text && it.quote.trim() === it.text.trim());
  const dupCount = ordered.filter(isDup).length;

  const out = [];
  out.push('# 我的思考时间线');
  out.push('');
  if (banner) {
    out.push(`> ${banner}`);
    out.push('');
  }
  out.push('> 这份文件把所有平台里**我自己写下的内容**按时间混排在一起。');
  out.push(`> 覆盖 ${range} · 共 ${items.length} 条 · 来自 ${results.map((r) => r.label).join(' / ')}`);
  out.push(`> 生成时间：${fmtDateTime(Date.now())}`);
  if (undated.length) out.push(`> 其中 ${undated.length} 条没有可用日期，已集中列在文件末尾。`);
  if (dupCount) out.push(`> 其中 ${dupCount} 条「想法」与它引用的原文相同，已合并显示。`);
  out.push('');
  out.push('---');
  out.push('');

  let year = null;
  let day = null;
  const pushBody = (it) => {
    if (isDup(it)) out.push(it.text);
    else if (it.quote) out.push(`> ${it.quote}\n\n${it.text}`);
    else out.push(it.text);
  };

  for (const it of ordered) {
    const head = it.unitTitle ? ` · ${it.unitTitle}` : '';
    if (!it.createdMs) {
      if (year !== '__none__') {
        year = '__none__';
        day = null;
        out.push('## 日期未知');
        out.push('');
      }
      out.push(`**[${it.label}${head}]**`);
      out.push('');
      pushBody(it);
      out.push('');
      continue;
    }
    const d = fmtDate(it.createdMs);
    const y = d.slice(0, 4);
    if (y !== year) {
      year = y;
      day = null;
      out.push(`## ${y} 年`);
      out.push('');
    }
    if (d !== day) {
      day = d;
      out.push(`### ${d}`);
      out.push('');
    }
    out.push(`**[${it.label}${head}]**`);
    out.push('');
    pushBody(it);
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push('*由 selfloom 本地生成 · 数据从未离开这台电脑*');
  return { markdown: out.join('\n'), count: items.length, undated: undated.length, dup_quote: dupCount };
}

/* ---------------- 入口 ---------------- */

export function loadPlatformResults() {
  if (!existsSync(RAW_DIR)) return [];
  return readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('state.json'))
    .map((f) => readJson(join(RAW_DIR, f)))
    .filter((r) => r && r.platform && Array.isArray(r.items));
}

export function runExport({ outDir = OUT_DIR, mirrorDir = null, results: inputResults = null, banner = null } = {}) {
  ensureHome();
  mkdirSync(outDir, { recursive: true });
  const results = inputResults ?? loadPlatformResults();
  if (!results.length) throw new Error('还没有任何平台数据。先运行：selfloom sync <platform>');

  // 1) items.jsonl
  const all = [];
  for (const r of results) {
    for (const it of r.items) all.push({ platform: r.platform, platform_label: r.label, ...it });
  }
  all.sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));
  const jsonl = all.map((it) => JSON.stringify(it)).join('\n') + '\n';
  writeFileSync(join(outDir, 'items.jsonl'), jsonl, 'utf8');

  // 2) 平台层
  for (const r of results) {
    writeFileSync(join(outDir, `${r.platform}.md`), renderPlatformMd(r), 'utf8');
  }

  // 3) 汇总层
  const timeline = renderTimeline(results, banner);
  writeFileSync(join(outDir, 'timeline.md'), timeline.markdown, 'utf8');

  // 4) manifest
  const reconciles = results.map(reconcile);
  const byKind = {};
  for (const it of all) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  const ts = all.map((i) => i.createdMs).filter(Boolean);
  const manifest = {
    tool: 'selfloom',
    generated_at: new Date().toISOString(),
    generated_at_local: fmtDateTime(Date.now()),
    outputs: {
      items_jsonl: 'items.jsonl',
      timeline: 'timeline.md',
      platform_md: results.map((r) => `${r.platform}.md`),
    },
    totals: {
      items: all.length,
      timeline_items: timeline.count,
      timeline_undated_items: timeline.undated,
      timeline_dup_quote_items: timeline.dup_quote,
      by_platform: Object.fromEntries(results.map((r) => [r.platform, r.items.length])),
      by_kind: byKind,
      time_range: {
        from: ts.length ? fmtDate(Math.min(...ts)) : null,
        to: ts.length ? fmtDate(Math.max(...ts)) : null,
      },
    },
    platforms: results.map((r) => ({
      platform: r.platform,
      label: r.label,
      synced_at: r.syncedAt,
      source: r.source ?? null,
      units: r.units.length,
      items: r.items.length,
      reconcile: reconcile(r),
      notes: r.notes ?? [],
      privacy: r.privacy ?? [],
    })),
    reconciliation: {
      all_ok: reconciles.every((r) => r.ok),
      detail: reconciles,
      policy: '任何平台若存在无法归因的差额，视同静默丢数据，必须在修复后才可发布',
    },
  };
  writeJson(join(outDir, 'manifest.json'), manifest);

  // 镜像到第二个目录（例如桌面上的验收文件夹），方便直接打开查看
  let mirrored = null;
  if (mirrorDir) {
    const names = ['items.jsonl', 'timeline.md', 'manifest.json', ...results.map((r) => `${r.platform}.md`)];
    mkdirSync(mirrorDir, { recursive: true });
    for (const n of names) copyFileSync(join(outDir, n), join(mirrorDir, n));
    mirrored = { dir: mirrorDir, files: names };
  }

  return {
    outDir,
    mirrored,
    items: all.length,
    timeline: timeline.count,
    platforms: results.map((r) => ({ platform: r.platform, items: r.items.length })),
    reconciles,
  };
}
