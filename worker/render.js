// 页面渲染：使用预编译的 EJS 函数（worker/views.generated.js），并注入全局日期辅助函数。
import * as T from './views.generated.js';
import { fmtDateTime, fmtDate } from './util.js';

export function render(c, name, data = {}) {
  const key = name.replace(/[^a-zA-Z0-9_]/g, '_');
  const fn = T[key] || T[name] || T[name.replace(/\.ejs$/, '')];
  if (!fn) return c.text('View not found: ' + name, 500);
  let html;
  try {
    html = fn(Object.assign({ fmtDateTime, fmtDate }, data));
  } catch (e) {
    return c.text('Render error: ' + e.message, 500);
  }
  return c.html(html);
}
