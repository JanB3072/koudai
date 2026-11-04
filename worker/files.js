// 文件传输存储层：基于 D1 的分块存储（Base64），供工具端上传/下载。
// 单文件上限 20MB；内容按 512KB 分块存入 file_chunks，下载时按序还原。
import { query, queryOne, run } from './db.js';
import { randomTokenHex } from './util.js';

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const CHUNK_SIZE = 512 * 1024;

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

// 文件名净化：去掉路径分隔符与非法字符，防止路径穿越
export function sanitizeName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|\r\n\0]/g, '_').trim();
  if (n.startsWith('.')) n = '_' + n;
  return (n || 'file.bin').slice(0, 200);
}

// 保存文件，返回 { id, name, size, sha256, mime, chunks }
export async function saveFile(userId, name, bytes, mime) {
  if (!bytes || !bytes.byteLength) throw new Error('EMPTY_FILE');
  if (bytes.byteLength > MAX_FILE_SIZE) throw new Error('FILE_TOO_LARGE');
  name = sanitizeName(name);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  const id = 'f-' + randomTokenHex(16);
  const total = bytes.byteLength;
  const chunks = Math.ceil(total / CHUNK_SIZE);
  await run(
    'INSERT INTO files (id, user_id, name, size, sha256, mime, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, name, total, sha, mime || 'application/octet-stream', chunks]
  );
  for (let i = 0; i < chunks; i++) {
    const data = b64encode(bytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, total)));
    await run('INSERT INTO file_chunks (file_id, seq, data) VALUES (?, ?, ?)', [id, i, data]);
  }
  return { id, name, size: total, sha256: sha, mime: mime || 'application/octet-stream', chunks };
}

export async function listFiles(userId, page = 1, pageSize = 50) {
  page = Math.max(1, page || 1);
  pageSize = Math.min(100, Math.max(1, pageSize || 50));
  const totalRow = await queryOne('SELECT COUNT(*) AS c FROM files WHERE user_id = ?', [userId]);
  const rows = await query(
    'SELECT id, name, size, sha256, mime, chunks, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    [userId, pageSize, (page - 1) * pageSize]
  );
  return { total: totalRow ? Number(totalRow.c) : 0, page, pageSize, files: rows };
}

export async function getFileMeta(fileId, userId) {
  return queryOne(
    'SELECT id, user_id, name, size, sha256, mime, chunks, created_at FROM files WHERE id = ? AND user_id = ?',
    [fileId, userId]
  );
}

// 读取完整文件内容，返回 { meta, bytes }；不存在或非本人文件返回 null
export async function readFileBytes(fileId, userId) {
  const meta = await getFileMeta(fileId, userId);
  if (!meta) return null;
  const total = Number(meta.size) || 0;
  const rows = await query('SELECT seq, data FROM file_chunks WHERE file_id = ? ORDER BY seq ASC', [fileId]);
  const out = new Uint8Array(total);
  for (const r of rows) {
    const bytes = b64decode(r.data);
    const off = Number(r.seq) * CHUNK_SIZE;
    if (off < total) out.set(bytes.subarray(0, Math.min(bytes.length, total - off)), off);
  }
  return { meta, bytes: out };
}

export async function deleteFile(fileId, userId) {
  const meta = await getFileMeta(fileId, userId);
  if (!meta) return false;
  await run('DELETE FROM file_chunks WHERE file_id = ?', [fileId]);
  await run('DELETE FROM files WHERE id = ?', [fileId]);
  return true;
}
