/**
 * HTML → 文本，以及钉钉聊天记录邮件的结构化提取（零依赖）。
 *
 * 两种粒度：
 *  - htmlToText(html)        通用的块级感知转换，任何 HTML 邮件都能得到可读文本
 *  - extractDingtalkJournal() 针对「钉钉转发聊天记录」这一种模板，
 *                            按日期 + 发送人/时间切成逐条条目 —— 这样才能让
 *                            每条思考落在它真实的日期上，而不是全部堆在收件日
 *
 * 设计说明：钉钉模板识别用「样式色值」而不是页面结构，因为色值在模板里是稳定的
 * （#999999 = 发送人/时间行，#262626 = 消息正文），而 DOM 嵌套可能随时变。
 */

export function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    middot: '·', times: '×', copy: '©', reg: '®', deg: '°', yen: '¥',
  };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 通用 HTML → 文本：块级标签转换行，去标签，解实体，收敛空行 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|td|section|article)>/gi, '\n');
  s = s.replace(/<(p|div|tr|li|h[1-6]|table|blockquote|section|article)[^>]*>/gi, '\n');
  s = s.replace(/<td[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 钉钉「转发聊天记录」邮件 → 逐条条目。
 * 返回 [{ date:'YYYY-MM-DD', time:'HH:MM', sender, text }]；识别不到时返回 null。
 */
export function extractDingtalkJournal(html) {
  if (!html) return null;

  const events = [];
  const collect = (re, kind) => {
    for (const m of String(html).matchAll(re)) {
      events.push({ index: m.index, kind, inner: m[1] ?? m[2] ?? '' });
    }
  };

  // 日期分隔：表格里的 YYYY-M-D 单元格
  collect(/<td[^>]*>\s*(\d{4}-\d{1,2}-\d{1,2})\s*<\/td>/gi, 'date');
  // 发送人 / 时间行
  collect(/<div[^>]*style="[^"]*color:\s*#999999[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, 'meta');
  // 消息正文
  collect(/<div[^>]*style="[^"]*color:\s*#262626[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, 'body');

  if (!events.some((e) => e.kind === 'body')) return null;
  events.sort((a, b) => a.index - b.index);

  const pad = (n) => String(n).padStart(2, '0');
  const entries = [];
  let date = null;
  let meta = null;

  for (const ev of events) {
    if (ev.kind === 'date') {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ev.inner.trim());
      if (m) date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      continue;
    }
    const text = htmlToText(ev.inner);
    if (ev.kind === 'meta') {
      // 形如 "zoin  1:01"
      const m = /^(.*?)[\s\u00a0]+(\d{1,2}):(\d{2})$/.exec(text.replace(/\n+/g, ' ').trim());
      meta = m
        ? { sender: m[1].trim() || null, time: `${pad(m[2])}:${m[3]}` }
        : { sender: text.trim() || null, time: null };
      continue;
    }
    if (!text) continue;
    entries.push({ date, time: meta?.time ?? null, sender: meta?.sender ?? null, text });
    meta = null;
  }

  return entries.length ? entries : null;
}
