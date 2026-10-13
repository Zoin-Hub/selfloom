/**
 * 极简 ZIP 读取器（零依赖）。
 *
 * 做法：定位文件尾的 EOCD（End of Central Directory），读中央目录拿到
 * 每个条目的压缩方式、大小与偏移，再按本地头解析并解压。
 * 只支持最常见的 store(0) 与 deflate(8)；不支持加密与 ZIP64。
 *
 * 之所以自己实现而不引第三方库：这个工具要处理用户的私人数据与凭证，
 * 「依赖为零、全部代码可读」本身就是安全属性。
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export function readZip(file) {
  const buf = readFileSync(file);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到中央目录结束标记）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw new Error(`中央目录第 ${i + 1} 项解析失败（文件可能被截断或不支持 ZIP64）`);
    }
    const entry = {
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      uncompSize: buf.readUInt32LE(off + 24),
      nameLen: buf.readUInt16LE(off + 28),
      extraLen: buf.readUInt16LE(off + 30),
      commentLen: buf.readUInt16LE(off + 32),
      localOff: buf.readUInt32LE(off + 42),
    };
    entry.name = buf.toString('utf8', off + 46, off + 46 + entry.nameLen);
    entries.push(entry);
    off += 46 + entry.nameLen + entry.extraLen + entry.commentLen;
  }

  return entries
    .filter((e) => !e.name.endsWith('/'))
    .map((e) => ({ name: e.name, size: e.uncompSize, data: extract(buf, e) }));
}

function findEocd(buf) {
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function extract(buf, e) {
  if (buf.readUInt32LE(e.localOff) !== SIG_LOCAL) {
    throw new Error(`本地文件头解析失败：${e.name}`);
  }
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);

  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${e.method}：${e.name}`);
}

/** 便捷：从 zip 中按文件名后缀找第一个条目并当作文本读取 */
export function readTextFromZip(file, suffix) {
  const entries = readZip(file);
  const hit = entries.find((e) => e.name.toLowerCase().endsWith(suffix.toLowerCase()));
  if (!hit) throw new Error(`zip 中找不到 ${suffix}`);
  return { name: hit.name, text: hit.data.toString('utf8') };
}
