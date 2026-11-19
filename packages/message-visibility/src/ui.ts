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
const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5L12 15l5.5-5.5"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4.2 4.2L18.5 8"/></svg>`;
const ICON_CROSS = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.5 7l.9 12.1a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3L17.5 7"/></svg>`;

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

  /** 定时编辑器的草稿: 值存在这里, 后台刷新重建列表时不会丢 */
  type EditorState = {
    id: number;
    rounds: number;
    action: RuleAction;
    base_rounds: number;
    base_action: RuleAction;
    has_rule: boolean;
  };

  let editor: EditorState | null = null;
  let busy = false;
  let shell_ready = false;

  const isDirty = (state: EditorState | null): boolean =>
    Boolean(state && (state.rounds !== state.base_rounds || state.action !== state.base_action));

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

  // ── 列表渲染 · Accordion ──────────────────────────────
  //
  // 每层是一个 accordion item: 头部是触发器 + 可见性开关, 面板里放定时编辑。
  // 结构照 shadcn 的 accordion (`data-state` 驱动 + 内容区高度补间)。
  function panelId(id: number): string {
    return `mvb-acc-panel-${id}`;
  }

  function itemHtml(floor: Floor, rule: Rule | undefined): string {
    const hidden = floor.is_hidden;
    const open = editor?.id === floor.message_id;
    const chip = rule
      ? `<span class="mvb-chip" title="定时规则">${ICON_CLOCK}${escapeHtml(describeRule(rule))}</span>`
      : '';
    return (
      `<li class="mvb-acc${hidden ? ' is-hidden' : ''}" data-id="${floor.message_id}" data-state="${open ? 'open' : 'closed'}">` +
      `<div class="mvb-acc-head">` +
      `<button class="mvb-acc-trigger" type="button" data-role="edit" aria-expanded="${open}" aria-controls="${panelId(floor.message_id)}" title="定时规则">` +
      `<span class="mvb-acc-chevron">${ICON_CHEVRON_DOWN}</span>` +
      `<span class="mvb-row-id">#${floor.message_id}</span>` +
      `<span class="mvb-role mvb-role-${floor.role}">${ROLE_TEXT[floor.role]}</span>` +
      `<span class="mvb-excerpt">${escapeHtml(floor.excerpt) || '<span class="mvb-dim">（空）</span>'}</span>` +
      `${chip}` +
      `</button>` +
      `<button class="mvb-switch" type="button" role="switch" data-role="toggle" aria-checked="${!hidden}" aria-label="对 AI ${hidden ? '隐藏' : '可见'}">` +
      `<span class="mvb-switch-thumb"></span></button>` +
      `</div>` +
      `<div class="mvb-acc-panel" id="${panelId(floor.message_id)}" role="region" data-state="${open ? 'open' : 'closed'}">` +
      `<div class="mvb-acc-panel-inner"></div>` +
      `</div>` +
      `</li>`
    );
  }

  /** 面板内容: 一行里放轮数、到点开关和操作按钮, 不额外占行 */
  function editorHtml(state: EditorState): string {
    const dirty = isDirty(state);
    const hide = state.action === 'hide';
    return (
      `<div class="mvb-editor" data-editor="${state.id}">` +
      `<span class="mvb-editor-text">在</span>` +
      `<input class="mvb-input mvb-editor-rounds" type="number" min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" inputmode="numeric"` +
      ` value="${state.rounds}" aria-label="轮数">` +
      `<span class="mvb-editor-text">轮后</span>` +
      `<span class="mvb-editor-toggle">` +
      `<button class="mvb-switch" type="button" role="switch" data-role="rule-action" aria-checked="${hide}" aria-label="到点后${hide ? '隐藏' : '可见'}">` +
      `<span class="mvb-switch-thumb"></span></button>` +
      `<span class="mvb-editor-action-label">${hide ? '隐藏' : '可见'}</span>` +
      `</span>` +
      `<span class="mvb-editor-actions"${dirty ? '' : ' hidden'}>` +
      `<button class="mvb-icon-btn mvb-icon-primary" type="button" data-role="apply-rule" title="确定" aria-label="确定">${ICON_CHECK}</button>` +
      `<button class="mvb-icon-btn" type="button" data-role="cancel-rule" title="取消" aria-label="取消">${ICON_CROSS}</button>` +
      `</span>` +
      (state.has_rule
        ? `<button class="mvb-icon-btn mvb-icon-danger" type="button" data-role="remove-rule" title="删除规则" aria-label="删除规则">${ICON_TRASH}</button>`
        : '') +
      `</div>`
    );
  }

  function findItem(id: number): HTMLElement | null {
    return popover.querySelector<HTMLElement>(`.mvb-acc[data-id="${id}"]`);
  }

  function mountEditor(item: HTMLElement, state: EditorState): void {
    const inner = item.querySelector<HTMLElement>('.mvb-acc-panel-inner');
    if (inner) {
      inner.innerHTML = editorHtml(state);
    }
  }

  function unmountEditor(item: HTMLElement): void {
    item.querySelector<HTMLElement>('.mvb-acc-panel-inner')?.replaceChildren();
  }

  function setItemState(item: HTMLElement, open: boolean): void {
    item.dataset.state = open ? 'open' : 'closed';
    item.querySelector('.mvb-acc-trigger')?.setAttribute('aria-expanded', String(open));
    const panel = item.querySelector<HTMLElement>('.mvb-acc-panel');
    if (panel) {
      panel.dataset.state = open ? 'open' : 'closed';
    }
  }

  /** 只影响当前展开项, 不重建整个列表 —— 高度补间才有东西可过渡 */
  function collapseEditor(): HTMLElement | null {
    if (!editor) {
      return null;
    }
    const item = findItem(editor.id);
    editor = null;
    if (!item) {
      return null;
    }
    setItemState(item, false);
    // 等高度收完再清内容, 否则会瞬间塌陷
    page_window.setTimeout(() => {
      if (item.dataset.state === 'closed') {
        unmountEditor(item);
      }
    }, 180);
    return item;
  }

  function expandEditor(floor: Floor, rule: Rule | undefined): void {
    const item = findItem(floor.message_id);
    if (!item) {
      return;
    }
    const state: EditorState = {
      id: floor.message_id,
      rounds: rule?.rounds_left ?? 3,
      action: rule?.action ?? 'hide',
      base_rounds: rule?.rounds_left ?? 3,
      base_action: rule?.action ?? 'hide',
      has_rule: Boolean(rule),
    };
    editor = state;
    mountEditor(item, state);
    // 内容先落地, 下一帧再展开, 这样 grid-rows 才有起点
    page_window.requestAnimationFrame(() => {
      if (editor?.id === state.id) {
        setItemState(item, true);
      }
    });
  }

  function toggleEditor(id: number): void {
    const { floors, rules } = snapshot();
    const isSame = editor?.id === id;
    collapseEditor();
    if (isSame) {
      return;
    }
    const floor = floors.find(item => item.message_id === id);
    if (!floor) {
      return;
    }
    expandEditor(floor, findRule(rules, id));
  }

  /** 输入或开关变化后重算「是否有改动」, 决定确认/取消要不要出现 */
  function syncDirty(): void {
    const box = editor && popover.querySelector<HTMLElement>(`[data-editor="${editor.id}"]`);
    if (!box || !editor) {
      return;
    }
    const actions = box.querySelector<HTMLElement>('.mvb-editor-actions');
    if (actions) {
      actions.hidden = !isDirty(editor);
    }
    const label = box.querySelector<HTMLElement>('.mvb-editor-action-label');
    const toggle = box.querySelector<HTMLElement>('[data-role="rule-action"]');
    if (label) {
      label.textContent = editor.action === 'hide' ? '隐藏' : '可见';
    }
    if (toggle) {
      toggle.setAttribute('aria-checked', String(editor.action === 'hide'));
      toggle.setAttribute('aria-label', `到点后${editor.action === 'hide' ? '隐藏' : '可见'}`);
    }
  }

  function renderList(): void {
    const { floors, rules, prefs } = snapshot();
    const visible = filterFloors(floors, prefs.filter);

    // 筛选后展开项不在列表里, 直接收起
    const current = editor;
    if (current && !visible.some(floor => floor.message_id === current.id)) {
      editor = null;
    }

    const ordered = visible.slice().sort((a, b) => b.message_id - a.message_id);
    const list = popover.querySelector<HTMLElement>('.mvb-list');
    if (!list) {
      return;
    }

    const open_state = editor;
    const focused_rounds = Boolean(
      open_state &&
        popover.querySelector(`[data-editor="${open_state.id}"] .mvb-editor-rounds`) === page_document.activeElement,
    );

    list.innerHTML = ordered.length
      ? ordered.map(floor => itemHtml(floor, findRule(rules, floor.message_id))).join('')
      : `<li class="mvb-empty">${prefs.filter === 'all' ? '这个聊天还没有楼层。' : '当前筛选下没有楼层。'}</li>`;

    // 重建列表后把展开项的内容补回去 (草稿值在 editor 里)
    if (editor) {
      const item = findItem(editor.id);
      if (item) {
        mountEditor(item, editor);
        const input = item.querySelector<HTMLInputElement>('.mvb-editor-rounds');
        if (focused_rounds && input) {
          input.focus();
          const end = input.value.length;
          input.setSelectionRange(end, end);
        }
      } else {
        editor = null;
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
    renderChrome();
    renderList();
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
      editor = null;
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
        collapseEditor();
        editor = null;
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
        collapseEditor();
        editor = null;
        await handlers.clearRules();
      });
      return;
    }

    if (role === 'edit') {
      const id = Number(control?.closest<HTMLElement>('.mvb-acc')?.dataset.id);
      if (!Number.isInteger(id)) {
        return;
      }
      toggleEditor(id);
      positionPopover();
      return;
    }

    if (role === 'toggle') {
      const id = Number(control?.closest<HTMLElement>('.mvb-acc')?.dataset.id);
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

    // 编辑器里的到点开关: 只改草稿, 不动真实楼层
    if (role === 'rule-action') {
      if (!editor) {
        return;
      }
      editor.action = editor.action === 'hide' ? 'show' : 'hide';
      syncDirty();
      return;
    }

    if (role === 'apply-rule') {
      const state = editor;
      if (!state) {
        return;
      }
      void run(async () => {
        await handlers.schedule(state.id, state.action, state.rounds);
        collapseEditor();
        editor = null;
      });
      return;
    }

    if (role === 'cancel-rule') {
      collapseEditor();
      editor = null;
      positionPopover();
      return;
    }

    if (role === 'remove-rule') {
      const state = editor;
      if (!state) {
        return;
      }
      void run(async () => {
        await handlers.schedule(state.id, null, 0);
        collapseEditor();
        editor = null;
      });
    }
  });

  // 输入轮数 / 切换到点开关后, 才让确定取消出现
  popover.addEventListener('input', event => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.mvb-editor-rounds');
    if (!input || !editor) {
      return;
    }
    editor.rounds = clampRounds(input.value);
    syncDirty();
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
    if (editor) {
      collapseEditor();
      editor = null;
      positionPopover();
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
