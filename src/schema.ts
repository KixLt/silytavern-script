import YAML from 'yaml';
import { z } from 'zod';

export const ProgressSchema = z.object({
  时间: z.string().default(''),
  地点: z.string().default(''),
  当前目标: z.string().default(''),
  关键事件: z.array(z.string()).default([]),
  人物: z.record(z.string(), z.string()).default({}),
  未解伏笔: z.array(z.string()).default([]),
});

export type Progress = z.infer<typeof ProgressSchema>;

export function emptyProgress(): Progress {
  return ProgressSchema.parse({});
}

export function parseProgress(raw: string): Progress {
  if (!raw.trim()) {
    return emptyProgress();
  }
  try {
    const data = YAML.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw Error('世界书条目内容不是 YAML 对象');
    }
    return ProgressSchema.parse(data);
  } catch (error) {
    console.warn('[剧情进度状态栏] 无法解析已保存的进度, 将按空进度处理', error);
    return emptyProgress();
  }
}

export function stringifyProgress(progress: Progress): string {
  return YAML.stringify(progress, { lineWidth: 0 });
}

export type DiffLine = {
  kind: 'change' | 'add' | 'remove';
  label: string;
  text: string;
  /** 仅 change: 新旧值, 供界面分辨"什么变了"; text 同时保留合并形式给纯文本场景 */
  from?: string;
  to?: string;
  /** 仅人物: 角色名, 供界面把人物归成一组并加名字前缀 */
  name?: string;
};

function diffList(label: string, before: string[], after: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  const before_keys = new Set(before);
  const after_keys = new Set(after);
  for (const item of after) {
    if (!before_keys.has(item)) {
      lines.push({ kind: 'add', label, text: item });
    }
  }
  for (const item of before) {
    if (!after_keys.has(item)) {
      lines.push({ kind: 'remove', label, text: item });
    }
  }
  return lines;
}

export function diffProgress(before: Progress, after: Progress): DiffLine[] {
  const lines: DiffLine[] = [];

  for (const key of ['时间', '地点', '当前目标'] as const) {
    const from = before[key].trim();
    const to = after[key].trim();
    if (from === to) {
      continue;
    }
    if (from && to) {
      lines.push({ kind: 'change', label: key, text: `${from} → ${to}`, from, to });
    } else if (to) {
      lines.push({ kind: 'add', label: key, text: to });
    } else {
      lines.push({ kind: 'remove', label: key, text: from });
    }
  }

  // 人物放在长列表之前: 弹窗高度有限, 别把它埋到滚动区底部
  const names = new Set([...Object.keys(before.人物), ...Object.keys(after.人物)]);
  for (const name of names) {
    const from = before.人物[name];
    const to = after.人物[name];
    if (from === to) {
      continue;
    }
    if (from === undefined) {
      lines.push({ kind: 'add', label: '人物', name, text: to });
    } else if (to === undefined) {
      lines.push({ kind: 'remove', label: '人物', name, text: from });
    } else {
      lines.push({ kind: 'change', label: '人物', name, text: `${from} → ${to}`, from, to });
    }
  }

  lines.push(...diffList('关键事件', before.关键事件, after.关键事件));
  lines.push(...diffList('未解伏笔', before.未解伏笔, after.未解伏笔));

  return lines;
}
