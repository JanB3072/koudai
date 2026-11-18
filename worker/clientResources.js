// 客户端资源管理：版本号 + exe 资源清单，供桌面工具按需拉取。
// 二进制按 32KB 分块 Base64 存入 client_resource_chunks：
// D1 单条 SQL 语句上限 100KB、单值 2MB，整文件 Base64 存单行会触发 SQLITE_TOOBIG。
import * as db from './db.js';

const MAX_SIZE = 20 * 1024 * 1024; // 单资源上限 20MB
const CHUNK_SIZE = 32 * 1024;      // 原始字节 -> Base64 约 43KB，远低于 100KB 语句上限
const WRITE_BATCH = 25;            // 每批 25 条 INSERT（约 1.1MB，batch 只计 1 次查询）
const READ_BATCH = 32;             // 流式下载每批读取 32 块

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
export function sanitizeName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|\r\n\0]/g, '_').trim();
  if (n.startsWith('.')) n = '_' + n;
  return (n || 'file.bin').slice(0, 200);
}

// 当前发布的客户端版本号（工具端启动先读取它）
export async function getClientVersion() {
  const rows = await db.query('SELECT value FROM settings WHERE key = ?', ['client_version']);
  return rows.length ? rows[0].value : '0';
}
export async function setClientVersion(v) {
  const ver = String(v || '').trim();
  if (!/^\d+(\.\d+){0,3}$/.test(ver)) throw new Error('INVALID_VERSION');
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['client_version', ver]
  );
  return ver;
}

// 资源清单（不含内容）；客户端资源仅含 .exe 安装程序
export async function listResources() {
  const rows = await db.query('SELECT name, size, sha256, updated_at, downloads, last_downloaded_at FROM client_resources ORDER BY name');
  return rows
    .filter(r => /\.exe$/i.test(r.name))
    .map(r => ({
      name: r.name,
      size: Number(r.size) || 0,
      sha256: r.sha256,
      updatedAt: r.updated_at,
      downloads: Number(r.downloads) || 0,
      lastDownloadedAt: r.last_downloaded_at
    }));
}

// 记录一次下载：计数 +1 并记录最近下载时间（供后台统计）
export async function recordDownload(name) {
  name = sanitizeName(name);
  await db.run(
    'UPDATE client_resources SET downloads = downloads + 1, last_downloaded_at = datetime(\'now\') WHERE name = ?',
    [name]
  );
}

// 资源元数据（不含内容）；不存在返回 null
export async function getResourceMeta(name) {
  name = sanitizeName(name);
  const row = await db.queryOne('SELECT name, size, sha256 FROM client_resources WHERE name = ?', [name]);
  return row ? { name: row.name, size: Number(row.size) || 0, sha256: row.sha256 } : null;
}

// 保存/覆盖一个资源，返回 { name, size, sha256 }
export async function saveResource(name, bytes) {
  if (!bytes || !bytes.byteLength) throw new Error('EMPTY_FILE');
  if (bytes.byteLength > MAX_SIZE) throw new Error('FILE_TOO_LARGE');
  name = sanitizeName(name);
  const total = bytes.byteLength;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  const chunks = Math.ceil(total / CHUNK_SIZE);

  // 先清旧分块，再写元数据，最后分批写入分块
  await db.run('DELETE FROM client_resource_chunks WHERE name = ?', [name]);
  await db.run(
    'INSERT INTO client_resources (name, content_b64, size, sha256, updated_at) VALUES (?, NULL, ?, ?, datetime(\'now\')) ' +
    'ON CONFLICT(name) DO UPDATE SET content_b64 = NULL, size = excluded.size, sha256 = excluded.sha256, updated_at = datetime(\'now\')',
    [name, total, sha]
  );
  for (let i = 0; i < chunks; i += WRITE_BATCH) {
    const stmts = [];
    const end = Math.min(i + WRITE_BATCH, chunks);
    for (let seq = i; seq < end; seq++) {
      const part = bytes.subarray(seq * CHUNK_SIZE, Math.min((seq + 1) * CHUNK_SIZE, total));
      stmts.push({
        sql: 'INSERT INTO client_resource_chunks (name, seq, data) VALUES (?, ?, ?)',
        params: [name, seq, b64encode(part)]
      });
    }
    await db.batch(stmts);
  }
  return { name, size: total, sha256: sha };
}

// 流式读取资源字节；兼容早期把内容整行存在 content_b64 的资源
export function streamResource(name) {
  name = sanitizeName(name);
  let seq = 0;
  let triedLegacy = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const rows = await db.query(
          'SELECT seq, data FROM client_resource_chunks WHERE name = ? AND seq >= ? ORDER BY seq ASC LIMIT ?',
          [name, seq, READ_BATCH]
        );
        if (!rows.length) {
          if (!triedLegacy) {
            triedLegacy = true;
            const old = await db.queryOne('SELECT content_b64 FROM client_resources WHERE name = ?', [name]);
            if (old && old.content_b64) controller.enqueue(b64decode(old.content_b64));
          }
          controller.close();
          return;
        }
        for (const r of rows) {
          controller.enqueue(b64decode(r.data));
          seq = Number(r.seq) + 1;
        }
      } catch (e) {
        controller.error(e);
      }
    }
  });
}

export async function deleteResource(name) {
  name = sanitizeName(name);
  await db.run('DELETE FROM client_resource_chunks WHERE name = ?', [name]);
  await db.run('DELETE FROM client_resources WHERE name = ?', [name]);
  // 资源删空后，把对外版本号重置为 0，避免 /api/version 仍暴露一个已不存在的版本
  const remaining = await db.query('SELECT 1 FROM client_resources LIMIT 1');
  if (!remaining.length) await setClientVersion('0');
  return true;
}
