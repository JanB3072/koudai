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

// DATE / DATETIME / 毫秒时间戳 -> YYYY-MM-DD HH:mm:ss（按中国时区 UTC+8 显示）
// 数据库 datetime('now') 存的是 UTC，需当作 UTC 解析后再 +8 小时转成北京时间，
// 否则在 UTC 运行的 Worker 上会把 UTC 值直接当作本地时间显示（差 8 小时）。
export function fmtDateTime(d) {
  if (d == null) return '';
  let dt;
  if (d instanceof Date) {
    dt = d;
  } else if (typeof d === 'number') {
    dt = new Date(d);
  } else {
    let s = String(d).trim();
    // 无时区标记的时间串（数据库 datetime 格式 YYYY-MM-DD HH:MM:SS）按 UTC 解析
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) {
      if (s.indexOf('T') === -1) s = s.replace(' ', 'T');
      if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
      dt = new Date(s);
    } else {
      dt = new Date(s);
    }
  }
  if (isNaN(dt.getTime())) return '';
  // 转中国时区 UTC+8
  const cn = new Date(dt.getTime() + 8 * 3600 * 1000);
  return cn.getUTCFullYear() + '-' + pad2(cn.getUTCMonth() + 1) + '-' + pad2(cn.getUTCDate()) +
    ' ' + pad2(cn.getUTCHours()) + ':' + pad2(cn.getUTCMinutes()) + ':' + pad2(cn.getUTCSeconds());
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

// HMAC-SHA256 十六进制签名（用于接口响应防篡改）
export async function hmacSha256Hex(keyStr, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(String(keyStr)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(msg)));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 生成 n 字节十六进制随机串（用于 API 令牌，48 位）
export function randomTokenHex(bytes = 24) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 金额/数字精度工具 ----------
// 所有金额、点数、计数类数值统一走整数分（×100 取整）运算，避免浮点累加误差。
// 直接对浮点做 Math.round(x*100)/100 在 1.005 这类边界会因二进制表示丢失精度，
// 这里叠加 1e-9 修正舍入边界，保证分位四舍五入正确。

// 安全四舍五入到两位小数（返回 Number）。
export function round2(num) {
  if (num === null || num === undefined || num === '') return 0;
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  const r = Math.round((n * 100) + (n >= 0 ? 1e-9 : -1e-9)) / 100;
  return Object.is(r, -0) ? 0 : r; // 消除 -0
}

// 格式化为两位小数字符串（用于展示层）。非有限值回退为 '0.00'。
export function fmtMoney(num) {
  return round2(num).toFixed(2);
}
