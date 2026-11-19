import {
  clampRounds,
  describeRule,
  filterFloors,
  findRule,
  MAX_ROUNDS,
  MIN_ROUNDS,
  statusLabel,
  statusOf,
  type Filter,
  type Floor,
  type Rule,
  type RuleAction,
  type UiPrefs,
} from './state';

export type BarSnapshot = {
  floors: Floor[];
  rules: Rule[];
  window_rounds: number;
  prefs: UiPrefs;
};

export type BarHandlers = {
  snapshot(): BarSnapshot;
  toggle(message_id: number, hidden: boolean): Promise<void>;
  bulk(hidden: boolean): Promise<void>;
  window(rounds: number): Promise<void>;
  schedule(message_id: number, action: RuleAction | null, rounds: number): Promise<void>;
  clearRules(): Promise<void>;
  setPrefs(patch: Partial<UiPrefs>): void;
};

export type Bar = {
  el: HTMLElement;
  refresh(): void;
  setVisible(visible: boolean): void;
  destroy(): void;
};

/** 24 网格手画线稿, 线宽 1.6: 插件 / 时钟 / 收起 / 关闭 / 箭头 */
const ICON_PLUG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M15 3v4"/><path d="M6 7h12v3.4a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 16.4V21"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.2 2"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14"/><path d="M7.5 11.5l4.5 4.5 4.5-4.5"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14"/><path d="M7.5 16.5l4.5-4.5 4.5 4.5"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 14.5L12 9l5.5 5.5"/></svg>`;

const ROLE_TEXT: Record<Floor['role'], string> = {
  system: '系统',
  assistant: 'AI',
  user: '用户',
};

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'user', label: '用户' },
  { value: 'assistant', label: 'AI' },
];

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

export function mountBar(handlers: BarHandlers): Bar {
  // 脚本跑在 iframe 里, 界面要挂到酒馆页面本身
  const page_document = window.parent?.document ?? document;
  const page_window = page_document.defaultView ?? window;

  // ── 工具栏 ────────────────────────────────────────────
  const el = page_document.createElement('div');
  el.className = 'mvb-bar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', '楼层可见性');
  el.innerHTML = `
    <button class="mvb-trigger" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="mvb-trigger-icon">${ICON_PLUG}</span>
      <span class="mvb-trigger-compact mvb-only-compact"></span>
      <span class="mvb-trigger-label mvb-only-full">楼层可见</span>
      <span class="mvb-badge mvb-only-full" data-badge="hidden" hidden></span>
      <span class="mvb-badge mvb-only-full" data-badge="rules" hidden>${ICON_CLOCK}<span data-badge-rules>0</span></span>
      <span class="mvb-trigger-chevron">${ICON_CHEVRON}</span>
    </button>`;

  // ── 弹窗 ──────────────────────────────────────────────
  const popover = page_document.createElement('div');
  popover.className = 'mvb-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', '楼层可见性设置');
  popover.hidden = true;
  page_document.body.appendChild(popover);

  const trigger = el.querySelector<HTMLButtonElement>('.mvb-trigger')!;
  const compact_label = el.querySelector<HTMLElement>('.mvb-trigger-compact')!;
  const hidden_badge = el.querySelector<HTMLElement>('[data-badge="hidden"]')!;
  const rules_badge = el.querySelector<HTMLElement>('[data-badge="rules"]')!;
  const rules_count = el.querySelector<HTMLElement>('[data-badge-rules]')!;

  let editor_id: number | null = null;
  let busy = false;
  let shell_ready = false;

  const snapshot = () => handlers.snapshot();
  const isOpen = () => !popover.hidden;

  function insideUi(target: EventTarget | null): boolean {
    const node = target as Node | null;
    return Boolean(node && (el.contains(node) || popover.contains(node)));
  }

  // ── 工具栏渲染 ────────────────────────────────────────
  function renderBar(): void {
    const { floors, rules, prefs } = snapshot();
    const status = statusOf(floors, rules);
    const scheduled = rules.length;

    el.classList.toggle('mvb-bar-compact', prefs.compact);
    compact_label.textContent = statusLabel(status);

    hidden_badge.textContent = `隐藏 ${status.hidden}`;
    hidden_badge.hidden = status.hidden === 0;
    rules_badge.hidden = scheduled === 0;
    rules_count.textContent = String(scheduled);
    rules_badge.title = `${scheduled} 条定时规则`;
    trigger.title = prefs.compact
      ? `${statusLabel(status)} · 点击展开面板`
      : '楼层可见性';
    trigger.setAttribute('aria-expanded', String(isOpen()));
  }

  // ── 弹窗骨架 (只在打开时构建一次) ─────────────────────
  function renderShell(): void {
    const { window_rounds, prefs } = snapshot();
    popover.innerHTML = `
      <header class="mvb-head">
        <div class="mvb-head-title">楼层可见性</div>
        <div class="mvb-head-meta" data-meta></div>
        <div class="mvb-head-actions">
          <button class="mvb-icon-btn" type="button" data-role="compact" title="收起为状态条" aria-pressed="${prefs.compact}">
            ${prefs.compact ? ICON_EXPAND : ICON_COLLAPSE}
          </button>
          <button class="mvb-icon-btn" type="button" data-role="close" title="关闭" aria-label="关闭">
            ${ICON_CLOSE}
          </button>
        </div>
      </header>
      <div class="mvb-toolbar">
        <div class="mvb-segmented" role="tablist" aria-label="筛选楼层">
          ${FILTERS.map(
            item =>
              `<button class="mvb-segment" type="button" role="tab" data-role="filter" data-filter="${item.value}">${item.label}</button>`,
          ).join('')}
        </div>
        <div class="mvb-toolbar-row">
          <button class="mvb-btn" type="button" data-role="all" data-hidden="false">全部可见</button>
          <button class="mvb-btn" type="button" data-role="all" data-hidden="true">全部隐藏</button>
          <button class="mvb-btn mvb-btn-danger" type="button" data-role="clear-rules" hidden>清除定时</button>
        </div>
        <div class="mvb-toolbar-row mvb-window-row">
          <label class="mvb-window-label" for="mvb-window-input">最近</label>
          <input id="mvb-window-input" class="mvb-input mvb-window-input" type="number"
                 min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" inputmode="numeric" value="${window_rounds}">
          <span class="mvb-window-label">轮可见</span>
          <button class="mvb-btn mvb-btn-primary mvb-window-apply" type="button" data-role="window">应用</button>
        </div>
      </div>
      <div class="mvb-list-wrap">
        <ul class="mvb-list" role="list"></ul>
      </div>
      <footer class="mvb-foot">隐藏的楼层不会发给 AI，改动立即保存</footer>`;
    shell_ready = true;
  }

  // ── 列表渲染 ──────────────────────────────────────────
  function rowHtml(floor: Floor, rule: Rule | undefined): string {
    const hidden = floor.is_hidden;
    const chip = rule
      ? `<span class="mvb-chip" title="定时规则">${ICON_CLOCK}${escapeHtml(describeRule(rule))}</span>`
      : '';
    return (
      `<li class="mvb-row${hidden ? ' is-hidden' : ''}" data-id="${floor.message_id}">` +
      `<span class="mvb-row-id">#${floor.message_id}</span>` +
      `<span class="mvb-role mvb-role-${floor.role}">${ROLE_TEXT[floor.role]}</span>` +
      `<button class="mvb-row-body" type="button" data-role="edit" title="设置定时规则">` +
      `<span class="mvb-excerpt">${escapeHtml(floor.excerpt) || '<span class="mvb-dim">（空）</span>'}</span>${chip}` +
      `</button>` +
      `<button class="mvb-switch" type="button" role="switch" data-role="toggle" aria-checked="${!hidden}" aria-label="对 AI ${hidden ? '隐藏' : '可见'}">` +
      `<span class="mvb-switch-thumb"></span></button>` +
      `</li>`
    );
  }

  function editorHtml(floor: Floor, rule: Rule | undefined): string {
    const action = rule?.action ?? 'hide';
    const rounds = rule?.rounds_left ?? 3;
    return (
      `<li class="mvb-editor" data-editor="${floor.message_id}">` +
      `<span class="mvb-editor-text">#${floor.message_id} 在</span>` +
      `<input class="mvb-input mvb-editor-rounds" type="number" min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" inputmode="numeric" value="${rounds}" aria-label="轮数">` +
      `<span class="mvb-editor-text">轮后</span>` +
      `<select class="mvb-select mvb-editor-action" aria-label="到点后的可见性">` +
      `<option value="hide"${action === 'hide' ? ' selected' : ''}>隐藏</option>` +
      `<option value="show"${action === 'show' ? ' selected' : ''}>可见</option>` +
      `</select>` +
      `<span class="mvb-editor-actions">` +
      `<button class="mvb-btn mvb-btn-primary" type="button" data-role="apply-rule">确定</button>` +
      `<button class="mvb-btn" type="button" data-role="cancel-rule">取消</button>` +
      (rule ? `<button class="mvb-btn mvb-btn-danger" type="button" data-role="remove-rule">删除规则</button>` : '') +
      `</span></li>`
    );
  }

  /** 重渲染列表前记下编辑器里正在输入的内容, 免得后台刷新把用户输入冲掉 */
  function captureEditor() {
    if (editor_id === null) {
      return null;
    }
    const box = popover.querySelector<HTMLElement>(`[data-editor="${editor_id}"]`);
    if (!box) {
      return null;
    }
    return {
      rounds: box.querySelector<HTMLInputElement>('.mvb-editor-rounds')?.value ?? '',
      action: box.querySelector<HTMLSelectElement>('.mvb-editor-action')?.value ?? 'hide',
      focused: box.contains(page_document.activeElement),
    };
  }

  function renderList(captured: ReturnType<typeof captureEditor> = null): void {
    const { floors, rules, prefs } = snapshot();
    const visible = filterFloors(floors, prefs.filter);

    // 筛选后编辑器指向的楼层不在列表里, 直接收起
    if (editor_id !== null && !visible.some(floor => floor.message_id === editor_id)) {
      editor_id = null;
    }

    const ordered = visible.slice().sort((a, b) => b.message_id - a.message_id);
    const list = popover.querySelector<HTMLElement>('.mvb-list');
    if (!list) {
      return;
    }

    list.innerHTML = ordered.length
      ? ordered.map(floor => rowHtml(floor, findRule(rules, floor.message_id))).join('')
      : `<li class="mvb-empty">${prefs.filter === 'all' ? '这个聊天还没有楼层。' : '当前筛选下没有楼层。'}</li>`;

    if (editor_id !== null) {
      const floor = visible.find(item => item.message_id === editor_id);
      const row = list.querySelector<HTMLElement>(`.mvb-row[data-id="${editor_id}"]`);
      if (floor && row) {
        row.insertAdjacentHTML('afterend', editorHtml(floor, findRule(rules, floor.message_id)));
        const box = list.querySelector<HTMLElement>(`[data-editor="${editor_id}"]`);
        if (box && captured) {
          const rounds = box.querySelector<HTMLInputElement>('.mvb-editor-rounds');
          const action = box.querySelector<HTMLSelectElement>('.mvb-editor-action');
          if (rounds && captured.rounds) rounds.value = captured.rounds;
          if (action) action.value = captured.action;
          if (captured.focused) rounds?.focus();
        }
      } else {
        editor_id = null;
      }
    }
  }

  /** 头部统计 / 筛选态 / 清除定时按钮, 与列表一起刷新 */
  function renderChrome(): void {
    const { floors, rules, prefs } = snapshot();
    const status = statusOf(floors, rules);

    const meta = popover.querySelector<HTMLElement>('[data-meta]');
    if (meta) {
      meta.textContent = `${status.hidden}/${status.total} 隐藏${rules.length ? ` · ${rules.length} 定时` : ''}`;
    }

    popover.querySelectorAll<HTMLElement>('[data-role="filter"]').forEach(button => {
      const active = button.dataset.filter === prefs.filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });

    const clear = popover.querySelector<HTMLElement>('[data-role="clear-rules"]');
    if (clear) {
      clear.hidden = rules.length === 0;
    }

    const compact = popover.querySelector<HTMLElement>('[data-role="compact"]');
    if (compact) {
      compact.setAttribute('aria-pressed', String(prefs.compact));
      compact.title = prefs.compact ? '展开完整工具栏' : '收起为状态条';
      compact.innerHTML = prefs.compact ? ICON_EXPAND : ICON_COLLAPSE;
    }

    const window_input = popover.querySelector<HTMLInputElement>('.mvb-window-input');
    if (window_input && page_document.activeElement !== window_input) {
      window_input.value = String(snapshot().window_rounds);
    }
  }

  function renderPanel(): void {
    if (!shell_ready) {
      renderShell();
    }
    const captured = captureEditor();
    renderChrome();
    renderList(captured);
  }

  function render(): void {
    renderBar();
    if (isOpen()) {
      renderPanel();
      positionPopover();
    }
  }

  // ── 定位 ──────────────────────────────────────────────
  /**
   * 只用 `top` 定位: 酒馆的 <body> 是 position: fixed, 用 `bottom` 会参照一个
   * 0 高的包含块, 弹窗会飞到视口外。先渲染再量高度。
   */
  function positionPopover(): void {
    const rect = el.getBoundingClientRect();
    const gap = 8;
    const vw = page_window.innerWidth;
    const vh = page_window.innerHeight;
    const narrow = vw < 640;

    const width = narrow ? Math.max(240, vw - gap * 2) : Math.min(Math.max(rect.width, 320), 520);
    const left = narrow
      ? gap
      : Math.min(Math.max(rect.left, gap), Math.max(gap, vw - width - gap));

    popover.style.left = `${left}px`;
    popover.style.width = `${width}px`;

    const space_above = rect.top - gap * 2;
    const space_below = vh - rect.bottom - gap * 2;
    const place_above = space_above >= 240 || space_above >= space_below;
    const limit = place_above ? space_above : space_below;
    popover.style.maxHeight = `${Math.max(200, Math.min(limit, vh * (narrow ? 0.72 : 0.7)))}px`;

    const height = popover.getBoundingClientRect().height;
    const top = place_above ? rect.top - gap - height : rect.bottom + gap;
    popover.style.top = `${Math.max(gap, Math.min(top, Math.max(gap, vh - gap - height)))}px`;
  }

  // ── 开关 ──────────────────────────────────────────────
  function setOpen(open: boolean): void {
    if (open === isOpen()) {
      return;
    }
    popover.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      renderPanel();
      positionPopover();
      // 打开后把焦点交给弹窗, 键盘用户也能用 Esc 关掉
      popover.querySelector<HTMLElement>('.mvb-segment.is-active')?.focus();
    } else {
      editor_id = null;
      shell_ready = false;
    }
  }

  function setBusy(next: boolean): void {
    busy = next;
    popover.classList.toggle('mvb-busy', next);
    el.classList.toggle('mvb-busy', next);
  }

  /** 上层操作失败时只提示, 不关闭弹窗 */
  async function run(action: () => Promise<void> | void): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.warn('[楼层可见性] 操作失败', error);
      toastr.error(errorMessage(error), '楼层可见性');
    } finally {
      setBusy(false);
      render();
    }
  }

  // ── 事件 ──────────────────────────────────────────────
  trigger.addEventListener('click', () => {
    setOpen(!isOpen());
  });

  popover.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const control = target?.closest<HTMLElement>('[data-role]');
    const role = control?.dataset.role;

    if (role === 'close') {
      setOpen(false);
      return;
    }

    if (role === 'compact') {
      const next = !snapshot().prefs.compact;
      handlers.setPrefs({ compact: next });
      if (next) {
        setOpen(false);
      } else {
        renderChrome();
        renderBar();
      }
      return;
    }

    if (role === 'filter') {
      const filter = control?.dataset.filter as Filter | undefined;
      if (filter) {
        handlers.setPrefs({ filter });
        editor_id = null;
        renderChrome();
        renderList();
        renderBar();
        positionPopover();
      }
      return;
    }

    if (role === 'all') {
      const hidden = control?.dataset.hidden === 'true';
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
        editor_id = null;
        await handlers.clearRules();
      });
      return;
    }

    if (role === 'edit') {
      const id = Number(control?.closest<HTMLElement>('.mvb-row')?.dataset.id);
      if (!Number.isInteger(id)) {
        return;
      }
      const captured = captureEditor();
      editor_id = editor_id === id ? null : id;
      renderList(captured);
      positionPopover();
      return;
    }

    if (role === 'toggle') {
      const row = control?.closest<HTMLElement>('.mvb-row');
      const id = Number(row?.dataset.id);
      if (!Number.isInteger(id)) {
        return;
      }
      const floor = snapshot().floors.find(item => item.message_id === id);
      if (!floor) {
        return;
      }
      void run(async () => {
        await handlers.toggle(id, !floor.is_hidden);
      });
      return;
    }

    if (role === 'apply-rule') {
      const box = control?.closest<HTMLElement>('[data-editor]');
      const id = Number(box?.dataset.editor);
      if (!Number.isInteger(id)) {
        return;
      }
      const rounds = clampRounds(box?.querySelector<HTMLInputElement>('.mvb-editor-rounds')?.value ?? '');
      const action = (box?.querySelector<HTMLSelectElement>('.mvb-editor-action')?.value ?? 'hide') as RuleAction;
      void run(async () => {
        await handlers.schedule(id, action, rounds);
        editor_id = null;
      });
      return;
    }

    if (role === 'cancel-rule') {
      const captured = captureEditor();
      editor_id = null;
      renderList(captured);
      positionPopover();
      return;
    }

    if (role === 'remove-rule') {
      const box = control?.closest<HTMLElement>('[data-editor]');
      const id = Number(box?.dataset.editor);
      if (!Number.isInteger(id)) {
        return;
      }
      void run(async () => {
        await handlers.schedule(id, null, 0);
        editor_id = null;
      });
    }
  });

  // 点空白处收起: 弹窗与工具栏都算「里面」
  const onPointerDown = (event: Event) => {
    if (isOpen() && !insideUi(event.target)) {
      setOpen(false);
    }
  };
  // 焦点移到别处时也收起, 但绝不能因为焦点落在弹窗内部就关掉
  const onFocusIn = (event: Event) => {
    if (isOpen() && !insideUi(event.target)) {
      setOpen(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (editor_id !== null) {
      const captured = captureEditor();
      editor_id = null;
      renderList(captured);
      return;
    }
    if (isOpen()) {
      setOpen(false);
    }
  };
  const onViewportChange = () => {
    if (isOpen()) {
      positionPopover();
    }
  };

  page_document.addEventListener('pointerdown', onPointerDown, true);
  page_document.addEventListener('focusin', onFocusIn, true);
  page_document.addEventListener('keydown', onKeyDown);
  page_window.addEventListener('resize', onViewportChange);
  page_window.addEventListener('scroll', onViewportChange, true);

  return {
    el,
    refresh: render,
    setVisible(visible: boolean) {
      el.hidden = !visible;
      if (!visible) {
        setOpen(false);
      }
    },
    destroy() {
      page_document.removeEventListener('pointerdown', onPointerDown, true);
      page_document.removeEventListener('focusin', onFocusIn, true);
      page_document.removeEventListener('keydown', onKeyDown);
      page_window.removeEventListener('resize', onViewportChange);
      page_window.removeEventListener('scroll', onViewportChange, true);
      popover.remove();
      el.remove();
    },
  };
}
