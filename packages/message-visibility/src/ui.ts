import {
  clampRounds,
  describeRule,
  findRule,
  MAX_ROUNDS,
  MIN_ROUNDS,
  summarize,
  type Floor,
  type Rule,
  type RuleAction,
} from './state';

export type BarSnapshot = {
  floors: Floor[];
  rules: Rule[];
  window_rounds: number;
};

export type BarHandlers = {
  snapshot(): BarSnapshot;
  toggle(message_id: number, hidden: boolean): Promise<void>;
  bulk(hidden: boolean): Promise<void>;
  window(rounds: number): Promise<void>;
  schedule(message_id: number, action: RuleAction | null, rounds: number): Promise<void>;
  clearRules(): Promise<void>;
};

export type Bar = {
  el: HTMLElement;
  refresh(): void;
  setVisible(visible: boolean): void;
  destroy(): void;
};

/** 24 网格手画线稿, 线宽 1.6, 方头方角 —— 与仓库里另一个状态栏同一套几何语言 */
const ICON_LIST = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.6 7h14.8M4.6 12h14.8M4.6 17h9.6"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.2 2"/></svg>`;
const ICON_CARET = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 10l5 5 5-5"/></svg>`;

const ROLE_LABEL: Record<Floor['role'], string> = {
  system: '系统',
  assistant: 'AI',
  user: '用户',
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

type AsyncAction = () => Promise<void>;

export function mountBar(handlers: BarHandlers): Bar {
  // 脚本运行在 iframe 里, 面板要挂到酒馆页面本身: 一律用父页面的 document 创建节点
  const page_document = window.parent?.document ?? document;
  const page_window = page_document.defaultView ?? window;

  const el = page_document.createElement('div');
  el.className = 'mvb-bar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', '楼层可见性');
  el.innerHTML = `
    <button type="button" class="mvb-open" aria-haspopup="dialog" aria-expanded="false">
      <span class="mvb-icon">${ICON_LIST}</span>
      <span class="mvb-label">楼层可见</span>
      <span class="mvb-pill mvb-hidden-pill" hidden></span>
      <span class="mvb-pill mvb-rule-pill" hidden></span>
      <span class="mvb-icon mvb-caret">${ICON_CARET}</span>
    </button>`;

  const popover = page_document.createElement('div');
  popover.className = 'mvb-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', '楼层可见性设置');
  popover.hidden = true;
  page_document.body.appendChild(popover);

  const $open = el.querySelector<HTMLButtonElement>('.mvb-open')!;
  const $hidden_pill = el.querySelector<HTMLElement>('.mvb-hidden-pill')!;
  const $rule_pill = el.querySelector<HTMLElement>('.mvb-rule-pill')!;

  let open_editor: number | null = null;
  let busy = false;

  const isOpen = () => !popover.hidden;

  /** 上层操作失败时只提示, 不打断弹窗: 用户还可以继续调整 */
  async function run(action: AsyncAction): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    popover.classList.add('mvb-busy');
    try {
      await action();
    } catch (error) {
      console.warn('[楼层可见性] 操作失败', error);
      toastr.error(errorMessage(error), '楼层可见性');
    } finally {
      busy = false;
      popover.classList.remove('mvb-busy');
      render();
    }
  }

  /**
   * 弹窗只能贴状态栏上方, 且只用 `top` 定位:
   * 酒馆的 <body> 是 position: fixed, 用 `bottom` 会参照一个 0 高的包含块, 弹窗会飞出视口.
   * 所以先渲染内容再量高度.
   */
  function positionPopover(): void {
    const rect = el.getBoundingClientRect();
    const gap = 8;
    const viewport_width = page_window.innerWidth;
    const viewport_height = page_window.innerHeight;
    const width = Math.min(Math.max(rect.width, 300), 520, viewport_width - 16);
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, viewport_width - width - 8));
    const space_above = rect.top - gap * 2;
    const space_below = viewport_height - rect.bottom - gap * 2;
    const place_above = space_above >= 200 || space_above >= space_below;
    const max_height = Math.max(160, Math.min(place_above ? space_above : space_below, viewport_height * 0.7));

    popover.style.left = `${left}px`;
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${max_height}px`;

    const height = popover.getBoundingClientRect().height;
    const top = place_above ? rect.top - gap - height : rect.bottom + gap;
    popover.style.top = `${Math.max(gap, Math.min(top, Math.max(gap, viewport_height - gap - height)))}px`;
  }

  function rowHtml(floor: Floor, rule: Rule | undefined): string {
    const hidden = floor.is_hidden ? ' is-hidden' : '';
    const role = `<span class="mvb-role mvb-role-${floor.role}">${ROLE_LABEL[floor.role]}</span>`;
    const chip = rule
      ? `<span class="mvb-chip" title="定时规则">${ICON_CLOCK}${escapeHtml(describeRule(rule))}</span>`
      : '';
    const schedule_disabled = floor.role === 'system' ? ' disabled' : '';
    return (
      `<li class="mvb-row${hidden}" data-id="${floor.message_id}">` +
      `<span class="mvb-no">#${floor.message_id}</span>${role}` +
      `<span class="mvb-excerpt">${escapeHtml(floor.excerpt) || '<span class="mvb-dim">（空）</span>'}</span>` +
      chip +
      `<button type="button" class="mvb-clock" data-role="schedule" title="设置 N 轮后可见性"${schedule_disabled}>${ICON_CLOCK}</button>` +
      `<label class="mvb-switch" title="${floor.is_hidden ? '当前对 AI 隐藏' : '当前对 AI 可见'}">` +
      `<input type="checkbox" data-role="toggle" ${floor.is_hidden ? '' : 'checked'}${schedule_disabled}>` +
      `<span class="mvb-track"></span></label>` +
      `</li>`
    );
  }

  function editorHtml(floor: Floor, rule: Rule | undefined): string {
    const action = rule?.action ?? 'hide';
    const rounds = rule?.rounds_left ?? 3;
    return (
      `<li class="mvb-editor" data-editor="${floor.message_id}">` +
      `<label class="mvb-editor-label">楼层 #${floor.message_id} 在` +
      `<input type="number" class="mvb-editor-rounds" min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" value="${rounds}"> 轮后</label>` +
      `<select class="mvb-editor-action">` +
      `<option value="hide"${action === 'hide' ? ' selected' : ''}>对 AI 隐藏</option>` +
      `<option value="show"${action === 'show' ? ' selected' : ''}>对 AI 可见</option>` +
      `</select>` +
      `<span class="mvb-editor-actions">` +
      `<button type="button" class="mvb-primary" data-role="apply-rule">确定</button>` +
      (rule ? `<button type="button" class="mvb-ghost" data-role="clear-rule">取消规则</button>` : '') +
      `</span></li>`
    );
  }

  function renderPopover(): void {
    const snapshot = handlers.snapshot();
    const summary = summarize(snapshot.floors, snapshot.rules);
    const previous_body = popover.querySelector<HTMLElement>('.mvb-body');
    const scroll_top = previous_body?.scrollTop ?? 0;

    const ordered = snapshot.floors.slice().sort((a, b) => b.message_id - a.message_id);
    const rows = ordered.map(floor => rowHtml(floor, findRule(snapshot.rules, floor.message_id))).join('');
    const list = rows || '<li class="mvb-empty">这个聊天还没有楼层。</li>';

    popover.innerHTML = `
      <div class="mvb-head">
        <div class="mvb-title">楼层可见性</div>
        <div class="mvb-meta">共 ${summary.total} 楼 · 隐藏 ${summary.hidden} 楼${
          summary.scheduled > 0 ? ` · ${summary.scheduled} 条定时` : ''
        } · 最新在前</div>
      </div>
      <div class="mvb-tools">
        <div class="mvb-tools-row">
          <button type="button" class="mvb-ghost" data-role="all" data-hidden="false">全部可见</button>
          <button type="button" class="mvb-ghost" data-role="all" data-hidden="true">全部隐藏</button>
          ${
            summary.scheduled > 0
              ? '<button type="button" class="mvb-ghost mvb-danger" data-role="clear-rules">清除定时</button>'
              : ''
          }
        </div>
        <div class="mvb-tools-row">
          <span class="mvb-window-label">只让最近</span>
          <input type="number" class="mvb-window-input" min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" value="${snapshot.window_rounds}">
          <span class="mvb-window-label">轮可见</span>
          <button type="button" class="mvb-primary" data-role="window">应用</button>
        </div>
      </div>
      <div class="mvb-body">
        <ul class="mvb-list">${list}</ul>
      </div>
      <div class="mvb-foot">
        <span class="mvb-note">隐藏的楼层不会发给 AI，改动立即保存</span>
        <button type="button" class="mvb-ghost" data-role="close">关闭</button>
      </div>`;

    // 楼层可能在别的窗口被删掉: 编辑器指向不存在的楼层时直接收起
    if (open_editor !== null) {
      const floor = snapshot.floors.find(item => item.message_id === open_editor);
      const row = popover.querySelector<HTMLElement>(`.mvb-row[data-id="${open_editor}"]`);
      if (floor && row) {
        row.insertAdjacentHTML('afterend', editorHtml(floor, findRule(snapshot.rules, floor.message_id)));
      } else {
        open_editor = null;
      }
    }

    const next_body = popover.querySelector<HTMLElement>('.mvb-body');
    if (next_body) {
      next_body.scrollTop = scroll_top;
    }
  }

  function renderBar(): void {
    const snapshot = handlers.snapshot();
    const summary = summarize(snapshot.floors, snapshot.rules);
    $hidden_pill.textContent = `隐藏 ${summary.hidden}`;
    $hidden_pill.hidden = summary.hidden === 0;
    $rule_pill.innerHTML = `${ICON_CLOCK}<span>${summary.scheduled}</span>`;
    $rule_pill.hidden = summary.scheduled === 0;
    $rule_pill.title = `${summary.scheduled} 条定时规则`;
    // 数字消失时按钮宽度不跳: 药丸隐藏仍占位由 CSS 处理
    el.dataset.hidden = String(summary.hidden);
    el.dataset.rules = String(summary.scheduled);
  }

  function render(): void {
    renderBar();
    if (isOpen()) {
      renderPopover();
      positionPopover();
    }
  }

  function openPopover(): void {
    popover.hidden = false;
    $open.setAttribute('aria-expanded', 'true');
    render();
  }

  function closePopover(): void {
    popover.hidden = true;
    $open.setAttribute('aria-expanded', 'false');
    open_editor = null;
  }

  $open.addEventListener('click', () => {
    if (isOpen()) {
      closePopover();
    } else {
      openPopover();
    }
  });

  popover.addEventListener('change', event => {
    const target = event.target as HTMLElement | null;
    if (!target || target.dataset.role !== 'toggle') {
      return;
    }
    const row = target.closest<HTMLElement>('.mvb-row');
    const id = Number(row?.dataset.id);
    if (!Number.isInteger(id)) {
      return;
    }
    const hidden = !(target as HTMLInputElement).checked;
    void run(async () => {
      await handlers.toggle(id, hidden);
    });
  });

  popover.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const role = target.closest<HTMLElement>('[data-role]')?.dataset.role;

    if (role === 'close') {
      closePopover();
      return;
    }

    if (role === 'all') {
      const button = target.closest<HTMLElement>('[data-role="all"]')!;
      const hidden = button.dataset.hidden === 'true';
      void run(async () => {
        await handlers.bulk(hidden);
      });
      return;
    }

    if (role === 'window') {
      const input = popover.querySelector<HTMLInputElement>('.mvb-window-input');
      const rounds = clampRounds(input?.value ?? '');
      void run(async () => {
        await handlers.window(rounds);
      });
      return;
    }

    if (role === 'clear-rules') {
      void run(async () => {
        open_editor = null;
        await handlers.clearRules();
      });
      return;
    }

    if (role === 'schedule') {
      const row = target.closest<HTMLElement>('.mvb-row');
      const id = Number(row?.dataset.id);
      if (!Number.isInteger(id)) {
        return;
      }
      open_editor = open_editor === id ? null : id;
      renderPopover();
      positionPopover();
      return;
    }

    if (role === 'apply-rule') {
      const editor = target.closest<HTMLElement>('[data-editor]');
      const id = Number(editor?.dataset.editor);
      const rounds = clampRounds(editor?.querySelector<HTMLInputElement>('.mvb-editor-rounds')?.value ?? '');
      const action = (editor?.querySelector<HTMLSelectElement>('.mvb-editor-action')?.value ?? 'hide') as RuleAction;
      if (!Number.isInteger(id)) {
        return;
      }
      void run(async () => {
        await handlers.schedule(id, action, rounds);
        open_editor = null;
      });
      return;
    }

    if (role === 'clear-rule') {
      const editor = target.closest<HTMLElement>('[data-editor]');
      const id = Number(editor?.dataset.editor);
      if (!Number.isInteger(id)) {
        return;
      }
      void run(async () => {
        await handlers.schedule(id, null, 0);
        open_editor = null;
      });
    }
  });

  const onPointerDown = (event: Event) => {
    const target = event.target as Node | null;
    if (!target || el.contains(target) || popover.contains(target)) {
      return;
    }
    closePopover();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closePopover();
    }
  };

  const onViewportChange = () => {
    if (isOpen()) {
      positionPopover();
    }
  };

  // 手机上点输入框时收起弹窗, 避免挡住聊天或与软键盘叠加
  const onFocusIn = (event: Event) => {
    const target = event.target as Element | null;
    if (!target || !el.contains(target)) {
      closePopover();
    }
  };

  page_document.addEventListener('pointerdown', onPointerDown, true);
  page_document.addEventListener('keydown', onKeyDown);
  page_document.addEventListener('focusin', onFocusIn);
  page_window.addEventListener('resize', onViewportChange);
  page_window.addEventListener('scroll', onViewportChange, true);

  return {
    el,
    refresh: render,
    setVisible(visible: boolean) {
      el.hidden = !visible;
      if (!visible) {
        closePopover();
      }
    },
    destroy() {
      page_document.removeEventListener('pointerdown', onPointerDown, true);
      page_document.removeEventListener('keydown', onKeyDown);
      page_document.removeEventListener('focusin', onFocusIn);
      page_window.removeEventListener('resize', onViewportChange);
      page_window.removeEventListener('scroll', onViewportChange, true);
      popover.remove();
      el.remove();
    },
  };
}
