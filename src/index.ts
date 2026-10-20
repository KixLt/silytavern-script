import css from './styles.css?inline';

import { computeProgress } from './ai';
import { diffProgress, type Progress } from './schema';
import { mountBar, type Bar, type PendingView, type SavedView } from './ui';
import {
  ENTRY_NAME,
  getPendingMessages,
  loadProgressState,
  saveProgress,
  type ProgressState,
} from './worldbook';

/** 一次同步最多送给 AI 的楼层数, 超出的部分留待下次同步 */
const MAX_PENDING_MESSAGES = 60;
const REFRESH_DEBOUNCE_MS = 300;

type Draft = { progress: Progress; base_snapshot: string; up_to: number };

let state: ProgressState | null = null;
let draft: Draft | null = null;
let bar: Bar | null = null;
let $style: JQuery<HTMLElement> | null = null;
let refresh_timer: ReturnType<typeof setTimeout> | undefined;

function hasChat(): boolean {
  try {
    return !!SillyTavern.getCurrentChatId();
  } catch (error) {
    console.warn('[剧情进度状态栏] 无法获取当前聊天', error);
    return false;
  }
}

async function refreshState(): Promise<ProgressState | null> {
  if (!hasChat()) {
    state = null;
    draft = null;
    bar?.setVisible(false);
    return null;
  }

  state = await loadProgressState();
  bar?.setVisible(true);
  bar?.setPendingCount(getPendingMessages(state.synced_message_id).length);
  return state;
}

async function requireState(): Promise<ProgressState> {
  const current = state ?? (await refreshState());
  if (!current) {
    throw Error('当前没有打开任何聊天');
  }
  return current;
}

async function getSavedView(): Promise<SavedView> {
  const current = await requireState();
  return {
    worldbook_name: current.worldbook_name,
    updated_at: current.updated_at,
    text: current.entry?.content.trim() ?? '',
  };
}

async function getPendingView(): Promise<PendingView> {
  const current = await requireState();
  const pending = getPendingMessages(current.synced_message_id);

  if (pending.length === 0) {
    draft = null;
    return {
      worldbook_name: current.worldbook_name,
      entry_name: ENTRY_NAME,
      count: 0,
      included: 0,
      remaining: 0,
      up_to: current.synced_message_id,
      lines: [],
    };
  }

  const batch = pending.slice(0, MAX_PENDING_MESSAGES);
  const up_to = batch[batch.length - 1].message_id;
  const base_snapshot = JSON.stringify(current.progress);
  if (!draft || draft.up_to !== up_to || draft.base_snapshot !== base_snapshot) {
    const progress = await computeProgress(current.progress, batch);
    draft = { progress, base_snapshot, up_to };
  }

  return {
    worldbook_name: current.worldbook_name,
    entry_name: ENTRY_NAME,
    count: pending.length,
    included: batch.length,
    remaining: pending.length - batch.length,
    up_to,
    lines: diffProgress(current.progress, draft.progress),
  };
}

async function syncProgress(): Promise<void> {
  const current = await requireState();
  if (!draft) {
    throw Error('没有可同步的进度, 请先点击「待同步」查看改动');
  }

  await saveProgress(current, draft.progress, draft.up_to);
  draft = null;
  await refreshState();
}

function injectStyle(): void {
  if ($style && $style.parent().length > 0) {
    return;
  }
  $style = $('<style>').attr('id', 'plot-progress-bar-style').text(css);
  $style.appendTo('head');
}

function ensureMounted(attempt = 0): void {
  if (!bar) {
    bar = mountBar({
      saved: getSavedView,
      pending: getPendingView,
      sync: syncProgress,
    });
  }

  const $anchor = $('#send_form');
  if ($anchor.length === 0) {
    if (attempt < 20) {
      setTimeout(() => errorCatched(ensureMounted)(attempt + 1), 500);
    } else {
      console.warn('[剧情进度状态栏] 找不到 #send_form, 状态栏未挂载');
    }
    return;
  }

  if (bar.$el.parent().length === 0) {
    bar.$el.insertBefore($anchor);
    injectStyle();
  }
}

function scheduleRefresh(): void {
  clearTimeout(refresh_timer);
  refresh_timer = setTimeout(() => errorCatched(refreshState)(), REFRESH_DEBOUNCE_MS);
}

function handleChatChanged(): void {
  draft = null;
  ensureMounted();
  scheduleRefresh();
}

function destroy(listeners: { stop(): void }[]): void {
  listeners.forEach(listener => listener.stop());
  clearTimeout(refresh_timer);
  draft = null;
  state = null;
  bar?.destroy();
  bar = null;
  $style?.remove();
  $style = null;
  $(window).off('pagehide.ppb');
  console.info('[剧情进度状态栏] 已卸载');
}

function init(): void {
  if (typeof getWorldbook !== 'function' || typeof generateRaw !== 'function' || typeof eventOn !== 'function') {
    throw Error('剧情进度状态栏需要酒馆助手 (JS-Slash-Runner) 提供世界书与生成接口, 请更新酒馆助手');
  }

  const listeners = [
    eventOn(tavern_events.MESSAGE_SENT, scheduleRefresh),
    eventOn(tavern_events.MESSAGE_RECEIVED, scheduleRefresh),
    eventOn(tavern_events.MESSAGE_UPDATED, scheduleRefresh),
    eventOn(tavern_events.MESSAGE_DELETED, scheduleRefresh),
    eventOn(tavern_events.CHAT_CHANGED, handleChatChanged),
  ];

  ensureMounted();
  $(window).on('pagehide.ppb', () => destroy(listeners));
  errorCatched(refreshState)();
  console.info('[剧情进度状态栏] 已加载');
}

$(() => {
  errorCatched(init)();
});
