// 版本安装包：元数据存 D1 version_packages，二进制分块 Base64 存 package_chunks。
// 单包上限 20MB（D1 单行/响应体积限制）；下载走流式，避免大文件占满内存。
import * as db from './db.js';
import { randomTokenHex } from './util.js';

const CHUNK_SIZE = 512 * 1024;
export const MAX_SIZE = 20 * 1024 * 1024;

function b64encode(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
function b64decode(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function listPackages() {
  const rows = await db.query(
    'SELECT id, pkg_key, name, version, size, sha256, uploaded_by, created_at, downloads FROM version_packages ORDER BY created_at DESC'
  );
  return rows.map(r => ({ ...r, downloads: Number(r.downloads) || 0 }));
}
export async function getPackageByKey(key) {
  return db.queryOne('SELECT * FROM version_packages WHERE pkg_key = ?', [key]);
}
// 记录一次下载：计数 +1（供后台统计）
export async function recordDownload(key) {
  await db.run('UPDATE version_packages SET downloads = downloads + 1 WHERE pkg_key = ?', [key]);
}
export async function savePackage(meta) {
  return db.insert(
    'INSERT INTO version_packages (pkg_key, name, version, size, sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))',
    [meta.pkgKey, meta.name, meta.version || '', meta.size, meta.sha256, meta.uploadedBy || '']
  );
}
export async function deletePackageByKey(key) {
  await db.run('DELETE FROM package_chunks WHERE pkg_key = ?', [key]);
  await db.run('DELETE FROM version_packages WHERE pkg_key = ?', [key]);
  return true;
}
// 保存安装包二进制（分块 Base64）
export async function savePackageBytes(key, bytes) {
  if (!bytes || !bytes.byteLength) throw new Error('EMPTY_FILE');
  if (bytes.byteLength > MAX_SIZE) throw new Error('FILE_TOO_LARGE');
  const chunks = Math.ceil(bytes.byteLength / CHUNK_SIZE);
  for (let i = 0; i < chunks; i++) {
    const data = b64encode(bytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.byteLength)));
    await db.run('INSERT INTO package_chunks (pkg_key, seq, data) VALUES (?, ?, ?)', [key, i, data]);
  }
}
// 流式读取安装包字节（按分块顺序 enqueue，借助背压避免占满内存/触发响应体积上限）
export function streamPackageBytes(key) {
  let seq = 0;
  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const row = await db.queryOne('SELECT data FROM package_chunks WHERE pkg_key = ? AND seq = ?', [key, seq]);
          if (!row) break;
          controller.enqueue(b64decode(row.data));
          seq++;
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    }
  });
}
// 对象键（同时作为下载 url 的 id）：p-<random>
export function newKey() {
  return 'p-' + randomTokenHex(16);
}
