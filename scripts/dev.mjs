// 本地联调服务: 把构建产物托管为 HTTP 链接, 并在每次重新构建后通知酒馆助手重载脚本.
//
//   pnpm dev
//
// - http://localhost:5500/dist/index.js  构建产物 (带 CORS, 供脚本 iframe 以 ESM 导入)
// - http://localhost:6621                               socket.io 服务, 对应酒馆助手「设置 - 开发者 - 实时监听」
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from 'socket.io';
import { build } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTTP_PORT = Number(process.env.PPB_HTTP_PORT ?? 5500);
const SOCKET_PORT = Number(process.env.PPB_SOCKET_PORT ?? 6621);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const http_server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  let file_path = path.join(ROOT, pathname);

  // 防止 ../ 越界读取
  if (!file_path.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(file_path) && statSync(file_path).isDirectory()) {
    file_path = path.join(file_path, 'index.html');
  }
  if (!existsSync(file_path) || !statSync(file_path).isFile()) {
    response.writeHead(404).end(`Not Found: ${pathname}`);
    return;
  }

  response.writeHead(200, {
    // 酒馆页面 (localhost:8000) 跨端口导入 localhost:5500 的模块, 必须允许 CORS
    'Access-Control-Allow-Origin': '*',
    // 实时联调不能吃缓存, 否则重载后还是旧代码
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Type': MIME_TYPES[path.extname(file_path)] ?? 'application/octet-stream',
  });
  createReadStream(file_path).pipe(response);
});

const io = new Server(SOCKET_PORT, { cors: { origin: '*' } });

io.on('connection', socket => {
  console.info(`[联调] 酒馆已连接 '${socket.id}', 立即推送一次重载事件`);
  socket.emit('script_iframe_updated');
  socket.on('disconnect', reason => {
    console.info(`[联调] 酒馆断开连接: ${reason}`);
  });
});

let notify_timer;
function notifyReload() {
  clearTimeout(notify_timer);
  notify_timer = setTimeout(() => {
    io.emit('script_iframe_updated');
    console.info('[联调] 构建完成, 已通知酒馆重新加载脚本');
  }, 200);
}

http_server.listen(HTTP_PORT, () => {
  console.info(`[联调] 构建产物: http://localhost:${HTTP_PORT}/dist/index.js`);
});
console.info(`[联调] 实时监听: http://localhost:${SOCKET_PORT}  (在 酒馆助手 ‣ 开发 ‣ 实时监听 中启用)`);

const watcher = await build({
  configFile: path.join(ROOT, 'vite.config.ts'),
  mode: 'development',
  logLevel: 'info',
  build: { watch: {} },
});

watcher.on('event', event => {
  if (event.code === 'END') {
    notifyReload();
  } else if (event.code === 'ERROR') {
    console.error('[联调] 构建失败:', event.error);
  }
});

let closing = false;
async function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  clearTimeout(notify_timer);
  await watcher.close();
  io.close();
  http_server.close();
  console.info('[联调] 已退出');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
