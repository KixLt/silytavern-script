import { emptyProgress, parseProgress, stringifyProgress, type Progress } from './schema';

export const ENTRY_NAME = '【剧情进度】';
export const FALLBACK_WORLDBOOK_NAME = '剧情进度';

export type ProgressState = {
  worldbook_name: string;
  entry: WorldbookEntry | null;
  progress: Progress;
  synced_message_id: number;
  updated_at: string | null;
};

const ENTRY_PRESET: Partial<WorldbookEntry> = {
  enabled: true,
  probability: 100,
  strategy: {
    type: 'constant',
    keys: [],
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 'same_as_global',
  },
  position: { type: 'at_depth', role: 'system', depth: 2, order: 100 },
  recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
  effect: { sticky: null, cooldown: null, delay: null },
};

async function resolveWorldbookName(): Promise<string> {
  const chat_worldbook = getChatWorldbookName('current');
  if (chat_worldbook) {
    return chat_worldbook;
  }
  const character_worldbook = getCharWorldbookNames('current').primary;
  if (character_worldbook) {
    return character_worldbook;
  }
  console.info('[剧情进度状态栏] 当前聊天没有绑定世界书, 将创建一个聊天世界书');
  return await getOrCreateChatWorldbook('current', FALLBACK_WORLDBOOK_NAME);
}

export async function loadProgressState(): Promise<ProgressState> {
  const worldbook_name = await resolveWorldbookName();
  const entries = await getWorldbook(worldbook_name);
  const entry = entries.find(item => item.name === ENTRY_NAME) ?? null;
  const synced_message_id = entry?.extra?.synced_message_id;

  return {
    worldbook_name,
    entry,
    progress: entry ? parseProgress(entry.content) : emptyProgress(),
    synced_message_id: typeof synced_message_id === 'number' ? synced_message_id : -1,
    updated_at: typeof entry?.extra?.updated_at === 'string' ? entry.extra.updated_at : null,
  };
}

export async function saveProgress(
  state: ProgressState,
  progress: Progress,
  synced_message_id: number,
): Promise<void> {
  const content = stringifyProgress(progress);
  const extra = {
    ...state.entry?.extra,
    synced_message_id,
    updated_at: new Date().toISOString(),
  };

  if (state.entry) {
    const entry_uid = state.entry.uid;
    const updated = await updateWorldbookWith(state.worldbook_name, worldbook =>
      worldbook.map(item => (item.uid === entry_uid ? { ...item, content, extra } : item)),
    );
    if (!updated.some(item => item.uid === entry_uid)) {
      throw Error(`世界书「${state.worldbook_name}」中的条目「${ENTRY_NAME}」已不存在, 请刷新后重试`);
    }
    return;
  }

  await createWorldbookEntries(state.worldbook_name, [{ ...ENTRY_PRESET, name: ENTRY_NAME, content, extra }]);
  console.info(`[剧情进度状态栏] 已在世界书「${state.worldbook_name}」中创建条目「${ENTRY_NAME}」`);
}

/** 取所有尚未同步到世界书的楼层, 按楼层号升序 */
export function getPendingMessages(synced_message_id: number): ChatMessage[] {
  const start = Math.max(0, synced_message_id + 1);
  return getChatMessages(`${start}-{{lastMessageId}}`).filter(
    message =>
      message.message_id > synced_message_id &&
      !message.is_hidden &&
      message.role !== 'system' &&
      message.message.trim() !== '',
  );
}
