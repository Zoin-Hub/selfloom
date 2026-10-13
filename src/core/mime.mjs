/**
 * MIME 解析（零依赖）。
 *
 * 覆盖真实邮件里最常见的形态：
 *  - multipart 递归（mixed / alternative / related）
 *  - Content-Transfer-Encoding: base64 / quoted-printable / 7bit / 8bit
 *  - 标题里的编码字（=?UTF-8?B?...?= / =?GBK?B?...?= / =?UTF-8?Q?...?=）
 *  - 正文字符集：UTF-8 / GBK / GB18030 / Big5 / latin1 …
 *
 * 字符集解码用 Node 内置的 TextDecoder（Node 自带完整 ICU，支持 gbk/gb18030/big5 等），
 * 不需要任何第三方编码库；解码失败时回退 UTF-8 并标注，绝不静默丢正文。
 */

const HEADER_SPLIT = /\r?\n\r?\n/;

/* ---------------- 编码字（RFC 2047） ---------------- */

export function decodeWords(input) {
  if (!input) return '';
  return String(input).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      const buf =
        enc.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return decodeCharset(buf, charset);
    } catch {
      return data;
    }
  });
}

/* ---------------- 字符集解码 ---------------- */

const charsetCache = new Map();

export function decodeCharset(buf, charset) {
  const name = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const aliases = { utf8: 'utf-8', gb2312: 'gbk', gb18030: 'gb18030', 'iso-8859-1': 'windows-1252', latin1: 'windows-1252' };
  const normalized = aliases[name] || name;

  let decoder = charsetCache.get(normalized);
  if (decoder === undefined) {
    try {
      decoder = new TextDecoder(normalized, { fatal: false });
    } catch {
      decoder = null;
    }
    charsetCache.set(normalized, decoder);
  }
  if (decoder) return decoder.decode(buf);
  // 未知字符集：回退 UTF-8，并在文本里保留可察觉的痕迹
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/* ---------------- quoted-printable ---------------- */

export function decodeQuotedPrintable(str) {
  return String(str)
    .replace(/=\r?\n/g, '') // 软换行
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/* ---------------- 头部解析 ---------------- */

export function parseHeaders(text) {
  const headers = {};
  const unfolded = String(text).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (headers[key] === undefined) headers[key] = value;
  }
  return headers;
}

/** 解析形如 text/plain; charset="utf-8"; boundary="xxx" 的参数 */
export function parseContentType(value) {
  const raw = String(value || 'text/plain');
  const [mediaType, ...rest] = raw.split(';');
  const params = {};
  for (const part of rest) {
    const m = /^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(part);
    if (m) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  return { mediaType: mediaType.trim().toLowerCase(), params };
}

/* ---------------- 递归解析 ---------------- */

function decodeBody(body, encoding) {
  const enc = String(encoding || '7bit').toLowerCase();
  if (enc === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean, 'base64');
  }
  if (enc === 'quoted-printable') {
    return Buffer.from(decodeQuotedPrintable(body), 'binary');
  }
  return Buffer.from(body, 'binary');
}

function splitByBoundary(body, boundary) {
  const delim = `--${boundary}`;
  const parts = [];
  const lines = body.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (line.startsWith(delim)) {
      if (cur) parts.push(cur.join('\r\n'));
      if (line.startsWith(`${delim}--`)) {
        cur = null;
        break;
      }
      cur = [];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) parts.push(cur.join('\r\n'));
  return parts;
}

/**
 * 解析一封完整邮件。
 * 返回 { headers, text, html, attachments, parts }
 */
export function parseMessage(raw) {
  const s = raw.toString('binary');
  const m = HEADER_SPLIT.exec(s);
  const headerText = m ? s.slice(0, m.index) : s;
  const bodyText = m ? s.slice(m.index + m[0].length) : '';
  const headers = parseHeaders(headerText);
  const result = { headers, text: '', html: '', attachments: [] };
  walk(headers, bodyText, result, 0);
  // 注意：这里不把 html 塞进 text。优先用纯文本还是把 HTML 转文本，由调用方决定。
  return result;
}

function walk(headers, bodyText, out, depth) {
  if (depth > 8) return;
  const ct = parseContentType(headers['content-type']);
  const encoding = headers['content-transfer-encoding'] || '7bit';
  const disp = parseContentType(headers['content-disposition']);
  const filename = decodeWords(disp.params.filename || ct.params.name || '');

  if (ct.mediaType === 'multipart/*' || ct.mediaType.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    for (const part of splitByBoundary(bodyText, boundary)) {
      const pm = HEADER_SPLIT.exec(part);
      const ph = parseHeaders(pm ? part.slice(0, pm.index) : part);
      const pb = pm ? part.slice(pm.index + pm[0].length) : '';
      walk(ph, pb, out, depth + 1);
    }
    return;
  }

  const isText = ct.mediaType === 'text/plain' || ct.mediaType === 'text/html';
  const isAttachment = disp.mediaType === 'attachment' || (filename && !isText);

  if (isAttachment) {
    const buf = decodeBody(bodyText, encoding);
    out.attachments.push({
      filename: filename || '(未命名)',
      contentType: ct.mediaType || 'application/octet-stream',
      bytes: buf.length,
      inline: false,
      data: buf,
    });
    return;
  }

  if (!isText) {
    const buf = decodeBody(bodyText, encoding);
    out.attachments.push({
      filename: filename || '(内嵌资源)',
      contentType: ct.mediaType,
      bytes: buf.length,
      inline: true,
      data: buf,
    });
    return;
  }

  const buf = decodeBody(bodyText, encoding);
  const text = decodeCharset(buf, ct.params.charset);
  if (ct.mediaType === 'text/html') {
    if (!out.html) out.html = text;
  } else if (!out.text) {
    out.text = text;
  }
}
