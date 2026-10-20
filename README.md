# 剧情进度状态栏

酒馆助手 (JS-Slash-Runner) 脚本: 在酒馆输入栏上方加一条状态栏, 让 AI 把剧情进度同步进世界书条目。

```
┌──────────────────────────────────────────────┐
│  📖 剧情进度        🕘 待同步 ③          ⟳  │
└──────────────────────────────────────────────┘
```

| 按钮 | 行为 |
| --- | --- |
| 左 `剧情进度` | 弹出 popover, 显示世界书条目里**当前已保存**的进度 (YAML) |
| 中 `待同步` | 弹出 popover, 把「上次同步之后的楼层」交给模型, 计算并显示**待写入的改动** (字段级 diff); 徽标显示待同步楼层数 |
| 右 `⟳` | 先算待同步改动, 弹出确认框; 确认后才真正写入世界书并把已同步位置推进到本批最后一楼 |

## 构建

```bash
pnpm install
pnpm build     # 产物: dist/剧情进度状态栏/index.js
```

开发时用 `pnpm dev`(即 `vite build --watch`) 监听改动, 配合酒馆助手的「实时监听」与 Live Server 即可热重载。

## 在酒馆中使用

把 `dist/剧情进度状态栏/index.js` 的内容贴进酒馆助手脚本库的脚本内容; 或者用实时监听:

```js
import 'http://localhost:5500/dist/剧情进度状态栏/index.js'
```

脚本挂载在 `#send_form` 之前, 没有打开聊天时会自动隐藏。

## 数据存放

- 世界书: 优先用当前聊天绑定的世界书 → 角色卡主世界书 → 都没有时自动创建聊天世界书 `剧情进度`。
- 条目: 名称 `【剧情进度】`(常量/蓝灯, 插入 `at_depth` + `system`, 深度 2), 不存在时在首次同步时自动创建。
- 进度内容: 条目 `content`, 为下列结构的 YAML:

```yaml
时间: 夜晚
地点: 废弃车站
当前目标: 找到钥匙对应的锁
关键事件:
  - 抵达废弃车站
  - 在长椅下发现生锈的钥匙
人物:
  青空莉: 同行, 警惕
未解伏笔:
  - 钥匙能打开什么
```

- 同步位置: 条目 `extra.synced_message_id`(最后已同步的楼层号), `extra.updated_at`(最后同步时间)。

## 同步流程

1. 点 `⟳`(或先点 `待同步` 预览)。
2. 脚本取 `synced_message_id` 之后的非隐藏、非 system 楼层(单次最多 60 条, 从最早的开始)。
3. 用 `generateRaw` 静默调用当前模型, 让它把这段对话**合并**进已有进度, 只输出完整 JSON; 解析失败(含 YAML 拼写错误、未加引号的键、尾逗号)会用 `jsonrepair` 修复并重试一次。
4. 与已保存进度做字段级 diff, 确认框展示 `+ 新增 / ~ 修改 / - 删除`。
5. 确认后写回世界书 `content` 与 `extra`, 并且只推进到本批最后一楼; 剩余楼层下次再同步。

模型返回的内容会经 zod 校验, 不合结构会带着错误信息重试一次, 仍失败则在 popover 中报错且不写入。

## 可调项

- `src/worldbook.ts`: `ENTRY_NAME`、`FALLBACK_WORLDBOOK_NAME`、新建条目的插入位置/深度。
- `src/index.ts`: `MAX_PENDING_MESSAGES`(单次同步上限)、`REFRESH_DEBOUNCE_MS`。
- `src/ai.ts`: `SYSTEM_PROMPT`(进度字段与取值要求)、单条消息截断长度、输入总长度上限。

## 目录

```
src/
  index.ts     挂载、事件监听、刷新与同步编排
  ui.ts        状态栏与 popover
  worldbook.ts 世界书/条目定位与读写
  ai.ts        提示词与 AI 调用、容错解析
  schema.ts    zod 结构、YAML 读写、字段级 diff
  styles.css   注入到酒馆 <head> 的样式
  types/       酒馆助手全局接口的最小声明
```

## 要求

- 酒馆助手需提供 `getWorldbook` / `updateWorldbookWith` / `createWorldbookEntries` / `generateRaw` / `eventOn` 等接口。
- 同步依赖酒馆当前使用的模型可用; 模型不可用时 popover 会直接显示错误, 不会改动世界书。
