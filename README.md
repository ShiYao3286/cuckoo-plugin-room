# 多 AI 同室（cuckoo-room）

> 把 Cuckoo 的**多个窗口**当成同一个房间里的多位参与者——**每个窗口就是一个平台/账号**。
>
> 因为一个窗口 = 一个平台 = 一个账号，所以这一切天然是**跨平台**的：
> DeepSeek、Claude、ChatGPT 可以待在同一个房间里。
>
> 你在聊天室里说话，用 `@` 指定**谁**或**全体**来对话、下任务；可以发图片和文件。

## 快速开始

1. 打开若干个 AI 平台窗口，各自登录好
2. 侧栏「窗口」页 → 点「新建窗口」右边的 **「聊天室」**（或 AI 页面右上角的迷你胶囊）
3. 勾选参与者，输入消息，用 `@` 指定发给谁，<kbd>Enter</kbd> 发送

**需要 Cuckoo Code ≥ 0.8.8。装好后请重启 Cuckoo**——插件的可执行部分只在主进程启动时加载。

## 特性

- **`@` 指定对话对象**：选某一位就只发给他，选「全体」就发给所有选中的人
- **实时流式输出**：AI 回复逐字出现（SSE 推送），不用盯着等待
- **Markdown 渲染**：AI 回复里的加粗、列表、代码块、表格、引用都正确呈现
- **图片与文件上传**：📎 按钮、拖拽进窗口、<kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴截图
- **跨平台**：不同窗口可以是不同平台或同一平台的不同账号
- **身份色区分**：每个窗口一个稳定色相，同平台的不同账号也能一眼分清谁在说话
- **跟随应用主题**：亮色/深色自动切换
- **独立窗口**：不遮挡 AI 正文；关掉窗口也不中断正在进行的对话
- **聊天记录落盘**：重启后还在，只存文字不存图片，文件不会膨胀

## 目录结构

```
cuckoo-plugin-room/
├── plugin.json              # 清单（唯一必需文件）
├── providers/room-host.js   # ★ 主进程编排器：跨窗口收发、附件注入、开窗、按钮注入、主题
├── ui/room-window.html      # 独立窗口的完整界面（应用内 BrowserWindow 加载）
├── ui/cuckoo-room.js        # AI 页面右上角的迷你入口（小胶囊，点它开独立窗口）
├── LICENSE
└── README.md
```

面板里显示的名字取自 `plugin.json` 的 `name`（中文「多 AI 同室」），与目录名无关。
目录名同时是 `id`，按约定必须小写 kebab-case（`paths.ts:35`），所以目录名只能是英文。

## 安全：Markdown 为什么是这里唯一破例的地方

AI 的回复是**第三方内容**。整个插件其余部分一律用 `textContent` 渲染，
只有 Markdown 这一处必须走 `innerHTML`——因为要产出真正的 HTML 标签。

因此这里**不用正则消毒**（正则做 HTML 消毒必被绕过），而是**白名单重建**：

1. `marked` 的输出先写进一个**游离节点**（不挂进文档，脚本不执行、资源不加载）
2. 遍历这棵树，**只创建白名单里的标签**、**只复制白名单里的属性**，其余连子树一起丢弃
3. 允许的标签：`p h1-h6 ul ol li strong em del code pre blockquote hr br table thead tbody tr th td a`
4. `a[href]` 只放行 `http/https`——`javascript:` `data:` `vbscript:` `file:` 一律剥掉，并加 `rel="noreferrer noopener"`
5. **故意不允许 `img`**：AI 若输出 `![](http://x/y.png)`，打开消息就会自动发请求，
   等于把你的"已读"泄露给第三方。要看图可以点链接跳浏览器

`verify-markdown.cjs` 对这套逻辑有 87 项专门测试（含 `javascript:` 变体、
事件属性、嵌套绕过、表格内 iframe 等），并验证它在**真实渲染路径**上生效。

## 主题跟随

独立窗口是 `sandbox:true` 且没有 preload，拿不到 `electronAPI`，因此**读不到应用主题**。
解决办法：主进程的编排器直接问主题权威单例（`theme-manager.js` 的 `snapshot()`），
经已有的 `/status` 接口下发，页面每 1.5 秒轮询时自然跟着变。

三级降级，任何一级失败都不会让页面失去配色：
`theme-manager.snapshot()` → `nativeTheme.shouldUseDarkColors` → 兜底 `dark`。

`marked` 的供给同理：不从仓库里带 46 KB 第三方库，而是从应用自带的
`src/ui/vendor/marked.umd.js` 经 `/vendor/` 路由提供——**按文件名白名单放行**，
只认 `marked.umd.js` 一个名字，其余（含各种路径穿越写法）一律 404。

## 聊天室怎么用

1. 打开若干个 AI 平台窗口，各自登录好
2. 顶部的**参与者胶囊**默认全部选中；点一下可以取消某一位
3. 输入框里打 `@` 会弹出选择器：选某一位就**只发给他**，选「全体」就发给所有选中的人
4. 发送后，各窗口的回答会以气泡形式回到同一个消息流里

补充说明：

- **`@` 会改写发送对象**——被 @ 到的人成为唯一目标，其他人不会收到。
  如果只是想改发送列表，直接点参与者胶囊即可。
- **上下文自动拼接**：每次发送会把最近的对话记录拼在消息前面，让 AI 知道前因后果。
- **顺序发言**：以 `mode:'sequential'` 发送时逐个进行，后一位能看到前一位**刚刚**的回答——
  适合「让 B 评价 A 的方案」这类任务（界面上暂未暴露开关，走 API 可用）。
- **聊天记录会落盘**（`~/.cuckoo/cuckoo-room-chat.json`），重启后还在。
  只存文字，不存图片二进制，所以文件不会膨胀。

## 图片与文件上传

三种方式：**📎 按钮**、**直接拖进窗口**、**Ctrl+V 粘贴截图**。

### 为什么这件事需要一个技巧

浏览器安全边界不允许 JS 往 `<input type=file>` 里写文件——不能凭空造一个用户没选过的文件。
但可以在页面主世界里**构造 `File` 对象**，用 `DataTransfer` 赋给 `input.files` 再派发 `change`，
站点的上传逻辑就正常跑起来了。

这正是 Cuckoo 自己的 `attachFile` 工具的做法（`src/tools/impl/attach-file.ts:130-172`）。
本插件复刻了它，并做了三点增强：

1. **多入口尝试**——页面里可能有多个 `input[type=file]`（图片一个、文件一个）。
   按「可见 → accept 含 image」排序依次尝试，某个不行就换下一个。
2. **按文件类型选入口**——传图片时优先命中 `accept="image/*"` 的那个。
3. **真正确认挂载**——注入完不代表附件上去了。以「页面文本里出现文件名」或
   「输入区附近新增了图片」判定成功（`attach-file.ts:149-165` 的思路）。

### 上传失败会怎样

- **部分失败**：文字照发；失败项在界面上标红说明（哪个文件、哪个窗口、什么原因）
- **全部失败**：**整体拒绝发送**，并给出原因。这是刻意的——
  否则你以为附件发出去了，而 AI 那边只收到一段没有附件的文字。

单文件大小上限默认 20MB，可在插件配置里改。

### 已知限制

这套做法对**大多数**平台有效，但对付不了「免疫合成事件」的站点。
Cuckoo 自己为这种情况准备了另一条更重的通道：CDP
（`src/app/ipc/cdp-attach.ts`——真实鼠标事件点击上传入口 + `Page.setInterceptFileChooserDialog`
拦截文件选择框 + `DOM.setFileInputFiles` 注入）。

本插件**目前没有走 CDP**。如果某个平台传不上去，日志里会写明「已尝试 N 个上传入口」，
这时可以考虑把那条通道接进来（切入点见 `room-host.js` 的 `attachFileToWindow`）。

## 两个入口

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| **「聊天室」按钮** | 侧栏「窗口」页，「新建窗口」右边 | 打开独立窗口（推荐） |
| **迷你胶囊** | 每个 AI 页面右上角 | 点一下打开同一个独立窗口 |

**为什么是独立窗口**：早期版本把完整面板直接浮在 AI 页面上，会压住正文，
而且 AI 页面一重载面板就没了。独立窗口既不影响看正文，也不随任何页面重载而消失。

窗口的开/关与任务的跑/停是**解耦**的：关掉窗口不会中断正在进行的对话，
因为编排状态住在主进程内存里。重新打开就能看到当前进度。

### 「新建窗口」旁边那个按钮是怎么来的

官方给插件的界面挂载点只有工具栏/状态栏/侧边栏三处
（`src/ui/shell/scripts/plugin-shell.ts:64-108`），够不到窗口页的 `#win-new`
（`src/ui/shell/partials/pages/windows.html:4`）。

主进程编排器直接对壳页面的 `webContents` 注入按钮，并用 `MutationObserver`
兜住 SPA 重渲染导致的按钮丢失，启动后还会周期性补注入。

**点击走的是 `<img>` 图片信标，不是 `fetch`** —— 壳页面是 `file://` 协议，
从 `file://` 发往 `http://127.0.0.1` 的 fetch 会被拦（`ai-gateway` 的
`providers/gateway.js` 也专门注释过这一点）。图片加载不受该限制。

## 为什么是「主进程 + 薄客户端」这种结构

Cuckoo 的插件有**两条完全不同的执行轨道**，这是整个设计的立足点：

| 轨道 | 文件 | 运行位置 | 能力边界 |
| --- | --- | --- | --- |
| A | `ui/*.js`、`dsh/*.js` | AI 页面的**渲染进程** | 只能操作当前那一个页面 |
| B | **`providers/*.js`** | **主进程** | **一次触达所有窗口** |

`providers/*.js` 被 `require` 进主进程（`src/providers/custom/loader.ts:167`），
于是它可以 `require` 应用自己的窗口表模块，拿到全进程唯一的窗口列表：

```js
require('<appPath>/out/src/app/window.js').getAllContexts()
//  → [{ win, view, profileId, providerId, isSubagent, ... }, ...]
//     view.webContents 就是各平台的 AI 页面
```

于是可以对每个平台的页面**直接注入提示词、直接收回复**。

### 这比"切会话"好在哪

早期版本走的是渲染进程里的 `electronAPI.navigateSession(sessionId)`（`src/app/ipc/session.ts:246`），
那条路有三个绕不开的硬伤，现在全部消失：

| 问题 | 旧方案（navigateSession） | 现方案（主进程直连） |
| --- | --- | --- |
| 换人时页面重载 | `loadURL` 会**销毁插件实例**，被迫写「落盘→导航→重载后续跑」状态机，还要靠 `sentIdx` 保证幂等 | 页面根本不重载，编排状态住在主进程内存里 |
| 能否跨平台 | 不能。URL 用**当前** provider 的 `sessionUrlBase` 拼，只能在同一平台内切 | **可以**。每个窗口独立注入 |
| 并发 | `sendToChat` 走单个 `pendingSend` 令牌，只能串行 | 每窗口独立，互不影响 |

## 安装

1. 复制整个 `cuckoo-room` 目录到 `%USERPROFILE%\.cuckoo\plugins\cuckoo-room`
2. 在 Cuckoo 插件面板里**启用**「多 AI 同室」（Track A 插件默认是关闭的）
3. **重启 Cuckoo** —— `providers/*.js` 只在主进程启动/插件开关切换时被 `require`，
   仅仅重载 AI 页面不会加载它

## 用法

1. 先打开若干个 AI 平台窗口（每个窗口一个平台/账号），并确保它们都已登录、输入框可见
2. 点侧栏「窗口」页里「新建窗口」右边的 **「聊天室」** 按钮（或 AI 页面右上角的迷你胶囊）
3. 在独立窗口里勾选参与者、输入消息，用 `@` 指定发给谁，回车发送

## 工作原理

```
独立聊天室窗口               编排器 (providers, 主进程)              各平台页面
      │                                   │                                │
      │  POST /chat/send                  │                                │
      │ ─────────────────────────────────>│                                │
      │                                   │ getAllContexts() 取所有窗口      │
      │                                   │                                │
      │                                   │ 按 @ 选定的目标逐个：            │
      │                                   │ executeJavaScript(上下文+消息) ─>│ 目标窗口
      │                                   │<──── cuckoo-ai-response ────────│
      │  GET /chat/status（每 1.5 秒轮询） │                                │
      │ <─────────────────────────────────│                                │
```

主进程起一个只绑 `127.0.0.1` 的小 HTTP 服务（默认端口 18901，被占用时自动换随机端口并把
**实际**端口写进 `.room-port`），独立窗口与迷你入口都通过它读状态、发送、请求开窗。

收回复靠监听各平台 hook 在主世界派发的 `cuckoo-ai-stream` / `cuckoo-ai-response` 事件
（`src/providers/hooks/*.ts`）。含 ` ```cuckoo ` 代码块的是工具调用轮，会被跳过，
只取真正的最终回复。

发出的提示词在界面上**默认折叠成一行**（`<details>`），点击才展开——
否则每轮十几行提示词会把真正的发言淹掉。

## 关键接口出处

| 环节 | 实现 | 出处 |
| --- | --- | --- |
| provider 被主进程加载 | `require(file)` | `src/providers/custom/loader.ts:167` |
| provider 必填字段校验 | 六项缺一即跳过 | `src/providers/validate.ts:9-18` |
| 拿到所有窗口 | `getAllContexts()` | `src/app/window.ts:91` |
| 注入并取回复 | `webContents.executeJavaScript` | 同 `src/app/ipc/shell.ts:170` 的做法 |
| 收回复 | `cuckoo-ai-response` 事件 | `src/providers/hooks/deepseek.ts:128` 等 |
| 迷你入口挂载 | `ctx.ui.mount` / `ctx.ui.css` | `src/plugins/runtime/ui-runtime.ts:100,109` |
| 读插件文件（令牌/端口） | `ctx.assets.read` | `src/plugins/runtime/ui-runtime.ts:169` |
| 开独立窗口 | `new BrowserWindow({...})` | 同 `src/app/ipc/shell.ts:271` 的「飞书配置教程」 |
| 往壳页面注入按钮 | `壳页面 webContents.executeJavaScript` | 同 `src/app/ipc/cdp-attach.ts:65` |
| 「新建窗口」按钮锚点 | `#win-new` | `src/ui/shell/partials/pages/windows.html:4` |

## 安全

- 服务**只绑 `127.0.0.1`**，不对外网暴露。
- **令牌防护**：令牌每次随机生成，写在插件目录的 `.room-token`，只由面板经官方
  `readPluginAsset` 读取。带 `Origin` 头的浏览器跨源请求必须带令牌，否则 403；
  带 `Authorization` 的跨源请求会先触发预检，预检不通过浏览器自己就拦下了。
  这样即使某个 AI 网页被注入恶意脚本，也无法驱动本服务。
  不带 `Origin` 的请求（本机 curl / PowerShell 排障）放行，方便你自己查问题。
- 界面文本默认走 `textContent`；**唯一**使用 `innerHTML` 的地方是 Markdown 渲染，
  且必经白名单重建式消毒（详见上文「安全：Markdown 为什么是这里唯一破例的地方」）。
- 独立窗口是**沙箱化**的（`contextIsolation:true, nodeIntegration:false, sandbox:true`），
  与官方「飞书配置教程」窗口同一套配置；它只加载 `127.0.0.1` 上的本机页面。
- 独立窗口里的外链**不能就地导航**，一律交给系统默认浏览器打开
  （否则点一下链接，聊天界面就被顶掉且回不去）。
- `/vendor/` 路由**按文件名白名单**放行，只在册 `marked.umd.js` 一个名字，
  其余（含各种路径穿越写法）一律 404。
- 往壳页面注入的按钮**只用图片信标**打本机 HTTP，不发起 fetch、不读任何页面数据。
- **附件注入只在目标页面内构造 `File` 对象并交给该页面的上传控件**，
  不发起任何外发请求、不读取页面上的其他数据（测试里有一条专门断言这一点）。
- 附件内容经本机 loopback 以 base64 传输，**不写入磁盘**（聊天记录里也只存文件名）。
- 插件本身不联网，只在本机 loopback 上通信。

## 排障

```powershell
# 服务与窗口列表（version 应为 0.6.0）
Invoke-RestMethod http://127.0.0.1:18901/status | ConvertTo-Json -Depth 4

# 逐个窗口问「你是谁、能不能收字」（只读，不会发送任何东西）
Invoke-RestMethod http://127.0.0.1:18901/probe | ConvertTo-Json -Depth 6

# 看聊天记录（含每条消息的角色与来源）
Invoke-RestMethod http://127.0.0.1:18901/chat/status | ConvertTo-Json -Depth 5

# 手动发一条（排障用；不带 Origin 的本机请求无需令牌）
Invoke-RestMethod http://127.0.0.1:18901/chat/send -Method POST -ContentType 'application/json' `
  -Body '{"text":"测试","targets":[1]}'

# 手动开一次独立窗口（排障用；正常从界面点）
Invoke-RestMethod http://127.0.0.1:18901/window/open -Method POST

# 手动补注入一次入口按钮（壳页面重载后丢了按钮时）
Invoke-RestMethod http://127.0.0.1:18901/window/inject -Method POST

# 主进程日志（主进程没有可见控制台，一切都在这个文件里）
Get-Content "$env:USERPROFILE\.cuckoo\cuckoo-room.log" -Tail 40
```

浏览器里直接打开 `http://127.0.0.1:18901/window` 也能看到完整界面
（页面自带令牌，适合单独调样式）。

### 改了界面为什么有时不用重启

`ui/room-window.html` 是**每次开窗时从磁盘现读**的（`readWindowHtml()`），
所以只改这个文件的话，**关掉聊天室窗口再打开就生效**，不必重启 Cuckoo。

但 `providers/room-host.js` 只在主进程启动或插件开关切换时被 `require`，
改它就必须重启（或去插件面板把开关关掉再打开）。

## 踩过的坑

### 点「发送」没反应（v0.4.0 → v0.4.1 修复）

**现象**：界面一切正常，输入文字后点发送，什么都不发生。

**原因**：`renderStatus()` 里读写 `btnStart` / `btnStop` 的 `disabled`，
但这两行 ES5 变量声明漏了（`room-window.html` 顶部那串 `var`）。
在浏览器里访问未声明变量抛 `ReferenceError`，而 `send()` 恰好在**发请求之前**调用
`renderStatus()`，于是整个函数中断，`fetch` 根本没执行。

**为什么测试没抓到**：当时的测试只覆盖了「DOM 元素存在」和「语法正确」，
以及直接打后端的 HTTP 测试——**前端脚本从未被真正执行过**。
现已补上 `verify-page.cjs`：它在 DOM 桩里真的加载并运行页面脚本，
模拟点击发送，断言请求确实发出、以及失败路径必须有可见提示。

**顺带做的加固**（这才是根本解法）：

- 加了**错误横幅**：任何后端拒绝、网络失败、未捕获异常都会显示在界面顶部，
  而不是只写进顶栏那行小字。之前"没反应"的观感，很大程度是因为错误根本看不见。
- 加了 `window.onerror` / `unhandledrejection` 兜底，脚本异常也会弹横幅。
- **发送失败时不再清空输入框**，让你能直接重试，不用重新打字。
- 调整了 `send()` 的顺序：先做完全部可能抛错的事，再清空输入、再发请求。

## 已知边界

- **每个窗口都得是「干净可用」的状态**：页面停在登录页、输入框被弹窗挡住，
  该窗口就会被跳过并在消息流里标红说明原因，不会卡住整轮。
- **子代理窗口不参与**（`isSubagent` 会被过滤掉）。
- **回复超时是必须的**：默认 180 秒，可在插件配置里改。超时即记为未回复并继续下一位。
- **一次可以发给多位**：并行模式下各窗口独立回答，互不影响，发送按目标数排队。
- **附件靠注入页面主世界实现**，对「免疫合成事件」的站点可能无效（见上文「已知限制」）。
- **聊天记录只保留最近 500 条**，超出后自动丢弃最旧的。
- 依赖 `out/src/app/window.js` 这个内部模块路径。官方没有承诺它是稳定接口，
  升级 Cuckoo 后若报「找不到 window.js」，改 `room-host.js` 里的 `resolveAppPath` 候选路径即可。
