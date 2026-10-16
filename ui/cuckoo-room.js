/**
 * cuckoo-room · 页内迷你入口（ui/cuckoo-room.js）
 *
 * 这个文件只做一件事：在 AI 页面右上角放一个**很小的**入口按钮，
 * 点它打开独立的聊天室窗口（由主进程 providers/room-host.js 创建）。
 *
 * 为什么不再把完整面板塞在页面上：
 *   1. 面板会压住 AI 的正文，这是实际使用中第一个被吐槽的问题；
 *   2. ui/*.js 跑在 AI 页面的渲染进程里，页面一重载实例就没了。
 * 独立窗口既不会遮正文，也不随任何 AI 页面重载而消失。
 *
 * 注意：本文件是纯 JavaScript，不能写 TypeScript 语法——
 * Cuckoo 的插件加载器只做正则 ESM→CJS 转换，不做类型转译
 * （src/plugins/runtime/loader.ts:189-238）。
 */

export const name = 'cuckoo-room';

const CSS = [
  '#ck-room-mini{position:fixed;right:14px;top:56px;z-index:2147483000;display:flex;align-items:center;gap:6px;',
  'background:rgba(24,26,32,.9);color:#e8eaf0;border:1px solid rgba(255,255,255,.14);border-radius:999px;',
  'padding:5px 11px 5px 9px;cursor:pointer;user-select:none;font:12px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;',
  'box-shadow:0 4px 14px rgba(0,0,0,.32);transition:background .12s;}',
  '#ck-room-mini:hover{background:rgba(38,42,52,.95);}',
  '#ck-room-mini .d{width:7px;height:7px;border-radius:50%;background:#6b7280;flex:none;}',
  '#ck-room-mini .d.on{background:#22c55e;box-shadow:0 0 6px #22c55e;}',
  '#ck-room-mini .d.run{background:#eab308;animation:ckmp 1s infinite;}',
  '#ck-room-mini .d.err{background:#ef4444;}',
  '@keyframes ckmp{50%{opacity:.3}}',
  '#ck-room-mini .t{white-space:nowrap;}',
  '#ck-room-mini .n{opacity:.6;font-size:11px;}',
].join('\n');

export function apply(ctx, config) {
  const cfg = config || {};
  let PORT = Number(cfg.hostPort) || 18901;
  let token = '';
  let alive = false;
  let chat = null;
  let lastError = '';

  // ===================== 与主进程服务通信 =====================
  async function call(p, opts) {
    const o = opts || {};
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (o.body) headers['Content-Type'] = 'application/json';
    const res = await fetch('http://127.0.0.1:' + PORT + p, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  /** 读插件目录里的令牌与实际端口（端口被占用时主进程会换随机端口） */
  async function discover() {
    if (!ctx.assets || typeof ctx.assets.read !== 'function') return;
    try {
      const b = await ctx.assets.read('.room-token');
      token = new TextDecoder().decode(b).trim();
    } catch (e) { /* 令牌可能还没生成 */ }
    try {
      const b2 = await ctx.assets.read('.room-port');
      const p = parseInt(new TextDecoder().decode(b2).trim(), 10);
      if (p > 0) PORT = p;
    } catch (e) { /* 端口文件可能还没写 */ }
  }

  async function refresh() {
    try {
      const r = await call('/status');
      alive = true;
      lastError = '';
      if (r.port) PORT = r.port;
    } catch (e) {
      alive = false;
      lastError = (e && e.message) ? e.message : String(e);
    }
    try {
      const r2 = await call('/chat/status');
      chat = r2.chat || null;
    } catch (e) { /* 保留上一次状态 */ }
  }

  // ===================== 界面 =====================
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  const root = el('div');
  root.id = 'ck-room-mini';
  root.title = '打开独立的圆桌窗口';

  const dot = el('i', 'd');
  const label = el('span', 't', '多 AI 同室');
  const count = el('span', 'n', '');
  root.appendChild(dot); root.appendChild(label); root.appendChild(count);

  try { ctx.ui.css(CSS); } catch (e) {}
  try { ctx.ui.mount(root); } catch (e) {}

  function render() {
    const busy = !!(chat && (chat.sending || (chat.busy && chat.busy.length)));
    dot.className = 'd' + (alive ? (busy ? ' run' : ' on') : ' err');
    if (!alive) {
      label.textContent = '聊天室未连接';
      count.textContent = '';
      root.title = '连不上主进程服务：' + (lastError || '未知原因');
      return;
    }
    root.title = '打开独立的聊天室窗口';
    if (busy) {
      label.textContent = '等待回复';
      count.textContent = chat.busy && chat.busy.length ? String(chat.busy.length) : '';
    } else {
      label.textContent = '多 AI 同室';
      const n = (chat && chat.messages) ? chat.messages.length : 0;
      count.textContent = n ? String(n) : '';
    }
  }

  let busy = false;
  root.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    // 走 POST /window/open：主进程用 BrowserWindow 打开独立窗口
    call('/window/open', { method: 'POST' })
      .then(function (r) {
        if (!r || !r.ok) lastError = (r && r.error) || '打开失败';
        else lastError = '';
      }, function (e) {
        lastError = '打开窗口失败：' + ((e && e.message) || e);
      })
      .then(function () {
        busy = false;
        return refresh();
      })
      .then(render, render);
  });

  // ===================== 启动 =====================
  let poll = null;
  Promise.resolve()
    .then(discover)
    .then(refresh)
    .catch(function (e) { lastError = (e && e.message) || String(e); })
    .then(function () {
      render();
      if (poll) return;
      poll = setInterval(function () {
        refresh().then(render, render);
      }, 2000);
    });

  // ===================== 卸载 =====================
  try {
    ctx.__dispose = function () {
      if (poll) { clearInterval(poll); poll = null; }
      try { root.remove(); } catch (e) {}
    };
  } catch (e) {}
}
