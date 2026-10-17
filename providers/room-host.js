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

const VERSION = '0.18.0';
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

/**
 * 给一个窗口起「唯一且可被 @ 的名字」。
 *
 * 为什么不能用标题：两个 DeepSeek 窗口的标题可能一模一样，
 * 于是上下文里出现两行「DeepSeek：…」，AI 根本分不清哪句是自己说的，
 * 会把自己说过的话当成别人说的——接力跑到第二轮就会开始混乱。
 *
 * 做法：平台名 + 窗口序号，并保证整批不重复。全用不含空格的字符，
 * 这样 `@名字` 能被简单的空白分词解析出来。
 */
function assignMentions(windows) {
  const used = new Map();
  const out = [];
  for (const w of windows) {
    let base = String(w.providerId || w.title || 'AI')
      .replace(/\s+/g, '')          // @ 点名不能带空格
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      .slice(0, 14) || 'AI';
    let n = (used.get(base) || 0) + 1;
    used.set(base, n);
    // 同平台第 2 个起加序号；同时避开已有名字
    let name = base + '-' + n;
    while (out.some((x) => x.mention === name)) { n++; name = base + '-' + n; }
    out.push({ mention: name, label: w.title || w.providerId || ('窗口 ' + w.windowId), windowId: w.windowId });
  }
  return out;
}

/** 解析文本里出现了哪些 mention（长的优先，避免前缀互相吃掉） */
function parseMentions(text, mentions) {
  if (!text) return [];
  const sorted = mentions.slice().sort((a, b) => b.mention.length - a.mention.length);
  const hit = [];
  for (const m of sorted) {
    // 用前后边界判断，避免 @AI-1 命中 @AI-10
    const re = new RegExp('@' + m.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w\\u4e00-\\u9fa5-])');
    if (re.test(text)) hit.push(m);
  }
  return hit;
}

/** 按 windowId / profileId / index 选一个可注入的窗口 */function pickTarget(sel) {
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
    '    var acc = "", lastText = "", done = false, thinkAcc = "";',
    '    var BT = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);',
    // 把增量文本挂到页面全局，供主进程轮询取出 —— executeJavaScript 只在最后 resolve 一次，
    // 没有这个出口就拿不到中间过程。带一个单调递增的 n，便于主进程判断有没有变化。
    '    window.__ckRoomStream = { t: "", n: 0, done: false };',
    // 思考过程单独一个槽：可能与正文交替推送，混在一个变量里会互相覆盖
    '    window.__ckRoomThink = { t: "", n: 0 };',
    '    function hasToolBlock(t) { t = t || ""; return t.indexOf(BT + "cuckoo") >= 0 || t.indexOf(BT + "js") >= 0; }',
    '    function finish(text, reason) {',
    '      if (done) return; done = true;',
    '      window.removeEventListener("cuckoo-ai-stream", onStream);',
    '      window.removeEventListener("cuckoo-ai-response", onResp);',
    '      try { window.__ckRoomStream = { t: String(text || ""), n: window.__ckRoomStream.n + 1, done: true, reason: reason }; } catch (e) {}',
    '      resolve({ text: text, reason: reason, think: thinkAcc });',
    '    }',
    '    function onStream(ev) {',
    '      var d = (ev && ev.detail) || {};',
    // 思考过程：detail.think 一直都有（observer.ts 会透传），只是从来没读过。
    // 单独放一个槽，和正文分开——思考可能上万字，混在一起会把正文冲掉。
    '      if (typeof d.think === "string" && d.think.length >= thinkAcc.length) {',
    '        thinkAcc = d.think;',
    '        try { window.__ckRoomThink = { t: thinkAcc, n: (window.__ckRoomThink ? window.__ckRoomThink.n : 0) + 1 }; } catch (e) {}',
    '      }',
    '      if (typeof d.text === "string" && d.text.length >= acc.length) {',
    '        acc = d.text;',
    '        try { window.__ckRoomStream = { t: acc, n: window.__ckRoomStream.n + 1, done: false }; } catch (e) {}',
    '      }',
    '    }',
    '    function onResp(ev) {',
    '      var d = (ev && ev.detail) || {};',
    '      if (!d.finished) return;',
    '      var t = d.text || acc || ""; lastText = t;',
    '      if (hasToolBlock(t)) {',
    // 工具调用轮：清空已显示正文，并让页面上的半成品也一并清掉。
    //
    // 但**不能直接扔掉这段文本** —— 它就是"AI 要做什么动作"的唯一来源。
    // 之前一律丢弃，结果用户永远看不到成员打算改哪个文件、跑什么命令，
    // 只看到最后一句话。现在把它留在动作槽里，由主进程取走展示。
    '        acc = "";',
    '        try { window.__ckRoomAction = { t: String(t || ""), n: (window.__ckRoomAction ? window.__ckRoomAction.n : 0) + 1, at: Date.now() }; } catch (e) {}',
    '        try { window.__ckRoomStream = { t: "", n: window.__ckRoomStream.n + 1, done: false, tool: true }; } catch (e) {}',
    '        return;',
    '      }',
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

/** 只读页面上那个增量出口；不在则返回 null */
const STREAM_PEEK = '(function(){ var s = window.__ckRoomStream; return s ? { t: s.t, n: s.n, done: s.done === true } : null; })();';

/**
 * 读「动作槽」：AI 打算做什么（工具调用轮原文）。
 *
 * 与 STREAM_PEEK 分开读，因为两者节奏不同——正文是连续增量，
 * 动作是一轮一跳。合并成一个出口会让判断变复杂。
 */
const ACTION_PEEK = '(function(){ var a = window.__ckRoomAction; return a ? { t: a.t, n: a.n, at: a.at } : null; })();';

/**
 * 读「思考槽」：AI 的推理过程。
 *
 * 数据一直都有（`cuckoo-ai-stream` 的 detail.think），只是从没读过。
 * 注意不是所有平台都会给：DeepSeek 要开「深度思考」，ChatGPT 只有 o 系列，
 * Claude 要显式开 extended thinking。拿不到就是空，界面上要能优雅处理。
 */
const THINK_PEEK = '(function(){ var k = window.__ckRoomThink; return k ? { t: k.t, n: k.n } : null; })();';

/**
 * 从动作原文里解析出「涉及的文件」，并区分读/写。
 *
 * 为什么区分：**只有写才会撞车**。两个 AI 都读同一个文件没关系，
 * 一起写才会互相覆盖。不区分会给用户一堆没必要的警告。
 */
const WRITE_FNS = /^(write|edit|replace|create|delete|remove|move|rename|patch|append)/i;

function parseActionPaths(text) {
  const raw = String(text || '');
  const m = raw.match(/```(?:cuckoo|js)[^\n]*\n([\s\S]*?)```/);
  const body = m ? m[1] : raw;
  const writes = [];
  const reads = [];
  const re = /tools\.(\w+)\s*\(\s*\{([^}]*)\}/g;
  let x;
  while ((x = re.exec(body))) {
    const fn = x[1];
    const args = x[2];
    const p = (args.match(/path\s*:\s*["']([^"']+)["']/) || [])[1]
      || (args.match(/file\s*:\s*["']([^"']+)["']/) || [])[1];
    if (!p) continue;
    // 归一化：反斜杠转正斜杠、去掉 ./ 前缀。
    // 注意 \\+ → / ：Windows 路径经过 JSON 转义后可能留下连续反斜杠，
    // 只做 replace(/\\/g,'/') 会得到 src//win//f.js（实测踩过）。
    const norm = p.replace(/\\+/g, '/').replace(/^\.\//, '');
    if (WRITE_FNS.test(fn)) { if (writes.indexOf(norm) < 0) writes.push(norm); }
    else if (reads.indexOf(norm) < 0) reads.push(norm);
  }
  return { writes: writes, reads: reads };
}

/**
 * 当前有哪些文件正被谁占着。
 *
 * 只看**当前话题、且 30 分钟内**的写动作。
 * 不做永久占用——半小时前改过某个文件，不该阻止现在再改。
 */
const CLAIM_TTL_MS = 30 * 60 * 1000;

function currentClaims(topicId) {
  const topic = topicId || chat.activeTopic;
  const now = Date.now();
  const claims = {};
  for (const m of chat.messages) {
    if (m.role !== 'action') continue;
    if ((m.topic || chat.topics[0].id) !== topic) continue;
    if (now - (m.at || 0) > CLAIM_TTL_MS) continue;
    if (!m.claims || !m.claims.length) continue;
    for (const p of m.claims) {
      (claims[p] = claims[p] || []).push({
        mention: m.mention || m.who || '某位', at: m.at, windowId: m.windowId,
      });
    }
  }
  return claims;
}

/**
 * 给某位成员生成「文件占用提示」。
 *
 * 这是**软约束，不是锁**：插件层没有工具执行前的拦截钩子
 * （Cuckoo 只在各工具内部做 isProtectedPath 检查，插不进去），
 * 拦不住 AI 真的去写。能做的是把它知会清楚——
 * 让 AI 自己避开，或主动说明"我要改这个文件"。
 */
function buildClaimHint(selfMention, topicId) {
  const claims = currentClaims(topicId);
  const others = [];
  for (const p of Object.keys(claims)) {
    if (others.length >= 12) break;
    const holders = claims[p].filter((c) => c.mention !== selfMention);
    if (holders.length) {
      const names = [];
      for (const h of holders) if (names.indexOf(h.mention) < 0) names.push(h.mention);
      others.push(p + '（' + names.join('、') + ' 最近动过）');
    }
  }
  if (!others.length) return '';
  return '【文件占用提醒】以下文件最近已被其他人动过：\n'
    + others.map((x) => '- ' + x).join('\n')
    + '\n如果你要改这些文件，先说清你要改什么、为什么，或者换个不冲突的做法。'
    + '不要默默覆盖别人的改动。\n\n';
}

/** 从工具调用轮原文里抽出一个简短的动作摘要，给界面显示 */
function summarizeAction(text) {
  const raw = String(text || '');
  // 取第一个 ```cuckoo / ```js 代码块的起始几行；没有就取前 120 字
  const m = raw.match(/```(?:cuckoo|js)[^\n]*\n([\s\S]*?)```/);
  const body = m ? m[1] : raw;
  const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
  const pick = lines.slice(0, 4).join('\n');
  return pick.length > 400 ? (pick.slice(0, 400) + '…') : pick;
}

/**
 * 把动作压成**一行**，用于进上下文。
 *
 * 为什么不能直接用 summarizeAction 的结果：
 * 那个是给人看的（保留代码形状），一段就是 60-160 字。
 * 动作如果进上下文，按最近 14 条算，光动作就能吃掉一千多字，
 * 而且代码片段会干扰 AI 对"谁做了什么"的理解。
 *
 * 这里只留最关键的三样：**动作类型 + 目标**。
 *   writeFile src/csv.js
 *   runCommand `npm test`
 *   readFile a.js + writeFile b.js
 * 实测体积约为原来的 1/5，信息量够用。
 */
function compactAction(text) {
  const raw = String(text || '');
  const m = raw.match(/```(?:cuckoo|js)[^\n]*\n([\s\S]*?)```/);
  const body = m ? m[1] : raw;
  const calls = [];
  const re = /tools\.(\w+)\s*\(\s*\{([^}]*)\}/g;
  let x;
  while ((x = re.exec(body))) {
    const fn = x[1];
    const args = x[2];
    const p = (args.match(/path\s*:\s*["']([^"']+)["']/) || [])[1];
    const c = (args.match(/command\s*:\s*["']([^"']+)["']/) || [])[1];
    if (p) calls.push(fn + ' ' + p);
    else if (c) calls.push(fn + ' `' + c + '`');
    else calls.push(fn);
  }
  if (!calls.length) {
    // 认不出 tools.xxx：退回首行前 60 字，至少说明它在做什么
    const first = body.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    return first.slice(0, 60);
  }
  const joined = calls.join(' + ');
  return joined.length > 120 ? (joined.slice(0, 120) + '…') : joined;
}

/**
 * 向指定窗口发一条消息并等回复。
 *
 * @param opts.onProgress 可选：收到增量文本时调用（text, meta）。
 *        实现方式是从主进程轮询页面全局的增量出口 —— executeJavaScript 中途不返回，
 *        没有回调通道，轮询是这里最直接可靠的做法（250ms 一次，脚本极小）。
 */
/**
 * 发一条消息并等回复。
 *
 * @param opts.signal  AbortSignal —— 支持中途放弃。
 *
 * 为什么需要 signal：原先没有中断能力，用户点「停止」只是置了个标志，
 * 正在跑的那一次调用仍要一直等到 replyTimeoutMs（默认 180 秒）才返回。
 * "点了停止还要再等三分钟"是明确的坏体验。
 *
 * 注意能力边界：**无法真正掐断 AI 那边的生成**（我们只能通过
 * executeJavaScript 观察页面，没有取消接口）。能做的是不再等待它——
 * 立刻返回，让上层的循环尽快结束。
 */
async function sendAndCapture(wc, text, timeoutMs, opts) {
  const to = Math.max(15000, Math.min(900000, Number(timeoutMs) || 180000));
  const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const signal = opts && opts.signal ? opts.signal : null;

  // 先装监听，再发送（同一 webContents 上两次 executeJavaScript 的顺序有保证）
  const capPromise = wc.executeJavaScript(buildCaptureCode(to), true)
    .catch((e) => ({ text: '', reason: 'capture_error:' + (e && e.message) }));

  // 增量轮询：只在有 onProgress 时启动，且随 capture 结束自动停
  let stopPeek = false;
  let peekTimer = null;
  const onAction = opts && typeof opts.onAction === 'function' ? opts.onAction : null;
  const onThink = opts && typeof opts.onThink === 'function' ? opts.onThink : null;
  if (onProgress || onAction || onThink) {
    let lastN = -1;
    let lastActN = -1;
    let lastThinkN = -1;
    (async function peekLoop() {
      // 先立刻读一次再进定时循环。
      //
      // 为什么不能只有 await 定时器：如果 AI 秒回（尤其自动化场景），
      // capture 会在第一个 250ms 走完之前结束，stopPeekLoop 的
      // clearTimeout 会让那个 promise 永远不 resolve，整轮 peek 一次都不跑。
      // 实测复现过：桩同步返回时，动作一次都没被读到。
      while (!stopPeek) {
        try {
          if (onProgress) {
            const s = await wc.executeJavaScript(STREAM_PEEK, true);
            if (s && typeof s.n === 'number' && s.n !== lastN) {
              lastN = s.n;
              if (typeof s.t === 'string' && s.t.length) onProgress(s.t, { done: s.done === true });
            }
          }
          // 动作与正文分两个槽读：动作是一轮一跳，不能用增量的去重条件
          if (onAction) {
            const a = await wc.executeJavaScript(ACTION_PEEK, true);
            if (a && typeof a.n === 'number' && a.n !== lastActN) {
              lastActN = a.n;
              const brief = summarizeAction(a.t);
              if (brief) onAction(brief, { raw: a.t });
            }
          }
          // 思考过程：增量推送，界面折叠显示；不进上下文
          if (onThink) {
            const k = await wc.executeJavaScript(THINK_PEEK, true);
            if (k && typeof k.n === 'number' && k.n !== lastThinkN) {
              lastThinkN = k.n;
              if (typeof k.t === 'string' && k.t.length) onThink(k.t);
            }
          }
        } catch (_) { /* 页面可能正在导航，忽略这一轮 */ }
        if (stopPeek) break;
        await new Promise((r) => { peekTimer = setTimeout(r, 250); });
      }
    })().catch(() => {});
  }
  // 停止时别再 clearTimeout：让定时器自然到期，循环会因 stopPeek 退出。
  // （clearTimeout 会让等待中的 promise 永远悬着，见上面的注释。）
  const stopPeekLoop = () => { stopPeek = true; };

  // 发送前就被叫停：不必再发
  if (signal && signal.aborted) { stopPeekLoop(); return { ok: false, aborted: true, error: '已取消' }; }

  let sendRes;
  try { sendRes = await wc.executeJavaScript(buildSendCode(text), true); }
  catch (e) { stopPeekLoop(); return { ok: false, error: '注入失败: ' + (e && e.message) }; }
  if (sendRes === 'NO_INPUT') { stopPeekLoop(); return { ok: false, error: '未找到输入框（页面可能未就绪）' }; }
  if (sendRes === 'SET_FAILED') { stopPeekLoop(); return { ok: false, error: '写入输入框失败' }; }
  if (sendRes !== 'SENT') { stopPeekLoop(); return { ok: false, error: '发送失败: ' + sendRes }; }

  // 等回复：正常完成 / 整体超时 / 用户取消，三者竞速
  const racers = [
    capPromise,
    new Promise((r) => setTimeout(() => r({ text: '', reason: 'overall_timeout' }), to + 5000)),
  ];
  if (signal) {
    racers.push(new Promise((r) => {
      const onAbort = () => r({ text: '', reason: 'aborted' });
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }
  const res = await Promise.race(racers);
  stopPeekLoop();
  const reason = res && res.reason;
  if (reason === 'aborted') {
    return { ok: false, aborted: true, error: '已取消', partial: (res && res.text) || '' };
  }
  if (reason === 'timeout' || reason === 'overall_timeout') {
    return { ok: false, error: '等待回复超时', partial: (res && res.text) || '' };
  }
  if (reason && String(reason).indexOf('capture_error') === 0) return { ok: false, error: reason };
  return { ok: true, text: (res && res.text) || '', think: (res && res.think) || '' };
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
const chat = {
  messages: [], seq: 0, busy: {}, sending: false, topics: [], activeTopic: '', trash: null,
  // 发言方式：parallel（同时开工，快但互相看不见）
  //          sequential（一个一个来，后者能看到前者）
  // 用户实测过：并行时两个成员会干同一件事，所以要能切到串行。
  mode: 'parallel',
};
let chatSaveTimer = null;

/**
 * 话题（会话隔离）。
 *
 * 为什么需要：所有对话挤在一条流里时，多话题并行会互相污染——
 * 聊代码时上下文里夹着刚才聊天气的记录，AI 容易被带偏，也白费 token。
 * 给消息打上 topic，取上下文时只取同话题的。
 *
 * 用 id 而不是标题做键：标题可以随时改，历史消息不必跟着回填。
 */
const DEFAULT_TOPIC = '默认';

/** 生成一个不冲突的话题 id */
function newTopicId() {
  let n = chat.topics.length + 1;
  let id = 't' + n;
  const used = new Set(chat.topics.map((t) => t.id));
  while (used.has(id)) { n++; id = 't' + n; }
  return id;
}

/** 确保记录里至少有一个话题，且 activeTopic 合法 */
function ensureTopics() {
  if (!Array.isArray(chat.topics)) chat.topics = [];
  if (!chat.topics.length) {
    chat.topics.push({ id: 't1', title: DEFAULT_TOPIC, at: Date.now() });
  }
  const ids = new Set(chat.topics.map((t) => t.id));
  if (!chat.activeTopic || !ids.has(chat.activeTopic)) {
    chat.activeTopic = chat.topics[chat.topics.length - 1].id;
  }
}

/**
 * 旧记录迁移：v0.9.0 之前的消息没有 topic 字段。
 * 全部归到默认话题，避免升级后历史消息"消失"。
 */
function migrateTopics() {
  ensureTopics();
  const first = chat.topics[0];
  let moved = 0;
  for (const m of chat.messages) {
    if (!m.topic) { m.topic = first.id; moved++; }
  }
  if (moved) log('已把 ' + moved + ' 条旧记录归入「' + first.title + '」');
  ensureTopics();
}

function createTopic(title) {
  ensureTopics();
  const clean = String(title || '').trim().slice(0, 40) || ('话题 ' + (chat.topics.length + 1));
  const t = { id: newTopicId(), title: clean, at: Date.now() };
  chat.topics.push(t);
  chat.activeTopic = t.id;
  saveChatSoon();
  log('新建话题「' + clean + '」id=' + t.id);
  return t;
}

function renameTopic(id, title) {
  const t = chat.topics.find((x) => x.id === id);
  if (!t) return { ok: false, error: '话题不存在' };
  const clean = String(title || '').trim().slice(0, 40);
  if (!clean) return { ok: false, error: '标题不能为空' };
  t.title = clean;
  saveChatSoon();
  return { ok: true, topic: t };
}

/** 删除话题：连同它的消息一起删。最后一个话题不允许删。 */
function deleteTopic(id) {
  ensureTopics();
  if (chat.topics.length <= 1) return { ok: false, error: '至少要保留一个话题' };
  const idx = chat.topics.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: '话题不存在' };
  const gone = chat.topics[idx];
  const removed = chat.messages.filter((m) => m.topic === id).length;
  chat.topics.splice(idx, 1);
  chat.messages = chat.messages.filter((m) => m.topic !== id);
  if (chat.activeTopic === id) chat.activeTopic = chat.topics[0].id;
  saveChatSoon();
  log('删除话题「' + gone.title + '」，连同 ' + removed + ' 条消息');
  return { ok: true, removed: removed };
}

function setActiveTopic(id) {
  ensureTopics();
  const t = chat.topics.find((x) => x.id === id);
  if (!t) return { ok: false, error: '话题不存在' };
  chat.activeTopic = t.id;
  saveChatSoon();
  return { ok: true, topic: t };
}


function loadChat() {
  try {
    if (!fs.existsSync(CHAT_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf-8'));
    if (raw && Array.isArray(raw.messages)) {
      chat.messages = raw.messages.slice(-MAX_MESSAGES);
      // seq 不能只信任文件里的值：文件可能缺这个字段（手工编辑、写盘中断、旧版本），
      // 一旦归零，新消息就会产生与历史重复的 id（m1 撞 m1），
      // 进而破坏引用跳转与界面的"已渲染"判断。
      // 所以取 max(文件里的 seq, 已有消息 id 的最大值) 作为起点。
      let maxIdNum = 0;
      for (const m of chat.messages) {
        const n = parseInt(String(m && m.id || '').replace(/^m/, ''), 10);
        if (Number.isFinite(n) && n > maxIdNum) maxIdNum = n;
      }
      chat.seq = Math.max(maxIdNum, Number(raw.seq) || 0);
      // 话题列表也持久化，否则重启后话题会丢
      if (Array.isArray(raw.topics)) chat.topics = raw.topics;
      if (typeof raw.activeTopic === 'string') chat.activeTopic = raw.activeTopic;
      if (raw.trash && Array.isArray(raw.trash.messages)) chat.trash = raw.trash;
      log('已载入聊天记录 ' + chat.messages.length + ' 条（seq=' + chat.seq + '）');
    }
  } catch (e) { log('读聊天记录失败:', e && e.message); }
  // 无论有没有文件都要跑：保证话题结构始终合法
  migrateTopics();
}

function saveChatSoon() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CHAT_FILE, JSON.stringify({
        seq: chat.seq,
        topics: chat.topics,
        activeTopic: chat.activeTopic,
        // 回收站也落盘：进程重启后仍能撤回上一次清空
        trash: chat.trash,
        messages: chat.messages.slice(-MAX_MESSAGES),
      }, null, 0), 'utf-8');
    } catch (e) { log('写聊天记录失败:', e && e.message); }
  }, 400);
}

function pushMsg(m) {
  chat.seq++;
  const msg = Object.assign({
    id: 'm' + chat.seq,
    at: Date.now(),
    // 每条消息都归属一个话题（会话隔离的基础）
    topic: chat.activeTopic,
  }, m);
  chat.messages.push(msg);
  if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  saveChatSoon();
  return msg;
}

function chatSnapshot() {
  ensureTopics();
  return {
    messages: chat.messages,
    busy: Object.keys(chat.busy).filter((k) => chat.busy[k]),
    sending: chat.sending,
    seq: chat.seq,
    topics: chat.topics,
    activeTopic: chat.activeTopic,
    mode: chat.mode || 'parallel',
  };
}

/**
 * 把最近 N 条聊天记录整理成给 AI 看的上下文。
 *
 * @param limit    取最近几条（0 = 不带上下文）
 * @param excludeId 要排除的消息 id —— 即"本次正在发的那条"。
 * @param topicId  只取这个话题的记录。不传则用当前活跃话题。
 *
 * 为什么要 excludeId 而不是靠调用顺序：早先的写法是"在 pushMsg 之前取上下文"，
 * 但顺序模式会逐个参与者重新取（后一位要看到前一位刚说的），那时当前消息已在记录里，
 * 于是它同时出现在上下文和正文里。靠顺序约束太脆弱，直接按 id 排除才稳。
 *
 * 为什么要 topicId：多话题并行时，聊代码的上下文里夹着聊天气的记录，
 * 既容易把 AI 带偏，也白费 token。
 *
 * @returns { text, count } —— count 是真正带进去的条数，回给界面显示
 */
function buildChatContext(limit, excludeId, topicId) {
  const n = Math.max(0, Number(limit));
  if (!n) return { text: '', count: 0 };
  ensureTopics();
  const topic = topicId || chat.activeTopic;

  // 取最近 N 条（user / ai / action 都算）。
  // 动作参与计数是刻意的：它本身就是"上一轮发生了什么"的一部分，
  // 单独排除会导致 AI 只看到回答、看不到回答背后的动作。
  const inTopic = (m) => (m.topic || chat.topics[0].id) === topic;
  const picked = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'ai' || m.role === 'action')
    .filter(inTopic)
    .filter((m) => !excludeId || m.id !== excludeId)
    .slice(-n);
  if (!picked.length) return { text: '', count: 0 };

  const lines = picked.map((m) => {
    if (m.role === 'user') return '我：' + m.text;
    // 动作压成一行，前缀 [动作] 让 AI 一眼看出这是"做了什么"而非"说了什么"。
    // 不压缩的话，一段动作原文 60-160 字，14 条能吃掉上千字，代码片段还会干扰理解。
    if (m.role === 'action') {
      const brief = compactAction(m.actionRaw || m.text || '');
      return '[' + (m.mention || m.who || '某位') + ' 的动作] ' + brief;
    }
    return (m.mention || m.who || 'AI') + '：' + m.text;
  });
  // count 只统计"对话条目"，动作不算——界面上的「带 N 条上文」说的是对话，
  // 把动作算进去会让人以为带了更多对话，反而困惑。
  const count = picked.filter((m) => m.role !== 'action').length;
  return { text: lines.join('\n'), count: count };
}

/**
 * 把成员的「动作」记成一条消息。
 *
 * 为什么值得单独记：AI 真去改文件/跑命令时，用户最想知道"它现在要干什么"。
 * 此前这类信息被 hasToolBlock 分支整段丢掉，只剩最后一句总结，
 * 用户只能看到结果、看不到过程。
 *
 * 只做展示，不拦截、不审批——这不是权限系统，别指望它防住什么。
 */
function pushAction(windowId, label, brief, raw, mention) {
  if (!brief) return null;
  // 记下这条动作声明占用了哪些文件（只记写操作），供后续防撞车判断
  const parsed = parseActionPaths(raw || brief);
  return pushMsg({
    role: 'action', who: label, windowId: windowId,
    // mention 必须一起存：否则上下文里同一人会出现两个名字
    // （动作那行写标题、正文那行写 mention），AI 会当成两个人。
    mention: mention || '',
    text: brief, actionRaw: raw || '',
    claims: parsed.writes,
  });
}

/**
 * 把"引用"整理成提示词前缀。
 *
 * 为什么需要它：@ 只能指定"发给谁"，没法指定"针对哪条"。
 * 想说"针对刚才那条"时，用户只能手动复述一遍，既啰嗦又容易失真。
 *
 * 两条路径都要有：优先用 id 在本地记录里查到原文（最准），
 * 查不到就退回页面传来的快照（记录被清空/截断时仍能用）。
 * 截断上限 600 字 —— 引用整段长回复会把提示词撑爆，得不偿失。
 */
const QUOTE_MAX = 600;

// ===================== 成员互相对话（@ 触发接力）=====================
/**
 * 为什么用「@ 点名触发」而不是自动轮流发言：
 *
 * 自动轮流（甲答完给乙、乙答完给甲）一定会退化成互相客套——
 * 没有任何机制让它停，只能靠轮数硬砍，砍在哪一轮都像是"没说完"。
 *
 * @ 触发则相反：AI 自己判断要不要叫别人。它不叫，链条自然结束。
 * 这比任何轮数上限都可靠。maxHops 只是最后一道保险，防止互相 @ 死循环。
 *
 * 参考了 E:\反带ds\cuckoo补丁集合\工具本身修改\聊天室 的思路
 * （那份补丁改的是 app.asar，与当前版本不兼容，只取设计）。
 */
const RELAY_MAX = 3;          // 一次用户发言最多引发几跳
const relay = { on: false, depth: 0 };

/** 会话的成员名册（每次发送时重算，因为窗口会开关） */
function rosterOf(windows) {
  return assignMentions(windows.map((w) => ({
    providerId: w.providerId, title: w.title, windowId: w.windowId,
  })));
}

/**
 * 协作说明：让成员知道自己在多人房间里、别人叫什么、可以 @。
 *
 * 不写这段，AI 只会闷头回答，根本不知道可以叫别人——
 * 那就退化成了普通的"广播给所有人"，接力永远不会发生。
 */
/**
 * 协作说明：让成员知道自己在多人房间里、别人叫什么、可以 @。
 *
 * 单人房间不注入：房间里没有别人时这段全是废话，白费 token。
 * 不写这段，AI 只会闷头回答、根本不知道可以叫别人，
 * 那就退化成了普通的"广播给所有人"，接力永远不会发生。
 */
function buildRelayHeader(selfMention, roster, relayOn) {
  const others = roster.filter((m) => m.mention !== selfMention);
  if (!others.length) return '';    // 一个人不算"协作"，不占 token
  const list = roster.map((m) => m.label + '（@' + m.mention + '）').join('、');
  let s = '【多 AI 协作房间】你是 ' + selfMention + '。房间成员：' + list + '。\n';
  s += '请优先把用户的活干好，回复简洁聚焦，不要寒暄。';
  if (relayOn) {
    s += '\n如果你确实需要别人配合（比如需要另一种模型复核、或需要人补上你缺的那部分），'
      + '就在回复里 @' + others[0].mention + ' 并说明要他做什么；不需要就别 @。其他人会自动收到你的话。';
  } else {
    s += '\n你可以用 @' + others[0].mention + ' 这样的写法指代其他成员，但当前不会自动转发。';
  }
  return s + '\n\n';
}

function buildQuoteBlock(quote) {
  if (!quote || typeof quote !== 'object') return '';
  let who = typeof quote.who === 'string' ? quote.who.trim() : '';
  let text = '';

  // 1) 按 id 查本地记录
  if (quote.id) {
    const found = chat.messages.find((m) => m.id === quote.id);
    if (found) {
      who = found.who || who;
      text = found.text || '';
    }
  }
  // 2) 退回页面快照
  if (!text && typeof quote.text === 'string') text = quote.text;
  if (!text) return '';

  const trimmed = text.length > QUOTE_MAX ? (text.slice(0, QUOTE_MAX) + '…（已截断）') : text;
  return '【引用】' + (who || '上文') + ' 说：\n' + trimmed + '\n（以上是被引用的原文，请针对它作答）\n\n';
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
  // 记住用户选过的方式，下次默认沿用
  if (body.mode === 'sequential' || body.mode === 'parallel') chat.mode = mode;
  // 上下文条数：本次请求 > 配置默认值。0 = 不带上下文。
  // 兼容旧的 withContext:false（等价于 0），避免老调用方行为突变。
  let ctxLimit;
  if (body.withContext === false) ctxLimit = 0;
  else {
    const raw = body.contextLimit != null ? body.contextLimit : cfg.contextLimit;
    const v = Number(raw);
    ctxLimit = Number.isFinite(v) ? Math.max(0, Math.min(60, v)) : 0;
  }

  // 话题：请求可以指定，否则用当前活跃话题。指定时顺带切过去，
  // 否则用户"发到话题 A"之后界面还停在话题 B，观感上像发错了地方。
  ensureTopics();
  if (body.topic && chat.topics.some((t) => t.id === body.topic)) {
    chat.activeTopic = body.topic;
  }
  const topicId = chat.activeTopic;

  const userMsg = pushMsg({
    role: 'user', who: '我', text: text,
    targets: targets.map((t) => ({ windowId: t.windowId, label: t.title || t.providerId })),
    mode: mode,
    // 记下引用的是哪条，界面据此显示"回复某某"
    quote: body.quote && body.quote.id
      ? { id: body.quote.id, who: body.quote.who || '', text: (body.quote.text || '').slice(0, 200) }
      : null,
  });

  chat.sending = true;

  // 引用块在这里算一次就够：它只依赖入参，不随轮次变化
  const quoteBlock = buildQuoteBlock(body.quote);

  // 成员名册（唯一 mention）。
  //
  // 关键：名册必须是"房间里所有可用成员"，不能只用本次 targets。
  // 否则 A 被单独发消息时，名册里只有 A 自己，它写 "@B" 解析不到，
  // 接力永远不会发生——这正是第一版踩的坑。
  const relayOn = body.relay != null ? !!body.relay : !!relay.on;
  if (body.relay != null) relay.on = !!body.relay;
  const allWindows = (listWindows().windows || []).filter((w) => !w.isSubagent && w.canInject);
  const roster = rosterOf(allWindows);
  // 本次 target 的 mention 必须能在名册里查到；查不到就补进去
  for (const t of targets) {
    if (!roster.some((r) => r.windowId === t.windowId)) {
      roster.push({ mention: 'AI-' + t.windowId, label: t.title || t.providerId, windowId: t.windowId });
    }
  }
  const mentionOf = (wid) => {
    const hit = roster.find((r) => r.windowId === wid);
    return hit ? hit.mention : ('AI-' + wid);
  };
  // 用户发言把接力深度归零
  relay.depth = 0;

  /**
   * 组一份提示词前缀。每次调用都重新取上下文（顺序模式下后一位要看到前一位刚说的），
   * 并显式排除当前这条 —— 否则它会在上下文和正文里各出现一次。
   */
  const buildPrefix = () => {
    const ctx = ctxLimit ? buildChatContext(ctxLimit, userMsg.id, topicId) : { text: '', count: 0 };
    return { prefix: (ctx.text ? (ctx.text + '\n\n---\n') : '') + quoteBlock, count: ctx.count };
  };
  const first = buildPrefix();
  // 把"本次带了多少上下文"记在用户消息上，界面据此显示
  userMsg.ctxUsed = first.count;

  const one = async (w) => {
    chat.busy[w.windowId] = true;
    streamStart(w.windowId, w.title || w.providerId);
    try {
      // 协作说明放在最前：让成员知道自己在房间里、别人叫什么
      // 紧接着是文件占用提醒：软约束，让 AI 知道哪些文件别人最近动过
      const head = buildRelayHeader(mentionOf(w.windowId), roster, relayOn)
        + buildClaimHint(mentionOf(w.windowId), topicId);
      const prompt = head + first.prefix + text;
      const res = await sendAndCapture(wcOf(w), prompt, cfg.replyTimeoutMs, {
        onProgress: (t) => streamDelta(w.windowId, t),
        onAction: (brief, info) => pushAction(w.windowId, w.title || w.providerId, brief, info && info.raw, mentionOf(w.windowId)),
      });
      if (res.ok) {
        streamEnd(w.windowId, res.text);
        const msg = pushMsg({
          role: 'ai', who: w.title || w.providerId || ('窗口 ' + w.windowId),
          windowId: w.windowId, mention: mentionOf(w.windowId),
          text: res.text, replyTo: userMsg.id,
          // 思考过程只给人看，不进上下文（buildChatContext 不读这个字段）
          think: res.think || '',
        });
        // 回复里 @ 了别人 → 触发接力（受 RELAY_MAX 限制）
        maybeRelay(msg);
        return msg;
      }
      streamEnd(w.windowId, '', res.error);
      pushMsg({ role: 'system', who: '系统', text: '「' + (w.title || w.providerId) + '」未回复：' + res.error, err: true, replyTo: userMsg.id });
      return null;
    } catch (e) {
      streamEnd(w.windowId, '', (e && e.message) || String(e));
      throw e;
    } finally {
      chat.busy[w.windowId] = false;
    }
  };

  /**
   * 检查一条 AI 回复里是否 @ 了别人，是则由对方接话。
   *
   * 只在 relayOn 时生效；depth 每次用户发言归零，防止链条无限延伸。
   * 用 setImmediate 起，避免在 one() 的返回路径里递归等待。
   */
  const maybeRelay = (msg) => {
    if (!relayOn || !msg || !msg.text) return;
    const hits = parseMentions(msg.text, roster).filter((m) => m.windowId !== msg.windowId);
    if (!hits.length) return;
    if (relay.depth >= RELAY_MAX) {
      pushMsg({
        role: 'system', who: '系统', err: true,
        text: '接力已达上限 ' + RELAY_MAX + ' 跳，停止。' + msg.mention + ' 想找 '
          + hits.map((h) => h.mention).join('、') + '，如需继续请自己发一句。',
      });
      return;
    }
    relay.depth++;
    for (const h of hits) {
      pushMsg({
        role: 'system', who: '系统',
        text: '接力 ' + relay.depth + '/' + RELAY_MAX + '：' + msg.mention + ' → ' + h.mention,
      });
      // 找到那个成员的窗口，把原话发过去
      (async () => {
        const tw = targets.find((t) => t.windowId === h.windowId)
          || (listWindows().windows || []).find((t) => t.windowId === h.windowId);
        if (!tw) {
          pushMsg({ role: 'system', who: '系统', err: true, text: h.mention + ' 的窗口已不在，接力中断' });
          return;
        }
        chat.busy[tw.windowId] = true;
        streamStart(tw.windowId, tw.title || tw.providerId);
        try {
          const head = buildRelayHeader(h.mention, roster, relayOn)
            + buildClaimHint(h.mention, topicId);
          const ctx = ctxLimit ? buildChatContext(ctxLimit, null, topicId) : { text: '', count: 0 };
          const prompt = head
            + (ctx.text ? (ctx.text + '\n\n---\n') : '')
            + '【来自成员 ' + msg.mention + ' 的话】\n' + msg.text;
          const res = await sendAndCapture(wcOf(tw), prompt, cfg.replyTimeoutMs, {
            onProgress: (t) => streamDelta(tw.windowId, t),
            onAction: (brief, info) => pushAction(tw.windowId, tw.title || tw.providerId, brief, info && info.raw, h.mention),
          });
          if (res.ok) {
            streamEnd(tw.windowId, res.text);
            const m2 = pushMsg({
              role: 'ai', who: tw.title || tw.providerId, windowId: tw.windowId,
              mention: h.mention, text: res.text, relayed: true,
              think: res.think || '',
            });
            maybeRelay(m2);          // 允许继续接力
          } else {
            streamEnd(tw.windowId, '', res.error);
            pushMsg({ role: 'system', who: '系统', err: true, text: h.mention + ' 未回复：' + res.error });
          }
        } catch (e) {
          streamEnd(tw.windowId, '', (e && e.message) || String(e));
        } finally {
          chat.busy[tw.windowId] = false;
        }
      })();
    }
  };

  // 复用模块级的 wcOfWin，不再单独定义一份同样的实现
  const wcOf = wcOfWin;

  (async () => {
    try {
      if (mode === 'sequential') {
        // 顺序发言：后面的能看到前面刚说的。
        //
        // 为什么这很重要：并行时两条消息同时发出，谁也不知道对方会说什么，
        // 于是两个人干同一件事（实测用户就遇到：两位都在看同一个项目、
        // 各自 read/grep/bash，做了重复劳动）。
        // 串行则让后一位看到前一位的结论，能接着做而不是重做一遍。
        for (const w of targets) {
          const t = pickTarget({ windowId: w.windowId });
          if (!t.ok) { pushMsg({ role: 'system', who: '系统', text: '「' + (w.title || w.providerId) + '」不可用：' + t.error, err: true }); continue; }
          chat.busy[w.windowId] = true;
          streamStart(w.windowId, w.title || w.providerId);
          // 让用户看到"轮到谁了"——串行时等待感很强，不说清楚会以为卡住
          pushMsg({
            role: 'system', who: '系统',
            text: '轮到 ' + mentionOf(w.windowId) + ' 发言'
              + (targets.indexOf(w) > 0 ? '（它能看到前面几位的回答）' : ''),
          });
          try {
            // 顺序模式下每轮重新取上下文（后一位要看到前一位刚说的）。
            // buildPrefix 内部会排除当前这条消息，所以不会重复。
            const now = buildPrefix();
            // 顺序模式也要带协作说明，否则成员不知道可以 @ 别人
            const head = buildRelayHeader(mentionOf(w.windowId), roster, relayOn)
              + buildClaimHint(mentionOf(w.windowId), topicId);
            const prompt = head + now.prefix + text;
            const res = await sendAndCapture(t.wc, prompt, cfg.replyTimeoutMs, {
              onProgress: (tx) => streamDelta(w.windowId, tx),
              onAction: (brief, info) => pushAction(w.windowId, w.title || w.providerId, brief, info && info.raw, mentionOf(w.windowId)),
            });
            if (res.ok) {
              streamEnd(w.windowId, res.text);
              const m = pushMsg({
                role: 'ai', who: w.title || w.providerId, windowId: w.windowId,
                mention: mentionOf(w.windowId), text: res.text, replyTo: userMsg.id,
                think: res.think || '',
              });
              maybeRelay(m);
            } else {
              streamEnd(w.windowId, '', res.error);
              pushMsg({ role: 'system', who: '系统', text: '「' + (w.title || w.providerId) + '」未回复：' + res.error, err: true });
            }
          } catch (e) {
            streamEnd(w.windowId, '', (e && e.message) || String(e));
            throw e;
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

// ===================== 分工讨论（三阶段）=====================
/**
 * 用户的话：「我发布任务，说我想做什么，他们会自己拆分任务给自己，
 * 他们之间还会讨论怎么做比较好」。
 *
 * 关键判断：这**不等于自由聊天**。自由聊天一定会退化成互相客套
 * （"这个方案很好""我同意"），而且没有终止条件——只能等它自己停。
 *
 * 所以做成三个有明确终点、有明确产出物的阶段：
 *
 *   1. 各自提案（并行，**互相看不见**）
 *      互相看不见是故意的：看见了就会开始附和，提案会趋同。
 *      产出：每人「我承担哪 1-3 项 + 怎么拆」。
 *
 *   2. 交叉评议（并行，看到全部提案）
 *      唯一任务是**挑错**，不是赞同。禁止输出"同意""很好"。
 *      产出：每人指出的重叠/空缺/卡点 + 修改建议。
 *      这轮是真正有价值的一轮，也是"圆桌"最缺的东西。
 *
 *   3. 合成分工表（只让一位做）
 *      固定格式，可直接拿去执行。
 *      产出：| 任务 | 负责人 | 依赖 | 完成标准 | + 争议点
 *
 * 硬约束：轮数固定 3（不可配置）；每轮原文都进聊天记录（不是黑盒）；
 * **不会自动开工**——分工表出来就停，用户确认后才谈得上执行。
 */
const plan = {
  running: false,
  stage: 0,          // 0 空闲，1/2/3 进行中
  stageName: '',
  done: 0,           // 本阶段已完成几人
  total: 0,
  startedAt: 0,
  abort: false,      // 用户点了停止
  error: '',
  ctrl: null,        // AbortController：让"停止"能立刻生效，不必等超时
};

function planOpen() {
  return plan.running ? { running: true, stage: plan.stage, stageName: plan.stageName, done: plan.done, total: plan.total } : { running: false };
}

/** 阶段提示词。每个阶段都明确"你要产出什么"和"不要做什么"，否则会跑偏。 */
function planPrompt(stage, opts) {
  const { roster, self, task, proposals, reviews } = opts;
  const head = '【多 AI 协作房间 · 分工讨论】\n'
    + '任务：' + task + '\n'
    + '参与者：' + roster.map((r) => r.mention + '（' + r.label + '）').join('、') + '\n'
    + '你是 ' + self + '。\n\n';

  if (stage === 1) {
    return head
      + '【第 1 步：各自提案】\n'
      + '你看不到其他人会说什么，也**不需要**等别人。只写你自己的部分：\n'
      + '1) 你打算承担哪 1-3 项具体任务（要可执行，不要"负责整体设计"这种空话）\n'
      + '2) 每项你打算怎么做（两三句话说清思路）\n'
      + '3) 你需要别人提供什么前提（如果确实需要）\n\n'
      + '不要写"我同意""这个方案很好"这类话。不要重复任务描述。直接给提案。';
  }
  if (stage === 2) {
    const list = proposals.map((p) => '〔' + p.mention + ' 的提案〕\n' + p.text).join('\n\n');
    return head
      + '【第 2 步：交叉评议】\n'
      + '以下是所有人的提案：\n\n' + list + '\n\n'
      + '你的任务**只有一个：挑错**。逐条回答：\n'
      + '1) 谁的部分和谁**重叠**了？（点名 + 说明怎么合并）\n'
      + '2) 哪个环节**没有人负责**？（这是最容易被忽略的）\n'
      + '3) 哪里会**卡住**？（缺前置条件、顺序有问题、依赖不存在）\n'
      + '4) 谁的估工明显不合理？\n\n'
      + '每条都要给**具体修改建议**，不要只说"有问题"。\n'
      + '禁止输出"同意""很好""没有问题"这类无信息量的话。如果你觉得确实没问题，'
      + '就必须指出至少一个可以做得更好的地方。';
  }
  // stage 3
  const list = proposals.map((p) => '〔' + p.mention + ' 的提案〕\n' + p.text).join('\n\n');
  const rv = reviews.map((r) => '〔' + r.mention + ' 的评议〕\n' + r.text).join('\n\n');
  return head
    + '【第 3 步：合成分工表】\n'
    + '下面是所有人的提案与评议：\n\n' + list + '\n\n' + rv + '\n\n'
    + '请把上面的讨论**合并成一张可直接执行的分工表**，严格用这个格式：\n\n'
    + '| 任务 | 负责人 | 依赖 | 完成标准 |\n'
    + '| --- | --- | --- | --- |\n'
    + '| （具体任务） | （@mention） | （无 / 或其他任务） | （怎么算做完） |\n\n'
    + '要求：\n'
    + '- 合并重叠项，补上没人认领的环节\n'
    + '- 负责人只能填已存在的成员 mention\n'
    + '- 争议点单独列一节「## 需要用户定夺」，写清分歧和你的建议\n'
    + '- 表格之后不要再写别的客套话';
}

/**
 * 跑一次分工讨论。
 *
 * @param task   任务描述
 * @param opts   { synth } 指定谁做汇总（默认第一位）
 * @returns { ok, started, totalCalls, est }
 */
function planStart(task, opts) {
  const text = String(task || '').trim();
  if (!text) return { ok: false, error: '请先写清要做什么' };
  if (plan.running) return { ok: false, error: '上一轮分工还在进行中' };

  const list = listWindows();
  if (!list.ok) return { ok: false, error: list.error };
  const members = (list.windows || []).filter((w) => !w.isSubagent && w.canInject);
  if (members.length === 0) return { ok: false, error: '没有可用的成员（请先打开 AI 窗口）' };

  const roster = rosterOf(members);
  // 汇总人：优先指定，否则第一位
  const synthWid = opts && opts.synth != null ? Number(opts.synth) : members[0].windowId;
  const synthMention = (roster.find((r) => r.windowId === synthWid) || roster[0]).mention;

  plan.running = true;
  plan.stage = 1;
  plan.stageName = '各自提案';
  plan.done = 0;
  plan.total = members.length;
  plan.startedAt = Date.now();
  plan.abort = false;
  plan.error = '';
  plan.ctrl = new AbortController();
  const sig = plan.ctrl.signal;
  // 本次讨论的唯一标识：给每条产出打上，便于区分批次。
  // 否则"按 planStage 过滤"会把上一轮的产出也算进来（实测踩过）。
  const runId = 'pr' + Date.now().toString(36);
  plan.runId = runId;

  // 单成员时第 2 阶段会被跳过，实际调用数要按此计算，否则成本预告会虚高
  const totalCalls = (members.length >= 2 ? members.length * 2 : members.length) + 1;

  pushMsg({
    role: 'user', who: '我', text: '【分工讨论】' + text, mode: 'plan',
    targets: members.map((m) => ({ windowId: m.windowId, label: m.title || m.providerId })),
  });
  pushMsg({
    role: 'system', who: '系统',
    text: '开始分工讨论：' + members.length + ' 位成员，'
      + (members.length >= 2 ? '3 阶段' : '2 阶段（单成员跳过交叉评议）')
      + '，共 ' + totalCalls + ' 次调用。'
      + '每阶段只做一件事，原文都会记在这里。随时可以点「停止」。',
  });

  // 异步跑，立刻返回
  (async () => {
    try {
      // ---------- 第 1 阶段：各自提案 ----------
      const proposals = [];
      await Promise.all(members.map(async (w) => {
        if (plan.abort) return;
        const mention = (roster.find((r) => r.windowId === w.windowId) || {}).mention || ('AI-' + w.windowId);
        chat.busy[w.windowId] = true;
        streamStart(w.windowId, w.title || w.providerId);
        try {
          const res = await sendAndCapture(wcOfWin(w), planPrompt(1, { roster, self: mention, task: text }), cfg.replyTimeoutMs, {
            onProgress: (t) => streamDelta(w.windowId, t),
            onAction: (brief, info) => pushAction(w.windowId, w.title || w.providerId, brief, info && info.raw, mentionOf(w.windowId)),
            signal: sig,
          });
          if (res.ok) {
            streamEnd(w.windowId, res.text);
            proposals.push({ mention, windowId: w.windowId, label: w.title || w.providerId, text: res.text });
            pushMsg({
              role: 'ai', who: w.title || w.providerId, windowId: w.windowId, mention,
              text: res.text, planStage: 1, planRun: runId,
            });
          } else {
            streamEnd(w.windowId, '', res.error);
            pushMsg({ role: 'system', who: '系统', err: true, text: mention + ' 提案失败：' + res.error });
          }
        } catch (e) {
          streamEnd(w.windowId, '', (e && e.message) || String(e));
          pushMsg({ role: 'system', who: '系统', err: true, text: mention + ' 提案异常：' + (e && e.message) });
        } finally {
          chat.busy[w.windowId] = false;
          plan.done++;
        }
      }));

      if (plan.abort) return finishPlan('用户停止', true);
      if (!proposals.length) return finishPlan('没有人给出提案', true);

      // ---------- 第 2 阶段：交叉评议 ----------
      //
      // 只有一位成员时跳过这一阶段：没有"别人"可评议，
      // 它只能自己评自己。实测中 AI 自己都看出来了，如实写道：
      //   「没有其他人的提案可供比对……交叉评议实际退化成了自评」。
      // 跳过能省一次调用，也避免这种无意义的产出。
      const reviews = [];
      if (members.length < 2) {
        pushMsg({
          role: 'system', who: '系统',
          text: '跳过第 2 步（交叉评议）：只有 1 位成员，没有人可以评议它的提案。'
            + '要让这一步有效，请再打开一个 AI 窗口。',
        });
      } else {
        plan.stage = 2;
        plan.stageName = '交叉评议';
        plan.done = 0;
        pushMsg({ role: 'system', who: '系统', text: '进入第 2 步：交叉评议（各自挑错，不是附和）' });
      }

      if (members.length >= 2) await Promise.all(members.map(async (w) => {
        if (plan.abort) return;
        const mention = (roster.find((r) => r.windowId === w.windowId) || {}).mention || ('AI-' + w.windowId);
        chat.busy[w.windowId] = true;
        streamStart(w.windowId, w.title || w.providerId);
        try {
          const res = await sendAndCapture(wcOfWin(w), planPrompt(2, { roster, self: mention, task: text, proposals }), cfg.replyTimeoutMs, {
            onProgress: (t) => streamDelta(w.windowId, t),
            onAction: (brief, info) => pushAction(w.windowId, w.title || w.providerId, brief, info && info.raw, mentionOf(w.windowId)),
            signal: sig,
          });
          if (res.ok) {
            streamEnd(w.windowId, res.text);
            reviews.push({ mention, windowId: w.windowId, label: w.title || w.providerId, text: res.text });
            pushMsg({
              role: 'ai', who: w.title || w.providerId, windowId: w.windowId, mention,
              text: res.text, planStage: 2, planRun: runId,
            });
          } else {
            streamEnd(w.windowId, '', res.error);
            pushMsg({ role: 'system', who: '系统', err: true, text: mention + ' 评议失败：' + res.error });
          }
        } catch (e) {
          streamEnd(w.windowId, '', (e && e.message) || String(e));
        } finally {
          chat.busy[w.windowId] = false;
          plan.done++;
        }
      }));

      if (plan.abort) return finishPlan('用户停止', true);
      // 多成员时，一条评议都没有说明全都失败了，没有依据可合成，如实结束。
      // 单成员时本阶段是被跳过的，reviews 本来就是空——不能因此中断。
      if (members.length >= 2 && !reviews.length) return finishPlan('没有人给出评议', true);

      // ---------- 第 3 阶段：合成分工表 ----------
      plan.stage = 3;
      plan.stageName = '合成分工表';
      plan.done = 0;
      plan.total = 1;
      pushMsg({ role: 'system', who: '系统', text: '进入第 3 步：由 ' + synthMention + ' 合成分工表' });

      const sw = members.find((m) => (roster.find((r) => r.windowId === m.windowId) || {}).mention === synthMention) || members[0];
      chat.busy[sw.windowId] = true;
      streamStart(sw.windowId, sw.title || sw.providerId);
      try {
        const res = await sendAndCapture(wcOfWin(sw), planPrompt(3, { roster, self: synthMention, task: text, proposals, reviews }), cfg.replyTimeoutMs, {
          onProgress: (t) => streamDelta(sw.windowId, t),
          onAction: (brief, info) => pushAction(sw.windowId, sw.title || sw.providerId, brief, info && info.raw),
          signal: sig,
        });
        if (res.ok) {
          streamEnd(sw.windowId, res.text);
          pushMsg({
            role: 'ai', who: sw.title || sw.providerId, windowId: sw.windowId, mention: synthMention,
            text: res.text, planStage: 3, isPlan: true, planRun: runId,
          });
          pushMsg({
            role: 'system', who: '系统',
            text: '分工表已生成。**没有自动开工** —— 你确认或修改后再决定怎么执行。'
              + '（耗时 ' + Math.round((Date.now() - plan.startedAt) / 1000) + ' 秒）',
          });
        } else {
          streamEnd(sw.windowId, '', res.error);
          pushMsg({ role: 'system', who: '系统', err: true, text: '合成失败：' + res.error });
        }
      } finally {
        chat.busy[sw.windowId] = false;
        plan.done++;
      }

      finishPlan('', false);
    } catch (e) {
      log('分工讨论异常:', e && e.message);
      plan.error = (e && e.message) || String(e);
      pushMsg({ role: 'system', who: '系统', err: true, text: '分工讨论异常：' + plan.error });
      finishPlan('', true);
    }
  })();

  return { ok: true, started: true, totalCalls, members: roster.map((r) => ({ mention: r.mention, label: r.label })), synth: synthMention };
}

function finishPlan(reason, isErr) {
  plan.running = false;
  plan.stage = 0;
  plan.stageName = '';
  plan.done = 0;
  plan.total = 0;
  plan.ctrl = null;      // 别留着已结束的 controller
  if (reason) {
    pushMsg({ role: 'system', who: '系统', err: !!isErr, text: '分工讨论结束：' + reason });
  }
}

/**
 * 取消进行中的分工讨论。
 *
 * 关键：要真的 abort，而不是只置个标志。
 * 只置标志的话，正在进行的那次调用仍要等 replyTimeoutMs（默认 180 秒）——
 * 用户点了"停止"却还要干等三分钟，等于没用。
 */
function planStop() {
  if (!plan.running) return { ok: false, error: '当前没有进行中的分工讨论' };
  plan.abort = true;
  try { if (plan.ctrl) plan.ctrl.abort(); } catch (_) {}
  log('用户停止了分工讨论（已中断正在进行的等待）');
  return { ok: true, stopping: true };
}

/**
 * 取窗口的 webContents。
 *
 * 放在模块级（而不是 chatSend 里的闭包），因为 plan 也要用。
 * 之前有两份逐字相同的实现（wcOf / wcOfWin），合并成这一份。
 */
function wcOfWin(w) {
  const t = pickTarget({ windowId: w.windowId });
  return t.ok ? t.wc : null;
}

loadChat();

// ===================== SSE 事件推送 =====================
/**
 * 流式输出为什么要用 SSE 而不是继续轮询 /chat/status：
 * 页面现在 1.5 秒轮询一次，做流式会一顿一顿的。SSE 是单向服务端推送，
 * 浏览器原生支持（EventSource），比 WebSocket 简单得多 —— 本服务的路由是手写
 * http server，接 WebSocket 要自己实现握手与帧解析，不划算。
 *
 * 注意：EventSource 不支持自定义请求头，令牌只能走 query（页面从服务端拿到，
 * 不经过第三方）。同时校验 Origin，非本机来源直接拒。
 */
const sseClients = new Set();
let sseSeq = 0;

function sseWrite(res, event, data) {
  try {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (_) { /* 连接可能已断，下面统一清理 */ }
}

/** 广播给所有 SSE 订阅者 */
function sseBroadcast(event, data) {
  if (!sseClients.size) return;
  for (const c of Array.from(sseClients)) {
    sseWrite(c.res, event, data);
    if (c.res.writableEnded) sseClients.delete(c);
  }
}

function sseHandle(req, res, url) {
  const t = url.searchParams.get('t') || '';
  if (t !== token()) { json(res, 403, { ok: false, error: 'unauthorized' }); return; }
  // EventSource 不带自定义头，所以这里只能靠 Origin 兜一层
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    json(res, 403, { ok: false, error: 'origin not allowed' });
    return;
  }

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, CORS_HEADERS));
  // 告诉客户端重连间隔
  try { res.write('retry: 2000\n\n'); } catch (_) {}

  const client = { id: ++sseSeq, res: res };
  sseClients.add(client);
  log('SSE 客户端接入 #' + client.id + '（当前 ' + sseClients.size + ' 个）');

  // 立刻推一次当前状态，避免刚连上时界面空白
  sseWrite(res, 'hello', { clientId: client.id, streaming: Object.keys(activeStreams).length > 0 });

  // 心跳：防中间层掐断空闲连接（本机直连其实不会，但代价极低）
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (_) {}
    if (res.writableEnded) { clearInterval(hb); sseClients.delete(client); }
  }, 15000);

  const cleanup = () => {
    clearInterval(hb);
    sseClients.delete(client);
    log('SSE 客户端断开 #' + client.id + '（剩余 ' + sseClients.size + ' 个）');
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

/** 正在流式输出的目标：windowId → { text, startedAt, label } */
const activeStreams = {};

function streamStart(windowId, label) {
  activeStreams[windowId] = { text: '', startedAt: Date.now(), label: label || '' };
  sseBroadcast('stream-start', { windowId: windowId, label: activeStreams[windowId].label });
}
function streamDelta(windowId, text) {
  const s = activeStreams[windowId];
  if (!s) return;
  s.text = text;
  sseBroadcast('stream-delta', { windowId: windowId, text: text, len: text.length });
}
function streamEnd(windowId, finalText, error) {
  const s = activeStreams[windowId];
  const dur = s ? (Date.now() - s.startedAt) : 0;
  delete activeStreams[windowId];
  sseBroadcast('stream-end', { windowId: windowId, text: finalText || '', error: error || null, ms: dur });
}

// ===================== 配置与令牌 =====================
function readConfig() {
  const out = {
    host: '127.0.0.1', hostPort: 18901, autoStart: true, enabled: true,
    replyTimeoutMs: 180000, maxAttachMB: 20,
    // 每次发送自动携带的历史条数（0 = 不带）。此前硬编码 14，用户既看不见也改不了。
    contextLimit: 14,
  };
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
      // 0 是合法值（明确表示不带上下文），所以不能用 truthy 判断
      if (c.contextLimit != null) {
        const v = Number(c.contextLimit);
        if (Number.isFinite(v) && v >= 0) out.contextLimit = Math.min(60, v);
      }
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

  // ===== 流式事件（SSE）=====
  if (p === '/chat/events') { sseHandle(req, res, url); return; }

  // ===== 聊天室 =====
  if (p === '/chat/status') {
    // 带上"正在流式输出的目标"，页面重连后能立即恢复打字机视图
    const streams = {};
    for (const k of Object.keys(activeStreams)) {
      streams[k] = { text: activeStreams[k].text, label: activeStreams[k].label };
    }
    json(res, 200, { ok: true, chat: chatSnapshot(), streams: streams });
    return;
  }

  // 清空：只清当前话题的消息（有了话题隔离后，清空全部会误伤其它话题）。
  //
  // 这个接口曾经毫无防护——任何请求到达就清空且不可恢复。
  // 实测中一次误调用就把整段记录抹掉了（只剩 seq 和一个空壳文件）。
  // 现在三道防线：
  //   1. 必须显式带 confirm:true，否则拒绝；
  //   2. 清空前把被删的消息存进「回收站」，可用 /chat/restore 取回；
  //   3. 响应里明确告知 backup 条数，界面据此提示"可撤回"。
  if (p === '/chat/clear' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      ensureTopics();

      if (!body || body.confirm !== true) {
        json(res, 400, {
          ok: false,
          error: '清空需要显式确认（body 里带 confirm:true）',
          hint: '这是防误触用的：该操作曾因一次误调用抹掉整段记录',
        });
        return;
      }

      const scopeAll = body.all === true;
      const removed = scopeAll
        ? chat.messages.slice()
        : chat.messages.filter((m) => m.topic === chat.activeTopic);

      // 回收站：只留最近一次清空，够撤回就行
      chat.trash = { at: Date.now(), scope: scopeAll ? 'all' : 'topic', messages: removed };

      if (scopeAll) chat.messages = [];
      else chat.messages = chat.messages.filter((m) => m.topic !== chat.activeTopic);

      saveChatSoon();
      log('清空 ' + (scopeAll ? '全部' : '话题 ' + chat.activeTopic) + ' 的 ' + removed.length + ' 条消息（已存入回收站）');
      json(res, 200, {
        ok: true, cleared: removed.length, scope: scopeAll ? 'all' : 'topic',
        backup: removed.length, restorable: removed.length > 0,
      });
    }).catch(() => json(res, 400, { ok: false, error: '清空需要显式确认' }));
    return;
  }

  // 撤回上一次清空
  if (p === '/chat/restore' && req.method === 'POST') {
    const t = chat.trash;
    if (!t || !Array.isArray(t.messages) || !t.messages.length) {
      json(res, 200, { ok: false, error: '没有可恢复的内容' });
      return;
    }
    // 恢复时按 id 去重，避免与现有消息重复
    const have = new Set(chat.messages.map((m) => m.id));
    let added = 0;
    for (const m of t.messages) {
      if (have.has(m.id)) continue;
      chat.messages.push(m);
      have.add(m.id);
      added++;
    }
    chat.messages.sort((a, b) => (a.at || 0) - (b.at || 0));
    chat.trash = null;
    saveChatSoon();
    log('已恢复 ' + added + ' 条消息');
    json(res, 200, { ok: true, restored: added });
    return;
  }

  if (p === '/claims/status') {
    ensureTopics();
    const claims = currentClaims(chat.activeTopic);
    const out = [];
    for (const path of Object.keys(claims)) {
      const who = [];
      for (const c of claims[path]) if (who.indexOf(c.mention) < 0) who.push(c.mention);
      out.push({ path: path, holders: who, at: claims[path][claims[path].length - 1].at });
    }
    json(res, 200, { ok: true, claims: out, ttlMin: Math.round(CLAIM_TTL_MS / 60000) });
    return;
  }

  // ===== 分工讨论 =====
  if (p === '/plan/start' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      json(res, 200, planStart(body && body.task, { synth: body && body.synth }));
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }
  if (p === '/plan/stop' && req.method === 'POST') {
    json(res, 200, planStop());
    return;
  }
  if (p === '/plan/status') {
    json(res, 200, Object.assign({ ok: true }, planOpen()));
    return;
  }

  // ===== 接力开关 =====
  if (p === '/relay' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      if (body && typeof body.on === 'boolean') relay.on = body.on;
      relay.depth = 0;
      log('接力已' + (relay.on ? '开启（最多 ' + RELAY_MAX + ' 跳）' : '关闭'));
      json(res, 200, { ok: true, relay: relay.on, maxHops: RELAY_MAX });
    }).catch(() => json(res, 200, { ok: true, relay: relay.on, maxHops: RELAY_MAX }));
    return;
  }
  if (p === '/relay/status') {
    json(res, 200, { ok: true, relay: relay.on, maxHops: RELAY_MAX, depth: relay.depth });
    return;
  }

  // ===== 话题 =====
  if (p === '/topic/list') { ensureTopics(); json(res, 200, { ok: true, topics: chat.topics, activeTopic: chat.activeTopic }); return; }

  if (p === '/topic/create' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      const t = createTopic(body && body.title);
      json(res, 200, { ok: true, topic: t, topics: chat.topics, activeTopic: chat.activeTopic });
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  if (p === '/topic/rename' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      const r = renameTopic(body && body.id, body && body.title);
      json(res, 200, Object.assign({ topics: chat.topics, activeTopic: chat.activeTopic }, r));
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  if (p === '/topic/delete' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      const r = deleteTopic(body && body.id);
      json(res, 200, Object.assign({ topics: chat.topics, activeTopic: chat.activeTopic }, r));
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
    return;
  }

  if (p === '/topic/active' && req.method === 'POST') {
    readBody(req).then((raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
      const r = setActiveTopic(body && body.id);
      json(res, 200, Object.assign({ topics: chat.topics, activeTopic: chat.activeTopic }, r));
    }).catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
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
  buildQuoteBlock: buildQuoteBlock,
  assignMentions: assignMentions,
  parseMentions: parseMentions,
  parseActionPaths: parseActionPaths,
  currentClaims: currentClaims,
  buildClaimHint: buildClaimHint,
  sendAndCapture: sendAndCapture,
  compactAction: compactAction,
  summarizeAction: summarizeAction,
  buildRelayHeader: buildRelayHeader,
  planPrompt: planPrompt,
  planStart: planStart,
  planStop: planStop,
  planState: function () { return plan; },
  relayState: function () { return relay; },
  RELAY_MAX: RELAY_MAX,
  createTopic: createTopic,
  renameTopic: renameTopic,
  deleteTopic: deleteTopic,
  setActiveTopic: setActiveTopic,
  chatState: function () { return chat; },
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
