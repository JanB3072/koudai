// 通用工具：日期格式化、SHA-256、随机令牌（均兼容 Cloudflare Workers 运行时）

export function pad2(n) { return n < 10 ? '0' + n : '' + n; }

export function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'number') return new Date(d);
  if (typeof d === 'string') {
    if (/^\d+$/.test(d)) return new Date(Number(d)); // 毫秒时间戳字符串
    return new Date(d);
  }
  return new Date(d);
}

// DATE -> YYYY-MM-DD
export function fmtDate(d) {
  if (!d) return '';
  const dt = toDate(d);
  if (isNaN(dt.getTime())) return '';
  return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
}

// DATE / DATETIME / 毫秒时间戳 -> YYYY-MM-DD HH:mm:ss（按服务器本地时区，即中国时区）
export function fmtDateTime(d) {
  if (!d) return '';
  const dt = toDate(d);
  if (isNaN(dt.getTime())) return '';
  return fmtDate(dt) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds());
}

// YYYY-MM-DD 加 n 天
export function addDays(dateStr, n) {
  const p = String(dateStr).split('-');
  const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  dt.setDate(dt.getDate() + n);
  return fmtDate(dt);
}

// MySQL DATE 列在 SQLite 中返回字符串，统一转 YYYY-MM-DD
export function asDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return fmtDate(v);
  return String(v);
}

// SHA-256 十六进制（替代 Node crypto.createHash）
export async function sha256(s) {
  const data = new TextEncoder().encode(String(s));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 生成 n 字节十六进制随机串（用于 API 令牌，48 位）
export function randomTokenHex(bytes = 24) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
