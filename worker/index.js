// Cloudflare Workers 入口。
// - 默认导出 Hono 应用作为 fetch handler 处理 HTTP 请求。
// - scheduled 用于每日最低消费结算（替代原 Node 版的 setInterval 常驻定时器）。
import { app } from './routes.js';
import * as db from './db.js';

export default app;

export async function scheduled(event, env, ctx) {
  db.setDB(env.DB);
  // 每日结算前一天（北京时间约 00:00 触发）：对每个用户补齐最低消费。
  const run = db.settleDailyMinimum(null, null);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run);
  else await run;
}
