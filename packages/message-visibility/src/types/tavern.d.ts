declare module '*.css?inline' {
  const content: string;
  export default content;
}

// 酒馆助手在脚本 iframe 中注入的全局接口, 只声明本脚本用到的部分.

type ChatMessage = {
  message_id: number;
  name: string;
  role: 'system' | 'assistant' | 'user';
  is_hidden: boolean;
  message: string;
  data: Record<string, any>;
  extra: Record<string, any>;
};

type VariableOption = { type: 'chat' | 'preset' | 'global' } | { type: 'character' };

declare function getChatMessages(range: string | number, options?: { include_swipes?: false }): ChatMessage[];
declare function setChatMessages(
  chat_messages: Array<{ message_id: number } & Partial<Pick<ChatMessage, 'is_hidden' | 'message'>>>,
  options?: { refresh?: 'none' | 'affected' | 'all' },
): Promise<void>;
declare function getLastMessageId(): number;

declare function getVariables(option: VariableOption): Record<string, any>;
declare function insertOrAssignVariables(
  variables: Record<string, any>,
  option: VariableOption,
): Record<string, any>;
declare function deleteVariable(
  variable_path: string,
  option: VariableOption,
): { variables: Record<string, any>; delete_occurred: boolean };

declare function eventOn(event: string, listener: (...args: any[]) => void): { stop(): void };
declare function errorCatched<T extends any[], U>(fn: (...args: T) => U): (...args: T) => U;

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
