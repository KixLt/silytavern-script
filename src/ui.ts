import type { DiffLine } from './schema';

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

const ICONS = {
  saved: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5V5.5"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
  sync: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5V11h-6.5"/></svg>`,
};

const BAR_MARKUP = `
<div class="ppb-bar" role="toolbar" aria-label="剧情进度状态栏">
  <button type="button" class="ppb-left" data-action="saved" title="查看已保存的剧情进度" aria-label="查看已保存的剧情进度">
    <span class="ppb-icon">${ICONS.saved}</span>
    <span>剧情进度</span>
  </button>
  <button type="button" class="ppb-center" data-action="pending" title="查看待同步的剧情进度" aria-label="查看待同步的剧情进度">
    <span class="ppb-icon">${ICONS.pending}</span>
    <span>待同步</span>
    <span class="ppb-badge" hidden>0</span>
  </button>
  <button type="button" class="ppb-right" data-action="sync" title="让 AI 同步剧情进度到世界书" aria-label="让 AI 同步剧情进度到世界书">
    <span class="ppb-icon">${ICONS.sync}</span>
  </button>
  <div class="ppb-popover" role="dialog" aria-live="polite" hidden></div>
</div>`;

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
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function loadingHtml(text: string): string {
  return `<div class="ppb-loading"><span class="ppb-spinner"></span><span>${escapeHtml(text)}</span></div>`;
}

function emptyHtml(text: string): string {
  return `<div class="ppb-empty">${escapeHtml(text)}</div>`;
}

function errorHtml(error: unknown): string {
  return `<div class="ppb-error">${escapeHtml(errorMessage(error))}</div>`;
}

function diffHtml(lines: DiffLine[]): string {
  const items = lines
    .map(
      line =>
        `<li class="ppb-${line.kind}"><span class="ppb-tag">${escapeHtml(line.label)}</span>${escapeHtml(line.text)}</li>`,
    )
    .join('');
  return `<ul class="ppb-diff">${items}</ul>`;
}

export function mountBar(handlers: BarHandlers): Bar {
  const $el = $(BAR_MARKUP);
  const page_document = $el[0].ownerDocument;
  const page_window = page_document.defaultView ?? window;
  const $popover = $el.find('.ppb-popover').appendTo(page_document.body);
  const $badge = $el.find('.ppb-badge');
  let busy = false;
  let active_action: 'saved' | 'pending' | 'sync' | null = null;

  const setBusy = (next: boolean) => {
    busy = next;
    $el.toggleClass('ppb-busy', next);
    $el.find('button').prop('disabled', next);
  };

  const hidePopover = () => {
    active_action = null;
    $popover.prop('hidden', true).empty();
  };

  const positionPopover = () => {
    const rect = $el[0].getBoundingClientRect();
    const gap = 8;
    const viewport_width = page_window.innerWidth;
    const viewport_height = page_window.innerHeight;
    const width = Math.min(Math.max(rect.width, 240), viewport_width - 16);
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, viewport_width - width - 8));
    const max_height = Math.max(120, Math.min(rect.top - gap * 2, viewport_height * 0.6));

    $popover.css({
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${max_height}px`,
      bottom: `${viewport_height - rect.top + gap}px`,
    });
  };

  const showPopover = (html: string) => {
    positionPopover();
    $popover.html(html).prop('hidden', false);
  };

  const openSaved = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    showPopover(loadingHtml('正在读取已保存的剧情进度…'));
    try {
      const view = await handlers.saved();
      const body = view.text || '（世界书条目中还没有保存的进度）';
      const meta = [view.worldbook_name, view.updated_at ? formatTime(view.updated_at) : '']
        .filter(Boolean)
        .map(escapeHtml)
        .join(' · ');
      showPopover(
        `<div class="ppb-head"><span>已保存的剧情进度</span><span class="ppb-meta">${meta}</span></div>` +
          `<pre class="ppb-pre">${escapeHtml(body)}</pre>`,
      );
    } catch (error) {
      showPopover(errorHtml(error));
    } finally {
      setBusy(false);
    }
  };

  const openPending = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    showPopover(loadingHtml('正在让 AI 计算待同步的改动…'));
    try {
      const view = await handlers.pending();
      if (view.count === 0) {
        showPopover(emptyHtml('没有待同步的楼层。'));
      } else if (view.lines.length === 0) {
        showPopover(
          `<div class="ppb-head"><span>待同步 ${view.count} 条</span></div>` +
            emptyHtml('AI 认为这段对话没有产生需要记录的剧情进度。'),
        );
      } else {
        const remaining =
          view.remaining > 0
            ? `<div class="ppb-note">共 ${view.count} 条待同步, 本次只处理前 ${view.included} 条, 剩余 ${view.remaining} 条留待下次。</div>`
            : '';
        showPopover(
          `<div class="ppb-head"><span>待同步的改动</span><span class="ppb-meta">${view.count} 条楼层</span></div>` +
            diffHtml(view.lines) +
            remaining,
        );
      }
    } catch (error) {
      showPopover(errorHtml(error));
    } finally {
      setBusy(false);
    }
  };

  const openSyncConfirm = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    showPopover(loadingHtml('正在准备同步…'));

    let view: PendingView;
    try {
      view = await handlers.pending();
    } catch (error) {
      showPopover(errorHtml(error));
      setBusy(false);
      return;
    }
    setBusy(false);

    if (view.count === 0) {
      showPopover(emptyHtml('没有待同步的楼层。'));
      return;
    }
    if (view.lines.length === 0) {
      showPopover(emptyHtml('这段对话没有产生需要记录的剧情进度。'));
      return;
    }

    const remaining =
      view.remaining > 0 ? ` 本次只处理前 ${view.included} 条, 剩余 ${view.remaining} 条留待下次。` : '';
    showPopover(
      `<div class="ppb-head"><span>确认同步剧情进度</span></div>` +
        diffHtml(view.lines) +
        `<div class="ppb-note">将写入世界书「${escapeHtml(view.worldbook_name)}」中的条目「${escapeHtml(view.entry_name)}」, 并把第 ${view.up_to} 楼及之前标记为已同步。${remaining}</div>` +
        `<div class="ppb-actions"><button type="button" data-role="cancel">取消</button><button type="button" class="ppb-confirm" data-role="confirm">确认同步</button></div>`,
    );

    $popover.find('[data-role="cancel"]').on('click', hidePopover);
    $popover.find('[data-role="confirm"]').on('click', async () => {
      setBusy(true);
      showPopover(loadingHtml('正在合并剧情进度并写入世界书…'));
      try {
        await handlers.sync();
        hidePopover();
        toastr.success('剧情进度已同步到世界书');
      } catch (error) {
        showPopover(errorHtml(error));
      } finally {
        setBusy(false);
      }
    });
  };

  const toggle = (action: 'saved' | 'pending' | 'sync', open: () => Promise<void>) => {
    if (active_action === action) {
      hidePopover();
      return;
    }
    active_action = action;
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
      $badge.text(String(count)).prop('hidden', count <= 0);
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
