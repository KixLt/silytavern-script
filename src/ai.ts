import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

import { ProgressSchema, stringifyProgress, type Progress } from './schema';

const SYSTEM_PROMPT = `你是剧情进度记录员。你会收到「现有剧情进度」和一段「新对话」。
请阅读新对话, 把其中值得记住的剧情进展合并进现有记录, 输出更新后的完整记录。

要求:
- 只修改确实发生变化的内容; 现有记录中仍然有效的信息必须保留, 不要因为新对话没提到就删除或缩短;
- 不得编造新对话中没有出现的信息;
- 使用简体中文, 每一条尽量简短;
- 「关键事件」按时间顺序, 最多保留最近 12 条, 更早的事件可以合并或省略;
- 「人物」键为角色名, 值为该角色当前的状态、关系或位置;
- 「未解伏笔」记录尚未揭示的疑问、承诺、约定;
- 只输出 JSON 对象本身, 不要输出解释、Markdown 代码块或其他多余文字。

JSON 结构:
{"时间":"","地点":"","当前目标":"","关键事件":[""],"人物":{"角色名":"状态"},"未解伏笔":[""]}`;

const MAX_MESSAGE_CHARS = 1500;
const MAX_INPUT_CHARS = 24000;

function buildUserInput(current: Progress, messages: ChatMessage[]): string {
  const history = messages.map(message => {
    const content =
      message.message.length > MAX_MESSAGE_CHARS
        ? `${message.message.slice(0, MAX_MESSAGE_CHARS)}…`
        : message.message;
    return `[#${message.message_id} ${message.role === 'user' ? '用户' : '角色'}/${message.name}] ${content}`;
  });
  let dialogue = history.join('\n\n');
  if (dialogue.length > MAX_INPUT_CHARS) {
    dialogue = `…(更早的内容已省略)\n\n${dialogue.slice(dialogue.length - MAX_INPUT_CHARS)}`;
  }

  const saved = stringifyProgress(current).trim();
  return `【现有剧情进度】\n${saved || '（空）'}\n\n【新对话】\n${dialogue}`;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? body.slice(start, end + 1) : body;

  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(jsonrepair(candidate));
  }
}

const toMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 让 AI 把待同步楼层合并进现有进度, 返回合并后的完整进度 */
export async function computeProgress(current: Progress, messages: ChatMessage[]): Promise<Progress> {
  const base_input = buildUserInput(current, messages);
  let last_error = '未知错误';

  for (let attempt = 0; attempt < 2; attempt++) {
    const user_input =
      attempt === 0
        ? base_input
        : `${base_input}\n\n【上一次输出无效】\n${last_error}\n请严格按照 JSON 结构重新输出完整记录.`;

    const raw = await generateRaw({
      user_input,
      should_silence: true,
      ordered_prompts: [{ role: 'system', content: SYSTEM_PROMPT }, 'user_input'],
    });

    try {
      const parsed = ProgressSchema.safeParse(extractJson(raw));
      if (!parsed.success) {
        throw Error(z.prettifyError(parsed.error));
      }
      return parsed.data;
    } catch (error) {
      last_error = toMessage(error);
      console.warn(`[剧情进度状态栏] 第 ${attempt + 1} 次解析 AI 回复失败`, error);
    }
  }

  throw Error(`AI 返回的剧情进度无法解析: ${last_error}`);
}
