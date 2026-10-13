#!/usr/bin/env node
/**
 * DeepSeek 导出格式 · 契约检查工具
 *
 * 用途：当 DeepSeek 调整导出格式、或适配器抓不到数据时，用它把真实的树形结构打出来，
 *      定位「代码假设的形状」与「实际格式」的偏差。属于维护工具，不参与正式导出流程。
 *
 * 用法：node scripts/inspect-deepseek.mjs "<deepseek_data-xxxx.zip>"
 */
import { readZip } from '../src/core/zip.mjs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/inspect-deepseek.mjs "<导出文件.zip>"');
  process.exit(1);
}

const entries = readZip(file);
console.log('zip 条目：');
for (const e of entries) console.log(`  ${e.name}  ${e.size} bytes`);

const convEntry = entries.find((e) => /conversations\.json$/i.test(e.name));
if (!convEntry) throw new Error('zip 中找不到 conversations.json');
const conversations = JSON.parse(convEntry.data.toString('utf8'));

console.log(`\n对话数：${conversations.length}`);
const c = conversations[0];
console.log(`第 1 场对话的顶层字段：${Object.keys(c).join(', ')}`);
console.log(`title：${JSON.stringify(String(c.title ?? '').slice(0, 40))}`);

const nodes = Object.values(c.mapping ?? {});
console.log(`节点数：${nodes.length}`);

console.log('\n拓扑（前 12 个节点）：');
for (const n of nodes.slice(0, 12)) {
  const fr = n.message?.fragments;
  const fragDesc = Array.isArray(fr) ? `${fr.length}:[${fr.map((f) => f.type).join('/')}]` : String(fr);
  console.log(
    `  id=${JSON.stringify(n.id)} parent=${JSON.stringify(n.parent)} ` +
      `children=${JSON.stringify(n.children)} (isArray=${Array.isArray(n.children)}, len=${n.children?.length ?? 'n/a'}) ` +
      `msg=${n.message ? 'Y' : 'N'} frags=${fragDesc}`,
  );
}

const ids = new Set(nodes.map((n) => n.id));
const dangling = [];
for (const n of nodes) for (const ch of n.children ?? []) if (!ids.has(ch)) dangling.push(`${JSON.stringify(n.id)}→${JSON.stringify(ch)}`);
console.log(`\nchildren 指向不存在的节点：${dangling.length ? dangling.slice(0, 8).join(', ') : '无'}`);

const hasChild = new Set();
for (const n of nodes) for (const ch of n.children ?? []) hasChild.add(ch);

console.log(`\n有 message 的节点数：${nodes.filter((n) => n.message).length}`);
console.log(`无 children 的节点 id：${JSON.stringify(nodes.filter((n) => !n.children || n.children.length === 0).map((n) => n.id))}`);
console.log(`有 message 且不在任何 children 里的 id：${JSON.stringify(nodes.filter((n) => n.message && !hasChild.has(n.id)).map((n) => n.id))}`);
console.log(`所有节点 id：${JSON.stringify(nodes.map((n) => n.id))}`);

console.log('\n最后一个节点的原始内容（截断 900 字符）：');
console.log(JSON.stringify(nodes[nodes.length - 1]).slice(0, 900));

console.log('\n第一个有 message 的节点的 fragments（截断 400 字符）：');
const firstMsg = nodes.find((n) => n.message);
console.log(JSON.stringify(firstMsg?.message?.fragments).slice(0, 400));
