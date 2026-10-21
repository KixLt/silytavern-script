import { parseProgress, type DiffLine, type Progress } from './schema';

export type SavedView = {
  worldbook_name: string;
  updated_at: string | null;
  text: string;
};

export type PendingView = {
  worldbook_name: string;
  entry_name: string;
  /** 待同步楼层总数 */
  count: number;
  /** 本次纳入 AI 计算的楼层数 */
  included: number;
  /** 本次未纳入、留待下次的楼层数 */
  remaining: number;
  /** 本次同步后应标记为已同步的最末楼层号 */
  up_to: number;
  lines: DiffLine[];
};

export type BarHandlers = {
  saved(): Promise<SavedView>;
  pending(): Promise<PendingView>;
  sync(): Promise<void>;
};

export type Bar = {
  $el: JQuery<HTMLElement>;
  setPendingCount(count: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
};

type Action = 'saved' | 'pending' | 'sync';

/**
 * 图标都在 24 网格上手画, 线宽 1.6, 方头方角 —— 一套几何语言, 不做圆头圆角混搭。
 * saved: 档案册 (书脊 + 目录线) / pending: 折角待归档页 / sync: 回转箭头。
 */
const ICONS: Record<Action, string> = {
  saved: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="3.5" width="15" height="17" rx="1.6"/><path d="M8.6 3.5v17"/><path d="M11.6 8h5M11.6 11.5h5"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3.6H6.6A1.6 1.6 0 0 0 5 5.2v13.6a1.6 1.6 0 0 0 1.6 1.6h10.8a1.6 1.6 0 0 0 1.6-1.6V8.6z"/><path d="M14 3.6v5h5"/><path d="M8.4 13h7.2M8.4 16.4h4.6"/></svg>`,
  sync: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19.9 13.2A8 8 0 0 1 6.6 18.6"/><path d="M4.1 10.8A8 8 0 0 1 17.4 5.4"/><path d="M17.6 2.6v3.6h-3.6"/><path d="M6.4 21.4v-3.6h3.6"/></svg>`,
};

/** 错误态也要和状态栏同一套几何语言: 圆 + 竖线, 不用 ASCII 感叹号 */
const ALERT_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6v5.2M12 16.4v.1"/></svg>`;

const BAR_MARKUP = `
<div class="ppb-bar" role="toolbar" aria-label="剧情进度状态栏">
  <button type="button" class="ppb-saved" data-action="saved" title="查看已保存的剧情进度">
    <span class="ppb-icon">${ICONS.saved}</span>
    <span>剧情进度</span>
  </button>
  <button type="button" class="ppb-pending" data-action="pending" data-count="0" title="查看待同步的剧情进度">
    <span class="ppb-icon">${ICONS.pending}</span>
    <span>待同步</span>
    <span class="ppb-badge" hidden>0</span>
  </button>
  <button type="button" class="ppb-sync" data-action="sync" title="让 AI 把剧情进度同步到世界书" aria-label="让 AI 把剧情进度同步到世界书">
    <span class="ppb-icon">${ICONS.sync}</span>
  </button>
  <div class="ppb-popover" role="dialog" aria-live="polite" hidden></div>
</div>`;

type Row = {
  kind: DiffLine['kind'] | 'value';
  text: string;
  from?: string;
  to?: string;
  name?: string;
};

type Group = { label: string; rows: Row[] };

const MARKS: Record<Row['kind'], string> = { add: '+', change: '', remove: '−', value: '' };
const MARKS_SR: Record<Row['kind'], string> = {
  add: '新增：',
  change: '改动：',
  remove: '移除：',
  value: '',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  // 档案的戳只需要精确到分钟, 完整时间戳太长, 会和标题抢注意力
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function rowHtml(row: Row): string {
  const mark = MARKS[row.kind];
  const sr = MARKS_SR[row.kind];
  const name = row.name ? `<span class="ppb-name">${escapeHtml(row.name)}</span>` : '';
  // 改动行把新旧值分开排版: 旧值退后当参照, 新值是主角
  const text =
    row.kind === 'change' && row.from !== undefined && row.to !== undefined
      ? `<span class="ppb-from">${escapeHtml(row.from)}</span><span class="ppb-arrow">→</span><span class="ppb-to">${escapeHtml(row.to)}</span>`
      : escapeHtml(row.text);
  const sr_only = sr ? `<span class="ppb-sr">${sr}</span>` : '';
  return (
    `<li class="ppb-row ppb-row-${row.kind}">` +
    (row.kind === 'value' ? '' : `<span class="ppb-mark" aria-hidden="true">${mark}</span>`) +
    `<span class="ppb-text">${sr_only}${name}${text}</span>` +
    `</li>`
  );
}

function groupHtml(group: Group): string {
  return (
    `<section class="ppb-group">` +
    `<h4 class="ppb-group-title">${escapeHtml(group.label)}</h4>` +
    `<ul class="ppb-list">${group.rows.map(rowHtml).join('')}</ul>` +
    `</section>`
  );
}

/** 同一字段的行归成一组: 标签只写一次, 同类信息放在一起, 方便扫读。 */
function groupDiffLines(lines: DiffLine[]): Group[] {
  const groups: Group[] = [];
  const by_label = new Map<string, Group>();
  for (const line of lines) {
    let group = by_label.get(line.label);
    if (!group) {
      group = { label: line.label, rows: [] };
      by_label.set(line.label, group);
      groups.push(group);
    }
    group.rows.push({ kind: line.kind, text: line.text, from: line.from, to: line.to, name: line.name });
  }
  return groups;
}

/** 已保存的进度: 同样的分组排版, 但都是"值"而不是改动; 空字段直接不出现。 */
function groupSavedProgress(progress: Progress): Group[] {
  const groups: Group[] = [];
  const scalar = (label: string, value: string) => {
    const text = value.trim();
    if (text) {
      groups.push({ label, rows: [{ kind: 'value', text }] });
    }
  };
  scalar('时间', progress.时间);
  scalar('地点', progress.地点);
  scalar('当前目标', progress.当前目标);

  const list = (label: string, values: string[]) => {
    const rows = values.map(text => text.trim()).filter(Boolean).map(text => ({ kind: 'value' as const, text }));
    if (rows.length) {
      groups.push({ label, rows });
    }
  };
  list('关键事件', progress.关键事件);
  const people = Object.entries(progress.人物)
    .map(([name, text]) => ({ kind: 'value' as const, text: text.trim(), name }))
    .filter(row => row.text);
  if (people.length) {
    groups.push({ label: '人物', rows: people });
  }
  list('未解伏笔', progress.未解伏笔);
  // 人物比事件短、比伏笔重要, 先按时间/地点/目标/人物排列, 长列表放后面
  const order = ['时间', '地点', '当前目标', '人物', '关键事件', '未解伏笔'];
  return groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

function loadingHtml(text: string): string {
  return `<div class="ppb-loading"><span class="ppb-spinner"></span><span>${escapeHtml(text)}</span></div>`;
}

function emptyHtml(text: string): string {
  return `<div class="ppb-empty">${escapeHtml(text)}</div>`;
}

function errorHtml(error: unknown): string {
  return (
    `<div class="ppb-error">` +
    `<span class="ppb-icon ppb-error-icon">${ALERT_ICON}</span>` +
    `<span>${escapeHtml(errorMessage(error))}</span>` +
    `</div>`
  );
}

type PopoverContent = {
  title?: string;
  meta?: string;
  body: string;
  /** 固定在底部、不随内容滚动的说明 (要写入哪里、还剩多少条) */
  note?: string;
  actions?: string;
};

export function mountBar(handlers: BarHandlers): Bar {
  const $el = $(BAR_MARKUP);
  const page_document = $el[0].ownerDocument;
  const page_window = page_document.defaultView ?? window;
  const $popover = $el.find('.ppb-popover').appendTo(page_document.body);
  const $badge = $el.find('.ppb-badge');
  const $pending = $el.find('[data-action="pending"]');
  let busy = false;
  let active_action: Action | null = null;
  /** 弹窗里是错误时, 再点同一个按钮应当是重试, 而不是收起 */
  let failed_action: Action | null = null;

  const setBusy = (next: boolean, action: Action | null = active_action) => {
    busy = next;
    $el.find('.ppb-icon').removeClass('ppb-spin');
    if (next) {
      $el.attr('data-busy', action ?? '');
      if (action) {
        $el.find(`[data-action="${action}"] .ppb-icon`).addClass('ppb-spin');
      }
    } else {
      $el.removeAttr('data-busy');
    }
    $el.find('button').prop('disabled', next);
  };

  const hidePopover = () => {
    active_action = null;
    failed_action = null;
    $popover.prop('hidden', true).empty();
  };

  /**
   * 把弹窗贴到状态栏上方；上方空间不够时改放下方。
   *
   * 只能用 `top` 定位：SillyTavern 的 <body> 是 position: fixed，使它脱离文档流把 <html>
   * 撑成 0 高，而 <html> 上带 `transform` 又会成为 fixed 元素的包含块。用 `bottom` 定位时
   * 参照的是那个 0 高的包含块，弹窗会整块飞到视口上方看不见（用 `top` 时包含块左上角
   * 仍与视口原点重合，所以算出来的位置是对的）。同理必须先渲染内容再量高度。
   */
  const positionPopover = () => {
    const rect = $el[0].getBoundingClientRect();
    const gap = 8;
    const viewport_width = page_window.innerWidth;
    const viewport_height = page_window.innerHeight;
    // 一行长的 diff 会难看, 弹窗宽度不跟着状态栏无限拉长
    const width = Math.min(Math.max(rect.width, 240), 560, viewport_width - 16);
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, viewport_width - width - 8));
    const space_above = rect.top - gap * 2;
    const space_below = viewport_height - rect.bottom - gap * 2;
    const place_above = space_above >= 160 || space_above >= space_below;
    const max_height = Math.max(120, Math.min(place_above ? space_above : space_below, viewport_height * 0.6));

    $popover.css({ left: `${left}px`, width: `${width}px`, maxHeight: `${max_height}px` });

    const height = $popover[0].getBoundingClientRect().height;
    const top = place_above ? rect.top - gap - height : rect.bottom + gap;
    const clamped_top = Math.max(gap, Math.min(top, Math.max(gap, viewport_height - gap - height)));
    $popover.css({ top: `${clamped_top}px` });
  };

  const showPopover = (content: PopoverContent) => {
    const head =
      content.title === undefined
        ? ''
        : `<div class="ppb-head"><div class="ppb-title">${escapeHtml(content.title)}</div>` +
          (content.meta ? `<div class="ppb-meta">${escapeHtml(content.meta)}</div>` : '') +
          `</div>`;
    const note = content.note ? `<p class="ppb-note">${content.note}</p>` : '';
    const actions = content.actions ? `<div class="ppb-actions">${content.actions}</div>` : '';
    const foot = note || actions ? `<div class="ppb-foot">${note}${actions}</div>` : '';
    $popover.html(`${head}<div class="ppb-body">${content.body}</div>${foot}`).prop('hidden', false);
    // 滚到底部时去掉渐隐, 否则最后一行永远是半透明的
    const $body = $popover.find('.ppb-body');
    const syncFade = () => {
      const el = $body[0];
      const at_end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      $body.toggleClass('ppb-body-end', at_end);
    };
    $body.on('scroll', syncFade);
    syncFade();
    positionPopover();
  };

  const showFailure = (title: string, error: unknown, retry: () => void) => {
    failed_action = active_action;
    showPopover({
      title,
      body: errorHtml(error),
      actions: `<button type="button" class="ppb-cancel" data-role="retry">重试</button>`,
    });
    $popover.find('[data-role="retry"]').on('click', () => {
      failed_action = null;
      void retry();
    });
  };

  const remainingText = (view: PendingView) =>
    view.remaining > 0 ? `本次只处理最早 ${view.included} 条，剩余 ${view.remaining} 条留待下次。` : '';

  const remainingNote = (view: PendingView) =>
    view.remaining > 0 ? `共 ${view.count} 条待同步。${remainingText(view)}` : undefined;

  const openSaved = async () => {
    if (busy) {
      return;
    }
    setBusy(true, 'saved');
    showPopover({ title: '已保存的剧情进度', body: loadingHtml('正在读取…') });
    try {
      const view = await handlers.saved();
      const groups = groupSavedProgress(parseProgress(view.text));
      const meta = [view.worldbook_name, view.updated_at ? formatTime(view.updated_at) : '']
        .filter(Boolean)
        .join(' · ');
      let body: string;
      if (groups.length > 0) {
        body = groups.map(groupHtml).join('');
      } else if (view.text.trim()) {
        // 解析不出结构时退回原文, 至少让用户看到世界里到底写了什么
        body = `<pre class="ppb-pre">${escapeHtml(view.text.trim())}</pre>`;
      } else {
        body = emptyHtml('世界书条目里还没有记录剧情进度。');
      }
      showPopover({ title: '已保存的剧情进度', meta, body });
    } catch (error) {
      showFailure('已保存的剧情进度', error, openSaved);
    } finally {
      setBusy(false);
    }
  };

  const openPending = async () => {
    if (busy) {
      return;
    }
    setBusy(true, 'pending');
    showPopover({ title: '待同步的改动', body: loadingHtml('正在让 AI 计算待同步的改动…') });
    try {
      const view = await handlers.pending();
      if (view.count === 0) {
        showPopover({ title: '待同步的改动', meta: '已全部同步', body: emptyHtml('没有待同步的楼层。') });
      } else if (view.lines.length === 0) {
        showPopover({
          title: '待同步的改动',
          meta: `${view.count} 条待同步`,
          body: emptyHtml('AI 认为这段对话没有产生需要记录的剧情进度。'),
        });
      } else {
        showPopover({
          title: '待同步的改动',
          meta: `${view.count} 条待同步`,
          body: groupDiffLines(view.lines).map(groupHtml).join(''),
          note: remainingNote(view),
        });
      }
    } catch (error) {
      showFailure('待同步的改动', error, openPending);
    } finally {
      setBusy(false);
    }
  };

  const openSyncConfirm = async () => {
    if (busy) {
      return;
    }
    setBusy(true, 'sync');
    showPopover({ title: '确认同步剧情进度', body: loadingHtml('正在准备同步…') });

    let view: PendingView;
    try {
      view = await handlers.pending();
    } catch (error) {
      showFailure('确认同步剧情进度', error, openSyncConfirm);
      setBusy(false);
      return;
    }
    setBusy(false);

    if (view.count === 0) {
      showPopover({ title: '同步剧情进度', meta: '已全部同步', body: emptyHtml('没有待同步的楼层。') });
      return;
    }
    if (view.lines.length === 0) {
      showPopover({
        title: '同步剧情进度',
        meta: `${view.count} 条待同步`,
        body: emptyHtml('这段对话没有产生需要记录的剧情进度。'),
      });
      return;
    }

    showPopover({
      title: '确认同步剧情进度',
      meta: `${view.count} 条待同步`,
      body: groupDiffLines(view.lines).map(groupHtml).join(''),
      note: `写入世界书「${escapeHtml(view.worldbook_name)}」中的条目「${escapeHtml(view.entry_name)}」，并把第 ${view.up_to} 楼及之前标记为已同步。${remainingText(view)}`,
      actions:
        `<button type="button" class="ppb-cancel" data-role="cancel">取消</button>` +
        `<button type="button" class="ppb-confirm" data-role="confirm">确认同步</button>`,
    });

    $popover.find('[data-role="cancel"]').on('click', hidePopover);
    $popover.find('[data-role="confirm"]').on('click', async () => {
      setBusy(true, 'sync');
      showPopover({ title: '确认同步剧情进度', body: loadingHtml('正在合并剧情进度并写入世界书…') });
      try {
        await handlers.sync();
        hidePopover();
        toastr.success('剧情进度已同步到世界书');
      } catch (error) {
        showFailure('同步失败', error, openSyncConfirm);
      } finally {
        setBusy(false);
      }
    });
  };

  const toggle = (action: Action, open: () => Promise<void>) => {
    if (active_action === action && failed_action !== action) {
      hidePopover();
      return;
    }
    active_action = action;
    failed_action = null;
    void open();
  };

  $el.find('[data-action="saved"]').on('click', () => toggle('saved', openSaved));
  $el.find('[data-action="pending"]').on('click', () => toggle('pending', openPending));
  $el.find('[data-action="sync"]').on('click', () => toggle('sync', openSyncConfirm));

  $(page_document).on('pointerdown.ppbBar', event => {
    const target = event.target as Node | null;
    if (!target || $el[0].contains(target) || $popover[0].contains(target)) {
      return;
    }
    hidePopover();
  });

  $(page_window).on('resize.ppbBar', () => {
    if (!$popover.prop('hidden')) {
      positionPopover();
    }
  });

  // 页面滚动会让按视口算出来的位置失效
  $(page_window).on('scroll.ppbBar', () => {
    if (!$popover.prop('hidden')) {
      positionPopover();
    }
  });

  $(page_document).on('keydown.ppbBar', event => {
    if (event.key === 'Escape') {
      hidePopover();
    }
  });

  // 手机上点输入框时收起弹窗, 避免挡住聊天或与键盘叠加
  $(page_document).on('focusin.ppbBar', 'textarea, input', event => {
    const target = event.target as Element | null;
    if (!target || !$(target).closest('.ppb-bar').length) {
      hidePopover();
    }
  });

  return {
    $el,
    setPendingCount(count: number) {
      $pending.attr('data-count', String(count));
      $badge.text(String(count)).prop('hidden', count <= 0);
      $pending.attr('aria-label', count > 0 ? `待同步 ${count} 条, 查看改动` : '待同步, 已全部同步');
    },
    setVisible(visible: boolean) {
      $el.toggle(visible);
      if (!visible) {
        hidePopover();
      }
    },
    destroy() {
      $(page_document).off('.ppbBar');
      $(page_window).off('.ppbBar');
      $popover.remove();
      $el.remove();
    },
  };
}
