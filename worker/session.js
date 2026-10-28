// 基于签名 Cookie 的会话（替代 express-session 的 MemoryStore）
// Workers 无内存态，故将会话数据直接放进 HMAC 签名的 httpOnly Cookie 中。
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

function b64urlEncode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function sign(obj, secret) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return b64urlEncode(data) + '.' + b64urlEncode(sig);
}

export async function verify(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('bad token');
  const data = b64urlDecode(parts[0]);
  const sig = b64urlDecode(parts[1]);
  const key = await importKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, sig, data);
  if (!ok) throw new Error('bad signature');
  return JSON.parse(new TextDecoder().decode(data));
}

const COOKIE = 'kd_session';

export async function getSession(c) {
  const raw = getCookie(c, COOKIE);
  if (!raw) return {};
  try {
    return await verify(raw, c.env.SESSION_SECRET);
  } catch {
    return {};
  }
}

export async function saveSession(c, data) {
  const val = await sign(data, c.env.SESSION_SECRET);
  setCookie(c, COOKIE, val, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 8,
    secure: String(c.req.url || '').startsWith('https')
  });
}

export function destroySession(c) {
  deleteCookie(c, COOKIE, { path: '/' });
}
