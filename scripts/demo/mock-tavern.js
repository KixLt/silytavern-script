/* 酒馆助手接口的最小替身 —— 让两个真实产物 (dist/*) 在普通浏览器里跑起来.
 *
 * 只实现两个脚本实际调用到的接口:
 *   - 楼层读写: getChatMessages / setChatMessages / getLastMessageId
 *   - 聊天变量: getVariables / insertOrAssignVariables / deleteVariable
 *   - 事件: eventOn / tavern_events (自带一个极简事件总线)
 *   - 其它: SillyTavern / toastr / errorCatched / replaceScriptButtons / getButtonEvent
 *   - ai-monitor 的日志流: __TAURITAVERN__.api.dev.llmApiLogs (subscribeIndex / index / getPreview)
 */
(function () {
    'use strict';

    const CHAT_ID = 'mock-chat';
    const AVATAR = 'mock.png';
    const CHAT_KEY = `${AVATAR}::${CHAT_ID}`;

    // ---------------------------------------------------------------- 楼层
    const messages = [
        {
            message_id: 0,
            name: '赛勒',
            role: 'assistant',
            is_hidden: false,
            message: '雨停在你推门的前一秒。赛勒把最后一盏灯拨亮，抬头看你：“坐吧，今晚没有客人，只有你和我。”',
            extra: {},
        },
        {
            message_id: 1,
            name: '你',
            role: 'user',
            is_hidden: false,
            message: '我把湿透的外套挂在门后，问他：“你一直在等我？”',
            extra: {},
        },
        {
            message_id: 2,
            name: '赛勒',
            role: 'assistant',
            is_hidden: true,
            message: '“等一个愿意在雨里走过来的人。”他把杯子推到你面前，杯壁上的水汽还没散。',
            extra: {},
        },
        {
            message_id: 3,
            name: '你',
            role: 'user',
            is_hidden: false,
            message: '我握住杯子，没喝，先看着他：“如果我不来呢。”',
            extra: {},
        },
        {
            message_id: 4,
            name: '赛勒',
            role: 'assistant',
            is_hidden: true,
            message: '他笑了一下，笑意停在眼睛里：“那我就会把这盏灯留到天亮。”',
            extra: {},
        },
        {
            message_id: 5,
            name: '你',
            role: 'user',
            is_hidden: false,
            message: '窗外的雨敲得很轻。我把椅子往他那边挪了半寸。',
            extra: {},
        },
        {
            message_id: 6,
            name: '赛勒',
            role: 'assistant',
            is_hidden: false,
            message: '他没有退开，只是把灯拨暗了一些：“这样的话，我就当你今晚不走了。”',
            extra: {},
        },
        {
            message_id: 7,
            name: '你',
            role: 'user',
            is_hidden: false,
            message: '“不走。”我听见自己的声音比预想的稳。',
            extra: {},
        },
        {
            message_id: 8,
            name: '赛勒',
            role: 'assistant',
            is_hidden: false,
            message: '他从柜子深处取出一只旧杯子，和你的那只配成一对：“那就用这只——为不留人的夜晚，留一个例外。”',
            extra: {},
        },
        {
            message_id: 9,
            name: '你',
            role: 'user',
            is_hidden: false,
            message: '我接过那只杯子，指腹擦过他手背上的旧疤。',
            extra: {},
        },
        {
            message_id: 10,
            name: '赛勒',
            role: 'assistant',
            is_hidden: false,
            message: '他没有收回手，只低声说：“有些问题，你不问，我也不必答。”',
            extra: {},
        },
    ];

    // ---------------------------------------------------------------- 变量
    // 楼层可见性的定时规则: 6 号 4 轮后隐藏, 8 号 2 轮后可见
    const chatVars = {
        tt_message_visibility: {
            rules: [
                { message_id: 6, action: 'hide', rounds_left: 4 },
                { message_id: 8, action: 'show', rounds_left: 2 },
            ],
            window_rounds: 3,
            version: 1,
        },
    };

    // 界面偏好: 默认展开 (与脚本默认一致)
    try {
        localStorage.setItem(
            'tt-message-visibility:ui',
            JSON.stringify({ filter: 'all', collapsed: false }),
        );
    } catch {
        /* 忽略 */
    }

    // ai-monitor 的历史统计: 预置 3 成功 + 1 失败, 面板一打开就有内容
    const now = Date.now();
    const seededRecords = [
        {
            id: 1042,
            key: 'id:1042',
            ts: now - 214000,
            ok: false,
            source: 'main',
            model: 'claude-sonnet-4.5',
            durationMs: 9300,
            input: null,
            output: null,
            cached: null,
            ttft: null,
            error: '429 Too Many Requests: rate limit exceeded, retry after 20s',
        },
        {
            id: 1041,
            key: 'id:1041',
            ts: now - 168000,
            ok: true,
            source: 'main',
            model: 'claude-sonnet-4.5',
            durationMs: 7420,
            input: 11840,
            output: 486,
            cached: 6912,
            ttft: 760,
            estimated: false,
        },
        {
            id: 1040,
            key: 'id:1040',
            ts: now - 96000,
            ok: true,
            source: 'main',
            model: 'claude-sonnet-4.5',
            durationMs: 6180,
            input: 12410,
            output: 512,
            cached: 8064,
            ttft: 690,
            estimated: false,
        },
        {
            id: 1039,
            key: 'id:1039',
            ts: now - 41000,
            ok: true,
            source: 'main',
            model: 'claude-sonnet-4.5',
            durationMs: 8340,
            input: 13050,
            output: 604,
            cached: 9280,
            ttft: 810,
            estimated: false,
        },
    ];

    // ai-monitor 的面板偏好: 首次打开给一份「展开 + 实时页」的初值, 方便截图复现;
    // 之后不再覆盖, 否则拖动位置这类用户选择会被模拟页抹掉
    try {
        if (!localStorage.getItem('tt-ai-monitor:v2:ui')) {
            localStorage.setItem(
                'tt-ai-monitor:v2:ui',
                JSON.stringify({ collapsed: false, hidden: false, tab: 'live', selectedKey: null }),
            );
        }
    } catch {
        /* 忽略 */
    }

    try {
        localStorage.setItem(
            `tt-ai-monitor:v2:stats:${CHAT_KEY}`,
            JSON.stringify({
                records: seededRecords,
                totals: {
                    requests: 4,
                    ok: 3,
                    failed: 1,
                    input: 37300,
                    output: 1602,
                    cached: 24256,
                    cacheInput: 37300,
                    durationMs: 31240,
                },
            }),
        );
    } catch {
        /* 忽略 */
    }

    // ---------------------------------------------------------------- 事件总线
    const listeners = new Map();

    function eventOn(event, handler) {
        const list = listeners.get(event) ?? [];
        list.push(handler);
        listeners.set(event, list);
        return {
            stop() {
                const current = listeners.get(event) ?? [];
                const index = current.indexOf(handler);
                if (index >= 0) current.splice(index, 1);
            },
        };
    }

    function emit(event, ...args) {
        (listeners.get(event) ?? []).slice().forEach(handler => {
            try {
                handler(...args);
            } catch (error) {
                console.error(`[demo] ${event} 监听器报错`, error);
            }
        });
    }

    // ---------------------------------------------------------------- toastr
    function toast(message, title) {
        const box = document.getElementById('demo-toast');
        const item = document.createElement('div');
        item.textContent = title ? `${title} · ${message}` : String(message ?? '');
        box.appendChild(item);
        setTimeout(() => item.remove(), 2600);
    }

    // ---------------------------------------------------------------- 聊天渲染
    function paint() {
        const inner = document.getElementById('chat-inner');
        inner.innerHTML = '';
        messages.forEach(message => {
            const row = document.createElement('div');
            row.className = `mes${message.is_hidden ? ' is-hidden' : ''}`;
            row.dataset.role = message.role;
            row.dataset.id = String(message.message_id);
            row.innerHTML =
                `<div class="mes-avatar">${message.role === 'user' ? '你' : '赛'}</div>` +
                '<div>' +
                `<div class="mes-head"><span class="mes-name">${message.name}</span>` +
                `<span>#${message.message_id}</span>` +
                `${message.is_hidden ? '<span>· 对 AI 隐藏</span>' : ''}</div>` +
                `<p class="mes-text"></p>` +
                '</div>';
            row.querySelector('.mes-text').textContent = message.message;
            inner.appendChild(row);
        });
        const chat = document.getElementById('chat');
        chat.scrollTop = chat.scrollHeight;
    }

    // ---------------------------------------------------------------- 酒馆接口
    function pick(range) {
        if (typeof range === 'number') {
            return messages.filter(message => message.message_id === range);
        }
        const [from, to] = String(range).split('-').map(Number);
        return messages.filter(
            message => message.message_id >= from && (!Number.isFinite(to) || message.message_id <= to),
        );
    }

    window.getChatMessages = function getChatMessages(range) {
        return pick(range).map(message => ({
            message_id: message.message_id,
            name: message.name,
            role: message.role,
            is_hidden: message.is_hidden,
            message: message.message,
            data: {},
            extra: message.extra ?? {},
        }));
    };

    window.setChatMessages = function setChatMessages(list) {
        (list ?? []).forEach(change => {
            const target = messages.find(message => message.message_id === change.message_id);
            if (!target) return;
            if (typeof change.is_hidden === 'boolean') target.is_hidden = change.is_hidden;
            if (typeof change.message === 'string') target.message = change.message;
        });
        paint();
        return Promise.resolve();
    };

    window.getLastMessageId = () => messages[messages.length - 1].message_id;

    window.getVariables = () => JSON.parse(JSON.stringify(chatVars));
    window.insertOrAssignVariables = variables => {
        Object.assign(chatVars, variables);
        return chatVars;
    };
    window.deleteVariable = path => ({ variables: chatVars, delete_occurred: false });

    window.eventOn = eventOn;
    window.errorCatched = fn => fn;

    window.tavern_events = {
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_UPDATED: 'message_updated',
        MESSAGE_DELETED: 'message_deleted',
        CHAT_CHANGED: 'chat_changed',
        GENERATION_STARTED: 'generation_started',
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended',
    };

    window.SillyTavern = {
        getCurrentChatId: () => CHAT_ID,
        getContext: () => ({
            chatId: CHAT_ID,
            characterId: 0,
            characters: [{ avatar: AVATAR, name: '赛勒' }],
            getTokenCountAsync: text => Promise.resolve(Math.max(1, Math.round(String(text).length / 1.7))),
        }),
    };

    window.toastr = {
        success: message => toast(message, '楼层可见性'),
        info: message => toast(message),
        warning: message => toast(message),
        error: (message, title) => toast(message, title),
    };

    // 脚本按钮: 酒馆助手会把这些名字画成输入框旁的按钮, 这里只记住, 供手动触发
    const scriptButtons = [];
    window.replaceScriptButtons = buttons => {
        scriptButtons.splice(0, scriptButtons.length, ...buttons);
    };
    window.getButtonEvent = name => `button_clicked_${name}`;

    // ai-monitor 的 TauriTavern 日志流: 假装已连接, 由「模拟请求」按钮推数据
    const logSubscribers = [];
    const logEntries = [];

    window.__TAURITAVERN__ = {
        api: {
            dev: {
                llmApiLogs: {
                    subscribeIndex(handler) {
                        logSubscribers.push(handler);
                        return Promise.resolve();
                    },
                    index() {
                        return Promise.resolve(logEntries.slice(-12));
                    },
                    getPreview(id) {
                        const entry = logEntries.find(item => item.id === id);
                        return Promise.resolve({
                            errorMessage: entry?.error ?? '429 Too Many Requests: rate limit exceeded',
                        });
                    },
                },
            },
        },
    };

    // ---------------------------------------------------------------- 模拟请求
    let seq = 2000;

    function simulateRequest({ fail = false } = {}) {
        const ts = Date.now();
        const nextId = window.getLastMessageId() + 1;
        const entry = {
            id: ++seq,
            ok: !fail,
            model: 'claude-sonnet-4.5',
            source: 'main',
            timestampMs: ts,
            durationMs: fail ? 9300 : 5600 + Math.round(Math.random() * 1800),
            stream: true,
            error: fail ? '429 Too Many Requests: rate limit exceeded, retry after 20s' : '',
        };

        emit(window.tavern_events.GENERATION_STARTED, 'normal');

        if (fail) {
            logEntries.push(entry);
            setTimeout(() => {
                logSubscribers.forEach(handler => handler(entry));
            }, 320);
            return;
        }

        setTimeout(() => {
            messages.push({
                message_id: nextId,
                name: '赛勒',
                role: 'assistant',
                is_hidden: false,
                message: '“雨小了。”他把灯芯剪短，屋里只剩两个人的影子，“你明天要走，我也还是会把灯留着。”',
                extra: {
                    prompt_cache: { input_tokens: 13050, cached_tokens: 9280 },
                    token_count: 528,
                    time_to_first_token: 740,
                },
            });
            paint();
            logEntries.push(entry);
            logSubscribers.forEach(handler => handler(entry));
            setTimeout(() => emit(window.tavern_events.MESSAGE_RECEIVED, nextId, 'normal'), 50);
        }, 320);
    }

    // ---------------------------------------------------------------- 交互
    document.getElementById('demo-send').addEventListener('click', () => {
        const input = document.getElementById('send_textarea');
        const text = input.value.trim() || '我把杯子举起来，和他碰了一下。';
        input.value = '';
        messages.push({
            message_id: window.getLastMessageId() + 1,
            name: '你',
            role: 'user',
            is_hidden: false,
            message: text,
            extra: {},
        });
        paint();
        emit(window.tavern_events.MESSAGE_SENT, messages[messages.length - 1].message_id);
        simulateRequest();
    });

    document.getElementById('demo-request').addEventListener('click', () => simulateRequest());

    // 页面脚本按钮 (酒馆助手把它们画在输入框旁): 这里用键盘 F2 / F3 触发
    document.addEventListener('keydown', event => {
        const name = event.key === 'F2' ? '显示/隐藏面板' : event.key === 'F3' ? '清空统计' : null;
        if (!name) return;
        event.preventDefault();
        if (scriptButtons.some(button => button.name === name)) emit(window.getButtonEvent(name));
    });

    paint();
    // 打开页面就让监控面板收到一次真实数据, 截图时两栏都有内容
    setTimeout(() => simulateRequest(), 500);
})();
