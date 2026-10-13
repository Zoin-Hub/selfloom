/**
 * DeepSeek 适配器（本地导出文件解析）
 *
 * 输入：DeepSeek 网页版「导出全部对话」产出的 deepseek_data-*.zip（内含 conversations.json）
 *      也支持直接给一个 conversations.json
 * 输出：归一化的 units（一场对话）+ items（一条消息）
 *
 * 为什么这个平台最可靠：数据已经是本地文件，无网络、无登录、无浏览器、无风控；
 * 且格式固定，解析失败会显式报错，而不是静默返回空数据。
 *
 * 隐私：导出包里的 user.json 含邮箱与手机号 —— 本适配器只读取 user_id，
 *      邮箱与手机号一律丢弃，绝不写入任何产物。
 */
import { readFileSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { readZip } from '../core/zip.mjs';
import {
  RAW_DIR, SOURCE_DIR, ensureHome, sha256, toMs, fmtDate, fmtDateTime, writeJson, shortHash,
} from '../core/util.mjs';

export const platform = 'deepseek';
export const label = 'DeepSeek';

/** 片段类型 → 角色。未知类型不会被丢弃，会记为 other 并出现在对账里。 */
const ROLE = {
  REQUEST: 'user',
  RESPONSE: 'assistant',
  THINK: 'reasoning',
};

/* ---------------- 定位导出文件 ---------------- */

export function locateExport({ file, dir } = {}) {
  if (file) return existsSync(file) ? file : null;
  const dirs = [dir, join(homedir(), 'Downloads'), join(homedir(), 'Desktop')].filter(Boolean);
  const found = [];
  for (const d of dirs) {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^(deepseek_data.*\.zip|conversations\.json)$/i.test(n)) continue;
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isFile()) found.push({ path: p, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path ?? null;
}

/* ---------------- 读取与解析 ---------------- */

function loadFrom(path) {
  const buf = readFileSync(path);
  let conversationsText;
  let userText = null;

  if (extname(path).toLowerCase() === '.zip') {
    const entries = readZip(path);
    const conv = entries.find((e) => /conversations\.json$/i.test(e.name));
    if (!conv) throw new Error('zip 里找不到 conversations.json，可能不是 DeepSeek 的导出包');
    conversationsText = conv.data.toString('utf8');
    const u = entries.find((e) => /user\.json$/i.test(e.name));
    if (u) userText = u.data.toString('utf8');
  } else {
    conversationsText = buf.toString('utf8');
  }

  let conversations;
  try {
    conversations = JSON.parse(conversationsText);
  } catch (e) {
    throw new Error(`conversations.json 解析失败：${e.message}`);
  }
  if (!Array.isArray(conversations)) throw new Error('conversations.json 顶层不是数组，格式可能已变更');

  // 只取 user_id；邮箱、手机号显式丢弃
  let userId = null;
  let piiDropped = false;
  if (userText) {
    try {
      const u = JSON.parse(userText);
      userId = u.user_id ?? null;
      if (u.email || u.mobile || u.oauth_profiles) piiDropped = true;
    } catch {
      /* 忽略 */
    }
  }
  return { conversations, userId, piiDropped, bytes: buf.length };
}

/**
 * 从 mapping（树）中取「当前主路径」：找到时间最晚的叶子，再沿 parent 回溯到 root。
 *
 * 注意：叶子 = **自己没有 children** 的节点，而不是「不在别人 children 里」的节点
 * （后者是根节点）。这里曾经写反过，导致 99 场对话全部返回空路径——
 * 这也是为什么 reconcile 里必须有一条「声明有数据却一条没抓到」的硬规则。
 *
 * 同一层有多个分支说明用户重新生成过回答，取时间最晚的那条，即用户最后看到的那条线。
 */
function mainPath(mapping) {
  const nodes = Object.values(mapping ?? {});
  if (!nodes.length) return [];

  const leaves = nodes.filter((n) => n.message && (n.children ?? []).length === 0);
  if (!leaves.length) return [];

  const t = (n) => toMs(n.message?.inserted_at) ?? 0;
  leaves.sort((a, b) => t(b) - t(a));

  const path = [];
  const seen = new Set();
  let cur = leaves[0];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parent != null ? mapping[cur.parent] : null;
  }
  return path.reverse().filter((n) => n.message);
}

/* ---------------- 主流程 ---------------- */

export function sync({ file, dir, includeThink = false, debug = false, dryRun = false } = {}) {
  ensureHome();
  const path = locateExport({ file, dir });
  if (!path) {
    throw new Error(
      '没有找到 DeepSeek 导出文件。\n' +
        '  请到 DeepSeek 网页版 → 设置 → 导出全部对话，下载 deepseek_data-*.zip，\n' +
        '  然后运行：selfloom sync deepseek            （会自动扫描下载目录）\n' +
        '  或指定路径：selfloom sync deepseek --file "路径\\deepseek_data-xxxx.zip"',
    );
  }

  const loaded = loadFrom(path);
  const { conversations, userId, piiDropped } = loaded;

  const units = [];
  const items = [];
  const fragmentTypes = {};
  let fragsOnPath = 0; // 主路径上的片段数（真正应该被导出的量）
  let fragsAll = 0; // 文件内全部片段数（含被放弃的重生成分支）
  let nodesOnPath = 0;
  let nodesAll = 0;
  let skippedReasoning = 0;
  let skippedEmpty = 0;
  let skippedToolTrace = 0;
  let skippedOther = 0;
  const diagnostics = [];

  for (const c of conversations) {
    const cid = c.id ?? shortHash(c.title ?? Math.random());
    const allNodes = Object.values(c.mapping ?? {});
    const path2 = mainPath(c.mapping);

    // 计数：文件内全部 vs 主路径。差额 = 用户重新生成过、被放弃的分支（显式归因，不算丢失）
    nodesAll += allNodes.filter((n) => n.message).length;
    nodesOnPath += path2.length;
    for (const n of allNodes) fragsAll += (n.message?.fragments ?? []).length;

    // 解析诊断：抓取结果异常时，用来定位「代码假设的形状」与实际格式的偏差
    if (debug && diagnostics.length < 5) {
      const leaves = allNodes.filter((n) => n.message && (n.children ?? []).length === 0);
      diagnostics.push({
        id: c.id,
        顶层字段: Object.keys(c).join(','),
        节点数: allNodes.length,
        有message的节点: allNodes.filter((n) => n.message).length,
        叶子数: leaves.length,
        叶子id: leaves.map((n) => n.id).slice(0, 6).join('|'),
        主路径长度: path2.length,
        首条片段类型: (path2[0]?.message?.fragments ?? []).map((f) => f.type).join('/') || null,
        非文本片段字段: (() => {
          const all = path2.flatMap((n) => n.message?.fragments ?? []);
          const o = all.find((f) => !['REQUEST', 'RESPONSE', 'THINK'].includes(String(f.type).toUpperCase()));
          return o ? `${o.type}: ${Object.keys(o).join(',')}` : null;
        })(),
      });
    }
    const md = [];
    const title = (c.title ?? '').trim() || '（无标题对话）';
    let unitItems = 0;

    md.push(`## ${title}`);
    md.push('');

    // 逐条渲染
    const blocks = [];
    for (let ni = 0; ni < path2.length; ni++) {
      const n = path2[ni];
      const msg = n.message ?? {};
      const createdMs = toMs(msg.inserted_at);
      for (let fi = 0; fi < (msg.fragments ?? []).length; fi++) {
        const f = msg.fragments[fi];
        const type = String(f.type ?? 'UNKNOWN').toUpperCase();
        fragmentTypes[type] = (fragmentTypes[type] ?? 0) + 1;
        fragsOnPath++;

        const role = ROLE[type] ?? 'other';
        const text = String(f.content ?? '').trim();
        if (!text) {
          // 检索与工具调用轨迹（SEARCH / TOOL_* / FILE）本来就没有文本正文，
          // 单独归因，不能和真正的「空内容」混在一起 —— 否则对账会掩盖问题。
          if (role === 'other') skippedToolTrace++;
          else skippedEmpty++;
          continue;
        }
        if (role === 'reasoning' && !includeThink) {
          skippedReasoning++;
          continue;
        }
        if (role === 'other') skippedOther++;

        unitItems++;
        items.push({
          id: `${platform}:${cid}:${n.id}:${fi}`,
          kind: 'chat_message',
          role,
          fragment_type: type,
          createdMs,
          unit_id: cid,
          unit_title: title,
          text,
          quote: null,
          url: null,
          timeline: role === 'user',
        });

        if (role === 'user') blocks.push(`**👤 我**\n\n${text}`);
        else if (role === 'assistant') blocks.push(`**🤖 DeepSeek**\n\n${text}`);
        else if (role === 'reasoning') blocks.push(`<details><summary>🧠 思考过程</summary>\n\n${text}\n\n</details>`);
        else blocks.push(`**· ${type}**\n\n${text}`);
      }
    }

    const firstMs = toMs(path2[0]?.message?.inserted_at);
    const lastMs = toMs(path2[path2.length - 1]?.message?.inserted_at);
    const models = [...new Set(path2.map((n) => n.message?.model).filter(Boolean))];

    md.push(
      `> ${fmtDateTime(firstMs) || '时间未知'} → ${fmtDateTime(lastMs) || '时间未知'}` +
        `${models.length ? `　·　模型 ${models.join(' / ')}` : ''}　·　${unitItems} 段`,
    );
    md.push('');
    md.push(blocks.join('\n\n'));
    md.push('');

    units.push({
      id: cid,
      title,
      createdMs: firstMs ?? toMs(c.inserted_at),
      updatedMs: lastMs ?? toMs(c.updated_at),
      itemCount: unitItems,
      markdown: md.join('\n'),
    });
  }

  // 内部一致性对账：主路径上的片段 = 导出记录 + 各类跳过。差额必须为 0。
  const kept = items.length;
  const accounted = kept + skippedReasoning + skippedEmpty + skippedToolTrace + skippedOther;
  const unattributed = fragsOnPath - accounted;

  const notes = [];
  if (includeThink) notes.push('已包含模型的思考过程（THINK 片段），产物体积会明显变大。');
  else if (skippedReasoning) notes.push(`已跳过 ${skippedReasoning} 段模型思考过程（默认不导出，加 --include-think 可包含）。`);

  const privacy = [];
  if (piiDropped) privacy.push('导出包中的邮箱与手机号已被丢弃，未写入任何产物。');

  // 来源留档（可审计、可重放）
  // dryRun：只计算、不落盘。demo 命令借此复用真实的解析与渲染，而不碰到用户的真实数据。
  const hash = sha256(readFileSync(path));
  let savedSource = null;
  if (!dryRun) {
    try {
      savedSource = join(SOURCE_DIR, `${platform}-${basename(path)}`);
      if (!existsSync(savedSource)) copyFileSync(path, savedSource);
    } catch {
      savedSource = null;
    }
  }

  const result = {
    platform,
    label,
    syncedAt: new Date().toISOString(),
    source: { path, saved_copy: savedSource, sha256: hash, bytes: loaded.bytes, kind: extname(path).slice(1) },
    account: userId ? { user_id: userId } : null,
    units,
    items,
    notes,
    privacy,
    stats: {
      declared: {
        对话数: conversations.length,
        文件内节点数: nodesAll,
        文件内片段总数: fragsAll,
        片段类型分布: fragmentTypes,
      },
      captured: {
        对话单元: units.length,
        主路径节点: nodesOnPath,
        已放弃分支节点: nodesAll - nodesOnPath,
        已放弃分支片段: fragsAll - fragsOnPath,
        导出记录: kept,
        跳过_思考过程: skippedReasoning,
        跳过_工具与检索轨迹: skippedToolTrace,
        跳过_空内容: skippedEmpty,
        未知类型: skippedOther,
      },
      // 硬性防线：文件里明明有内容，却一条都没抓到 —— 一律判为失败
      sanity: { declared_content: fragsAll, captured_content: accounted },
      unattributed,
      reconcileNote:
        '本平台没有外部计数可比对，对账口径为「内部一致性」：' +
        '主路径片段 = 导出记录 + 各类跳过，差额必须为 0。' +
        '被放弃的重新生成分支单独计数，属于显式归因，不计入丢失。',
    },
  };

  if (debug) result.diagnostics = diagnostics;
  if (!dryRun) writeJson(join(RAW_DIR, `${platform}.json`), result);
  return result;
}
