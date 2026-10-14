/**
 * 通用工具：路径、时间、JSON 读写。
 *
 * 设计原则：
 *  - 零第三方依赖（只用 Node 内置模块），便于审计。
 *  - 所有时间统一归一为 epoch 毫秒；同时保留本地日期字符串供展示。
 *  - 用户数据默认落在 ~/.selfloom/，可用 SELFLOOM_HOME 覆盖。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export const HOME = process.env.SELFLOOM_HOME || join(homedir(), '.selfloom');
export const RAW_DIR = join(HOME, 'raw');
export const OUT_DIR = join(HOME, 'out');
export const CRED_FILE = join(HOME, 'credentials.json');
export const SOURCE_DIR = join(HOME, 'sources');
export const CONFIG_FILE = join(HOME, 'config.json');

export function ensureHome() {
  for (const d of [HOME, RAW_DIR, OUT_DIR, SOURCE_DIR]) mkdirSync(d, { recursive: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带超时与自动重试的 fetch，并把「网络失败」与「认证失败」明确区分开。
 *
 * 为什么需要它（来自真实用户反馈）：
 *   第一次使用时，用户看到裸的 `fetch failed` 会以为"API Key 失效了"，
 *   于是反复去重新获取 Key——其实只是网络抖动，或者挂着代理导致国内域名走不通。
 *   网络错误必须：① 先自动重试 ② 报错时给出可操作的原因，而不是把 Node 的原始字符串抛出去。
 */
export async function fetchRetry(url, options = {}, { retries = 3, timeoutMs = 20000, debug = false } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (debug) console.error(`[net] 第 ${i + 1}/${retries} 次请求失败：${e.message}`);
      if (i < retries - 1) await sleep(700 * (i + 1));
    }
  }
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 忽略 */
  }
  const err = new Error(
    `网络请求失败 —— 这**不是** API Key / 授权码的问题\n` +
      `  连不上：${host}\n` +
      `  已自动重试 ${retries} 次仍失败。常见原因：\n` +
      `    ① 你挂着代理/梯子，而这是国内域名 —— 请先关掉代理再试\n` +
      `    ② 网络抖动或临时不可达 —— 等一会儿重试\n` +
      `  原始错误：${lastErr?.message ?? '未知'}`,
  );
  err.cause = lastErr;
  throw err;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function shortHash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export function exists(file) {
  return existsSync(file);
}

/** 把各种时间表示归一为 epoch 毫秒。支持：unix 秒、unix 毫秒、ISO 字符串。 */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '' && !/[T:\-]/.test(String(v))) {
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const p2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD */
export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 本地时区的 YYYY-MM-DD HH:mm */
export function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${fmtDate(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 简易命令行参数解析：--key value / --flag */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** 用户级配置（目前只有镜像目录这类少量键） */
export function readConfig() {
  return readJson(CONFIG_FILE, {}) ?? {};
}

export function writeConfig(patch) {
  ensureHome();
  const next = { ...readConfig(), ...patch };
  writeJson(CONFIG_FILE, next);
  return next;
}
