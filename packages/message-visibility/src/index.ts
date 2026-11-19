import css from './styles.css?inline';

import {
  DEFAULT_UI_PREFS,
  EMPTY_STORED,
  STORAGE_KEY,
  clampRounds,
  parseStored,
  parseUiPrefs,
  planAll,
  planWindow,
  staleRuleIds,
  tickRules,
  upsertRule,
  type Floor,
  type Rule,
  type RuleAction,
  type Stored,
  type UiPrefs,
  type Visibility,
} from './state';
import { mountBar, type Bar, type BarSnapshot } from './ui';

/** 楼层变动很密集 (流式、批量隐藏), 统一防抖后再读一遍聊天 */
const REFRESH_DEBOUNCE_MS = 300;
/** 摘要只保留开头一段: 列表里已经不显示正文, 它只用于悬停提示 */
const EXCERPT_LENGTH = 80;
/** 界面偏好 (筛选、展开状态) 跟人不跟聊天, 存在本地 */
const UI_KEY = 'tt-message-visibility:ui';
/** 输入框上方的共享状态栏行: 本脚本与 ai-monitor 各挂一张卡片, 各占一半宽度 */
const ROW_ID = 'tavern-status-row';

const page_document = window.parent?.document ?? document;
const page_window = page_document.defaultView ?? window;

let floors: Floor[] = [];
let stored: Stored = { ...EMPTY_STORED, rules: [] };
let prefs: UiPrefs = { ...DEFAULT_UI_PREFS };
let bar: Bar | null = null;
let style_el: HTMLStyleElement | null = null;
let refresh_timer: ReturnType<typeof setTimeout> | undefined;
let mount_timer: ReturnType<typeof setTimeout> | undefined;
let applying = false;

function hasChat(): boolean {
  try {
    return !!SillyTavern.getCurrentChatId();
  } catch (error) {
    console.warn('[楼层可见性] 无法获取当前聊天', error);
    return false;
  }
}

/** 聊天消息里可能带 HTML, 摘要只取纯文本开头 */
function excerptOf(message: string): string {
  const text = String(message ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

function readFloors(): Floor[] {
  try {
    const last = getLastMessageId();
    if (!Number.isInteger(last) || last < 0) {
      return [];
    }
    return getChatMessages(`0-${last}`).map(message => ({
      message_id: message.message_id,
      role: message.role,
      name: message.name,
      is_hidden: Boolean(message.is_hidden),
      excerpt: excerptOf(message.message),
    }));
  } catch (error) {
    console.warn('[楼层可见性] 读取楼层失败', error);
    return [];
  }
}

function loadStored(): Stored {
  try {
    const variables = getVariables({ type: 'chat' });
    return parseStored(variables?.[STORAGE_KEY]);
  } catch (error) {
    console.warn('[楼层可见性] 读取规则失败', error);
    return { ...EMPTY_STORED, rules: [] };
  }
}

function saveStored(next: Stored): void {
  stored = next;
  try {
    insertOrAssignVariables({ [STORAGE_KEY]: next }, { type: 'chat' });
  } catch (error) {
    console.warn('[楼层可见性] 保存规则失败', error);
    toastr.error('规则保存失败，请检查酒馆助手版本', '楼层可见性');
  }
}

/** 把内存状态与真实聊天对齐, 顺手清掉指向已删除楼层的规则 */
function syncFromChat(): void {
  floors = readFloors();
  const stale = staleRuleIds(stored.rules, floors);
  if (stale.length > 0) {
    const dropped = new Set(stale);
    saveStored({ ...stored, rules: stored.rules.filter(rule => !dropped.has(rule.message_id)) });
  }
}

async function applyVisibility(changes: Visibility[]): Promise<void> {
  const payload = changes.filter(change => {
    const floor = floors.find(item => item.message_id === change.message_id);
    // 系统楼层与已经一致的楼层不发请求, 少一次重渲染
    return floor && floor.role !== 'system' && floor.is_hidden !== change.hidden;
  });

  if (payload.length === 0) {
    return;
  }

  applying = true;
  try {
    await setChatMessages(
      payload.map(change => ({ message_id: change.message_id, is_hidden: change.hidden })),
      { refresh: 'affected' },
    );
  } finally {
    // 重渲染还在进行, 稍后再放开事件, 避免自己触发刷新风暴
    setTimeout(() => {
      applying = false;
    }, 300);
  }

  syncFromChat();
  bar?.refresh();
}

function snapshot(): BarSnapshot {
  return { floors, rules: stored.rules, window_rounds: stored.window_rounds, prefs };
}

function loadPrefs(): UiPrefs {
  try {
    return parseUiPrefs(JSON.parse(page_window.localStorage.getItem(UI_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

function savePrefs(next: UiPrefs): void {
  prefs = next;
  try {
    page_window.localStorage.setItem(UI_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式或配额不足时只影响记忆, 不影响功能 */
  }
}

/** 一轮 = 一次 AI 回复: 定时规则在这里倒数 */
async function advanceRounds(): Promise<void> {
  if (stored.rules.length === 0) {
    scheduleRefresh();
    return;
  }

  syncFromChat();
  if (stored.rules.length === 0) {
    bar?.refresh();
    return;
  }

  const { fired, remaining } = tickRules(stored.rules);
  saveStored({ ...stored, rules: remaining });

  if (fired.length > 0) {
    await applyVisibility(
      fired.map((rule: Rule) => ({ message_id: rule.message_id, hidden: rule.action === 'hide' })),
    );
  }
  bar?.refresh();
}

function scheduleRefresh(): void {
  if (applying) {
    return;
  }
  clearTimeout(refresh_timer);
  refresh_timer = setTimeout(() => {
    syncFromChat();
    bar?.refresh();
  }, REFRESH_DEBOUNCE_MS);
}

function injectStyle(): void {
  if (style_el && style_el.isConnected) {
    return;
  }
  style_el = page_document.createElement('style');
  style_el.id = 'message-visibility-style';
  style_el.textContent = css;
  page_document.head.appendChild(style_el);
}

/**
 * 输入框上方的状态栏行: 谁的脚本先跑谁建, 后来的直接复用.
 * 行用 flex 把子元素压成等分, 所以只有本脚本时卡片独占整行,
 * ai-monitor 也在时两者各占一半.
 */
function ensureRow(): HTMLElement | null {
  const existing = page_document.getElementById(ROW_ID);
  if (existing?.isConnected) {
    return existing;
  }
  existing?.remove();

  const anchor = page_document.getElementById('send_form');
  if (!anchor?.parentElement) {
    return null;
  }
  const row = page_document.createElement('div');
  row.id = ROW_ID;
  anchor.parentElement.insertBefore(row, anchor);
  return row;
}

function ensureMounted(attempt = 0): void {
  if (!bar) {
    bar = mountBar({
      snapshot,
      async toggle(message_id, hidden) {
        await applyVisibility([{ message_id, hidden }]);
      },
      async bulk(hidden) {
        await applyVisibility(planAll(floors, hidden));
        toastr.success(hidden ? '已对 AI 隐藏全部楼层' : '已恢复全部楼层可见', '楼层可见性');
      },
      async window(rounds) {
        const wanted = clampRounds(rounds);
        saveStored({ ...stored, window_rounds: wanted });
        await applyVisibility(planWindow(floors, wanted));
        toastr.success(`只保留最近 ${wanted} 轮对话可见`, '楼层可见性');
      },
      async schedule(message_id, action: RuleAction | null, rounds) {
        const removed = action === null;
        const next = removed
          ? upsertRule(stored.rules, message_id, 'hide', 0)
          : upsertRule(stored.rules, message_id, action, rounds);
        saveStored({ ...stored, rules: next });
      },
      async clearRules() {
        saveStored({ ...stored, rules: [] });
      },
      setPrefs(patch) {
        savePrefs({ ...prefs, ...patch });
        bar?.refresh();
      },
    });
  }

  const row = ensureRow();
  if (!row) {
    if (attempt < 20) {
      setTimeout(() => errorCatched(ensureMounted)(attempt + 1), 500);
    } else {
      console.warn('[楼层可见性] 找不到 #send_form, 状态栏未挂载');
    }
    return;
  }

  // 页面重建 (换聊天 / 视口变化) 后卡片会掉出文档, 这里按需重新挂上
  if (!bar.el.isConnected || bar.el.parentElement !== row) {
    row.appendChild(bar.el);
  }
  injectStyle();
}

function handleChatChanged(): void {
  stored = loadStored();
  syncFromChat();
  ensureMounted();
  bar?.setVisible(hasChat());
  bar?.refresh();
}
/** 屏幕旋转、软键盘收起或移动端重排后, 输入区可能被重建 */
function handleViewportChange(): void {
  clearTimeout(mount_timer);
  mount_timer = setTimeout(() => errorCatched(ensureMounted)(), 250);
}

function destroy(listeners: { stop(): void }[]): void {
  listeners.forEach(listener => listener.stop());
  clearTimeout(refresh_timer);
  clearTimeout(mount_timer);
  bar?.destroy();
  bar = null;
  style_el?.remove();
  style_el = null;
  page_window.removeEventListener('resize', handleViewportChange);
  page_window.removeEventListener('orientationchange', handleViewportChange);
  console.info('[楼层可见性] 已卸载');
}

function init(): void {
  if (typeof getChatMessages !== 'function' || typeof setChatMessages !== 'function' || typeof eventOn !== 'function') {
    throw Error('楼层可见性需要酒馆助手 (JS-Slash-Runner) 提供楼层读写接口, 请更新酒馆助手');
  }

  stored = loadStored();
  prefs = loadPrefs();
  syncFromChat();

  const listeners = [
    eventOn(tavern_events.MESSAGE_SENT, scheduleRefresh),
    eventOn(tavern_events.MESSAGE_RECEIVED, (_message_id: number, type: string) => {
      // 隐式生成 (quiet) 不写进聊天, 不算一轮
      if (type === 'quiet' || type === 'impersonate') {
        scheduleRefresh();
        return;
      }
      // 等这条回复真正落进聊天再倒数
      setTimeout(() => errorCatched(advanceRounds)(), 0);
    }),
    eventOn(tavern_events.MESSAGE_UPDATED, scheduleRefresh),
    eventOn(tavern_events.MESSAGE_DELETED, scheduleRefresh),
    eventOn(tavern_events.CHAT_CHANGED, handleChatChanged),
  ];

  ensureMounted();
  bar?.setVisible(hasChat());
  bar?.refresh();

  page_window.addEventListener('resize', handleViewportChange);
  page_window.addEventListener('orientationchange', handleViewportChange);
  page_window.addEventListener('pagehide', () => destroy(listeners), { once: true });
  console.info('[楼层可见性] 已加载');
}

if (typeof window.parent !== 'undefined' && window.parent !== window) {
  // 脚本 iframe 内的常规入口
  setTimeout(() => errorCatched(init)(), 0);
} else {
  errorCatched(init)();
}
