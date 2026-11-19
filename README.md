# 酒馆助手脚本集

[酒馆助手 (JS-Slash-Runner)](https://github.com/N0VI028/JS-Slash-Runner) 脚本的 monorepo:
pnpm workspace 管理多个脚本, **一次提交由 CI 同时打包出所有产物**, jsDelivr 直接从 `master` 读取。

| 包 | 脚本 | 产物 | 说明 |
| --- | --- | --- | --- |
| [`packages/plot-progress-bar`](packages/plot-progress-bar) | 剧情进度状态栏 | `dist/build/index.js` | 输入栏上方的状态栏, 让 AI 把剧情进度同步进世界书 |
| [`packages/message-visibility`](packages/message-visibility) | 楼层可见性 | `dist/message-visibility/index.js` | 输入栏上方的开关栏, 决定哪些楼层发给 AI |
| [`packages/ai-monitor`](packages/ai-monitor) | TT \| AI 请求监控 | `dist/ai-monitor/TT-AI-Monitor.json` | 悬浮面板: 请求成败、输入/输出 token、缓存命中率 |

## 在酒馆中使用

三个脚本都是「加载器脚本」模式: 脚本本身不存代码, 每次重载都会重新拉取最新构建产物, 因此更新后重新打开酒馆即可生效, 不需要反复复制粘贴。

### 剧情进度状态栏

酒馆助手 ‣ 脚本 ‣ 新建脚本, 内容只写一行:

```js
import 'https://cdn.jsdelivr.net/gh/KixLt/silytavern-script@master/dist/build/index.js'
```

### 楼层可见性

同样的方法新建脚本:

```js
import 'https://cdn.jsdelivr.net/gh/KixLt/silytavern-script@master/dist/message-visibility/index.js'
```

### TT | AI 请求监控

同样的方法新建脚本:

```js
import 'https://cdn.jsdelivr.net/gh/KixLt/silytavern-script@master/dist/ai-monitor/tt-ai-monitor.js'
```

也可以离线使用: 下载 [`dist/ai-monitor/TT-AI-Monitor.json`](dist/ai-monitor/TT-AI-Monitor.json),
在脚本库用「导入」加载 (导入后脚本默认关闭, 记得手动打开开关)。

> 分支地址 (`@master`) 有 jsDelivr 缓存; 需要立即生效时把 `@master` 换成具体 commit 哈希。

## 开发

```bash
pnpm install
pnpm typecheck   # 逐包 typecheck
pnpm build       # 逐包构建, 产物统一写到仓库根 dist/
pnpm dev         # 剧情进度状态栏的本地联调服务 (HTTP 5500 + socket.io 6621)
```

构建细节、本地联调步骤、方向约定见 [AGENTS.md](AGENTS.md)。

## 目录

```
package.json            workspace 根 (build / typecheck / dev)
pnpm-workspace.yaml     packages: ['packages/*']
tsconfig.base.json      共享 TS 编译选项
dist/                   发布产物, 由 CI 回写
packages/
  plot-progress-bar/    TS + Vite
  message-visibility/   TS + Vite
  ai-monitor/           单文件 JS + 打包成酒馆助手 JSON
.github/workflows/      build.yml: typecheck → build → 回写 dist/
```

## 新增一个脚本

1. `packages/<name>/` 建包, 声明 `build` 与 `typecheck` 脚本。
2. 产物写到仓库根 `dist/<name>/` (要与 jsDelivr 地址保持一致)。
3. 确认产物没被 `.gitignore` 忽略, CI 才会把它提交回去。
