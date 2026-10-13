/**
 * 极简 IMAP 客户端（零依赖，只用 node:tls）。
 *
 * 为什么自己写：这个工具要接收用户的邮箱授权码，多一个第三方依赖就多一份
 * 供应链风险，也就少一分可审计性。我们只需要「登录 → 选信箱 → 取邮件」这条最小路径。
 *
 * 覆盖的协议要点：
 *  - 行协议 + 字面量（literal）：行尾 {N} 表示后面紧跟 N 字节原始数据（其中可能含 CRLF）
 *  - 命令用 TAG 串联，靠 `TAG OK/NO/BAD` 判定完成
 *  - LOGIN 失败时回退 AUTHENTICATE PLAIN（部分服务商只认后者）
 */
import { connect } from 'node:tls';

const CRLF = '\r\n';

export class Imap {
  constructor({ host = 'imap.qq.com', port = 993, user, pass, timeout = 60000, debug = false } = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.timeout = timeout;
    this.debug = debug;
    this.seq = 0;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.capabilities = [];
  }

  log(...a) {
    if (this.debug) console.error('[imap]', ...a);
  }

  async connect() {
    this.sock = await new Promise((resolve, reject) => {
      const s = connect({ host: this.host, port: this.port, servername: this.host });
      const fail = (e) => reject(e);
      s.once('secureConnect', () => resolve(s));
      s.once('error', fail);
      s.setTimeout(this.timeout, () => s.destroy(new Error(`IMAP 连接超时（${this.timeout}ms）`)));
    });
    this.sock.on('data', (c) => this.#onData(c));
    this.sock.on('error', (e) => this.#failAll(e));
    this.sock.on('close', () => {
      this.closed = true;
      this.#failAll(new Error('IMAP 连接已关闭'));
    });

    const greeting = await this.#next();
    this.log('greeting:', greeting.line);
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting.line)) throw new Error(`IMAP 握手失败：${greeting.line}`);

    // 尽力而为：部分服务商（如网易）要求先发 ID，QQ 不需要，失败就忽略
    try {
      await this.#run(`ID ("name" "selfloom" "version" "0.1.0")`);
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 协议收发 ---------------- */

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.#parse();
  }

  #parse() {
    for (;;) {
      const idx = this.buf.indexOf(CRLF);
      if (idx < 0) return;
      const line = this.buf.subarray(0, idx).toString('latin1');
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (m) {
        const n = Number(m[1]);
        const start = idx + CRLF.length;
        // 字面量之后通常还有一个 CRLF；等数据够了再切
        if (this.buf.length < start + n) return;
        const literal = this.buf.subarray(start, start + n);
        this.buf = this.buf.subarray(start + n);
        this.#push({ line, literal: Buffer.from(literal) });
        // 吃掉字面量后紧随的 CRLF
        if (this.buf.subarray(0, 2).toString('latin1') === CRLF) this.buf = this.buf.subarray(2);
      } else {
        this.buf = this.buf.subarray(idx + CRLF.length);
        this.#push({ line });
      }
    }
  }

  #push(token) {
    const w = this.waiters.shift();
    if (w) w.resolve(token);
    else this.queue.push(token);
  }

  #failAll(err) {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.reject(err);
  }

  #next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('IMAP 连接已关闭'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async #run(cmd) {
    const tag = `a${String(++this.seq).padStart(4, '0')}`;
    this.log('>>>', tag, cmd);
    this.sock.write(`${tag} ${cmd}${CRLF}`);
    const out = { lines: [], literals: [] };
    for (;;) {
      const t = await this.#next();
      if (t.line.startsWith(`${tag} `)) {
        out.status = t.line.slice(tag.length + 1);
        this.log('<<<', out.status);
        if (/^OK\b/i.test(out.status)) return out;
        throw new Error(`IMAP 命令失败：${out.status}`);
      }
      if (t.literal) out.literals.push({ line: t.line, data: t.literal });
      else {
        out.lines.push(t.line);
        this.log('<<<', t.line.slice(0, 160));
      }
    }
  }

  static q(s) {
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  /* ---------------- 业务方法 ---------------- */

  async login() {
    try {
      await this.#run(`LOGIN ${Imap.q(this.user)} ${Imap.q(this.pass)}`);
    } catch (e) {
      // 回退：AUTHENTICATE PLAIN（base64(\0user\0pass)）
      this.log('LOGIN 失败，回退 AUTHENTICATE PLAIN：', e.message);
      const b64 = Buffer.from(`\0${this.user}\0${this.pass}`, 'utf8').toString('base64');
      await this.#run(`AUTHENTICATE PLAIN ${b64}`);
    }
    return true;
  }

  async select(mailbox = 'INBOX') {
    const r = await this.#run(`SELECT ${Imap.q(mailbox)}`);
    const pick = (re) => {
      for (const l of r.lines) {
        const m = re.exec(l);
        if (m) return Number(m[1]);
      }
      return null;
    };
    return {
      exists: pick(/^\*\s+(\d+)\s+EXISTS/i),
      uidvalidity: pick(/\[UIDVALIDITY\s+(\d+)\]/i),
      uidnext: pick(/\[UIDNEXT\s+(\d+)\]/i),
    };
  }

  async listMailboxes() {
    const r = await this.#run('LIST "" "*"');
    return r.lines
      .map((l) => /"([^"]*)"$/.exec(l)?.[1])
      .filter(Boolean);
  }

  /** 返回 uid 数组 */
  async uidSearch(criteria = 'ALL') {
    const r = await this.#run(`UID SEARCH ${criteria}`);
    const line = r.lines.find((l) => /^\*\s+SEARCH/i.test(l));
    if (!line) return [];
    return line
      .replace(/^\*\s+SEARCH\s*/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  }

  /**
   * 批量按 UID 取数据。返回 Map<uid, Buffer>。
   * items 例如 'BODY.PEEK[]' 或 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]'
   */
  async uidFetch(uids, items) {
    const out = new Map();
    if (!uids.length) return out;
    const r = await this.#run(`UID FETCH ${uids.join(',')} (${items})`);
    // 每个字面量前面那一行形如：* 3 FETCH (UID 123 BODY[] {456}
    for (const lit of r.literals) {
      const m = /UID\s+(\d+)/i.exec(lit.line);
      if (m) out.set(Number(m[1]), lit.data);
    }
    return out;
  }

  async logout() {
    try {
      await this.#run('LOGOUT');
    } catch {
      /* 忽略 */
    }
    this.sock?.destroy();
  }

  destroy() {
    this.sock?.destroy();
  }
}
