import {
  clampRounds,
  describeRule,
  filterFloors,
  findRule,
  MAX_ROUNDS,
  MIN_ROUNDS,
  statusOf,
  statusLabel,
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

/** 24 网格手画线稿, 线宽 1.6: 时钟 / 展开箭头 / 确认 / 取消 / 删除 */
const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.2 2"/></svg>`;
const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5L12 15l5.5-5.5"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4.2 4.2L18.5 8"/></svg>`;
const ICON_CROSS = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.5 7l.9 12.1a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3L17.5 7"/></svg>`;

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

/**
 * 输入框上方的状态栏卡片: 头部一行常驻, 展开区在原地长高 (不浮层, 不遮挡聊天).
 * 与 ai-monitor 共用 #tavern-status-row, 各占一半宽度.
 */
export function mountBar(handlers: BarHandlers): Bar {
  // 脚本跑在 iframe 里, 界面要挂到酒馆页面本身
  const page_document = window.parent?.document ?? document;
  const page_window = page_document.defaultView ?? window;

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

  const el = page_document.createElement('div');
  el.className = 'mvb-card';
  // 与 ai-monitor 的 #tt-ai-monitor 对齐: 排查和脚本外部干预时有个稳定锚点
  el.id = 'message-visibility';
  el.dataset.state = 'closed';
  el.innerHTML = `
    <button class="mvb-head" type="button" data-role="fold" aria-expanded="false" title="展开 / 收起楼层列表">
      <span class="mvb-dot"></span>
      <span class="mvb-title">楼层可见</span>
      <span class="mvb-badge" data-badge="hidden"></span>
      <span class="mvb-badge mvb-badge-accent" data-badge="rules" hidden>${ICON_CLOCK}<span data-badge-rules></span></span>
      <span class="mvb-fold" data-fold>+</span>
    </button>
    <div class="mvb-body" hidden>
      <div class="mvb-tabs" role="tablist" aria-label="筛选楼层">
        ${FILTERS.map(
          item =>
            `<button class="mvb-tab" type="button" role="tab" data-role="filter" data-filter="${item.value}">${item.label}</button>`,
        ).join('')}
      </div>
      <div class="mvb-toolbar">
        <div class="mvb-toolbar-row">
          <button class="mvb-btn" type="button" data-role="all" data-hidden="false">全部可见</button>
          <button class="mvb-btn" type="button" data-role="all" data-hidden="true">全部隐藏</button>
          <button class="mvb-btn mvb-btn-danger" type="button" data-role="clear-rules" hidden>清除定时</button>
        </div>
        <div class="mvb-toolbar-row">
          <label class="mvb-window-label" for="mvb-window-input">最近</label>
          <input id="mvb-window-input" class="mvb-input mvb-window-input" type="number"
                 min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" inputmode="numeric">
          <span class="mvb-window-label">轮可见</span>
          <button class="mvb-btn mvb-btn-primary mvb-window-apply" type="button" data-role="window">应用</button>
        </div>
      </div>
      <div class="mvb-list-wrap">
        <ul class="mvb-list" role="list"></ul>
      </div>
      <div class="mvb-foot">隐藏的楼层不会发给 AI，改动立即保存</div>
    </div>`;

  const head = el.querySelector<HTMLButtonElement>('.mvb-head')!;
  const body = el.querySelector<HTMLElement>('.mvb-body')!;
  const dot = el.querySelector<HTMLElement>('.mvb-dot')!;
  const hidden_badge = el.querySelector<HTMLElement>('[data-badge="hidden"]')!;
  const rules_badge = el.querySelector<HTMLElement>('[data-badge="rules"]')!;
  const rules_count = el.querySelector<HTMLElement>('[data-badge-rules]')!;
  const fold = el.querySelector<HTMLElement>('[data-fold]')!;
  const list = el.querySelector<HTMLElement>('.mvb-list')!;

  const snapshot = () => handlers.snapshot();
  const isOpen = () => !body.hidden;

  const isDirty = (state: EditorState | null): boolean =>
    Boolean(state && (state.rounds !== state.base_rounds || state.action !== state.base_action));

  // ── 头部 ──────────────────────────────────────────────
  function renderHead(): void {
    const { floors, rules, prefs } = snapshot();
    const status = statusOf(floors, rules);
    const scheduled = rules.length;
    const open = !prefs.collapsed;

    el.dataset.state = open ? 'open' : 'closed';
    body.hidden = !open;
    fold.textContent = open ? '−' : '+';
    head.setAttribute('aria-expanded', String(open));

    // 圆点只回答一个问题: 最后一条对话楼层现在对 AI 可见吗
    dot.className = 'mvb-dot';
    if (status.last_hidden !== null) {
      dot.classList.add(status.last_hidden ? 'is-warn' : 'is-ok');
    }

    hidden_badge.textContent = `${status.hidden}/${status.total} 隐藏`;
    hidden_badge.title = `${status.total} 条对话楼层中 ${status.hidden} 条对 AI 隐藏`;
    rules_badge.hidden = scheduled === 0;
    rules_count.textContent = `定时 ${scheduled}`;
    rules_badge.title = `${scheduled} 条定时规则待执行`;
    head.title = `${statusLabel(status)} · 点击${open ? '收起' : '展开'}楼层列表`;
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
    // 行里不显示摘要正文: 列表只用来定位楼层, 正文留在聊天区看;
    // 摘要退到 tooltip, 悬停仍能确认是不是这一层.
    const role_text = ROLE_TEXT[floor.role];
    const tip = `第 ${floor.message_id} 楼 · ${role_text}：${floor.excerpt || '（空）'}`;
    return (
      `<li class="mvb-acc${hidden ? ' is-hidden' : ''}" data-id="${floor.message_id}" data-state="${open ? 'open' : 'closed'}">` +
      `<div class="mvb-acc-head">` +
      `<button class="mvb-acc-trigger" type="button" data-role="edit" aria-expanded="${open}" aria-controls="${panelId(floor.message_id)}" aria-label="${escapeHtml(tip)}" title="${escapeHtml(tip)}">` +
      `<span class="mvb-acc-chevron">${ICON_CHEVRON_DOWN}</span>` +
      `<span class="mvb-row-id">#${floor.message_id}</span>` +
      `<span class="mvb-role mvb-role-${floor.role}">${role_text}</span>` +
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
    return el.querySelector<HTMLElement>(`.mvb-acc[data-id="${id}"]`);
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
  function collapseEditor(): void {
    if (!editor) {
      return;
    }
    const item = findItem(editor.id);
    editor = null;
    if (!item) {
      return;
    }
    setItemState(item, false);
    // 等高度收完再清内容, 否则会瞬间塌陷
    page_window.setTimeout(() => {
      if (item.dataset.state === 'closed') {
        unmountEditor(item);
      }
    }, 180);
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
    const box = editor && el.querySelector<HTMLElement>(`[data-editor="${editor.id}"]`);
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
    const open_state = editor;
    const focused_rounds = Boolean(
      open_state &&
        el.querySelector(`[data-editor="${open_state.id}"] .mvb-editor-rounds`) === page_document.activeElement,
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

  /** 筛选态 / 清除定时按钮 / 可见窗口输入框, 与列表一起刷新 */
  function renderChrome(): void {
    const { rules, window_rounds, prefs } = snapshot();

    el.querySelectorAll<HTMLElement>('[data-role="filter"]').forEach(button => {
      const active = button.dataset.filter === prefs.filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });

    const clear = el.querySelector<HTMLElement>('[data-role="clear-rules"]');
    if (clear) {
      clear.hidden = rules.length === 0;
    }

    const window_input = el.querySelector<HTMLInputElement>('.mvb-window-input');
    if (window_input && page_document.activeElement !== window_input) {
      window_input.value = String(window_rounds);
    }
  }

  function render(): void {
    renderHead();
    if (isOpen()) {
      renderChrome();
      renderList();
    }
  }

  // ── 开关 ──────────────────────────────────────────────
  function setCollapsed(collapsed: boolean): void {
    if (snapshot().prefs.collapsed === collapsed) {
      return;
    }
    if (collapsed) {
      collapseEditor();
    }
    handlers.setPrefs({ collapsed });
    render();
    if (!collapsed) {
      // 展开后让键盘用户直接能筛楼层
      el.querySelector<HTMLElement>('.mvb-tab.is-active')?.focus();
    }
  }

  function setBusy(next: boolean): void {
    busy = next;
    el.classList.toggle('mvb-busy', next);
  }

  /** 上层操作失败时只提示, 不收起面板 */
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
  el.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const control = target?.closest<HTMLElement>('[data-role]');
    const role = control?.dataset.role;

    if (role === 'fold') {
      setCollapsed(isOpen());
      return;
    }

    if (role === 'filter') {
      const filter = control?.dataset.filter as Filter | undefined;
      if (filter) {
        handlers.setPrefs({ filter });
        collapseEditor();
        render();
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
      const input = el.querySelector<HTMLInputElement>('.mvb-window-input');
      const rounds = clampRounds(input?.value ?? '');
      void run(async () => {
        await handlers.window(rounds);
      });
      return;
    }

    if (role === 'clear-rules') {
      void run(async () => {
        collapseEditor();
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
      });
      return;
    }

    if (role === 'cancel-rule') {
      collapseEditor();
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
      });
    }
  });

  // 输入轮数 / 切换到点开关后, 才让确定取消出现
  el.addEventListener('input', event => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.mvb-editor-rounds');
    if (!input || !editor) {
      return;
    }
    editor.rounds = clampRounds(input.value);
    syncDirty();
  });

  // Esc 先收起手风琴, 再收起面板
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !isOpen()) {
      return;
    }
    if (editor) {
      collapseEditor();
      return;
    }
    setCollapsed(true);
  };
  page_document.addEventListener('keydown', onKeyDown);

  return {
    el,
    refresh: render,
    setVisible(visible: boolean) {
      el.hidden = !visible;
    },
    destroy() {
      page_document.removeEventListener('keydown', onKeyDown);
      const row = el.parentElement;
      el.remove();
      // 行是共享的: 只剩下一个空壳时顺手删掉, 免得留一条 6px 的空行
      if (row?.id === 'tavern-status-row' && row.childElementCount === 0) {
        row.remove();
      }
    },
  };
}
