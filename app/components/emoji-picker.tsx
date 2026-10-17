import { version } from "emojibase-data/package.json";
import { EmojiPicker as Picker, type EmojiPickerListComponents } from "frimousse";

// emojibase's zh group names are uneven and mix in traditional characters (食物飲料).
const categoryLabels: Partial<Record<string, string>> = {
  笑脸: "笑脸与情感",
  人体: "人物与身体",
  野生动物: "动物与自然",
  食物飲料: "食物与饮料",
  旅遊地點: "旅行与地点",
  个人活动: "活动",
  物件: "物品",
  人的符号: "符号",
};

const listComponents: EmojiPickerListComponents = {
  CategoryHeader: ({ category, ...props }) => (
    <div
      className="bg-popover px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground"
      {...props}
    >
      {categoryLabels[category.label] ?? category.label}
    </div>
  ),
  Row: ({ children, ...props }) => (
    <div className="scroll-my-1.5 px-1.5" {...props}>
      {children}
    </div>
  ),
  Emoji: ({ emoji, ...props }) => (
    <button
      className="flex size-9 items-center justify-center rounded-lg text-xl data-active:bg-accent"
      {...props}
    >
      {emoji.emoji}
    </button>
  ),
};

// Loaded only when a picker opens (see emoji-button.tsx). The data is copied from emojibase-data
// on install and served by us: jsDelivr, frimousse's default, is unreliable from mainland China.
// frimousse keeps it in localStorage and rechecks once per session; the versioned path lets
// the proxy cache it for a year, so that recheck is answered by the browser cache.
export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <Picker.Root
      locale="zh"
      emojibaseUrl={`/emojibase/${version}`}
      columns={8}
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
      className="isolate flex h-80 w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
    >
      <Picker.Search
        placeholder="搜索表情"
        className="m-2 h-8 shrink-0 rounded-lg bg-secondary px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <Picker.Viewport className="relative flex-1 outline-none">
        <Picker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          加载中…
        </Picker.Loading>
        <Picker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          未找到表情
        </Picker.Empty>
        <Picker.List className="pb-1.5 select-none" components={listComponents} />
      </Picker.Viewport>
    </Picker.Root>
  );
}
