// 本地预览用的静态服务器: 只托管仓库根目录, 让模拟页能直接引用 dist/ 里的产物.
// 用法: node scripts/demo/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const port = Number(process.argv[2] ?? process.env.DEMO_PORT ?? 5510);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http
  .createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'scripts/demo/tavern-mock.html';
    const target = path.resolve(root, relative);

    // 只允许读仓库内的文件
    if (!target.startsWith(root)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      response.end(data);
    });
  })
  .listen(port, () => {
    console.log(`[demo] http://localhost:${port}/scripts/demo/tavern-mock.html`);
  });
