/**
 * 楼层可见性的纯逻辑: 不碰 DOM 与酒馆接口, 方便单测与推敲规则.
 *
 * 术语:
 *  - 楼层 (floor)  一条聊天消息, 由酒馆的 `is_hidden` 决定是否进入提示词.
 *  - 轮 (round)    一次 AI 回复. 用户发一句、AI 回一句算一轮, 因此一轮的落点是 assistant 楼层.
 */

export type RuleAction = 'hide' | 'show';

export type Rule = {
  message_id: number;
  /** 到点之后要把这条楼层设成可见还是隐藏 */
  action: RuleAction;
  /** 还剩几轮 */
  rounds_left: number;
};

export type Floor = {
  message_id: number;
  role: 'system' | 'assistant' | 'user';
  name: string;
  is_hidden: boolean;
  excerpt: string;
};

export type Visibility = { message_id: number; hidden: boolean };

export type Stored = {
  rules: Rule[];
  /** 上次「最近 N 轮可见」用过的 N, 回填输入框 */
  window_rounds: number;
  version: 1;
};

/** 持久化到聊天变量的键, 同一聊天共享, 换聊天自动隔离 */
export const STORAGE_KEY = 'tt_message_visibility';

export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 99;
export const DEFAULT_WINDOW_ROUNDS = 3;

export const EMPTY_STORED: Stored = { rules: [], window_rounds: DEFAULT_WINDOW_ROUNDS, version: 1 };

export function clampRounds(value: unknown): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WINDOW_ROUNDS;
  }
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, parsed));
}

function normalizeRule(value: unknown): Rule | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const message_id = Math.round(Number(raw.message_id));
  const rounds_left = Math.round(Number(raw.rounds_left));
  const action = raw.action;
  if (!Number.isInteger(message_id) || message_id < 0) {
    return null;
  }
  if (!Number.isInteger(rounds_left) || rounds_left < 0) {
    return null;
  }
  if (action !== 'hide' && action !== 'show') {
    return null;
  }
  return { message_id, action, rounds_left };
}

/** 聊天变量是外部数据: 结构不对就整条丢掉, 不让脏数据把面板打崩 */
export function parseStored(value: unknown): Stored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_STORED, rules: [] };
  }
  const raw = value as Record<string, unknown>;
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(normalizeRule).filter((rule): rule is Rule => rule !== null)
    : [];
  // 同一楼层只保留最后一条规则, 免得界面显示与执行不一致
  const deduped = new Map<number, Rule>();
  rules.forEach(rule => deduped.set(rule.message_id, rule));
  return {
    rules: [...deduped.values()].sort((a, b) => a.message_id - b.message_id),
    window_rounds: clampRounds(raw.window_rounds ?? DEFAULT_WINDOW_ROUNDS),
    version: 1,
  };
}

export function findRule(rules: Rule[], message_id: number): Rule | undefined {
  return rules.find(rule => rule.message_id === message_id);
}

/** 设置/覆盖一条规则; rounds 为 0 表示取消 */
export function upsertRule(rules: Rule[], message_id: number, action: RuleAction, rounds: number): Rule[] {
  const rest = rules.filter(rule => rule.message_id !== message_id);
  if (rounds <= 0) {
    return rest;
  }
  return [...rest, { message_id, action, rounds_left: clampRounds(rounds) }].sort(
    (a, b) => a.message_id - b.message_id,
  );
}

/** 一轮结束: 所有规则各减一轮, 减到 0 的触发 */
export function tickRules(rules: Rule[]): { fired: Rule[]; remaining: Rule[] } {
  const fired: Rule[] = [];
  const remaining: Rule[] = [];
  for (const rule of rules) {
    const rounds_left = rule.rounds_left - 1;
    if (rounds_left <= 0) {
      fired.push({ ...rule, rounds_left: 0 });
    } else {
      remaining.push({ ...rule, rounds_left });
    }
  }
  return { fired, remaining };
}

export function describeRule(rule: Rule): string {
  return `${rule.rounds_left} 轮后${rule.action === 'hide' ? '隐藏' : '可见'}`;
}

export function summarize(floors: Floor[], rules: Rule[]) {
  return {
    total: floors.filter(floor => floor.role !== 'system').length,
    hidden: floors.filter(floor => floor.role !== 'system' && floor.is_hidden).length,
    scheduled: rules.length,
  };
}

/** 全部可见 / 全部隐藏; 系统楼层不动, 它们不参与对话 */
export function planAll(floors: Floor[], hidden: boolean): Visibility[] {
  return floors
    .filter(floor => floor.role !== 'system' && floor.is_hidden !== hidden)
    .map(floor => ({ message_id: floor.message_id, hidden }));
}

/**
 * 「只让最近 N 轮可见」:
 * 从末尾往前数 N 条 AI 回复, 落点作为边界; 边界之前(含)的楼层隐藏, 之后的可见.
 * 若边界前一条是用户提问, 一并保留 —— 只留回答不留问题, AI 会看不懂在接什么.
 * 轮数不足 N 时全部可见.
 */
export function planWindow(floors: Floor[], rounds: number): Visibility[] {
  const ordered = floors
    .filter(floor => floor.role !== 'system')
    .slice()
    .sort((a, b) => a.message_id - b.message_id);

  if (ordered.length === 0) {
    return [];
  }

  const wanted = clampRounds(rounds);
  let seen = 0;
  let start = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index].role !== 'assistant') {
      continue;
    }
    seen += 1;
    if (seen === wanted) {
      start = index;
      break;
    }
  }
  if (start > 0 && ordered[start - 1].role === 'user') {
    start -= 1;
  }

  const boundary = ordered[start].message_id;
  return ordered
    .filter(floor => floor.is_hidden !== floor.message_id < boundary)
    .map(floor => ({ message_id: floor.message_id, hidden: floor.message_id < boundary }));
}

/** 楼层被删掉后, 对应规则也失效; 返回需要清理的 id */
export function staleRuleIds(rules: Rule[], floors: Floor[]): number[] {
  const alive = new Set(floors.map(floor => floor.message_id));
  return rules.filter(rule => !alive.has(rule.message_id)).map(rule => rule.message_id);
}
