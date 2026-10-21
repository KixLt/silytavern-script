# 剧情进度状态栏

酒馆助手 (JS-Slash-Runner) 脚本: 在酒馆输入栏上方加一条状态栏, 让 AI 把剧情进度同步进世界书条目。

```
┌──────────────────────────────────────────────────────┐
│  ▤ 剧情进度                     ▯ 待同步 (3)      ⟳  │
└──────────────────────────────────────────────────────┘
   ↑ 弱文字, 是这一行的身份        ↑ 唯一的主角       ↑ 纯图标动作
```

| 按钮 | 行为 |
| --- | --- |
| 左 `剧情进度` | 弹出 popover, 显示世界书条目里**当前已保存**的进度 (YAML) |
| 中 `待同步` | 弹出 popover, 把「上次同步之后的楼层」交给模型, 计算并显示**待写入的改动** (字段级 diff); 徽标显示待同步楼层数 |
| 右 `⟳` | 先算待同步改动, 弹出确认框; 确认后才真正写入世界书并把已同步位置推进到本批最后一楼 |

## 构建与发布

```bash
pnpm install
pnpm typecheck
pnpm build     # 产物: dist/index.js
```

发布时把 `dist/index.js` 的内容贴进酒馆助手脚本库的脚本内容即可.

## 本地联调

`pnpm dev` 在**同一个进程**里做三件事:

| 服务 | 地址 | 作用 |
| --- | --- | --- |
| 静态文件服务 | `http://localhost:5500` | 托管仓库文件, 带 `Access-Control-Allow-Origin: *` 与 `no-store`, 供脚本 iframe 跨端口导入 |
| Vite 监听构建 | — | 源码改动后重新打包到 `dist/` (development 模式, 带 sourcemap) |
| socket.io | `http://localhost:6621` | 每次构建完成后广播 `script_iframe_updated`, 让酒馆助手重载脚本 |

端口可用环境变量 `PPB_HTTP_PORT` / `PPB_SOCKET_PORT` 覆盖.

### 一次性准备

1. **启动酒馆**: 在 `SillyTavern` 目录执行 `node server.js`, 默认地址 `http://localhost:8000`.
2. **安装酒馆助手**: 把 `JS-Slash-Runner` 克隆/解压到 `SillyTavern/public/scripts/extensions/third-party/JS-Slash-Runner`,
   或在酒馆「扩展」页用 URL 安装 `https://github.com/N0VI028/JS-Slash-Runner`; 然后在扩展列表中启用「酒馆助手」.
3. **建一个"加载器"脚本**: 酒馆助手 ‣ 脚本 ‣ 新建脚本, 脚本内容只写一行:
   ```js
   import 'http://localhost:5500/dist/index.js'
   ```
   脚本本身不存代码, 每次重载都会重新拉取最新构建产物, 所以不需要反复复制粘贴.
4. **打开实时监听**: 酒馆助手 ‣ 设置 ‣ 开发 ‣ 实时监听, 勾选「允许监听」, 地址保持默认 `http://localhost:6621`.

### 日常开发

1. 终端执行 `pnpm dev`(窗口保持打开).
2. 打开酒馆页面; 「实时监听」右侧的 WiFi 图标变绿说明已连上.
3. 修改 `src/**`: 构建完成 → 脚本 iframe 自动重载 → 状态栏用新代码重建.
4. 调试: DevTools ‣ Sources 中能看到 `src/index.ts` 等原始文件(development sourcemap), 可直接下断点;
   脚本日志都带 `[剧情进度状态栏]` 前缀.
5. 想强制重连时刷新酒馆页面即可.

> `pnpm dev` 的产物带 sourcemap 且未压缩, 只用于联调; 发布前用 `pnpm build` 重新打包.
>
> 默认 socket 端口 `6621` 与官方 `tavern_helper_template` 相同, 同时只能开一个; 冲突时用 `PPB_SOCKET_PORT` 换端口并同步修改酒馆助手的监听地址.

## 在酒馆中使用

正式使用时, 把 `pnpm build` 产出的 `dist/index.js` 内容贴进酒馆助手脚本库的脚本内容;
本地实时修改请用上一节的联调流程.

脚本挂载在 `#send_form` 之前, 没有打开聊天时会自动隐藏.

## 数据存放

- 世界书: 优先用当前聊天绑定的世界书 → 角色卡主世界书 → 都没有时自动创建聊天世界书 `剧情进度`。
- 条目: 名称 `【剧情进度】`(常量/蓝灯, 插入 `at_depth` + `system`, 深度 2), 不存在时在首次同步时自动创建。
- 进度内容: 条目 `content`, 为下列结构的 YAML:

```yaml
时间: 夜晚
地点: 废弃车站
当前目标: 找到钥匙对应的锁
关键事件:
  - 抵达废弃车站
  - 在长椅下发现生锈的钥匙
人物:
  青空莉: 同行, 警惕
未解伏笔:
  - 钥匙能打开什么
```

- 同步位置: 条目 `extra.synced_message_id`(最后已同步的楼层号), `extra.updated_at`(最后同步时间)。

## 同步流程

1. 点 `⟳`(或先点 `待同步` 预览)。
2. 脚本取 `synced_message_id` 之后的非隐藏、非 system 楼层(单次最多 60 条, 从最早的开始)。
3. 用 `generateRaw` 静默调用当前模型, 让它把这段对话**合并**进已有进度, 只输出完整 JSON; 解析失败(含 YAML 拼写错误、未加引号的键、尾逗号)会用 `jsonrepair` 修复并重试一次。
4. 与已保存进度做字段级 diff, 确认框按字段分组展示, 每行前面有符号: `+` 新增 / `→` 改动 / `−` 移除;
   改动行把旧值调灰、新值提亮, 一眼能看出"什么变了"。
5. 确认后写回世界书 `content` 与 `extra`, 并且只推进到本批最后一楼; 剩余楼层下次再同步。

模型返回的内容会经 zod 校验, 不合结构会带着错误信息重试一次, 仍失败则在 popover 中报错且不写入。

## 视觉规范

状态栏是酒馆里一直存在的设施, 弹窗是要读的一份档案 —— 这两条决定所有细节。

**状态栏** —— 一行, 安静, 只有一个主角。

- 从左到右: 弱文字标签 `剧情进度` → `待同步` + 数字药丸 → 同步图标。日常只有 `待同步` 和药丸是亮的, 点下去之前它不该抢注意力。
- 药丸数字出现/消失不挤动旁边布局 (隐藏时保留占位), 图标位置永远不动。
- 图标是 24 网格手画线稿 (线宽 1.6、方头方角): 档案册 / 折角待归档页 / 回转箭头。不用 emoji, 也不用图标库的默认形状。
- 忙碌时只转被点那个按钮的图标, 三个按钮一起禁用。

**弹窗** —— 标题和主操作固定, 中间滚动。

- `.ppb-head` 标题 + meta 常驻; `.ppb-body` 独立滚动; `.ppb-foot` 放"要写到哪里、还剩多少条"的说明和主操作 —— 再长的 diff 也顶不掉"确认同步"。
- 内容按字段分组 (时间 / 地点 / 当前目标 / 人物 / 关键事件 / 未解伏笔), 标签只写一次, 标题离自己的内容比离下一组更近。人物排在长列表前面, 免得被滚动埋掉。
- 每行是"符号列 + 内容列"两列网格: `+` / `→` / `−` 让状态不只靠颜色, 换行后文字有悬挂缩进。
- 已保存视图复用同一套分组排版, 但取值没有增删语义, 所以不带符号列; 空字段不出现, YAML 解析失败才退回原文。
- 宽度跟随状态栏但上限 560px, 一行不至于长到难以扫读。

**颜色** —— 全部从主题变量派生, 深色/浅色主题都能读。

| 用途 | 取值 |
| --- | --- |
| 正文 | `--SmartThemeBodyColor` |
| 弱文字 / 标签 | `--SmartThemeEmColor` (主题自带的中性灰) |
| 强调 (药丸、主按钮、焦点环) | `--SmartThemeUnderlineColor` |
| 底色 | `--SmartThemeBlurTintColor` |
| 线条 / 面 | 正文色 `color-mix` 出 14% 的线与 8% 的面 |

不要用 `--SmartThemeQuoteColor` 当弱化色: 很多主题里它是高饱和的引用色 (当前主题是橙的), 标签会看起来像强调。
`--SmartThemeBorderColor` 往往极暗, 深色主题下几乎不可见, 所以线条从正文色派生。

**排版**: 正文 13px / 行高 1.62, 小字与分组标题 12px, 弹窗标题 13.5px; 手机端 note 提到 13px、分组标题 12.5px。

## 手机端适配

- 按钮在窄屏下最小高度 36px, 触摸设备 (`pointer: coarse`) 40px, 同步按钮宽 44px; 横向两个按钮平分剩余宽度。
- popover 用 `position: fixed` 挂到页面 `body`, 宽度跟随状态栏并被限制在视口内; 高度按状态栏上方剩余空间收敛 (短屏 / 键盘弹出时不会溢出屏幕), 内容超出时内部滚动。
- 点击输入框会自动收起 popover, 避免遮挡聊天或与软键盘叠加。
- 屏幕旋转、窗口尺寸变化 (移动端重排可能重建输入区) 时会在 250ms 防抖后自动重新挂载状态栏。
- 确认框在窄屏下为两个等宽的 38px 高按钮, 方便手指点击。

## 可调项

- `src/worldbook.ts`: `ENTRY_NAME`、`FALLBACK_WORLDBOOK_NAME`、新建条目的插入位置/深度。
- `src/index.ts`: `MAX_PENDING_MESSAGES`(单次同步上限)、`REFRESH_DEBOUNCE_MS`。
- `src/ai.ts`: `SYSTEM_PROMPT`(进度字段与取值要求)、单条消息截断长度、输入总长度上限。

## 目录

```
src/
  index.ts     挂载、事件监听、刷新与同步编排
  ui.ts        状态栏与 popover
  worldbook.ts 世界书/条目定位与读写
  ai.ts        提示词与 AI 调用、容错解析
  schema.ts    zod 结构、YAML 读写、字段级 diff
  styles.css   注入到酒馆 <head> 的样式
  types/       酒馆助手全局接口的最小声明
```

## 让 AI 直接查看酒馆网页 (chrome-devtools MCP)

仓库内置了 [`.vscode/mcp.json`](.vscode/mcp.json), 配置了 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.11.0, 让编程助手能读取页面 DOM / Console / 网络、点击按钮、填写表单。

```json
{
  "servers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "chrome-devtools-mcp@latest",
               "--executablePath", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
               "--isolated"]
    }
  }
}
```

- **无需预装**: 通过 `npx` 按需拉取, 不污染全局; `--isolated` 用临时用户目录启动浏览器, 退出后自动清理。
- **本机没有 Chrome, 因此指向 Edge 154**(Chromium 内核, 已验证可调试)。若安装了 Chrome 144+, 可把 `args` 换成 `["/c", "npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect"]`, 并在 `chrome://inspect/#remote-debugging` 勾选允许远程调试。
- **需要看已登录的酒馆页面时**, 用附加模式: 先以调试端口启动浏览器

  ```powershell
  & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\edge-debug"
  ```

  再把 `args` 改为 `["/c", "npx", "-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]` 并重启该 MCP 服务。
- 启用方式: VS Code 命令面板执行 `MCP: List Servers` → 选中 `chrome-devtools` → `Start`(首次使用工具时也会自动启动)。

## 要求

- 酒馆助手需提供 `getWorldbook` / `updateWorldbookWith` / `createWorldbookEntries` / `generateRaw` / `eventOn` 等接口。
- 同步依赖酒馆当前使用的模型可用; 模型不可用时 popover 会直接显示错误, 不会改动世界书。
