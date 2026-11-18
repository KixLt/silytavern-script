declare module '*.css?inline' {
  const content: string;
  export default content;
}

// 酒馆助手在脚本 iframe 中注入的全局接口, 仅声明本脚本用到的部分.

type ChatMessage = {
  message_id: number;
  name: string;
  role: 'system' | 'assistant' | 'user';
  is_hidden: boolean;
  message: string;
  data: Record<string, any>;
  extra: Record<string, any>;
};

type WorldbookEntry = {
  uid: number;
  name: string;
  enabled: boolean;
  strategy: {
    type: 'constant' | 'selective' | 'vectorized';
    keys: (string | RegExp)[];
    keys_secondary: { logic: 'and_any' | 'and_all' | 'not_all' | 'not_any'; keys: (string | RegExp)[] };
    scan_depth: 'same_as_global' | number;
  };
  position: {
    type:
      | 'before_character_definition'
      | 'after_character_definition'
      | 'before_example_messages'
      | 'after_example_messages'
      | 'before_author_note'
      | 'after_author_note'
      | 'at_depth'
      | 'outlet';
    role: 'system' | 'assistant' | 'user';
    depth: number;
    order: number;
  };
  content: string;
  probability: number;
  recursion: { prevent_incoming: boolean; prevent_outgoing: boolean; delay_until: number | null };
  effect: { sticky: number | null; cooldown: number | null; delay: number | null };
  extra?: Record<string, any>;
};

type WorldbookOptions = { render?: 'debounced' | 'immediate' };

declare function getChatWorldbookName(chat_name: 'current'): string | null;
declare function getCharWorldbookNames(character_name_or_id: 'current'): { primary: string | null; additional: string[] };
declare function getOrCreateChatWorldbook(chat_name: 'current', worldbook_name?: string): Promise<string>;
declare function getWorldbook(worldbook_name: string): Promise<WorldbookEntry[]>;
declare function updateWorldbookWith(
  worldbook_name: string,
  updater: (worldbook: WorldbookEntry[]) => WorldbookEntry[],
  options?: WorldbookOptions,
): Promise<WorldbookEntry[]>;
declare function createWorldbookEntries(
  worldbook_name: string,
  new_entries: Partial<WorldbookEntry>[],
  options?: WorldbookOptions,
): Promise<{ worldbook: WorldbookEntry[]; new_entries: WorldbookEntry[] }>;

declare function getChatMessages(
  range: string | number,
  options?: { role?: 'all' | 'system' | 'assistant' | 'user'; hide_state?: 'all' | 'unhidden' | 'hidden' },
): ChatMessage[];
declare function getLastMessageId(): number;

declare function eventOn(event: string, listener: (...args: any[]) => void): { stop(): void };
declare function errorCatched<T extends any[], U>(fn: (...args: T) => U): (...args: T) => U;
declare function getScriptId(): string;

type GenerateRawPrompt = string | { role: 'system' | 'assistant' | 'user'; content: string };
declare function generateRaw(config: {
  user_input?: string;
  should_silence?: boolean;
  should_stream?: boolean;
  ordered_prompts?: GenerateRawPrompt[];
  max_chat_history?: 'all' | number;
}): Promise<string>;

declare const tavern_events: {
  readonly MESSAGE_SENT: string;
  readonly MESSAGE_RECEIVED: string;
  readonly MESSAGE_UPDATED: string;
  readonly MESSAGE_DELETED: string;
  readonly CHAT_CHANGED: string;
  readonly GENERATION_ENDED: string;
};

declare const SillyTavern: { getCurrentChatId(): string | undefined };
declare const toastr: {
  success(message: string, title?: string): void;
  info(message: string, title?: string): void;
  warning(message: string, title?: string): void;
  error(message: string, title?: string): void;
};
