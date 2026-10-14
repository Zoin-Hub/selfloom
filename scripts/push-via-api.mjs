#!/usr/bin/env node
/**
 * 通过 GitHub API 提交代码（当 git 的传输通道不通时的备用通道）
 *
 * 为什么需要它：
 *   在某些网络环境下，`git push`（走 git 自己的 HTTPS 传输）会被重置或超时，
 *   但普通 HTTPS 请求（Node 的 fetch）却是通的。这时可以用 GitHub 的 Git Data API
 *   完成同样的提交：blob → tree → commit → 更新分支引用。
 *
 * 用法：
 *   $env:GH_TOKEN = "<你的 GitHub 令牌>"
 *   node scripts/push-via-api.mjs --message "提交说明"
 *   node scripts/push-via-api.mjs --message "..." --dry-run    # 只看会提交哪些文件
 *
 * 注意：本脚本会把「工作区里所有未被排除的文件」整体作为一次提交的内容，
 *      因此提交后远端状态 = 你本地当前状态。排除项见 SKIP 常量。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 'Zoin-Hub';
const REPO = 'selfloom';
const BRANCH = 'main';
const API = 'https://api.github.com';

/** 不提交的路径（与 .gitignore 保持一致，这里是硬性兜底） */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.selfloom', '.vscode', '.idea']);
const SKIP_FILES = new Set(['.npmrc', 'credentials.json', 'Thumbs.db', '.DS_Store']);

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const message = getArg('--message');
const dryRun = args.includes('--dry-run');
const token = process.env.GH_TOKEN || getArg('--token');

if (!message) {
  console.error('用法：node scripts/push-via-api.mjs --message "提交说明" [--dry-run]');
  process.exit(1);
}
if (!token && !dryRun) {
  console.error('缺少令牌：请设置环境变量 GH_TOKEN');
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'selfloom',
  'Content-Type': 'application/json',
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    const parts = rel.split(sep);
    if (parts.some((p) => SKIP_DIRS.has(p))) continue;
    if (SKIP_FILES.has(name)) continue;
    if (name.endsWith('.tgz') || name.endsWith('.log')) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push({ rel: parts.join('/'), full, size: st.size });
  }
  return out;
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${json?.message ?? text.slice(0, 200)}`);
  }
  return json;
}

const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`  本地待提交文件：${files.length} 个`);
if (dryRun) {
  for (const f of files) console.log(`    ${f.rel}  (${f.size} B)`);
  console.log('  --dry-run，未提交');
  process.exit(0);
}

// 1) 当前分支头
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const parentSha = ref.object.sha;
const parent = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
console.log(`  远端当前 HEAD：${parentSha.slice(0, 7)}  ${parent.message.split('\n')[0]}`);

// 2) 逐个上传 blob（内容未变时 GitHub 会复用，不会重复占空间）
const tree = [];
for (const f of files) {
  const content = readFileSync(f.full);
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
}
console.log(`  已上传 ${tree.length} 个 blob`);

// 3) 建树（不带 base_tree → 该提交即工作区完整状态，被删掉的文件也会随之消失）
const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree });
console.log(`  已建树：${newTree.sha.slice(0, 7)}`);

// 4) 建提交
const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [parentSha],
});
console.log(`  已建提交：${commit.sha.slice(0, 7)}`);

// 5) 更新分支引用
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log(`  ✅ 已更新 ${BRANCH} → ${commit.sha.slice(0, 7)}`);
console.log(`     ${commit.html_url}`);
