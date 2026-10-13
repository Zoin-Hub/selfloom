#!/usr/bin/env node
/**
 * selfloom —— 把你的创作从各平台，收成一份 AI 能读的文件。
 *
 * 命令设计（对应真实生命周期「配置一次 → 反复同步」）：
 *   selfloom auth <platform>    配置并校验凭证（一次性）
 *   selfloom sync <platform>    抓取（可反复运行做增量）
 *   selfloom doctor             体检：配了什么、哪个失效了、下一步做什么
 *   selfloom export             生成统一产物（items.jsonl / timeline.md / <platform>.md）
 *   selfloom config             查看或修改本机配置
 *
 * 数据默认落在 ~/.selfloom/，可用环境变量 SELFLOOM_HOME 覆盖。
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { HOME, RAW_DIR, OUT_DIR, parseArgs, ensureHome, readJson, fmtDateTime, readConfig, writeConfig } from '../src/core/util.mjs';
import { runExport, loadPlatformResults, reconcile } from '../src/core/render.mjs';
import { runDemo } from '../src/core/demo.mjs';
import { getCred, setCred, loadCreds, mask, readClipboard } from '../src/core/secret.mjs';
import * as deepseek from '../src/adapters/deepseek.mjs';
import * as qqmail from '../src/adapters/qqmail.mjs';
import * as weread from '../src/adapters/weread.mjs';

const VERSION = '0.1.0';
const ADAPTERS = { weread, deepseek, qqmail };
const PLANNED = ['douban', 'zhihu'];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function help() {
  console.log(`${C.bold('selfloom')} ${C.dim('v' + VERSION)} —— 把你的创作从各平台，收成一份 AI 能读的文件

${C.bold('用法')}
  selfloom demo [--out 目录]          零配置看效果（样例数据，不联网、不需要凭证）
  selfloom auth <platform> [选项]     配置并校验凭证（一次性）
  selfloom sync <platform> [选项]     抓取（可反复运行做增量）
  selfloom export [--out 目录]        生成统一产物
  selfloom doctor                     体检：凭证状态 / 数据规模 / 下一步
  selfloom list                       已同步的平台
  selfloom config [set <键> <值>]     查看或修改本机配置
  selfloom help                       显示本帮助

${C.bold('已支持')}   ${Object.keys(ADAPTERS).join(', ')}
${C.bold('开发中')}   ${PLANNED.join(', ')}

${C.bold('auth 选项')}
  --clipboard          从剪贴板读取（先在浏览器里复制好）
  --key <API Key>      weread：直接传入 API Key（wrk- 开头）
  --user <邮箱>        qqmail：你的 QQ 邮箱地址
  --pass <授权码>      qqmail：16 位 IMAP 授权码

${C.bold('sync 选项')}
  --file <路径>        DeepSeek：导出 zip 或 conversations.json
  --dir <目录>         指定扫描目录
  --include-think      包含模型思考过程（默认不导出）
  --allow-from <子串>  QQ邮箱：发件人白名单（逗号分隔，如 dingtalk.com）——命中即收
  --self <邮箱>        QQ邮箱：额外视为「自己」的地址（逗号分隔）
  --all                QQ邮箱：不筛选，导出全部邮件
  --since <日期>       QQ邮箱：只取该日期之后的邮件（如 2026-01-01）
  --limit <n>          QQ邮箱：只处理最后 n 封（试跑用）
  --dry-run            QQ邮箱：只勘探计数，不下载正文（先看规模再决定）
  --batch <n>          QQ邮箱：每批下载几封正文（默认 5，越大越快越占内存）
  --no-attachments     QQ邮箱：不保存任何附件
  --max-attachment-mb <n>   QQ邮箱：超过 n MB 的附件不保存（默认 20）
  --archive-attachments     QQ邮箱：连压缩包也保存（默认不保存）
  --inline-attachments      QQ邮箱：连内嵌图片也保存（默认不保存）
  --match-to                QQ邮箱：同时按收件人匹配自己（默认只看发件人）
  --accept-broad             QQ邮箱：命中比例过高时不再拦截（确认规则无误时用）
  --force              忽略缓存，全部重抓
  --debug              输出协议/解析诊断

${C.bold('数据位置')} ${HOME}
  ${C.dim('可用环境变量 SELFLOOM_HOME 覆盖')}
`);
}

function syncSummary(r, ms) {
  console.log(`${C.green('✓')} ${r.label} 同步完成 ${C.dim(`(${(ms / 1000).toFixed(1)}s)`)}`);
  console.log(`  单元 ${C.bold(r.units.length)} 个 · 记录 ${C.bold(r.items.length)} 条`);
  console.log(`  ${C.dim('来源声称：')}${JSON.stringify(r.stats.declared)}`);
  console.log(`  ${C.dim('实际抓到：')}${JSON.stringify(r.stats.captured)}`);
  const rc = reconcile(r);
  console.log(`  对账：${rc.ok ? C.green('通过（差额 0、无静默丢失）') : C.red(`未通过：${rc.reason}`)}`);
  for (const n of r.notes ?? []) console.log(`  ${C.dim('ℹ')} ${n}`);
  for (const p of r.privacy ?? []) console.log(`  ${C.green('🔒')} ${p}`);
  if (r.source?.saved_copy) console.log(`  ${C.dim('来源留档：')}${r.source.saved_copy}`);
}

function progressPrinter() {
  return (p) => {
    if (p.done % 20 === 0 || p.done === p.total) {
      const name = p.phase === 'headers' ? '筛选邮件' : '抓取正文';
      console.log(`  ${C.dim(`${name} ${p.done}/${p.total}`)}`);
    }
  };
}

async function cmdSync(args) {
  const p = args._[1];
  if (!p) throw new Error('用法：selfloom sync <platform>');
  const a = ADAPTERS[p];
  if (!a) {
    throw new Error(
      `暂不支持 platform：${p}\n  已支持：${Object.keys(ADAPTERS).join(', ')}\n  开发中：${PLANNED.join(', ')}`,
    );
  }
  const t0 = Date.now();
  const r = await a.sync({
    apiKey: typeof args.key === 'string' ? args.key : undefined,
    file: typeof args.file === 'string' ? args.file : undefined,
    dir: typeof args.dir === 'string' ? args.dir : undefined,
    includeThink: Boolean(args['include-think']),
    user: typeof args.user === 'string' ? args.user : undefined,
    pass: typeof args.pass === 'string' ? args.pass : undefined,
    all: Boolean(args.all),
    self: typeof args.self === 'string' ? args.self : undefined,
    allowFrom: typeof args['allow-from'] === 'string' ? args['allow-from'] : undefined,
    noAttachments: Boolean(args['no-attachments']),
    archiveAttachments: Boolean(args['archive-attachments']),
    inlineAttachments: Boolean(args['inline-attachments']),
    acceptBroad: Boolean(args['accept-broad']),
    matchTo: Boolean(args['match-to']),
    maxAttachmentMb: args['max-attachment-mb'],
    since: typeof args.since === 'string' ? args.since : undefined,
    limit: args.limit,
    batch: args.batch,
    dryRun: Boolean(args['dry-run']),
    force: Boolean(args.force),
    debug: Boolean(args.debug),
    onProgress: p === 'qqmail' ? progressPrinter() : undefined,
  });
  if (r.dryRun) {
    console.log(`${C.green('✓')} ${r.label} 勘探完成 ${C.dim('（未下载任何正文）')}`);
    console.log(`  ${C.dim('来源声称：')}${JSON.stringify(r.stats.declared)}`);
    console.log(`  ${C.dim('实际抓到：')}${JSON.stringify(r.stats.captured)}`);
    const rc = reconcile(r);
    console.log(`  对账：${rc.ok ? C.green('通过') : C.red(`未通过：${rc.reason}`)}`);
    for (const n of r.notes ?? []) console.log(`  ${C.dim('ℹ')} ${n}`);
    return;
  }
  syncSummary(r, Date.now() - t0);
  if (Array.isArray(r.diagnostics) && r.diagnostics.length) {
    console.log(`\n${C.dim('— 解析诊断（前几条对话，用于定位格式偏差）—')}`);
    for (const d of r.diagnostics) console.log('  ' + JSON.stringify(d));
  }
  console.log(`\n下一步：${C.bold('selfloom export')} 生成统一产物`);
}

async function cmdAuth(args) {
  const p = args._[1];
  if (p === 'qqmail') {
    let user = typeof args.user === 'string' ? args.user : (getCred('qqmail')?.user ?? null);
    let pass = typeof args.pass === 'string' ? args.pass : null;
    if (!pass && args.clipboard) {
      pass = readClipboard();
      if (!pass) throw new Error('没能读到剪贴板内容。请先复制 16 位授权码，或用 --pass <授权码> 传入。');
    }
    if (!user) throw new Error('请用 --user 指定邮箱地址，例如：selfloom auth qqmail --user you@qq.com --clipboard');
    if (!pass) throw new Error('缺少授权码：先复制授权码再加 --clipboard，或用 --pass <授权码> 传入。');

    console.log(`${C.dim('正在用 IMAP 验证凭证…')}`);
    const info = await qqmail.verify({ user, pass, debug: Boolean(args.debug) });
    setCred('qqmail', { user, pass, host: info.host, port: 993, mailbox: info.mailbox });
    console.log(`${C.green('✓')} 凭证有效`);
    console.log(`  账号     ${info.user}`);
    console.log(`  服务器   ${info.host}`);
    console.log(`  收件箱   ${info.mailbox} · ${info.exists} 封邮件`);
    console.log(`  授权码   ${mask(pass)} ${C.dim('（只存在本机，未写入任何产物）')}`);
    console.log(`\n下一步：${C.bold('selfloom sync qqmail --limit 5')} 先试跑 5 封`);
    return;
  }
  if (p === 'weread') {
    let key = typeof args.key === 'string' ? args.key : null;
    if (!key && args.clipboard) {
      key = readClipboard();
      if (!key) throw new Error('没能读到剪贴板内容。请先复制 API Key（wrk- 开头），或用 --key <API Key> 传入。');
    }
    if (!key) {
      throw new Error(
        '缺少 API Key。\n' +
          '  1) 打开 https://weread.qq.com/r/weread-skills 登录后获取 API Key（wrk- 开头）\n' +
          '  2) 复制它，然后运行：selfloom auth weread --clipboard',
      );
    }
    key = String(key).trim();
    console.log(`${C.dim('正在校验 API Key…')}`);
    const info = await weread.verify({ apiKey: key, debug: Boolean(args.debug) });
    setCred('weread', { api_key: key });
    console.log(`${C.green('✓')} API Key 有效`);
    console.log(`  有笔记的书   ${info.totalBookCount} 本`);
    console.log(`  笔记总数     ${info.totalNoteCount} 条 ${C.dim('（统计口径）')}`);
    console.log(`  API Key      ${mask(key)} ${C.dim('（只存在本机，未写入任何产物）')}`);
    console.log(`\n下一步：${C.bold('selfloom sync weread')}  ${C.dim('（首次约 2–3 分钟，之后是秒级增量）')}`);
    return;
  }
  throw new Error(`用法：selfloom auth <platform>（可配置：weread、qqmail）`);
}

function cmdExport(args) {
  const outDir = typeof args.out === 'string' ? args.out : OUT_DIR;
  const cfg = readConfig();
  const mirrorDir = typeof args.mirror === 'string' ? args.mirror : (cfg.mirror_dir ?? null);
  const r = runExport({ outDir, mirrorDir });
  console.log(`${C.green('✓')} 产物已生成于 ${C.bold(outDir)}`);
  console.log(`  items.jsonl    ${r.items} 条记录`);
  console.log(`  timeline.md    ${r.timeline} 条时间线条目 ${C.dim('★ 核心产物')}`);
  for (const p of r.platforms) console.log(`  ${(p.platform + '.md').padEnd(16)}${p.items} 条`);
  console.log(`  manifest.json  对账与元数据`);
  if (r.mirrored) console.log(`  ${C.green('↳')} 已镜像到 ${r.mirrored.dir}${C.dim(`（${r.mirrored.files.length} 个文件）`)}`);
  const bad = r.reconciles.filter((x) => !x.ok);
  if (bad.length) {
    console.log(`\n${C.red('⚠ 对账未通过：')}${bad.map((b) => b.platform).join(', ')} —— ${bad[0].reason}`);
    process.exitCode = 2;
  } else {
    console.log(`\n${C.green('对账全部通过')}：${r.reconciles.length} 个平台，无静默丢失`);
  }
}

function cmdList() {
  const results = loadPlatformResults();
  if (!results.length) {
    console.log('还没有任何平台数据。');
    console.log(`下一步：${C.bold('selfloom sync deepseek')}`);
    return;
  }
  console.log(C.bold('已同步的平台：'));
  for (const r of results) {
    console.log(`  ${r.platform.padEnd(10)} ${String(r.items.length).padStart(6)} 条  ${C.dim(fmtDateTime(Date.parse(r.syncedAt)))}`);
  }
}

function cmdDoctor() {
  ensureHome();
  const cfg = readConfig();
  const creds = loadCreds();
  console.log(C.bold('selfloom 体检报告'));
  console.log(`  数据目录   ${HOME}`);
  console.log(`  产物目录   ${OUT_DIR}`);
  console.log(`  镜像目录   ${cfg.mirror_dir ? cfg.mirror_dir : C.dim('未设置（selfloom config set mirror <目录>）')}`);
  console.log('');

  const results = loadPlatformResults();
  const synced = new Set(results.map((r) => r.platform));
  console.log(C.bold('平台状态'));
  for (const key of Object.keys(ADAPTERS)) {
    const r = results.find((x) => x.platform === key);
    const cred = creds[key];
    const credText =
      key === 'deepseek'
        ? C.dim('无需凭证')
        : cred
          ? C.green(`凭证已配置${cred.user ? `（${cred.user}）` : cred.api_key ? `（${mask(cred.api_key)}）` : ''}`)
          : C.yellow('未配置凭证');
    if (!r) {
      console.log(`  ${key.padEnd(10)} ${C.yellow('未同步')}  ${credText}`);
      continue;
    }
    const rc = reconcile(r);
    console.log(
      `  ${key.padEnd(10)} ${rc.ok ? C.green('正常') : C.red('对账异常')}  ${String(r.items.length).padStart(6)} 条 · 上次同步 ${fmtDateTime(Date.parse(r.syncedAt))}  ${credText}`,
    );
    if (r.source?.path) console.log(`  ${' '.repeat(10)} ${C.dim('来源：')}${r.source.path}`);
    if (r.source?.account) console.log(`  ${' '.repeat(10)} ${C.dim('账号：')}${r.source.account} · 收件箱 ${r.source.mailbox_total} 封`);
    if (r.source?.total_book_count !== undefined) {
      console.log(`  ${' '.repeat(10)} ${C.dim('账号笔记：')}${r.source.total_book_count} 本 · ${r.source.total_note_count} 条（统计口径）`);
    }
  }
  for (const p of PLANNED) if (!synced.has(p)) console.log(`  ${p.padEnd(10)} ${C.dim('开发中')}`);

  console.log('');
  console.log(C.bold('下一步'));
  const next = [];
  for (const key of Object.keys(ADAPTERS)) {
    if (synced.has(key)) continue;
    if (key === 'deepseek') next.push(`selfloom sync deepseek`.padEnd(26) + C.dim('先在 DeepSeek 网页版导出对话数据'));
    else if (!creds[key]) next.push(`selfloom auth ${key}`.padEnd(26) + C.dim('先获取凭证'));
    else next.push(`selfloom sync ${key}`.padEnd(26) + C.dim('可先加 --dry-run 或 --limit 试跑'));
  }
  if (results.length) next.push('selfloom export'.padEnd(26) + C.dim('生成 items.jsonl / timeline.md'));
  if (!next.length) next.push('一切就绪，跑 selfloom export 更新产物');
  next.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
}

const CONFIG_KEYS = {
  mirror: { path: ['mirror_dir'], parse: (v) => (v === 'off' ? null : v) },
  'qqmail.allow_from': { path: ['qqmail', 'allow_senders'], parse: (v) => v.split(/[,;\s]+/).filter(Boolean) },
  'qqmail.self': { path: ['qqmail', 'self_addresses'], parse: (v) => v.split(/[,;\s]+/).filter(Boolean) },
  'qqmail.max_attachment_mb': { path: ['qqmail', 'max_attachment_mb'], parse: (v) => Number(v) },
  'qqmail.save_archives': { path: ['qqmail', 'save_archives'], parse: (v) => v === 'on' || v === 'true' },
  'qqmail.save_inline': { path: ['qqmail', 'save_inline'], parse: (v) => v === 'on' || v === 'true' },
  'qqmail.match_to': { path: ['qqmail', 'match_to'], parse: (v) => v === 'on' || v === 'true' },
};

function cmdConfig(args) {
  const cfg = readConfig();

  if (args._[1] === 'set') {
    const key = args._[2];
    const value = args._[3];
    if (!key || value === undefined) throw new Error('用法：selfloom config set <键> <值>');
    const spec = CONFIG_KEYS[key];
    if (!spec) throw new Error(`不支持的配置键：${key}\n可用：${Object.keys(CONFIG_KEYS).join('、')}`);
    let cur = cfg;
    for (const k of spec.path.slice(0, -1)) {
      cur[k] = { ...(cur[k] ?? {}) };
      cur = cur[k];
    }
    const parsed = spec.parse(value);
    cur[spec.path[spec.path.length - 1]] = parsed;
    writeConfig(cfg);
    console.log(`${C.green('✓')} 已设置 ${key} = ${JSON.stringify(parsed)}`);
    return;
  }

  const q = cfg.qqmail ?? {};
  console.log(C.bold('当前配置'));
  console.log(`  mirror                     ${cfg.mirror_dir ?? '（未设置）'}`);
  console.log(`  qqmail.self                ${(q.self_addresses ?? []).join(', ') || '（仅登录账号）'}`);
  console.log(`  qqmail.allow_from          ${(q.allow_senders ?? []).join(', ') || '（未设置）'}`);
  console.log(`  qqmail.max_attachment_mb   ${q.max_attachment_mb ?? 20}`);
  console.log(`  qqmail.save_archives       ${q.save_archives ? 'on' : 'off'}`);
  console.log(`  qqmail.save_inline         ${q.save_inline ? 'on' : 'off'}`);
  console.log(`  qqmail.match_to            ${q.match_to ? 'on（同时按收件人匹配）' : 'off（只看发件人）'}`);
  console.log(`\n${C.dim('例：selfloom config set qqmail.allow_from "dingtalk.com"')}`);
  console.log(`${C.dim('    selfloom config set mirror "D:\\\\某目录"    关闭镜像：selfloom config set mirror off')}`);
}

function cmdDemo(args) {
  const outDir = typeof args.out === 'string' ? args.out : join(HOME, 'demo');
  const r = runDemo({ outDir });
  console.log(`${C.green('✓')} demo 产物已生成于 ${C.bold(outDir)}`);
  console.log(`  ${C.dim('样例数据全部虚构；没有读取、也没有改动你的任何真实数据或产物')}`);
  console.log('');
  console.log(`  timeline.md     ${String(r.timeline).padStart(5)} 条时间线条目 ${C.dim('★ 先看这个')}`);
  console.log(`  items.jsonl     ${String(r.items).padStart(5)} 条记录`);
  for (const p of r.platforms) console.log(`  ${(p.platform + '.md').padEnd(15)} ${String(p.items).padStart(5)} 条`);
  console.log(`  manifest.json        对账与元数据`);
  console.log('');
  console.log(C.dim('— timeline.md 开头预览 —'));
  const preview = readFileSync(join(outDir, 'timeline.md'), 'utf8').split('\n').slice(0, 24).join('\n');
  console.log(preview);
  console.log('');
  console.log(C.bold('这就是你接入真实平台后会得到的东西。'));
  console.log(`下一步：${C.bold('selfloom auth <platform>')}`);
  console.log(`  ${C.dim('可接入：weread（API Key）· deepseek（网页版导出 zip）· qqmail（IMAP 授权码）')}`);
  console.log(`  ${C.dim(`完整说明：selfloom help`)}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'help';

try {
  if (cmd === 'sync') await cmdSync(args);
  else if (cmd === 'auth') await cmdAuth(args);
  else if (cmd === 'demo') cmdDemo(args);
  else if (cmd === 'export') cmdExport(args);
  else if (cmd === 'list') cmdList();
  else if (cmd === 'doctor') cmdDoctor();
  else if (cmd === 'config') cmdConfig(args);
  else if (cmd === 'version' || args.version) console.log(VERSION);
  else help();
} catch (e) {
  console.error(`${C.red('✗')} ${e.message}`);
  process.exitCode = 1;
}
