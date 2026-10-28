/* 前台登录/注册弹框：拦截头部「登录」链接，弹出登录+注册，调用现有接口。非必须，不登录也能正常浏览。 */
(function () {
  // 注入样式（自包含，无需改 style.css）
  const css = `
  .auth-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:999;opacity:0;pointer-events:none;transition:opacity .2s}
  .auth-mask.open{opacity:1;pointer-events:auto}
  .auth-box{position:relative;width:420px;max-width:92vw;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.2);overflow:hidden;transform:translateY(8px);transition:transform .2s}
  .auth-mask.open .auth-box{transform:translateY(0)}
  .auth-close{position:absolute;top:10px;right:14px;background:none;border:none;font-size:22px;line-height:1;color:#9ca3af;cursor:pointer;z-index:2}
  .auth-close:hover{color:#374151}
  .auth-tabs{display:flex}
  .auth-tabs button{flex:1;padding:16px;font-size:15px;border:none;background:#f9fafb;color:#6b7280;cursor:pointer;transition:.2s}
  .auth-tabs button.active{background:#fff;color:#4f7cff;font-weight:700;box-shadow:inset 0 -2px 0 #4f7cff}
  .auth-body{padding:28px 24px}
  .auth-form{display:none}
  .auth-form.active{display:block}
  .auth-field{margin-bottom:16px}
  .auth-field label{display:block;font-size:13px;color:#374151;margin-bottom:6px}
  .auth-field input{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box}
  .auth-field input:focus{outline:none;border-color:#4f7cff}
  .auth-field .opt{color:#9ca3af;font-size:12px;margin-left:6px}
  .auth-hint{font-size:12px;color:#9ca3af;margin-top:4px}
  .auth-btn{width:100%;padding:12px;border:none;border-radius:8px;background:#4f7cff;color:#fff;font-size:15px;cursor:pointer;transition:.2s}
  .auth-btn:hover{background:#3a5fd4}
  .auth-msg{font-size:13px;margin-top:14px;min-height:18px}
  .auth-msg.ok{color:#10b981}.auth-msg.err{color:#ef4444}
  .auth-user{font-size:14px;color:#374151;margin-right:12px}
  .auth-logout{color:#ef4444;text-decoration:none}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // 注入弹框结构
  const mask = document.createElement('div');
  mask.className = 'auth-mask';
  mask.innerHTML = `
    <div class="auth-box">
      <button class="auth-close" aria-label="关闭">&times;</button>
      <div class="auth-tabs">
        <button id="authTabLogin" class="active" type="button">登录</button>
        <button id="authTabRegister" type="button">注册</button>
      </div>
      <div class="auth-body">
        <form id="authLoginForm" class="auth-form active">
          <div class="auth-field">
            <label>用户名</label>
            <input type="text" id="authLoginUser" autocomplete="username" placeholder="请输入用户名">
          </div>
          <div class="auth-field">
            <label>密码</label>
            <input type="password" id="authLoginPwd" autocomplete="current-password" placeholder="请输入密码">
          </div>
          <button type="submit" class="auth-btn">登录</button>
          <div id="authLoginMsg" class="auth-msg"></div>
        </form>
        <form id="authRegisterForm" class="auth-form">
          <div class="auth-field">
            <label>用户名</label>
            <input type="text" id="authRegUser" autocomplete="username" placeholder="3-64 位">
          </div>
          <div class="auth-field">
            <label>密码</label>
            <input type="password" id="authRegPwd" autocomplete="new-password" placeholder="至少 8 位">
          </div>
          <div class="auth-field">
            <label>邀请码<span class="opt">（选填）</span></label>
            <input type="text" id="authRegInvite" placeholder="如有邀请码可填写，不填也能注册">
            <div class="auth-hint">邀请码非必填，留空也可正常注册。</div>
          </div>
          <button type="submit" class="auth-btn">注册</button>
          <div id="authRegisterMsg" class="auth-msg"></div>
        </form>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const $ = (s) => mask.querySelector(s);
  const loginForm = $('#authLoginForm');
  const regForm = $('#authRegisterForm');

  // token 存储：登录后保存，后续请求统一带上 Authorization 头（与 cookie 并存，供工具/前端共用）
  const TOKEN_KEY = 'koudai_token';
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function authHeaders(extra) {
    const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    const t = getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function openAuth(tab) { switchTab(tab || 'login'); mask.classList.add('open'); }
  function closeAuth() { mask.classList.remove('open'); }
  function switchTab(t) {
    $('#authTabLogin').classList.toggle('active', t === 'login');
    $('#authTabRegister').classList.toggle('active', t === 'register');
    loginForm.classList.toggle('active', t === 'login');
    regForm.classList.toggle('active', t === 'register');
  }

  $('#authTabLogin').addEventListener('click', () => switchTab('login'));
  $('#authTabRegister').addEventListener('click', () => switchTab('register'));
  mask.querySelector('.auth-close').addEventListener('click', closeAuth);
  mask.addEventListener('click', (e) => { if (e.target === mask) closeAuth(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAuth(); });

  async function doLogin(e) {
    e.preventDefault();
    const msg = $('#authLoginMsg'); msg.className = 'auth-msg'; msg.textContent = '';
    const r = await fetch('/api/login', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ username: $('#authLoginUser').value, password: $('#authLoginPwd').value })
    });
    const j = await r.json();
    if (j.success) { setToken(j.token); closeAuth(); refreshHeader(); }
    else { msg.className = 'auth-msg err'; msg.textContent = j.message || '登录失败'; }
  }

  async function doRegister(e) {
    e.preventDefault();
    const msg = $('#authRegisterMsg'); msg.className = 'auth-msg'; msg.textContent = '';
    const user = $('#authRegUser').value;
    const pwd = $('#authRegPwd').value;
    const invite = $('#authRegInvite').value.trim();
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pwd, inviteCode: invite })
    });
    const j = await r.json();
    if (!j.success) { msg.className = 'auth-msg err'; msg.textContent = j.message || '注册失败'; return; }
    // 注册成功自动登录
    const lr = await fetch('/api/login', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ username: user, password: pwd })
    });
    const lj = await lr.json();
    if (lj.success) { setToken(lj.token); closeAuth(); refreshHeader(); }
    else { msg.className = 'auth-msg ok'; msg.textContent = '注册成功，请登录'; switchTab('login'); }
  }

  loginForm.addEventListener('submit', doLogin);
  regForm.addEventListener('submit', doRegister);

  // 已登录则把头部「登录」替换为用户名 + 退出
  async function refreshHeader() {
    try {
      const r = await fetch('/api/me', { headers: authHeaders() });
      const j = await r.json();
      if (!j.loggedIn || !j.user) return;
      document.querySelectorAll('a[href="/login"]').forEach((a) => {
        const wrap = document.createElement('span');
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'center';
        const span = document.createElement('span');
        span.className = 'auth-user';
        span.textContent = '你好，' + j.user.username;
        const out = document.createElement('a');
        out.href = '#';
        out.className = 'auth-logout';
        out.textContent = '退出';
        out.addEventListener('click', async (e) => {
          e.preventDefault();
          await fetch('/api/logout', { method: 'POST', headers: authHeaders() });
          setToken('');
          location.reload();
        });
        wrap.appendChild(span);
        wrap.appendChild(out);
        a.replaceWith(wrap);
      });
    } catch (e) { /* 忽略，未登录照常浏览 */ }
  }

  // 头部「登录」链接改为弹框
  function bindLoginLinks() {
    document.querySelectorAll('a[href="/login"]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); openAuth('login'); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { refreshHeader(); bindLoginLinks(); });
  } else {
    refreshHeader(); bindLoginLinks();
  }
})();
