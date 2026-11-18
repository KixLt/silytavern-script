// 打包 AI 请求监控脚本:
//
//   pnpm --filter @silytavern/ai-monitor build
//
// 产物写入仓库根目录 dist/ai-monitor/, 与剧情进度状态栏的 dist/build 并列,
// 由 CI 统一回写, jsDelivr 直接读取.
//
// 刻意不写 `id`: 酒馆助手导入时会自动生成, 这样同一份源码永远产出同一份 JSON,
// CI 才能靠 `git status` 判断产物是否真的变化, 不会每次构建都刷一次提交.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url)); // packages/ai-monitor
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // 仓库根目录
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'ai-monitor');
const SOURCE_FILE = path.join(PACKAGE_ROOT, 'src', 'tt-ai-monitor.js');

const SCRIPT_NAME = 'TT | AI 请求监控';
const SCRIPT_INFO = [
    '监控 TauriTavern 访问 AI 的情况: 成功/失败、发送(输入) token、接收(输出) token、缓存命中率,',
    '以及耗时与首字延迟。数据来自主进程 LLM API 日志与楼层 extra.prompt_cache。',
].join(' ');

const content = await readFile(SOURCE_FILE, 'utf8');

const script = {
    type: 'script',
    enabled: false,
    name: SCRIPT_NAME,
    content,
    info: SCRIPT_INFO,
    button: {
        enabled: true,
        buttons: [
            { name: '显示/隐藏面板', visible: true },
            { name: '清空统计', visible: true },
        ],
    },
    data: {},
    export_with: { data: true, button: true },
};

await mkdir(OUT_DIR, { recursive: true });

// 1) 酒馆助手脚本库 JSON (推荐: 本地导入用)
const json_path = path.join(OUT_DIR, 'TT-AI-Monitor.json');
await writeFile(json_path, `${JSON.stringify(script, null, 2)}\n`, 'utf8');

// 2) 原始脚本 (可当加载器脚本直接 import, 或供 jsDelivr 读取源码)
const js_path = path.join(OUT_DIR, 'tt-ai-monitor.js');
await copyFile(SOURCE_FILE, js_path);

console.log(`[ai-monitor] ${path.relative(REPO_ROOT, json_path)}`);
console.log(`[ai-monitor] ${path.relative(REPO_ROOT, js_path)}`);
