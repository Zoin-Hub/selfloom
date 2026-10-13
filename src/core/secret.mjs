/**
 * 凭证存储。
 *
 * 阶段一：本机文件（~/.selfloom/credentials.json），权限尽量收紧，并在 doctor 里明确提示。
 * 阶段二（计划中）：接入系统密钥库（Windows DPAPI / macOS Keychain / Linux libsecret）。
 *
 * 原则：
 *  - 凭证只在本地，不上传、不打印、不写进任何产物。
 *  - 命令行里传入的凭证不应出现在日志里 —— 输出一律走 mask()。
 */
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CRED_FILE, ensureHome, readJson } from './util.mjs';

export function loadCreds() {
  return readJson(CRED_FILE, {}) ?? {};
}

export function getCred(platform) {
  return loadCreds()[platform] ?? null;
}

export function setCred(platform, value) {
  ensureHome();
  const all = loadCreds();
  all[platform] = { ...(all[platform] ?? {}), ...value, saved_at: new Date().toISOString() };
  writeFileSync(CRED_FILE, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(CRED_FILE, 0o600);
  } catch {
    /* Windows 上 chmod 基本无效，靠目录权限，文档里已说明 */
  }
  return all[platform];
}

export function credsFileExists() {
  return existsSync(CRED_FILE);
}

/** 只显示首尾各 3 位，用于「确认你填对了」而不是「把密钥说出来」 */
export function mask(secret) {
  const s = String(secret ?? '');
  if (s.length <= 8) return s ? `${s.slice(0, 1)}***` : '';
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/**
 * 读系统剪贴板（尽力而为，跨平台，零依赖）。
 * 目的：用户在浏览器里复制完 API Key / 授权码后，不必再手动粘贴一遍。
 */
export function readClipboard() {
  const attempts =
    process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]]
      : process.platform === 'darwin'
        ? [['pbpaste', []]]
        : [
            ['xclip', ['-selection', 'clipboard', '-o']],
            ['xsel', ['--clipboard', '--output']],
          ];
  for (const [cmd, args] of attempts) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}
