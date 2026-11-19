/**
 * TauriTavern AI 请求监控面板（酒馆助手脚本）
 *
 * 结构：
 *  - 「实时」页：当前/最近一次请求的成功与否、发送(输入) token、接收(输出) token、缓存命中率
 *  - 「历史」页：最近 35 条请求（只显示成功/失败），点击任意一条在页内展开详情，
 *               详情与实时页共用同一套渲染逻辑，保证数值完全一致
 *
 * 数据来源：
 * 1. TauriTavern 主进程的 LLM API 日志流（__TAURITAVERN__.api.dev.llmApiLogs）
 *    —— 每次真实 HTTP 请求的成功/失败、模型、来源、耗时。
 * 2. 楼层消息的 extra（prompt_cache / token_count / time_to_first_token）
 *    —— 提供方上报的输入 token、缓存命中 token、输出 token、首字延迟。
 *
 * 若宿主不提供日志流（非 TauriTavern 环境），退化为纯酒馆事件统计。
 */
(function () {
    'use strict';

    const HOST = window.parent;
    const DOC = HOST.document;
    const PANEL_ID = 'tt-ai-monitor';
    const STYLE_ID = 'tt-ai-monitor-style';
    const LS_STATS = 'tt-ai-monitor:v2:stats';
    const LS_UI = 'tt-ai-monitor:v2:ui';
    const MAX_RECORDS = 35;
    const PENDING_TIMEOUT_MS = 5000;
    const MESSAGE_FRESH_MS = 5000;

    // 防止脚本重复执行导致多份监听 / 多份面板
    try {
        HOST.__TT_AI_MONITOR__?.destroy?.();
    } catch {
        /* 忽略旧实例清理失败 */
    }

    // ---------------------------------------------------------------- 格式化
    const intFmt = new Intl.NumberFormat('zh-CN');

    const isNum = value => typeof value === 'number' && Number.isFinite(value);

    function fmtInt(value) {
        return isNum(value) ? intFmt.format(Math.round(value)) : '—';
    }

    function fmtCompact(value) {
        if (!isNum(value)) return '—';
        const abs = Math.abs(value);
        if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
        if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
        return intFmt.format(Math.round(value));
    }

    function fmtPct(ratio) {
        return isNum(ratio) ? `${(ratio * 100).toFixed(ratio >= 0.995 || ratio === 0 ? 0 : 1)}%` : '—';
    }

    function fmtSeconds(ms) {
        if (!isNum(ms)) return '—';
        return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
    }

    function fmtClock(ts) {
        if (!isNum(ts)) return '--:--:--';
        const date = new Date(ts);
        const pad = value => String(value).padStart(2, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function fmtDateTime(ts) {
        if (!isNum(ts)) return '—';
        const date = new Date(ts);
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
            + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function clampText(text, max) {
        const value = String(text ?? '').replace(/\s+/g, ' ').trim();
        return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    }

    function escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(text) {
        return escapeHtml(text).replace(/'/g, '&#39;');
    }

    // ---------------------------------------------------------------- 状态
    const emptyTotals = () => ({
        requests: 0,
        ok: 0,
        failed: 0,
        input: 0,
        output: 0,
        cached: 0,
        cacheInput: 0,
        durationMs: 0,
    });

    let recordSeq = 0;

    const state = {
        chatKey: '',
        records: [],
        totals: emptyTotals(),
        inflightAt: null,
        pending: null,
        lastMessage: null,
        localStartAt: null,
        lastError: null,
        streamReady: false,
        ui: {
            left: null,
            top: null,
            collapsed: false,
            hidden: false,
            tab: 'live',
            selectedKey: null,
        },
    };

    const offs = [];

    // ---------------------------------------------------------------- 存储
    function currentChatKey() {
        try {
            const context = HOST.SillyTavern?.getContext?.();
            const chatId = context?.chatId ?? context?.getCurrentChatId?.() ?? 'unknown';
            const avatar = context?.characters?.[context?.characterId]?.avatar ?? 'group-or-none';
            return `${avatar}::${chatId}`;
        } catch {
            return 'unknown';
        }
    }

    function statsStorageKey() {
        return `${LS_STATS}:${state.chatKey}`;
    }

    function readJson(key, fallback) {
        try {
            const raw = HOST.localStorage?.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            HOST.localStorage?.setItem(key, JSON.stringify(value));
        } catch {
            /* 隐私模式或配额不足时静默忽略 */
        }
    }

    function loadStats() {
        const saved = readJson(statsStorageKey(), null);
        const records = Array.isArray(saved?.records) ? saved.records.slice(-MAX_RECORDS) : [];
        state.records = records.map(record => ({ ...record, key: record.key ?? `st:${++recordSeq}` }));
        state.totals = { ...emptyTotals(), ...(saved?.totals ?? {}) };
        if (state.ui.selectedKey && !state.records.some(r => r.key === state.ui.selectedKey)) {
            state.ui.selectedKey = null;
        }
    }

    let saveTimer = null;
    function saveStats() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            writeJson(statsStorageKey(), { records: state.records, totals: state.totals });
        }, 400);
    }

    function loadUi() {
        state.ui = { ...state.ui, ...readJson(LS_UI, {}) };
        if (state.ui.tab !== 'history') state.ui.tab = 'live';
    }

    function saveUi() {
        writeJson(LS_UI, state.ui);
    }

    // ---------------------------------------------------------------- 样式
    function injectStyle() {
        if (DOC.getElementById(STYLE_ID)) return;
        const style = DOC.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${PANEL_ID} {
    /* 主题变量 → 本组件语义色。
     * 状态色从正文色调和, 深色/浅色主题都读得清, 也不用框架默认的那套糖果色;
     * 弱化色用 SmartThemeEmColor, 不要用 SmartThemeQuoteColor (很多主题里是高饱和引用色)。 */
    --ttam-text: var(--SmartThemeBodyColor, #e8e8ea);
    --ttam-muted: var(--SmartThemeEmColor, #919191);
    --ttam-accent: var(--SmartThemeUnderlineColor, #bce7cf);
    --ttam-bg: var(--SmartThemeBlurTintColor, #14161c);
    --ttam-line: color-mix(in srgb, var(--ttam-text) 14%, transparent);
    --ttam-surface: color-mix(in srgb, var(--ttam-text) 8%, transparent);
    --ttam-accent-soft: color-mix(in srgb, var(--ttam-accent) 22%, transparent);
    --ttam-accent-line: color-mix(in srgb, var(--ttam-accent) 45%, transparent);
    --ttam-ok: color-mix(in srgb, #4fae6a 78%, var(--ttam-text));
    --ttam-fail: color-mix(in srgb, #c26666 72%, var(--ttam-text));
    --ttam-warn: color-mix(in srgb, #c9962f 82%, var(--ttam-text));

    position: fixed;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    width: 320px;
    max-width: calc(100vw - 24px);
    max-height: min(500px, calc(100vh - 24px));
    box-sizing: border-box;
    font-family: var(--mainFontFamily, "Segoe UI", "Microsoft YaHei", sans-serif);
    font-size: 12px;
    line-height: 1.45;
    color: var(--ttam-text);
    background: var(--ttam-bg);
    border: 1px solid var(--ttam-line);
    border-radius: 10px;
    /* 一个小而紧的高度感: 模糊不超过控件自身尺寸 */
    box-shadow: 0 6px 18px rgba(0, 0, 0, .32);
    overflow: hidden;
    user-select: none;
}
#${PANEL_ID} .ttam-head { flex: 0 0 auto; }
#${PANEL_ID} .ttam-tabs { flex: 0 0 auto; }
#${PANEL_ID}.ttam-collapsed .ttam-main,
#${PANEL_ID}.ttam-collapsed .ttam-tabs { display: none; }
#${PANEL_ID} .ttam-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 6px 7px 9px;
    cursor: grab;
}
#${PANEL_ID} .ttam-head:active { cursor: grabbing; }
#${PANEL_ID} .ttam-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--ttam-muted); flex: 0 0 auto;
}
#${PANEL_ID} .ttam-dot.is-ok { background: var(--ttam-ok); }
#${PANEL_ID} .ttam-dot.is-fail { background: var(--ttam-fail); }
#${PANEL_ID} .ttam-dot.is-busy { background: var(--ttam-warn); }
#${PANEL_ID} .ttam-title { font-weight: 600; letter-spacing: .3px; }
#${PANEL_ID} .ttam-badge {
    margin-left: auto; font-size: 11px; opacity: .72;
    font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .ttam-btn {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    width: 20px; height: 20px; line-height: 1; padding: 0; border-radius: 4px;
    opacity: .7; font-size: 13px; flex: 0 0 auto;
}
#${PANEL_ID} .ttam-btn:hover { opacity: 1; background: var(--ttam-surface); }
#${PANEL_ID} .ttam-btn.ttam-close:hover { background: color-mix(in srgb, var(--ttam-fail) 24%, transparent); color: var(--ttam-fail); }
#${PANEL_ID} .ttam-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    padding: 0;
    border-bottom: 1px solid var(--ttam-line);
}
#${PANEL_ID} .ttam-tab {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font: inherit; font-size: 11px; padding: 6px 8px;
    text-align: center; width: 100%; min-width: 0; box-sizing: border-box;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    opacity: .6; border-bottom: 2px solid transparent; border-radius: 0;
}
#${PANEL_ID} .ttam-tab:hover { opacity: .9; background: var(--ttam-surface); }
#${PANEL_ID} .ttam-tab.is-active {
    opacity: 1; font-weight: 600;
    border-bottom-color: var(--ttam-accent);
}
#${PANEL_ID} .ttam-tab-count {
    margin-left: 4px; font-size: 10px; opacity: .6; font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .ttam-main {
    flex: 1 1 auto;
    min-height: 0;
    cursor: grab;
    padding: 8px 9px 9px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
}
#${PANEL_ID} .ttam-main:active { cursor: grabbing; }
#${PANEL_ID} .ttam-view { display: none; }
#${PANEL_ID} .ttam-view.is-active { display: block; }
#${PANEL_ID} .ttam-status-card {
    background: var(--ttam-surface);
    border: 1px solid var(--ttam-line);
    border-radius: 7px;
    padding: 5px 7px;
    margin-bottom: 6px;
}
#${PANEL_ID} .ttam-row {
    display: flex; align-items: baseline; gap: 6px;
    flex-wrap: wrap; min-width: 0;
}
#${PANEL_ID} .ttam-state { font-weight: 600; flex: 0 0 auto; }
#${PANEL_ID} .ttam-state.is-ok { color: var(--ttam-ok); }
#${PANEL_ID} .ttam-state.is-fail { color: var(--ttam-fail); }
#${PANEL_ID} .ttam-state.is-busy { color: var(--ttam-warn); }
#${PANEL_ID} .ttam-state.is-idle { color: inherit; opacity: .7; }
#${PANEL_ID} .ttam-sub {
    color: inherit; opacity: .62; font-size: 11px;
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#${PANEL_ID} .ttam-metrics {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 6px; margin: 7px 0 4px;
}
#${PANEL_ID} .ttam-metric {
    background: var(--ttam-surface);
    border: 1px solid var(--ttam-line);
    border-radius: 7px; padding: 5px 6px;
}
#${PANEL_ID} .ttam-metric-label { font-size: 10px; opacity: .6; }
#${PANEL_ID} .ttam-metric-value {
    font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${PANEL_ID} .ttam-metric-value small { font-size: 10px; font-weight: 400; opacity: .65; margin-left: 2px; }
#${PANEL_ID} .ttam-bar {
    height: 4px; border-radius: 3px; overflow: hidden;
    background: var(--ttam-surface); margin: 2px 0 6px;
}
#${PANEL_ID} .ttam-bar-fill {
    height: 100%; width: 0%;
    background: var(--ttam-accent);
    transition: width .2s ease;
}
#${PANEL_ID} .ttam-totals {
    font-size: 11px; opacity: .78; padding-top: 4px;
    border-top: 1px dashed var(--ttam-line);
    font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .ttam-totals b { font-weight: 600; opacity: 1; }
#${PANEL_ID} .ttam-sep { opacity: .35; margin: 0 4px; }
#${PANEL_ID} .ttam-list {
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .ttam-item {
    display: flex; align-items: center; gap: 7px;
    padding: 4px 6px; border-radius: 6px;
    cursor: pointer; border: 1px solid transparent;
}
#${PANEL_ID} .ttam-item:hover { background: var(--ttam-surface); }
#${PANEL_ID} .ttam-item.is-selected {
    background: var(--ttam-accent-soft);
    border-color: var(--ttam-accent-line);
}
#${PANEL_ID} .ttam-item-mark { flex: 0 0 auto; font-weight: 700; }
#${PANEL_ID} .ttam-item-mark.is-ok { color: var(--ttam-ok); }
#${PANEL_ID} .ttam-item-mark.is-fail { color: var(--ttam-fail); }
#${PANEL_ID} .ttam-item-time { flex: 0 0 auto; opacity: .55; font-size: 11px; }
#${PANEL_ID} .ttam-item-tail { margin-left: auto; opacity: .45; font-size: 10px; }
#${PANEL_ID} .ttam-empty { opacity: .55; font-size: 11px; padding: 8px 2px; }
#${PANEL_ID} .ttam-detail-head {
    display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
}
#${PANEL_ID} .ttam-back {
    border: 0; background: var(--ttam-surface); color: inherit; cursor: pointer;
    font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 5px; opacity: .85;
}
#${PANEL_ID} .ttam-back:hover { opacity: 1; background: var(--ttam-line); }
#${PANEL_ID} .ttam-detail-title { font-size: 11px; opacity: .6; margin-left: auto; }
#${PANEL_ID} .ttam-facts {
    margin-top: 8px; padding-top: 6px;
    border-top: 1px dashed var(--ttam-line);
    font-size: 11px; font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .ttam-fact { display: flex; gap: 8px; padding: 1px 0; }
#${PANEL_ID} .ttam-fact-key { opacity: .55; flex: 0 0 62px; }
#${PANEL_ID} .ttam-fact-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .ttam-fact-value.ttam-fail { color: var(--ttam-fail); white-space: normal; word-break: break-word; }
#${PANEL_ID} .ttam-foot {
    display: flex; align-items: center; gap: 8px;
    margin-top: 8px; padding-top: 6px;
    border-top: 1px solid var(--ttam-line);
    font-size: 10px; opacity: .62;
}
#${PANEL_ID} .ttam-link {
    color: inherit; text-decoration: underline; cursor: pointer;
    background: none; border: 0; padding: 0; font: inherit; opacity: .9;
}
#${PANEL_ID} .ttam-link:hover { opacity: 1; }
#${PANEL_ID} .ttam-run { margin-left: auto; }
        `;
        (DOC.head ?? DOC.documentElement).appendChild(style);
    }

    const METRICS_TEMPLATE = `
        <div class="ttam-status-card">
            <div class="ttam-row">
                <span class="ttam-state">等待请求</span>
                <span class="ttam-sub ttam-meta"></span>
            </div>
        </div>
        <div class="ttam-metrics">
            <div class="ttam-metric">
                <div class="ttam-metric-label">发送 (输入)</div>
                <div class="ttam-metric-value ttam-input">—</div>
            </div>
            <div class="ttam-metric">
                <div class="ttam-metric-label">接收 (输出)</div>
                <div class="ttam-metric-value ttam-output">—</div>
            </div>
            <div class="ttam-metric">
                <div class="ttam-metric-label">缓存命中</div>
                <div class="ttam-metric-value ttam-cache">—</div>
            </div>
        </div>
        <div class="ttam-bar"><div class="ttam-bar-fill"></div></div>
    `;

    const PANEL_TEMPLATE = `
        <div class="ttam-head">
            <span class="ttam-dot"></span>
            <span class="ttam-title">AI 监控</span>
            <span class="ttam-badge"></span>
            <button class="ttam-btn ttam-collapse" title="折叠/展开">–</button>
            <button class="ttam-btn ttam-close" title="关闭面板">×</button>
        </div>
        <div class="ttam-tabs">
            <button class="ttam-tab" data-tab="live">实时</button>
            <button class="ttam-tab" data-tab="history">历史<span class="ttam-tab-count"></span></button>
        </div>
        <div class="ttam-main">
            <div class="ttam-view ttam-view-live">
                ${METRICS_TEMPLATE}
                <div class="ttam-totals"></div>
            </div>
            <div class="ttam-view ttam-view-history">
                <div class="ttam-history-list">
                    <div class="ttam-list"></div>
                </div>
                <div class="ttam-history-detail" hidden>
                    <div class="ttam-detail-head">
                        <button class="ttam-back">← 列表</button>
                        <span class="ttam-detail-title"></span>
                    </div>
                    ${METRICS_TEMPLATE}
                    <div class="ttam-facts"></div>
                </div>
            </div>
            <div class="ttam-foot">
                <button class="ttam-link ttam-clear">清空统计</button>
                <span class="ttam-run"></span>
            </div>
        </div>
    `;

    // ---------------------------------------------------------------- 面板
    let root = null;
    const els = {};

    /** 从某个作用域里取出「指标卡片」相关元素，实时页与详情页共用同一套渲染 */
    function queryView(scope) {
        return {
            scope,
            state: scope.querySelector('.ttam-state'),
            meta: scope.querySelector('.ttam-meta'),
            input: scope.querySelector('.ttam-input'),
            output: scope.querySelector('.ttam-output'),
            cache: scope.querySelector('.ttam-cache'),
            bar: scope.querySelector('.ttam-bar-fill'),
        };
    }

    function ensurePanel() {
        if (root && root.isConnected) return true;
        root = DOC.getElementById(PANEL_ID);
        const created = !root;
        if (created) {
            injectStyle();
            root = DOC.createElement('div');
            root.id = PANEL_ID;
            root.innerHTML = PANEL_TEMPLATE;
            (DOC.body ?? DOC.documentElement).appendChild(root);
        }

        els.dot = root.querySelector('.ttam-dot');
        els.badge = root.querySelector('.ttam-badge');
        els.collapse = root.querySelector('.ttam-collapse');
        els.close = root.querySelector('.ttam-close');
        els.tabs = Array.from(root.querySelectorAll('.ttam-tab'));
        els.tabCount = root.querySelector('.ttam-tab-count');
        els.main = root.querySelector('.ttam-main');
        els.liveView = root.querySelector('.ttam-view-live');
        els.historyView = root.querySelector('.ttam-view-history');
        els.historyList = root.querySelector('.ttam-history-list');
        els.historyDetail = root.querySelector('.ttam-history-detail');
        els.list = root.querySelector('.ttam-list');
        els.back = root.querySelector('.ttam-back');
        els.detailTitle = root.querySelector('.ttam-detail-title');
        els.facts = root.querySelector('.ttam-facts');
        els.totals = root.querySelector('.ttam-totals');
        els.clear = root.querySelector('.ttam-clear');
        els.run = root.querySelector('.ttam-run');
        els.live = queryView(els.liveView);
        els.detail = queryView(els.historyDetail);

        if (created) bindPanel();
        applyUi();
        return true;
    }

    function applyUi() {
        if (!root) return;
        root.classList.toggle('ttam-collapsed', Boolean(state.ui.collapsed));
        root.style.display = state.ui.hidden ? 'none' : '';
        if (els.collapse) els.collapse.textContent = state.ui.collapsed ? '+' : '–';
        if (isNum(state.ui.top)) root.style.top = `${state.ui.top}px`;
        if (isNum(state.ui.left)) {
            root.style.left = `${state.ui.left}px`;
            root.style.right = 'auto';
        } else {
            root.style.right = '16px';
            root.style.top = isNum(state.ui.top) ? `${state.ui.top}px` : '96px';
        }
        applyTab();
    }

    function applyTab() {
        if (!root) return;
        const tab = state.ui.tab === 'history' ? 'history' : 'live';
        els.tabs.forEach(button => {
            button.classList.toggle('is-active', button.dataset.tab === tab);
        });
        els.liveView.classList.toggle('is-active', tab === 'live');
        els.historyView.classList.toggle('is-active', tab === 'history');
        const showDetail = tab === 'history' && Boolean(state.ui.selectedKey);
        els.historyList.hidden = showDetail;
        els.historyDetail.hidden = !showDetail;
    }

    function bindPanel() {
        els.tabs.forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                state.ui.tab = button.dataset.tab === 'history' ? 'history' : 'live';
                saveUi();
                render();
            });
        });

        els.collapse.addEventListener('click', event => {
            event.stopPropagation();
            state.ui.collapsed = !state.ui.collapsed;
            saveUi();
            applyUi();
        });

        els.close.addEventListener('click', event => {
            event.stopPropagation();
            setVisible(false);
        });

        els.back.addEventListener('click', event => {
            event.stopPropagation();
            state.ui.selectedKey = null;
            saveUi();
            render();
        });

        els.clear.addEventListener('click', event => {
            event.stopPropagation();
            resetStats();
        });

        els.list.addEventListener('click', event => {
            const item = event.target.closest('.ttam-item');
            if (!item?.dataset.key) return;
            state.ui.tab = 'history';
            state.ui.selectedKey = item.dataset.key;
            saveUi();
            render();
        });

        bindDrag();
    }

    // 整个面板都可拖动：除了按钮、列表项、输入控件与滚动条
    function bindDrag() {
        const NO_DRAG = 'button, .ttam-item, a, input, textarea, select';
        root.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            if (event.target.closest(NO_DRAG)) return;
            if (event.target.closest('.ttam-main')) {
                // 允许在滚动区空白处拖动，但不抢滚动条
                const rect = els.main.getBoundingClientRect();
                if (event.clientX > rect.right - 12) return;
            }

            const rect = root.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const offsetY = event.clientY - rect.top;
            const onMove = moveEvent => {
                const left = Math.min(Math.max(moveEvent.clientX - offsetX, 0), Math.max(0, HOST.innerWidth - rect.width));
                const top = Math.min(Math.max(moveEvent.clientY - offsetY, 0), Math.max(0, HOST.innerHeight - 40));
                root.style.left = `${left}px`;
                root.style.right = 'auto';
                root.style.top = `${top}px`;
                state.ui.left = Math.round(left);
                state.ui.top = Math.round(top);
            };
            const onUp = () => {
                DOC.removeEventListener('mousemove', onMove);
                DOC.removeEventListener('mouseup', onUp);
                saveUi();
            };
            DOC.addEventListener('mousemove', onMove);
            DOC.addEventListener('mouseup', onUp);
            event.preventDefault();
        });
    }

    function setVisible(visible) {
        state.ui.hidden = !visible;
        saveUi();
        applyUi();
    }

    // ---------------------------------------------------------------- 渲染
    function lastRecord() {
        return state.records[state.records.length - 1] ?? null;
    }

    function recordByKey(key) {
        return state.records.find(record => record.key === key) ?? null;
    }

    /** 统一的指标渲染：实时页与历史详情页都调用它，保证数值一致 */
    function paintMetrics(view, record, { busy = false } = {}) {
        if (!view?.scope) return;

        let statusClass = 'is-idle';
        let statusText = '等待请求';
        if (busy) {
            statusClass = 'is-busy';
            statusText = '请求中…';
        } else if (record) {
            statusClass = record.ok ? 'is-ok' : 'is-fail';
            statusText = record.ok ? '成功' : '失败';
        }

        view.state.textContent = statusText;
        view.state.className = `ttam-state ${statusClass}`;

        const metaParts = [];
        if (busy) {
            metaParts.push('进行中');
        } else if (record) {
            if (record.model) metaParts.push(record.model);
            else if (record.source) metaParts.push(record.source);
            if (isNum(record.durationMs)) metaParts.push(fmtSeconds(record.durationMs));
            if (record.ok && isNum(record.output) && isNum(record.durationMs) && record.durationMs > 0) {
                metaParts.push(`${(record.output / (record.durationMs / 1000)).toFixed(1)} tok/s`);
            }
            if (isNum(record.ttft)) metaParts.push(`首字 ${fmtSeconds(record.ttft)}`);
        }
        view.meta.textContent = metaParts.join(' · ');

        view.input.innerHTML = record && isNum(record.input)
            ? `${fmtCompact(record.input)}${record.estimated ? '<small>估</small>' : ''}`
            : '—';
        view.input.title = record && isNum(record.input) ? `${fmtInt(record.input)} tokens` : '未获取到输入 token';

        view.output.innerHTML = record && isNum(record.output)
            ? `${fmtCompact(record.output)}${record.estimated ? '<small>估</small>' : ''}`
            : '—';
        view.output.title = record && isNum(record.output) ? `${fmtInt(record.output)} tokens` : '未获取到输出 token';

        const rate = record && isNum(record.cached) && isNum(record.input) && record.input > 0
            ? record.cached / record.input
            : null;
        view.cache.textContent = isNum(rate) ? fmtPct(rate) : '—';
        view.cache.title = isNum(rate)
            ? `${fmtInt(record.cached)} / ${fmtInt(record.input)} tokens 命中`
            : '提供方未上报缓存用量';
        view.bar.style.width = isNum(rate) ? `${Math.min(100, Math.max(0, rate * 100)).toFixed(1)}%` : '0%';
    }

    function paintFacts(record) {
        if (!els.facts) return;
        if (!record) {
            els.facts.innerHTML = '';
            return;
        }
        const rows = [
            ['时间', fmtDateTime(record.ts)],
            ['模型', record.model || '—'],
            ['来源', record.source || '—'],
            ['耗时', isNum(record.durationMs) ? `${fmtSeconds(record.durationMs)}（${fmtInt(record.durationMs)} ms）` : '—'],
            ['首字延迟', isNum(record.ttft) ? fmtSeconds(record.ttft) : '—'],
            ['发送', isNum(record.input) ? `${fmtInt(record.input)} tokens${record.estimated ? '（估算）' : ''}` : '—'],
            ['接收', isNum(record.output) ? `${fmtInt(record.output)} tokens${record.estimated ? '（估算）' : ''}` : '—'],
            ['缓存命中', isNum(record.cached) && isNum(record.input) && record.input > 0
                ? `${fmtPct(record.cached / record.input)}（${fmtInt(record.cached)} / ${fmtInt(record.input)}）`
                : '—'],
        ];
        if (record.id != null) rows.push(['日志 ID', String(record.id)]);
        if (!record.ok) rows.push(['错误', record.error || '请求失败']);

        els.facts.innerHTML = rows.map(([key, value]) => {
            const fail = key === '错误' ? ' ttam-fail' : '';
            return `<div class="ttam-fact"><span class="ttam-fact-key">${escapeHtml(key)}</span>`
                + `<span class="ttam-fact-value${fail}">${escapeHtml(value)}</span></div>`;
        }).join('');
    }

    function renderList() {
        if (!els.list) return;
        const items = state.records.slice().reverse();
        if (!items.length) {
            els.list.innerHTML = '<div class="ttam-empty">还没有历史请求。</div>';
            return;
        }
        els.list.innerHTML = items.map(record => {
            const mark = record.ok
                ? '<span class="ttam-item-mark is-ok">✓</span>'
                : '<span class="ttam-item-mark is-fail">✗</span>';
            const selected = record.key === state.ui.selectedKey ? ' is-selected' : '';
            return `<div class="ttam-item${selected}" data-key="${escapeAttr(record.key)}" title="点击查看详情">`
                + `${mark}<span class="ttam-item-time">${fmtClock(record.ts)}</span>`
                + `<span class="ttam-item-tail">详情 ›</span></div>`;
        }).join('');
    }

    function render() {
        if (!ensurePanel()) return;

        const pending = Boolean(state.pending) || isNum(state.inflightAt);
        const last = lastRecord();

        // 头部状态点
        const statusClass = pending ? 'is-busy' : last ? (last.ok ? 'is-ok' : 'is-fail') : '';
        if (els.dot) els.dot.className = `ttam-dot ${statusClass}`;
        if (els.badge) els.badge.textContent = state.records.length ? `${state.records.length} 条` : '';

        // 实时页
        paintMetrics(els.live, last, { busy: pending });

        const totals = state.totals;
        const avgRate = totals.cacheInput > 0 ? totals.cached / totals.cacheInput : null;
        const avgDuration = totals.requests > 0 ? totals.durationMs / totals.requests : null;
        if (els.totals) {
            els.totals.innerHTML = [
                `<b>${totals.requests}</b> 次`,
                `✓${totals.ok} ✗${totals.failed}`,
                `↑${fmtCompact(totals.input)} ↓${fmtCompact(totals.output)}`,
                `缓存 ${isNum(avgRate) ? fmtPct(avgRate) : '—'}`,
                isNum(avgDuration) ? `均耗 ${fmtSeconds(avgDuration)}` : '',
            ].filter(Boolean).join('<span class="ttam-sep">·</span>');
            els.totals.title = [
                `请求 ${totals.requests} 次（成功 ${totals.ok}，失败 ${totals.failed}）`,
                `输入 ${fmtInt(totals.input)} tokens，输出 ${fmtInt(totals.output)} tokens`,
                `缓存命中 ${fmtInt(totals.cached)} / ${fmtInt(totals.cacheInput)} tokens`,
            ].join('\n');
        }

        // 历史页
        if (els.tabCount) els.tabCount.textContent = state.records.length ? String(state.records.length) : '';
        renderList();

        const selected = state.ui.selectedKey ? recordByKey(state.ui.selectedKey) : null;
        if (!selected) state.ui.selectedKey = null;
        if (els.detailTitle) {
            els.detailTitle.textContent = selected
                ? `${selected.ok ? '成功' : '失败'} · ${fmtDateTime(selected.ts)}`
                : '';
        }
        paintMetrics(els.detail, selected);
        paintFacts(selected);

        applyTab();

        if (els.run) {
            els.run.textContent = state.streamReady ? '日志流已连接' : '事件模式';
            els.run.title = state.streamReady
                ? '已连接 TauriTavern LLM 请求日志，可统计失败请求'
                : '未连接 TauriTavern 日志流，只能统计成功请求';
        }
    }

    // ---------------------------------------------------------------- 记录
    function addRecord(record) {
        if (record.id != null && state.records.some(item => item.id === record.id)) return;
        record.key = record.id != null ? `id:${record.id}` : `ev:${++recordSeq}`;
        state.records.push(record);
        if (state.records.length > MAX_RECORDS) {
            state.records.splice(0, state.records.length - MAX_RECORDS);
        }

        if (!record.historyOnly) {
            const totals = state.totals;
            totals.requests += 1;
            if (record.ok) totals.ok += 1;
            else totals.failed += 1;
            if (isNum(record.input)) totals.input += record.input;
            if (isNum(record.output)) totals.output += record.output;
            if (isNum(record.input) && isNum(record.cached)) {
                totals.cacheInput += record.input;
                totals.cached += record.cached;
            }
            if (isNum(record.durationMs)) totals.durationMs += record.durationMs;
        }

        saveStats();
        render();
    }

    function resetStats() {
        state.records = [];
        state.totals = emptyTotals();
        state.pending = null;
        state.ui.selectedKey = null;
        saveStats();
        render();
    }

    // ---------------------------------------------------------------- 数据抓取
    function numOrNull(value) {
        return isNum(value) ? value : null;
    }

    /** 兜底：用提示词管理器里最后一次组装的 token 数估算输入 */
    function estimatePromptTokens() {
        try {
            const manager = window.builtin?.promptManager
                ?? window.TavernHelper?.builtin?.promptManager;
            const messages = manager?.messages;
            if (!messages) return null;

            let total = 0;
            let found = false;
            const walk = node => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node.collection)) {
                    node.collection.forEach(walk);
                    return;
                }
                if (isNum(node.tokens) && node.tokens > 0) {
                    total += node.tokens;
                    found = true;
                }
            };
            if (Array.isArray(messages)) messages.forEach(walk);
            else walk(messages);
            return found ? total : null;
        } catch {
            return null;
        }
    }

    function readMessageExtra(messageId) {
        try {
            const messages = getChatMessages(messageId);
            return messages?.[0] ?? null;
        } catch {
            return null;
        }
    }

    async function countTextTokens(text) {
        try {
            const context = HOST.SillyTavern?.getContext?.();
            if (!context?.getTokenCountAsync || !text) return null;
            const count = await context.getTokenCountAsync(text);
            return isNum(count) && count > 0 ? count : null;
        } catch {
            return null;
        }
    }

    async function collectUsage(message) {
        const extra = message?.extra ?? {};
        const cache = extra.prompt_cache ?? null;

        let input = numOrNull(cache?.input_tokens);
        let cached = numOrNull(cache?.cached_tokens);
        let output = numOrNull(extra.token_count);
        let estimated = false;

        if (input == null) {
            const guess = estimatePromptTokens();
            if (guess) {
                input = guess;
                estimated = true;
            }
        }
        if (output == null && message?.message) {
            const counted = await countTextTokens(message.message);
            if (counted) {
                output = counted;
                estimated = true;
            }
        }
        if (cached != null && input != null && (cached < 0 || cached > input)) {
            cached = null; // 数据不自洽时按未知处理
        }

        return {
            input,
            output,
            cached,
            estimated,
            ttft: numOrNull(extra.time_to_first_token),
        };
    }

    async function finalizePending(message) {
        const pending = state.pending;
        if (!pending) return;
        state.pending = null;
        state.inflightAt = null;

        const entry = pending.entry;
        const usage = await collectUsage(message);

        addRecord({
            id: entry?.id ?? null,
            ts: isNum(entry?.timestampMs) ? entry.timestampMs : Date.now(),
            ok: true,
            source: entry?.source ?? '',
            model: entry?.model ?? '',
            durationMs: numOrNull(entry?.durationMs),
            stream: entry?.stream,
            ...usage,
        });
    }

    async function recordFailure(entry) {
        let error = '';
        try {
            const logs = HOST.__TAURITAVERN__?.api?.dev?.llmApiLogs;
            if (logs?.getPreview && isNum(entry?.id)) {
                const preview = await logs.getPreview(entry.id);
                error = preview?.errorMessage || preview?.responseReadable || '';
            }
        } catch {
            /* 预览取不到就留空 */
        }
        addRecord({
            id: entry?.id ?? null,
            ts: isNum(entry?.timestampMs) ? entry.timestampMs : Date.now(),
            ok: false,
            source: entry?.source ?? '',
            model: entry?.model ?? '',
            durationMs: numOrNull(entry?.durationMs),
            stream: entry?.stream,
            input: null,
            output: null,
            cached: null,
            ttft: null,
            error: clampText(error || '请求失败', 400),
        });
    }

    // ---------------------------------------------------------------- 日志流
    function onLogEntry(entry) {
        if (!entry || typeof entry !== 'object') return;
        if (entry.id != null && state.records.some(item => item.id === entry.id)) return;

        state.inflightAt = null;

        if (!entry.ok) {
            state.pending = null;
            state.lastMessage = null;
            void recordFailure(entry);
            return;
        }

        state.pending = { entry, at: Date.now() };

        // 消息可能先于日志事件到达
        if (state.lastMessage && Date.now() - state.lastMessage.at < MESSAGE_FRESH_MS) {
            const message = readMessageExtra(state.lastMessage.messageId);
            state.lastMessage = null;
            void finalizePending(message);
            return;
        }

        // 静默生成 / 无楼层写入时的兜底
        setTimeout(() => {
            if (state.pending?.entry?.id === entry.id) void finalizePending(null);
        }, PENDING_TIMEOUT_MS);
    }

    function backfill(entries) {
        if (!Array.isArray(entries) || !entries.length) return;
        const known = new Set(state.records.map(item => item.id).filter(id => id != null));
        const fresh = entries
            .filter(entry => entry && entry.id != null && !known.has(entry.id))
            .slice(-12);
        for (const entry of fresh) {
            addRecord({
                id: entry.id,
                ts: entry.timestampMs,
                ok: Boolean(entry.ok),
                source: entry.source ?? '',
                model: entry.model ?? '',
                durationMs: numOrNull(entry.durationMs),
                input: null,
                output: null,
                cached: null,
                ttft: null,
                error: entry.ok ? '' : '请求失败',
                historyOnly: true,
            });
        }
    }

    function setupTauriStream() {
        let logs = null;
        try {
            logs = HOST.__TAURITAVERN__?.api?.dev?.llmApiLogs;
        } catch {
            logs = null;
        }
        if (!logs || typeof logs.subscribeIndex !== 'function') return;

        Promise.resolve(logs.subscribeIndex(onLogEntry))
            .then(() => {
                state.streamReady = true;
                render();
            })
            .catch(error => {
                console.warn('[AI 监控] 无法订阅 LLM 日志流，退化为事件模式', error);
            });

        if (typeof logs.index === 'function') {
            Promise.resolve(logs.index({ limit: 12 }))
                .then(list => {
                    backfill(list);
                    render();
                })
                .catch(() => { /* 忽略 */ });
        }
    }

    // ---------------------------------------------------------------- 酒馆事件
    function markInflight() {
        state.inflightAt = Date.now();
        state.localStartAt = Date.now();
        state.lastError = null;
        state.lastMessage = null;
        render();
    }

    function onMessageReceived(messageId) {
        state.lastMessage = { messageId, at: Date.now() };
        if (state.streamReady) {
            if (state.pending) {
                const message = readMessageExtra(messageId);
                state.lastMessage = null;
                void finalizePending(message);
            }
            return;
        }

        // 事件模式：直接以楼层数据成单
        const message = readMessageExtra(messageId);
        const durationMs = isNum(state.localStartAt) ? Date.now() - state.localStartAt : null;
        state.localStartAt = null;
        state.inflightAt = null;

        void (async () => {
            const usage = await collectUsage(message);
            addRecord({
                id: null,
                ts: Date.now(),
                ok: true,
                source: '',
                model: '',
                durationMs,
                ...usage,
            });
        })();
    }

    function onGenerationStopped() {
        state.inflightAt = null;
        if (state.streamReady) {
            render();
            return;
        }
        const durationMs = isNum(state.localStartAt) ? Date.now() - state.localStartAt : null;
        state.localStartAt = null;
        addRecord({
            id: null,
            ts: Date.now(),
            ok: false,
            source: '',
            model: '',
            durationMs,
            input: null,
            output: null,
            cached: null,
            ttft: null,
            error: '已中止',
        });
    }

    function onGenerationEnded() {
        if (state.streamReady) {
            setTimeout(() => {
                if (state.pending) void finalizePending(null);
            }, 1200);
            return;
        }

        // 事件模式：失败时不会成单，用 toastr 捕获的错误兜底
        setTimeout(() => {
            if (!isNum(state.localStartAt)) return;
            const durationMs = Date.now() - state.localStartAt;
            state.localStartAt = null;
            state.inflightAt = null;
            addRecord({
                id: null,
                ts: Date.now(),
                ok: false,
                source: '',
                model: '',
                durationMs,
                input: null,
                output: null,
                cached: null,
                ttft: null,
                error: clampText(state.lastError || '请求失败', 400),
            });
        }, 1500);
    }

    function patchToastr() {
        try {
            const toastr = HOST.toastr;
            if (!toastr || typeof toastr.error !== 'function') return;
            const original = toastr.error.bind(toastr);
            const wrapped = function (message, title, options) {
                try {
                    if (isNum(state.inflightAt) || isNum(state.localStartAt)) {
                        state.lastError = String(message ?? '');
                    }
                } catch {
                    /* 忽略 */
                }
                return original(message, title, options);
            };
            wrapped.__ttAiMonitor = true;
            wrapped.__original = original;
            toastr.error = wrapped;
        } catch {
            /* 忽略 */
        }
    }

    function unpatchToastr() {
        try {
            const toastr = HOST.toastr;
            if (toastr?.error?.__ttAiMonitor && toastr.error.__original) {
                toastr.error = toastr.error.__original;
            }
        } catch {
            /* 忽略 */
        }
    }

    function subscribeTavernEvents() {
        const on = (type, handler) => {
            try {
                const handle = eventOn(type, handler);
                if (handle?.stop) offs.push(handle.stop);
            } catch (error) {
                console.warn('[AI 监控] 监听事件失败', type, error);
            }
        };

        on(tavern_events.GENERATION_STARTED, markInflight);
        on(tavern_events.MESSAGE_RECEIVED, onMessageReceived);
        on(tavern_events.GENERATION_STOPPED, onGenerationStopped);
        on(tavern_events.GENERATION_ENDED, onGenerationEnded);
        on(tavern_events.CHAT_CHANGED, () => {
            state.inflightAt = null;
            state.pending = null;
            state.lastMessage = null;
            state.localStartAt = null;
            state.chatKey = currentChatKey();
            state.ui.selectedKey = null;
            loadStats();
            render();
        });
    }

    function registerButtons() {
        try {
            if (typeof replaceScriptButtons !== 'function') return;
            replaceScriptButtons([
                { name: '显示/隐藏面板', visible: true },
                { name: '清空统计', visible: true },
            ]);
            const toggle = eventOn(getButtonEvent('显示/隐藏面板'), () => {
                ensurePanel();
                setVisible(Boolean(state.ui.hidden));
            });
            const clear = eventOn(getButtonEvent('清空统计'), () => resetStats());
            if (toggle?.stop) offs.push(toggle.stop);
            if (clear?.stop) offs.push(clear.stop);
        } catch (error) {
            console.warn('[AI 监控] 注册脚本按钮失败', error);
        }
    }

    // ---------------------------------------------------------------- 生命周期
    function destroy() {
        offs.splice(0).forEach(stop => {
            try { stop(); } catch { /* 忽略 */ }
        });
        unpatchToastr();
        if (root?.isConnected) root.remove();
        root = null;
    }

    function start() {
        loadUi();
        state.chatKey = currentChatKey();
        loadStats();
        ensurePanel();
        render();

        subscribeTavernEvents();
        patchToastr();
        setupTauriStream();
        registerButtons();
    }

    HOST.__TT_AI_MONITOR__ = {
        destroy,
        resetStats,
        show: () => { ensurePanel(); setVisible(true); },
        hide: () => setVisible(false),
        state,
    };

    try {
        start();
    } catch (error) {
        console.error('[AI 监控] 初始化失败', error);
    }

    try {
        $(window).on('pagehide', () => destroy());
    } catch {
        window.addEventListener('pagehide', () => destroy());
    }
})();
