/**
 * cuckoo-room · 主进程编排器（providers/room-host.js）
 *
 * ===== 为什么会有这个文件 =====
 * Cuckoo 的插件有两条完全不同的执行轨道：
 *   - ui/*.js      → AI 页面的**渲染进程**，只能操作当前那一个页面
 *   - providers/*.js → 被 require 进**主进程**
 *
 * 后者是跨平台协作的唯一立足点：主进程里 require('out/src/app/window.js') 能拿到
 * 全进程唯一的窗口表 getAllContexts()，一次触达所有平台/账号的窗口，
 * 于是可以「不导航、不重载、不切换会话」直接对每个窗口注入提示词并回收回复。
 *
 * 这解决了旧方案（ui 里靠 navigateSession 逐窗口轮转）的三个硬伤：
 *   1. 原方案每次换人都 loadURL 重载页面，插件实例随之销毁，被迫写了
 *      「落盘 → 导航 → 重载后原地续跑」的复杂状态机；本方案完全不需要。
 *   2. 原方案受 sessionUrlBase 限制，只能在**同一平台**内切换；本方案跨平台。
 *   3. 原方案的 sendToChat 走单个 pendingSend 令牌，不能并发；本方案每窗口独立。
 *
 * ===== 安全 =====
 *   - 只绑 127.0.0.1，不对外网暴露
 *   - 浏览器发来的跨源请求（带 Origin 头）必须携带令牌；令牌每次启动随机生成，
 *     写在插件目录的 .room-token，只由渲染侧经官方 readPluginAsset 读取。
 *     这样即使某个 AI 网页被注入恶意脚本，也无法驱动本服务（拿不到令牌，且
 *     带 Authorization 头的跨源请求会先触发预检，预检不通过即被浏览器拦下）。
 *   - 不带 Origin 的请求（本机 curl / PowerShell 排障）放行。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const requireFromHere = createRequire(__filename);

const VERSION = '0.6.1';
const PLUGIN_ID = 'cuckoo-room';
/** __dirname 是 <插件目录>/providers */
const PLUGIN_DIR = path.resolve(__dirname, '..');
/** 只有渲染进程才需要「跳过启动」——provider 文件在主/渲染两侧都会被 require */
const IS_RENDERER = process.type === 'renderer';

const USER_DIR = process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo');
const LOG_FILE = path.join(USER_DIR, 'cuckoo-room.log');
const TOKEN_FILE = path.join(PLUGIN_DIR, '.room-token');
const PORT_FILE = path.join(PLUGIN_DIR, '.room-port');

// ===================== 日志（主进程无控制台可看，必须落盘） =====================
let logBroken = false;
function log(...args) {
  if (logBroken) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, '');
    } catch (_) { /* 不存在则忽略 */ }
    const line = '[' + new Date().toISOString() + '] ' + args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()))
      .join(' ');
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch (_) { logBroken = true; }
}

// ===================== 访问主进程的应用模块 =====================
let _app;
function getApp() {
  if (_app !== undefined) return _app;
  try { _app = requireFromHere('electron').app || null; } catch (_) { _app = null; }
  return _app;
}

/** 与 ai-gateway 相同的解析策略：appPath → cwd → resources/app.asar */
function resolveAppPath(rel) {
  const roots = [];
  const app = getApp();
  try { if (app) roots.push(app.getAppPath()); } catch (_) { /* ignore */ }
  try { roots.push(process.cwd()); } catch (_) { /* ignore */ }
  try { if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'app.asar')); } catch (_) { /* ignore */ }
  for (const root of roots) {
    try { const c = path.join(root, rel); if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

let _winMod;
let _winModErr = null;
/**
 * 取应用自己的窗口表模块。
 *
 * 关键前提：require 这个模块必须拿到**与主进程同一份**实例，否则窗口表是空的。
 * 这一点已由 ai-gateway 实证：它的 /api/stats 返回 hasAIPage:true，而该值来自
 * 同一个 getAllContexts() —— 若拿到的是新实例，必然是 true 不了。
 */
function getWindowStateModule() {
  if (_winMod !== undefined) return _winMod;
  const file = resolveAppPath('out/src/app/window.js') || resolveAppPath('src/app/window.js');
  if (!file) { _winModErr = '找不到 window.js（尝试过 appPath / cwd / resources）'; _winMod = null; return null; }
  try {
    _winMod = requireFromHere(file);
    log('已挂接窗口表:', file);
  } catch (e) {
    _winModErr = 'require window.js 失败: ' + (e && e.message ? e.message : e);
    log(_winModErr);
    _winMod = null;
  }
  return _winMod;
}

// ===================== 枚举窗口 =====================
/** 列出所有窗口（含平台、URL、可注入性） */
function listWindows() {
  const wm = getWindowStateModule();
  if (!wm) return { ok: false, error: _winModErr || '窗口表不可用', windows: [] };
  let ctxs;
  try { ctxs = wm.getAllContexts() || []; }
  catch (e) { return { ok: false, error: 'getAllContexts 抛错: ' + (e && e.message), windows: [] }; }

  const out = [];
  for (let i = 0; i < ctxs.length; i++) {
    const c = ctxs[i] || {};
    const view = c.view;
    const wc = view && view.webContents;
    let url = '', title = '';
    let destroyed = true;
    try {
      if (wc && !wc.isDestroyed()) {
        destroyed = false;
        url = wc.getURL() || '';
        title = wc.getTitle() || '';
      }
    } catch (_) { /* ignore */ }
    out.push({
      index: i,
      windowId: (c.win && typeof c.win.id === 'number') ? c.win.id : null,
      profileId: c.profileId || null,
      providerId: c.providerId || null,
      isSubagent: !!c.isSubagent,
      destroyed,
      canInject: !destroyed,
      url,
      title,
    });
  }
  return { ok: true, count: out.length, windows: out };
}

/** 按 windowId / profileId / index 选一个可注入的窗口 */
function pickTarget(sel) {
  const list = listWindows();
  if (!list.ok) return { ok: false, error: list.error };
  let hit = null;
  if (sel && sel.windowId != null) hit = list.windows.find((w) => w.windowId === sel.windowId);
  else if (sel && sel.profileId) hit = list.windows.find((w) => w.profileId === sel.profileId);
  else if (sel && sel.index != null) hit = list.windows.find((w) => w.index === sel.index);
  if (!hit) return { ok: false, error: '找不到目标窗口', windows: list.windows };
  if (!hit.canInject) return { ok: false, error: '目标窗口的 AI 页面不可用' };

  const wm = getWindowStateModule();
  const ctxs = wm.getAllContexts() || [];
  const wc = ctxs[hit.index] && ctxs[hit.index].view && ctxs[hit.index].view.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'webContents 已失效' };
  return { ok: true, info: hit, wc };
}

// ===================== 注入：探针 / 发送 / 收回复 =====================
/** 只读探针：报告页面身份与输入框情况，不做任何写入 */
const PROBE_CODE = [
  '(function () {',
  '  function visible(el) { try { var s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0"; } catch (e) { return false; } }',
  '  var tas = document.querySelectorAll("textarea");',
  '  var visTa = 0;',
  '  for (var i = 0; i < tas.length; i++) { if (visible(tas[i])) visTa++; }',
  '  var ed = document.querySelector(\'div[contenteditable="true"], [role="textbox"]\');',
  '  return {',
  '    href: location.href,',
  '    origin: location.origin,',
  '    title: document.title,',
  '    readyState: document.readyState,',
  '    textareaTotal: tas.length,',
  '    textareaVisible: visTa,',
  '    contentEditable: !!(ed && visible(ed)),',
  '    hasCuckooHook: typeof window.__cuckooDeepseekHookInstalled__ !== "undefined" || typeof window.__cuckooClaudeHookInstalled__ !== "undefined" || typeof window.__cuckooChatgptHookInstalled__ !== "undefined",',
  '    lang: (document.documentElement && document.documentElement.lang) || ""',
  '  };',
  '})();',
].join('\n');

/** 把文本写进输入框并触发发送（复刻 overlay/chat-input.ts 与 ai-inject.js 的做法） */
function buildSendCode(text) {
  const payload = JSON.stringify(String(text));
  return [
    '(function () {',
    '  var MSG = ' + payload + ';',
    '  function visible(el) { try { var s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0"; } catch (e) { return false; } }',
    '  function findInput() {',
    '    var tas = document.querySelectorAll("textarea");',
    '    for (var i = 0; i < tas.length; i++) { if (visible(tas[i])) return tas[i]; }',
    '    var ed = document.querySelector(\'div[contenteditable="true"], [role="textbox"]\');',
    '    if (ed && visible(ed)) return ed;',
    '    return null;',
    '  }',
    '  function setContent(input, msg) {',
    '    try {',
    '      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {',
    '        input.focus();',
    '        var proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;',
    '        var setter = Object.getOwnPropertyDescriptor(proto, "value").set;',
    '        setter.call(input, msg);',
    '        input.dispatchEvent(new Event("input", { bubbles: true }));',
    '        return true;',
    '      }',
    '      if (input.isContentEditable || input.getAttribute("contenteditable") === "true") {',
    '        input.focus();',
    '        document.execCommand("selectAll", false, undefined);',
    '        document.execCommand("delete", false, undefined);',
    '        var dt = new DataTransfer(); dt.setData("text/plain", msg);',
    '        input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));',
    '        return true;',
    '      }',
    '    } catch (e) {}',
    '    return false;',
    '  }',
    '  function triggerSend(input) {',
    '    var opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };',
    '    input.dispatchEvent(new KeyboardEvent("keydown", opts));',
    '    input.dispatchEvent(new KeyboardEvent("keypress", opts));',
    '    input.dispatchEvent(new KeyboardEvent("keyup", opts));',
    '  }',
    '  var input = findInput();',
    '  if (!input) return "NO_INPUT";',
    '  if (!setContent(input, MSG)) return "SET_FAILED";',
    '  setTimeout(function () { triggerSend(input); }, 400);',
    '  return "SENT";',
    '})();',
  ].join('\n');
}

/**
 * 收回复：监听各平台 hook 在主世界派发的 cuckoo-ai-stream / cuckoo-ai-response。
 * 含 ```cuckoo / ```js 代码块的是工具调用轮，跳过，等真正的最终回复。
 */
function buildCaptureCode(timeoutMs) {
  return [
    '(function () {',
    '  return new Promise(function (resolve) {',
    '    var acc = "", lastText = "", done = false;',
    '    var BT = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);',
    '    function hasToolBlock(t) { t = t || ""; return t.indexOf(BT + "cuckoo") >= 0 || t.indexOf(BT + "js") >= 0; }',
    '    function finish(text, reason) {',
    '      if (done) return; done = true;',
    '      window.removeEventListener("cuckoo-ai-stream", onStream);',
    '      window.removeEventListener("cuckoo-ai-response", onResp);',
    '      resolve({ text: text, reason: reason });',
    '    }',
    '    function onStream(ev) { var d = (ev && ev.detail) || {}; if (typeof d.text === "string" && d.text.length >= acc.length) acc = d.text; }',
    '    function onResp(ev) {',
    '      var d = (ev && ev.detail) || {};',
    '      if (!d.finished) return;',
    '      var t = d.text || acc || ""; lastText = t;',
    '      if (hasToolBlock(t)) { acc = ""; return; }',
    '      finish(t, "finished");',
    '    }',
    '    window.addEventListener("cuckoo-ai-stream", onStream);',
    '    window.addEventListener("cuckoo-ai-response", onResp);',
    '    var t0 = Date.now();',
    '    var iv = setInterval(function () { if (Date.now() - t0 > ' + timeoutMs + ') { clearInterval(iv); finish(lastText || acc, "timeout"); } }, 1000);',
    '  });',
    '})();',
  ].join('\n');
}

/** 向指定窗口发一条消息并等回复 */
async function sendAndCapture(wc, text, timeoutMs) {
  const to = Math.max(15000, Math.min(900000, Number(timeoutMs) || 180000));
  // 先装监听，再发送（同一 webContents 上两次 executeJavaScript 的顺序有保证）
  const capPromise = wc.executeJavaScript(buildCaptureCode(to), true)
    .catch((e) => ({ text: '', reason: 'capture_error:' + (e && e.message) }));

  let sendRes;
  try { sendRes = await wc.executeJavaScript(buildSendCode(text), true); }
  catch (e) { return { ok: false, error: '注入失败: ' + (e && e.message) }; }
  if (sendRes === 'NO_INPUT') return { ok: false, error: '未找到输入框（页面可能未就绪）' };
  if (sendRes === 'SET_FAILED') return { ok: false, error: '写入输入框失败' };
  if (sendRes !== 'SENT') return { ok: false, error: '发送失败: ' + sendRes };

  const res = await Promise.race([
    capPromise,
    new Promise((r) => setTimeout(() => r({ text: '', reason: 'overall_timeout' }), to + 5000)),
  ]);
  const reason = res && res.reason;
  if (reason === 'timeout' || reason === 'overall_timeout') {
    return { ok: false, error: '等待回复超时', partial: (res && res.text) || '' };
  }
  if (reason && String(reason).indexOf('capture_error') === 0) return { ok: false, error: reason };
  return { ok: true, text: (res && res.text) || '' };
}

// ===================== 附件上传 =====================
/**
 * 把文件送进某个 AI 窗口的输入框。
 *
 * 为什么不能"直接把文件塞进去"：浏览器安全边界不允许 JS 往 <input type=file>
 * 里写文件。但可以在页面主世界里构造 File 对象，用 DataTransfer 赋给 input.files
 * 再派发 change —— 这正是 Cuckoo 自己的 attachFile 工具的做法
 * （src/tools/impl/attach-file.ts:130-172）。
 *
 * 更强的形态是 CDP（src/app/ipc/cdp-attach.ts：Page.setInterceptFileChooserDialog
 * + DOM.setFileInputFiles + 真实鼠标事件），能对付"免疫合成事件"的站点（如智谱）。
 * 这里先用前者：自包含、无副作用、对多数平台够用；失败时如实报错并提示。
 */
function buildAttachCode(name, mime, base64, timeoutMs) {
  return [
    '(async () => {',
    '  try {',
    '    const b64 = ' + JSON.stringify(base64) + ';',
    '    const fileName = ' + JSON.stringify(name) + ';',
    '    const mimeType = ' + JSON.stringify(mime) + ';',
    '    const timeoutMs = ' + timeoutMs + ';',
    '    const bin = atob(b64);',
    '    const bytes = new Uint8Array(bin.length);',
    '    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);',
    '    const file = new File([bytes], fileName, { type: mimeType });',
    '    const inputs = Array.prototype.slice.call(document.querySelectorAll("input[type=file]"));',
    '    if (!inputs.length) return { success: false, error: "页面里没有文件上传输入框" };',
    '    function vis(el) { try { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden"; } catch (e) { return false; } }',
    '    // 候选排序：可见的优先；accept 里带 image 的次之（图片场景更常命中）；最后兜底取最后一个',
    '    const cands = inputs.slice().sort(function (a, b) {',
    '      const av = vis(a) ? 2 : 0, bv = vis(b) ? 2 : 0;',
    '      const ai = /image/i.test(a.getAttribute("accept") || "") ? 1 : 0;',
    '      const bi = /image/i.test(b.getAttribute("accept") || "") ? 1 : 0;',
    '      return (bv + bi) - (av + ai);',
    '    });',
    '    // 基线：注入前统计"输入区附近的图片数"，用于判断是否出现了新附件',
    '    function lowerImgCount() {',
    '      const vh = window.innerHeight || 800;',
    '      let n = 0;',
    '      const imgs = document.querySelectorAll("img");',
    '      for (let i = 0; i < imgs.length; i++) {',
    '        const r = imgs[i].getBoundingClientRect();',
    '        if (r.width > 8 && r.height > 8 && r.top > vh * 0.5) n++;',
    '      }',
    '      return n;',
    '    }',
    '    const baseImgs = lowerImgCount();',
    '    function ready() {',
    '      try {',
    '        if (document.body && document.body.innerText && document.body.innerText.indexOf(fileName) >= 0) return true;',
    '      } catch (e) {}',
    '      return lowerImgCount() > baseImgs;',
    '    }',
    '    for (let ci = 0; ci < cands.length; ci++) {',
    '      const input = cands[ci];',
    '      try {',
    '        const dt = new DataTransfer();',
    '        dt.items.add(file);',
    '        input.files = dt.files;',
    '        input.dispatchEvent(new Event("change", { bubbles: true }));',
    '        input.dispatchEvent(new Event("input", { bubbles: true }));',
    '      } catch (e) { continue; }',
    '      const deadline = Date.now() + (ci === 0 ? timeoutMs : 2500);',
    '      while (Date.now() < deadline) {',
    '        await new Promise(function (r) { setTimeout(r, 300); });',
    '        if (ready()) return { success: true, fileName: fileName, inputIndex: ci, totalInputs: cands.length };',
    '      }',
    '    }',
    '    return { success: false, error: "已尝试 " + cands.length + " 个上传入口，未检测到附件出现", totalInputs: cands.length };',
    '  } catch (err) {',
    '    return { success: false, error: (err && err.message) ? err.message : String(err) };',
    '  }',
    '})();',
  ].join('\n');
}

/** 把一个文件附件注入到指定窗口的输入框 */
async function attachFileToWindow(wc, file) {
  const name = String(file.name || 'file.bin');
  const mime = String(file.mime || 'application/octet-stream');
  const buf = file.buffer;
  if (!buf || !buf.length) return { ok: false, error: '文件内容为空' };
  const maxB = Math.max(1, Number(cfg.maxAttachMB) || 20) * 1024 * 1024;
  if (buf.length > maxB) {
    return { ok: false, error: '文件超过 ' + Math.round(maxB / 1024 / 1024) + 'MB 上限（' + (buf.length / 1024 / 1024).toFixed(1) + 'MB）' };
  }
  try {
    const r = await wc.executeJavaScript(buildAttachCode(name, mime, buf.toString('base64'), 15000), true);
    if (r && r.success) return { ok: true, name: name, size: buf.length };
    return { ok: false, error: (r && r.error) || '上传失败' };
  } catch (e) {
    return { ok: false, error: '注入上传脚本失败: ' + ((e && e.message) || e) };
  }
}

// ===================== 聊天室（主进程编排） =====================
/**
 * 聊天室：用户主导——用 @ 指定谁（或全体）来接这条消息，可附带图片/文件、下发任务。
 * 状态住在主进程内存里（另存一份到磁盘，重启后还能看到历史），
 * 因此关掉聊天室窗口不会丢消息。
 */
const CHAT_FILE = path.join(USER_DIR, 'cuckoo-room-chat.json');
const MAX_MESSAGES = 500;
const chat = { messages: [], seq: 0, busy: {}, sending: false };
let chatSaveTimer = null;

function loadChat() {
  try {
    if (!fs.existsSync(CHAT_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf-8'));
    if (raw && Array.isArray(raw.messages)) {
      chat.messages = raw.messages.slice(-MAX_MESSAGES);
      chat.seq = Number(raw.seq) || 0;
      log('已载入聊天记录 ' + chat.messages.length + ' 条');
    }
  } catch (e) { log('读聊天记录失败:', e && e.message); }
}

function saveChatSoon() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CHAT_FILE, JSON.stringify({ seq: chat.seq, messages: chat.messages.slice(-MAX_MESSAGES) }, null, 0), 'utf-8');
    } catch (e) { log('写聊天记录失败:', e && e.message); }
  }, 400);
}

function pushMsg(m) {
  chat.seq++;
  const msg = Object.assign({
    id: 'm' + chat.seq,
    at: Date.now(),
  }, m);
  chat.messages.push(msg);
  if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  saveChatSoon();
  return msg;
}

function chatSnapshot() {
  return {
    messages: chat.messages,
    busy: Object.keys(chat.busy).filter((k) => chat.busy[k]),
    sending: chat.sending,
    seq: chat.seq,
  };
}

/** 把最近的聊天记录整理成给 AI 看的上下文 */
function buildChatContext(limit) {
  const n = Math.max(0, Number(limit) || 14);
  const recent = chat.messages.filter((m) => m.role === 'user' || m.role === 'ai').slice(-n);
  if (!recent.length) return '';
  const lines = recent.map((m) => (m.role === 'user' ? ('我：' + m.text) : ((m.who || 'AI') + '：' + m.text)));
  return lines.join('\n');
}

/**
 * 发一条消息。targets 可以是窗口 id 数组，或 'all'。
 * mode：'parallel'（各自独立回答，默认）| 'sequential'（按顺序，后者能看到前者的回答）
 */
async function chatSend(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, error: '消息不能为空' };

  const list = listWindows();
  if (!list.ok) return { ok: false, error: list.error };

  // 解析目标
  let targetIds = [];
  if (body.targets === 'all' || body.targets === undefined || body.targets === null) {
    targetIds = list.windows.filter((w) => !w.isSubagent && w.canInject).map((w) => w.windowId);
  } else if (Array.isArray(body.targets)) {
    targetIds = body.targets.map(Number).filter((n) => Number.isFinite(n));
  }
  const targets = targetIds
    .map((id) => list.windows.find((w) => w.windowId === id && !w.isSubagent && w.canInject))
    .filter(Boolean);
  if (!targets.length) return { ok: false, error: '没有可用的对话对象（请先打开 AI 窗口）' };

  const mode = body.mode === 'sequential' ? 'sequential' : 'parallel';
  const withContext = body.withContext !== false;

  const userMsg = pushMsg({
    role: 'user', who: '我', text: text,
    targets: targets.map((t) => ({ windowId: t.windowId, label: t.title || t.providerId })),
    mode: mode,
  });

  chat.sending = true;
  const baseContext = withContext ? buildChatContext(14) : '';

  const one = async (w) => {
    chat.busy[w.windowId] = true;
    try {
      const prompt = baseContext ? (baseContext + '\n\n---\n' + text) : text;
      const res = await sendAndCapture(wcOf(w), prompt, cfg.replyTimeoutMs);
      if (res.ok) {
        return pushMsg({ role: 'ai', who: w.title || w.providerId || ('窗口 ' + w.windowId), windowId: w.windowId, text: res.text, replyTo: userMsg.id });
      }
      pushMsg({ role: 'system', who: '系统', text: '「' + (w.title || w.providerId) + '」未回复：' + res.error, err: true, replyTo: userMsg.id });
      return null;
    } finally {
      chat.busy[w.windowId] = false;
    }
  };

  const wcOf = (w) => {
    const t = pickTarget({ windowId: w.windowId });
    return t.ok ? t.wc : null;
  };

  (async () => {
    try {
      if (mode === 'sequential') {
        // 顺序发言：后面的能看到前面刚说的
        for (const w of targets) {
          const t = pickTarget({ windowId: w.windowId });
          if (!t.ok) { pushMsg({ role: 'system', who: '系统', text: '「' + (w.title || w.providerId) + '」不可用：' + t.error, err: true }); continue; }
          chat.busy[w.windowId] = true;
          try {
            const ctxNow = withContext ? buildChatContext(14) : '';
            const prompt = ctxNow ? (ctxNow + '\n\n---\n' + text) : text;
            const res = await sendAndCapture(t.wc, prompt, cfg.replyTimeoutMs);
            if (res.ok) pushMsg({ role: 'ai', who: w.title || w.providerId, windowId: w.windowId, text: res.text, replyTo: userMsg.id });
            else pushMsg({ role: 'system', who: '系统', text: '「' + (w.title || w.providerId) + '」未回复：' + res.error, err: true });
          } finally {
            chat.busy[w.windowId] = false;
          }
        }
      } else {
        await Promise.all(targets.map(one));
      }
    } catch (e) {
      log('聊天发送异常:', e && e.message);
      pushMsg({ role: 'system', who: '系统', text: '发送异常：' + ((e && e.message) || e), err: true });
    } finally {
      chat.sending = false;
    }
  })();

  return { ok: true, message: userMsg, sentTo: targets.map((t) => ({ windowId: t.windowId, label: t.title || t.providerId })) };
}

loadChat();

// ===================== 配置与令牌 =====================
function readConfig() {
  const out = { host: '127.0.0.1', hostPort: 18901, autoStart: true, enabled: true, replyTimeoutMs: 180000, maxAttachMB: 20 };
  try {
    const file = path.join(USER_DIR, 'plugins-config.json');
    if (fs.existsSync(file)) {
      const table = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const c = table[PLUGIN_ID] || {};
      if (c.hostPort) out.hostPort = Number(c.hostPort) || out.hostPort;
      if (typeof c.host === 'string' && c.host) out.host = c.host;
      if (c.autoStart === false) out.autoStart = false;
      if (c.enabled === false) out.enabled = false;
      if (c.replyTimeoutMs) out.replyTimeoutMs = Number(c.replyTimeoutMs) || out.replyTimeoutMs;
      if (c.maxAttachMB) out.maxAttachMB = Number(c.maxAttachMB) || out.maxAttachMB;
    }
  } catch (e) { log('读配置失败:', e && e.message); }
  return out;
}

let _token = null;
function token() {
  if (_token) return _token;
  try {
    // 复用已有令牌，避免每次启动都让渲染侧读到旧值
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (t.length >= 32) { _token = t; return _token; }
    }
  } catch (_) { /* ignore */ }
  _token = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, _token, 'utf-8'); } catch (e) { log('写令牌失败:', e && e.message); }
  return _token;
}

const cfg = readConfig();
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS));
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > (limit || 1e6)) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

/** 带 Origin 的（浏览器跨源）请求必须带令牌；不带 Origin 的本机排障请求放行 */
function authorized(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return !!m && m[1].trim() === token();
}

// ===================== 主题检测 =====================
/**
 * 读应用当前主题（亮/暗）。
 *
 * 为什么不给独立窗口加 preload 直接暴露主题：那要改窗口配置，
 * 而本文件已在主进程，直接问权威单例更省事。
 * theme-manager.js 的打包版导出了 snapshot()，用与窗口表相同的 require 手法即可。
 *
 * 三级降级，任何一级失败都不会让页面拿不到配色：
 *   1. theme-manager.snapshot().active.colorScheme  ← 最准（含用户主题与覆盖层）
 *   2. nativeTheme.shouldUseDarkColors              ← 主进程原生配色
 *   3. 'dark'                                        ← 兜底
 */
let _tm = undefined;
function getThemeManager() {
  if (_tm !== undefined) return _tm;
  const file = resolveAppPath('out/src/app/theme/theme-manager.js')
    || resolveAppPath('src/app/theme/theme-manager.js');
  if (!file) { _tm = null; return null; }
  try { _tm = requireFromHere(file); }
  catch (e) { log('挂接 theme-manager 失败:', e && e.message); _tm = null; }
  return _tm;
}

function currentColorScheme() {
  try {
    const tm = getThemeManager();
    if (tm && typeof tm.snapshot === 'function') {
      const snap = tm.snapshot();
      const cs = snap && snap.active && snap.active.colorScheme;
      if (cs === 'light' || cs === 'dark') return cs;
    }
  } catch (e) { log('读主题快照失败:', e && e.message); }
  try {
    const el = getElectron();
    const nt = el && el.nativeTheme;
    if (nt && typeof nt.shouldUseDarkColors === 'boolean') {
      return nt.shouldUseDarkColors ? 'dark' : 'light';
    }
  } catch (_) { /* ignore */ }
  return 'dark';
}

// ===================== 供应商资源（marked） =====================
/**
 * 把应用自带的 marked 提供给独立窗口。
 *
 * 为什么从 asar 里取而不是复制一份进插件：
 *   1. 不必把 46KB 第三方库塞进插件仓库（也免了许可证与版本漂移问题）
 *   2. 跟随应用升级
 * 独立窗口是 sandbox 且只加载本机 loopback 页面，用 <script src> 引用本服务即可。
 *
 * ⚠️ asar 里有两份同名文件，**必须挑对**：
 *     src/ui/vendor/marked.umd.js   46973 B  真 UMD（应用自己用的就是这份）
 *     out/src/ui/vendor/marked.umd.js 67050 B esbuild 转出来的 **ESM**（含 export）
 * 先前按 out → src 的顺序找，结果把 ESM 版发给了浏览器：
 * 经典 <script> 遇到顶层 export 直接抛 "Unexpected token 'export'"，
 * 于是 window.marked 是 undefined，Markdown 静默退回纯文本 —— 界面上什么都看不出来。
 * 现在改为「逐个候选读进来 + 校验可用性」，顺序不再重要。
 */
const VENDOR_CANDIDATES = {
  'marked.umd.js': [
    'src/ui/vendor/marked.umd.js',      // 真 UMD，优先
    'out/src/ui/vendor/marked.umd.js',  // 兜底（若是 ESM 会被下面的校验挡掉）
  ],
};
const _vendorCache = {};

/** 判断一段 JS 能否被经典 <script> 直接执行（顶层 export / import 会直接语法错误） */
function isClassicScript(text) {
  // 只看行首：字符串或注释里出现 export 不算
  if (/^[ \t]*export[ \t{*]/m.test(text)) return false;
  if (/^[ \t]*import[ \t{*"']/m.test(text)) return false;
  return true;
}

function readVendor(name) {
  const cands = VENDOR_CANDIDATES[name];
  if (!cands) return { ok: false, error: '不在白名单' };
  if (_vendorCache[name]) return _vendorCache[name];

  const tried = [];
  for (const rel of cands) {
    const file = resolveAppPath(rel);
    if (!file) { tried.push(rel + '(不存在)'); continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); }
    catch (e) { tried.push(rel + '(读取失败: ' + e.message + ')'); continue; }
    if (!isClassicScript(text)) {
      tried.push(rel + '(是 ESM，经典 <script> 加载会语法错误)');
      continue;
    }
    const buf = Buffer.from(text, 'utf-8');
    log('已挂接 vendor:', rel, '(' + buf.length + ' B)');
    _vendorCache[name] = { ok: true, buf: buf, from: rel };
    return _vendorCache[name];
  }
  const err = '找不到可用的 ' + name + '：' + tried.join('；');
  log(err);
  return { ok: false, error: err };
}

// ===================== 独立聊天室窗口 =====================
/** 1×1 透明 GIF：图片信标的响应体 */
const BEACON_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
/**
 * 为什么不复用 AI 页面里那块浮窗：
 * 它挂在 AI 页面上，会压住正文，而且页面一重载就没了。
 * 这里按应用自身的做法（参考 src/app/ipc/shell.ts:268-284 的「飞书配置教程」）
 * 开一个独立 BrowserWindow，加载本机 loopback 上的完整页面。
 *
 * 顺带一个好处：窗口的开/关与任务的跑/停解耦——关掉窗口不会中断正在进行的对话，
 * 因为编排状态在主进程，不在页面里。
 */
let roomWin = null;

function getElectron() {
  try { return requireFromHere('electron'); } catch (_) { return null; }
}

/** 把令牌、实际端口与配置烧进页面再返回（页面只在本机 loopback 上，等同给它的凭证） */
function readWindowHtml() {
  const f = path.join(PLUGIN_DIR, 'ui', 'room-window.html');
  let html = fs.readFileSync(f, 'utf-8');
  html = html.split('__ROOM_TOKEN__').join(token());
  html = html.split('__ROOM_PORT__').join(String(listenPort || cfg.hostPort));
  html = html.split('__ROOM_MAX_ATTACH__').join(String(Math.max(1, Number(cfg.maxAttachMB) || 20)));
  return html;
}

async function openRoomWindow() {
  const el = getElectron();
  if (!el || !el.BrowserWindow) return { ok: false, error: '拿不到 electron.BrowserWindow' };
  const st = await ensureServer();
  if (!st.ok) return { ok: false, error: st.error || '服务未启动' };

  const url = 'http://127.0.0.1:' + listenPort + '/window';

  if (roomWin && !roomWin.isDestroyed()) {
    try {
      if (roomWin.isMinimized()) roomWin.restore();
      roomWin.show();
      roomWin.focus();
    } catch (_) { /* ignore */ }
    return { ok: true, reused: true, url: url };
  }

  try {
    const scheme = currentColorScheme();
    roomWin = new el.BrowserWindow({
      width: 1040,
      height: 740,
      minWidth: 760,
      minHeight: 500,
      title: '多 AI 同室 · 聊天室',
      // 首帧背景跟随主题，避免开窗时闪一下深色
      backgroundColor: scheme === 'light' ? '#f7f8fa' : '#14161a',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    // 沙箱窗口里点外链不能就地导航（那会把聊天界面顶掉，且回不来）。
    // 一律交给系统默认浏览器打开。
    try {
      roomWin.webContents.setWindowOpenHandler(({ url: target }) => {
        try {
          const el2 = getElectron();
          if (el2 && el2.shell && /^https?:\/\//i.test(target)) el2.shell.openExternal(target);
        } catch (_) { /* ignore */ }
        return { action: 'deny' };
      });
      roomWin.webContents.on('will-navigate', (e, target) => {
        // 只允许留在本服务内；其余（含 http 外链）交给系统浏览器
        if (target === url || target.indexOf('http://127.0.0.1:' + listenPort + '/') === 0) return;
        e.preventDefault();
        try {
          const el2 = getElectron();
          if (el2 && el2.shell && /^https?:\/\//i.test(target)) el2.shell.openExternal(target);
        } catch (_) { /* ignore */ }
      });
    } catch (e) { log('挂接外链处理失败:', e && e.message); }

    roomWin.on('closed', () => { roomWin = null; });
    roomWin.loadURL(url);
    log('已打开聊天室窗口:', url, '主题=' + scheme);
    return { ok: true, url: url };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('打开聊天室窗口失败:', msg);
    roomWin = null;
    return { ok: false, error: msg };
  }
}

function closeRoomWindow() {
  if (roomWin && !roomWin.isDestroyed()) {
    try { roomWin.close(); } catch (_) { /* ignore */ }
  }
  roomWin = null;
  return { ok: true };
}

/**
 * 往壳页面的「新建窗口」按钮旁边注入一个「聊天室」按钮。
 *
 * 为什么不用官方的 ctx.ui.shell.addToolbarButton：那个只能挂到
 * 工具栏/状态栏/侧边栏三处（src/ui/shell/scripts/plugin-shell.ts:64-108），
 * 够不到窗口页的 #win-new（src/ui/shell/partials/pages/windows.html:4）。
 * 而本文件就跑在主进程，可以直接对壳页面的 webContents 注入，
 * 并用 MutationObserver 兜住 SPA 重渲染导致的按钮丢失。
 *
 * 为什么点击走 <img> 信标而不是 fetch：壳页面是 file:// 协议，
 * 从 file:// 发往 http://127.0.0.1 的 fetch 会被拦（ai-gateway 的 providers/gateway.js
 * 也专门注释过这一点，它同样用零尺寸 <img onerror> 绕开）。
 * 图片加载不受该限制，且不带 Origin 头，因此服务端把它当本机请求放行。
 */
function buildShellInjectCode() {
  const tok = encodeURIComponent(token());
  const port = Number(listenPort || cfg.hostPort) || 18901;
  return [
    '(function () {',
    '  var ID = "ck-room-launch";',
    '  var PORT = ' + port + ';',
    '  var TK = "' + tok + '";',
    '  function ensure() {',
    '    var anchor = document.getElementById("win-new");',
    '    if (!anchor || !anchor.parentNode) return;',
    '    var old = document.getElementById(ID);',
    '    if (old) { if (old.previousSibling === anchor && old.parentNode === anchor.parentNode) return; old.parentNode.removeChild(old); }',
    '    var b = document.createElement("button");',
    '    b.className = "ck-btn ck-btn-anim";',
    '    b.id = ID;',
    '    b.title = "打开独立的聊天室窗口（多 AI 同室）";',
    '    var NS = "http://www.w3.org/2000/svg";',
    '    var svg = document.createElementNS(NS, "svg");',
    '    svg.setAttribute("class", "ck-btn-icon");',
    '    svg.setAttribute("viewBox", "0 0 24 24");',
    '    svg.setAttribute("fill", "none");',
    '    svg.setAttribute("stroke", "currentColor");',
    '    svg.setAttribute("stroke-width", "2");',
    '    svg.setAttribute("stroke-linecap", "round");',
    '    svg.setAttribute("stroke-linejoin", "round");',
    '    var c = document.createElementNS(NS, "circle");',
    '    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9");',
    '    var p1 = document.createElementNS(NS, "path"); p1.setAttribute("d", "M12 3v18");',
    '    var p2 = document.createElementNS(NS, "path"); p2.setAttribute("d", "M3 12h18");',
    '    svg.appendChild(c); svg.appendChild(p1); svg.appendChild(p2);',
    '    var sp = document.createElement("span");',
    '    sp.textContent = "聊天室";',
    '    b.appendChild(svg); b.appendChild(sp);',
    '    b.addEventListener("click", function () {',
    '      b.disabled = true;',
    '      // 图片信标：file:// 下唯一能打到本机 HTTP 的可靠方式',
    '      var im = new Image();',
    '      im.onload = im.onerror = function () {',
    '        setTimeout(function () { b.disabled = false; }, 800);',
    '      };',
    '      im.src = "http://127.0.0.1:" + PORT + "/window/open-beacon?t=" + TK + "&_=" + Date.now();',
    '    });',
    '    anchor.parentNode.insertBefore(b, anchor.nextSibling);',
    '  }',
    '  ensure();',
    '  if (!window.__ckRoomObserver) {',
    '    var timer = null;',
    '    window.__ckRoomObserver = new MutationObserver(function () {',
    '      if (timer) return;',
    '      timer = setTimeout(function () { timer = null; try { ensure(); } catch (e) {} }, 150);',
    '    });',
    '    try { window.__ckRoomObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}',
    '  }',
    '})();',
  ].join('\n');
}

/** 给所有壳页面注入按钮（壳页面可能晚于插件加载，也会在重载后丢按钮，故周期性调用） */
function injectShellButtons() {
  const el = getElectron();
  if (!el || !el.webContents) return { ok: false, error: '拿不到 electron.webContents' };
  const code = buildShellInjectCode();
  let n = 0;
  // 壳窗口：ctx.win；AI 页面是 ctx.view，别搞混
  const wm = getWindowStateModule();
  if (wm) {
    let ctxs = [];
    try { ctxs = wm.getAllContexts() || []; } catch (_) { ctxs = []; }
    for (const c of ctxs) {
      const wc = c && c.win && c.win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      try { Promise.resolve(wc.executeJavaScript(code, true)).catch(function () {}); n++; } catch (_) { /* ignore */ }
    }
  }
  // 兜底：至少把当前主窗口覆盖到
  try {
    const all = el.webContents.getAllWebContents ? el.webContents.getAllWebContents() : [];
    if (!n && all && all.length) { /* 无窗口表时不做，避免误注入 AI 页面 */ }
  } catch (_) { /* ignore */ }
  return { ok: true, injected: n };
}

// ===================== HTTP 服务 =====================
let server = null;
let listenPort = 0;

function handle(req, res) {
  let url;
  try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
  catch (_) { json(res, 400, { ok: false, error: 'bad url' }); return; }

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }
  if (!authorized(req)) { json(res, 403, { ok: false, error: 'unauthorized' }); return; }

  const p = url.pathname;

  if (p === '/' || p === '/status') {
    const w = listWindows();
    json(res, 200, {
      ok: true, id: PLUGIN_ID, version: VERSION, pid: process.pid,
      port: listenPort, uptimeSec: Math.round(process.uptime()),
      // 页面的亮/暗跟随应用主题（页面每 1.5 秒轮询 /status，天然会跟着变）
      theme: currentColorScheme(),
      windowsOk: w.ok, windowCount: w.count || 0,
      windowError: w.error || null,
      windows: w.windows || [],
    });
    return;
  }

  if (p === '/log') {
    let text = '';
    try { text = fs.readFileSync(LOG_FILE, 'utf-8'); } catch (_) { text = '(无日志)'; }
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS_HEADERS));
    res.end(text.split('\n').slice(-120).join('\n'));
    return;
  }

  // 只读探针：逐个窗口问一句「你是谁、能不能收字」
  if (p === '/probe') {
    (async () => {
      const list = listWindows();
      if (!list.ok) { json(res, 200, { ok: false, error: list.error }); return; }
      const results = [];
      for (const w of list.windows) {
        const entry = Object.assign({}, w);
        if (!w.canInject) { entry.probe = { ok: false, error: '窗口不可注入' }; results.push(entry); continue; }
        const t = pickTarget({ index: w.index });
        if (!t.ok) { entry.probe = { ok: false, error: t.error }; results.push(entry); continue; }
        try { entry.probe = { ok: true, data: await t.wc.executeJavaScript(PROBE_CODE, true) }; }
        catch (e) { entry.probe = { ok: false, error: (e && e.message) || String(e) }; }
        results.push(entry);
      }
      json(res, 200, { ok: true, count: results.length, results });
    })().catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  // 发消息并收回复（真正干活的那个）
  if (p === '/send' && req.method === 'POST') {
    readBody(req).then(async (raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return; }
      if (typeof body.text !== 'string' || !body.text.trim()) { json(res, 400, { ok: false, error: '缺少 text' }); return; }
      const t = pickTarget(body);
      if (!t.ok) { json(res, 200, { ok: false, error: t.error, windows: t.windows || [] }); return; }
      const r = await sendAndCapture(t.wc, body.text, body.timeoutMs || cfg.replyTimeoutMs);
      json(res, 200, Object.assign({ target: { windowId: t.info.windowId, profileId: t.info.profileId, url: t.info.url } }, r));
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  // ===== 聊天室 =====
  if (p === '/chat/status') { json(res, 200, { ok: true, chat: chatSnapshot() }); return; }

  if (p === '/chat/clear' && req.method === 'POST') {
    chat.messages = [];
    saveChatSoon();
    json(res, 200, { ok: true });
    return;
  }

  // 发消息（可带附件）。附件走 JSON + base64：
  // 本页面是 http://127.0.0.1 而非 file://，所以能用 fetch 正常 POST。
  if (p === '/chat/send' && req.method === 'POST') {
    readBody(req, 80 * 1024 * 1024).then(async (raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return; }

      // 先处理附件：能挂上的才算数，挂不上的如实报错而不阻断文本
      const files = Array.isArray(body.files) ? body.files : [];
      const attached = [];      // 真正成功送达的
      const failed = [];        // 每一项失败
      let attempted = 0;        // 尝试过的文件数
      if (files.length) {
        const list = listWindows();
        const t0 = (Array.isArray(body.targets) ? body.targets.map(Number) : []);
        // 附件的目标：显式 targets；否则全体可注入窗口
        const dst = t0.length
          ? t0.map((id) => list.windows.find((w) => w.windowId === id)).filter(Boolean)
          : list.windows.filter((w) => !w.isSubagent && w.canInject);
        for (const f of files) {
          attempted++;
          let buf = null;
          try { buf = Buffer.from(String(f.data || ''), 'base64'); } catch (_) { buf = null; }
          if (!buf || !buf.length) { failed.push({ name: f.name, error: '内容为空' }); continue; }
          const per = { name: f.name, ok: 0, targets: [] };
          for (const w of dst) {
            const t = pickTarget({ windowId: w.windowId });
            if (!t.ok) { failed.push({ name: f.name, target: w.title || w.windowId, error: t.error }); continue; }
            const r = await attachFileToWindow(t.wc, { name: f.name, mime: f.mime, buffer: buf });
            if (r.ok) { per.ok++; per.targets.push(w.title || w.providerId); }
            else failed.push({ name: f.name, target: w.title || w.providerId, error: r.error });
          }
          // 只有至少送达一个窗口才算这个附件成功
          if (per.ok > 0) attached.push(per);
        }
        if (attached.length) {
          pushMsg({
            role: 'user', who: '我',
            text: '（附件）' + attached.map((a) => a.name).join('、'),
            attach: attached, attachFailed: failed,
          });
        }
        for (const f of failed) {
          pushMsg({ role: 'system', who: '系统', text: '附件「' + f.name + '」' + (f.target ? ('→ ' + f.target) : '') + ' 失败：' + f.error, err: true });
        }
      }

      const hasText = !!(body.text && String(body.text).trim());
      // 既没文字也没附件：这不是"只发附件"，而是空消息
      if (!hasText && !files.length) {
        json(res, 200, { ok: false, error: '消息不能为空' });
        return;
      }
      // 带了附件却一个都没送达：一律不发，如实报错。
      // （否则用户会以为发出去了，而 AI 那边只收到一段没有附件的文字。）
      if (attempted > 0 && !attached.length) {
        const why = failed.map((f) => (f.target ? (f.target + '：') : '') + f.error).join('；');
        json(res, 200, {
          ok: false,
          error: '附件全部上传失败，未发送。' + why,
          attached: attached, failed: failed,
        });
        return;
      }
      if (!hasText) {
        // 只发附件也是合法操作
        json(res, 200, { ok: true, attachOnly: true, attached: attached, failed: failed });
        return;
      }

      const r = await chatSend(body);
      json(res, 200, Object.assign({ attached: attached, failed: failed }, r));
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  // ===== 应用自带的第三方资源（页面用 <script src> 引用）=====
  // 只放行白名单里的文件名，不接受任意路径 —— 这等价于把 asar 里的文件开给本机页面读，
  // 白名单是唯一防线，不能省。
  if (p.indexOf('/vendor/') === 0) {
    const name = decodeURIComponent(p.slice('/vendor/'.length));
    const v = readVendor(name);
    if (!v.ok) {
      // 如实回报原因，别静默 404 —— 加载失败会让页面退回纯文本，界面上看不出来
      log('vendor 请求失败:', name, v.error);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('vendor not available: ' + v.error);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(v.buf);
    return;
  }

  // ===== 独立聊天室窗口 =====
  // 页面自带令牌（服务端烧进去的），所以这个路由不做令牌校验，但只可能来自 loopback。
  if (p === '/window') {
    getElectron(); // 触发 electron 解析（失败也无妨，页面本身不依赖它）
    try {
      const html = readWindowHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读取界面失败: ' + ((e && e.message) || e));
    }
    return;
  }

  if (p === '/window/open' && req.method === 'POST') {
    openRoomWindow().then((r) => json(res, 200, r), (e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  // 图片信标版开窗：壳页面是 file://，只能用 <img> 打过来（详见 buildShellInjectCode 注释）
  if (p === '/window/open-beacon') {
    const t = url.searchParams.get('t') || '';
    if (t !== token()) {
      res.writeHead(403, { 'Content-Type': 'image/gif' });
      res.end(BEACON_GIF);
      return;
    }
    openRoomWindow().catch((e) => log('信标开窗失败:', e && e.message));
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    res.end(BEACON_GIF);
    return;
  }

  if (p === '/window/close' && req.method === 'POST') { json(res, 200, closeRoomWindow()); return; }

  if (p === '/window/inject' && req.method === 'POST') { json(res, 200, injectShellButtons()); return; }

  json(res, 404, { ok: false, error: 'no route: ' + p });
}

/** 正在进行的启动过程。没有它就会出现双重 listen：
 *  模块加载时已自动启动，若此时又有人调 ensureServer()，
 *  listenPort 尚为 0 → 误判为"没起" → 新建一个 server 覆盖模块变量，
 *  于是前一个 server 的 listening 回调里 server.address() 已指向新实例（尚未监听）而为 null，
 *  直接抛 TypeError 把启动流程打断。 */
let starting = null;

function ensureServer() {
  if (server && listenPort) return Promise.resolve({ ok: true, port: listenPort });
  if (starting) return starting;

  starting = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let srv;
    try {
      srv = http.createServer((req, res) => {
        try { handle(req, res); }
        catch (e) { try { json(res, 500, { ok: false, error: (e && e.message) || String(e) }); } catch (_) {} }
      });
    } catch (e) {
      log('创建服务异常:', e && e.message);
      done({ ok: false, error: (e && e.message) || String(e) });
      return;
    }

    let retried = false;
    srv.on('error', (e) => {
      const msg = (e && e.message) || String(e);
      log('服务错误:', msg);
      // 端口被占用：换随机端口再试一次，但只试一次，避免无限递归
      if (e && e.code === 'EADDRINUSE' && !retried) {
        retried = true;
        log('端口 ' + cfg.hostPort + ' 被占用，改用随机端口');
        try { srv.listen(0, '127.0.0.1'); }
        catch (e2) { done({ ok: false, error: (e2 && e2.message) || String(e2) }); }
        return;
      }
      done({ ok: false, error: msg });
    });

    srv.on('listening', () => {
      let addr = null;
      try { addr = srv.address(); } catch (_) { addr = null; }
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      if (!port) { done({ ok: false, error: '监听成功但拿不到端口' }); return; }
      // 到这里才把模块级变量指向真正在监听的实例
      server = srv;
      listenPort = port;
      // 把**实际**端口写给 UI：端口被占用时会换随机端口，UI 光看配置是猜不到的
      try { fs.writeFileSync(PORT_FILE, String(port), 'utf-8'); } catch (e) { log('写端口文件失败:', e && e.message); }
      log('服务已启动: http://127.0.0.1:' + port + '  pid=' + process.pid + (retried ? '（备用端口）' : ''));
      done({ ok: true, port: port });
    });

    try { srv.listen(cfg.hostPort, '127.0.0.1'); }
    catch (e) {
      log('listen 抛错:', e && e.message);
      done({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // 失败后允许下次重试
  starting.then((r) => { if (!r || !r.ok) starting = null; });
  return starting;
}

// ===================== 出口 =====================
if (IS_RENDERER) {
  log('渲染进程：跳过启动（服务只在主进程起，否则会有两个实例）');
} else {
  token();
  if (cfg.autoStart && cfg.enabled) {
    ensureServer().then((r) => {
      if (!r || !r.ok) { log('服务未启动，跳过按钮注入'); return; }
      // 壳页面可能晚于 provider 加载，也可能在重载后丢掉按钮：
      // 注入代码自己带 MutationObserver 自愈，这里再周期性补刀兜底。
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        try { injectShellButtons(); } catch (e) { log('注入按钮异常:', e && e.message); }
        if (tries >= 40) clearInterval(iv);      // 约 2 分钟后停止轮询
      }, 3000);
      try { injectShellButtons(); } catch (e) { log('注入按钮异常:', e && e.message); }
    });
  } else {
    log('未自动启动（autoStart=' + cfg.autoStart + ' enabled=' + cfg.enabled + '）');
  }
}

/**
 * provider 契约：validateProvider 要求 id / name / homeUrl / sessionUrlBase /
 * matchesUrl / extractSessionId 六项齐全，缺一即被跳过。
 *
 * 注意 sessionUrlBase 不能给空串：validate.ts:14 判的是 `!p.sessionUrlBase`，
 * 空串是假值会被判为「缺少 sessionUrlBase」而整个 provider 被丢弃。
 *
 * matchesUrl 恒 false —— 本 provider 不是 AI 平台，绝不能参与 URL 识别，
 * 否则会劫持正常的平台判断。（与 ai-gateway 同一做法。）
 */
const BASE_URL = 'http://127.0.0.1:' + (cfg.hostPort || 18901);
const provider = {
  id: PLUGIN_ID,
  name: '多 AI 同室（主进程编排器）',
  homeUrl: BASE_URL,
  sessionUrlBase: BASE_URL + '/',
  extractSessionId: function () { return null; },
  matchesUrl: function () { return false; },
};

module.exports = provider;
module.exports.__room = {
  version: VERSION,
  ensureServer: ensureServer,
  listWindows: listWindows,
  probe: PROBE_CODE,
  send: sendAndCapture,
  pickTarget: pickTarget,
  chatSend: chatSend,
  chatSnapshot: chatSnapshot,
  attachFileToWindow: attachFileToWindow,
  buildAttachCode: buildAttachCode,
  buildChatContext: buildChatContext,
  openWindow: openRoomWindow,
  closeWindow: closeRoomWindow,
  injectShellButtons: injectShellButtons,
  buildShellInjectCode: buildShellInjectCode,
  readWindowHtml: readWindowHtml,
  currentColorScheme: currentColorScheme,
  readVendor: readVendor,
  getThemeManager: getThemeManager,
  getRoomWin: function () { return roomWin; },
  logFile: LOG_FILE,
  tokenFile: TOKEN_FILE,
  portFile: PORT_FILE,
  status: function () { return { running: !!server, port: listenPort, pid: process.pid }; },
};
