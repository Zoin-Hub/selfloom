#!/usr/bin/env node
/**
 * 邮件格式 · 契约检查工具
 *
 * 用途：当某封邮件解析失败（例如「正文为空」）时，把它真实的 MIME 结构打出来，
 *      判断是「邮件确实没有文本」还是「解析器漏了某一层」。
 *
 * 用法：node scripts/inspect-mail.mjs <uid> [uid2 uid3 ...]
 */
import { Imap } from '../src/core/imap.mjs';
import { parseMessage, parseContentType } from '../src/core/mime.mjs';
import { htmlToText } from '../src/core/html.mjs';
import { getCred } from '../src/core/secret.mjs';

const uids = process.argv.slice(2).map(Number).filter(Boolean);
if (!uids.length) {
  console.error('用法：node scripts/inspect-mail.mjs <uid> [uid2 ...]');
  process.exit(1);
}

const cred = getCred('qqmail');
if (!cred) {
  console.error('还没有配置 QQ 邮箱凭证，先运行：selfloom auth qqmail ...');
  process.exit(1);
}

const imap = new Imap({ user: cred.user, pass: cred.pass, host: cred.host, port: cred.port, timeout: 60000 });
try {
  await imap.connect();
  await imap.login();
  await imap.select('INBOX');
  const got = await imap.uidFetch(uids, 'BODY.PEEK[]');

  for (const uid of uids) {
    const raw = got.get(uid);
    console.log(`\n================ UID ${uid} ================`);
    if (!raw) {
      console.log('  服务端没有返回内容');
      continue;
    }
    const parsed = parseMessage(raw);
    const h = parsed.headers;
    console.log(`  原始报文字节数: ${raw.length}`);
    console.log(`  From:    ${h.from ?? ''}`);
    console.log(`  To:      ${h.to ?? ''}`);
    console.log(`  Subject: ${h.subject ?? ''}`);
    console.log(`  Date:    ${h.date ?? ''}`);
    const ct = parseContentType(h['content-type']);
    console.log(`  顶层类型: ${ct.mediaType} ${JSON.stringify(ct.params)}`);
    console.log(`  传输编码: ${h['content-transfer-encoding'] ?? '(无)'}`);
    console.log(`  解析结果: text=${parsed.text.length} 字符, html=${parsed.html.length} 字符, 附件=${parsed.attachments.length} 个`);
    for (const a of parsed.attachments) {
      console.log(`    - 附件 ${a.filename} (${a.contentType}, ${a.bytes} B)`);
    }
    const fromHtml = htmlToText(parsed.html);
    console.log(`  htmlToText 后: ${fromHtml.length} 字符`);
    if (fromHtml) console.log(`    预览: ${JSON.stringify(fromHtml.slice(0, 160))}`);

    // 原始正文预览：用于判断解析器是否漏层
    const s = raw.toString('binary');
    const i = s.indexOf('\r\n\r\n');
    const body = (i >= 0 ? s.slice(i + 4) : s).slice(0, 400);
    console.log(`  原始正文前 400 字符: ${JSON.stringify(body.replace(/[^\x20-\x7E\r\n]/g, '·'))}`);
  }
  await imap.logout();
} catch (e) {
  console.error('检查失败：' + e.message);
  process.exitCode = 1;
  imap.destroy();
}
