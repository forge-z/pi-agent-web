import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";

type Snapshot = Awaited<ReturnType<Runtime["snapshot"]>>;
export const CHAT_PAGE_SIZE = 80;
export const CHAT_PREVIEW_CHARS = 4096;
export const CHAT_TEXT_PAGE_CHARS = 16384;
type Message = NonNullable<EntryRecord["model"]>[number];
const messageCache = new WeakMap<Message, ReturnType<typeof previewMessage>>();
const visibleRole = (message: Message) =>
  ["user", "assistant", "toolResult"].includes(message.role);

// Only the human presentation is abbreviated. Durable entries/model context
// are immutable and are never rewritten by this adapter.
function previewMessage(message: Message) {
  let remaining = CHAT_PREVIEW_CHARS;
  let nodes = 128;
  let truncated = false;
  let metadataOmitted = false;
  const preview = (value: unknown, depth = 0): unknown => {
    if (--nodes < 0 || depth > 6) {
      truncated = true;
      return "…";
    }
    if (typeof value === "string") {
      const result = value.slice(0, remaining);
      remaining -= result.length;
      if (result.length !== value.length) truncated = true;
      return result;
    }
    if (Array.isArray(value)) {
      if (value.length > 16) truncated = true;
      return value.slice(0, 16).map((item) => preview(item, depth + 1));
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      // Only direct native content blocks carry provider signatures. Matching
      // names inside tool arguments remain user data.
      const blockType =
        depth === 1 && Array.isArray(message.content)
          ? (value as { type?: unknown }).type
          : undefined;
      let fields = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        // Provider-only bytes are omitted metadata, not missing visible text.
        if (
          blockType &&
          (key === "data" ||
            key === "thinking" ||
            key === "signature" ||
            (blockType === "thinking" && key === "thinkingSignature") ||
            (blockType === "text" && key === "textSignature"))
        ) {
          metadataOmitted = true;
          continue;
        }
        if (++fields > 16) {
          truncated = true;
          break;
        }
        result[key.slice(0, 128)] = preview(
          (value as Record<string, unknown>)[key],
          depth + 1,
        );
      }
      return result;
    }
    return value;
  };
  const content = preview(message.content);
  const originalText = visibleTextParts(message.content);
  const projectedText = visibleTextParts(content);
  const previewTruncated =
    originalText.length !== projectedText.length ||
    originalText.some((part, index) => part !== projectedText[index]);
  return {
    role: message.role,
    ...(message.role === "toolResult"
      ? { toolName: message.toolName.slice(0, 128), isError: message.isError }
      : {}),
    content,
    previewTruncated,
    previewMetadataOmitted: metadataOmitted,
    previewContentTruncated: truncated && !previewTruncated,
  };
}

function visibleTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
}

// Slice only rendered text. No provider metadata or whole-message JSON is
// allocated for a page, and the source durable message remains untouched.
export function chatMessageTextPage(message: Message, offset = 0) {
  const parts = visibleTextParts(message.content);
  const totalChars =
    parts.reduce((total, part) => total + part.length, 0) +
    Math.max(0, parts.length - 1);
  let text = "";
  let position = 0;
  for (const [index, part] of parts.entries()) {
    for (const segment of index ? ["\n", part] : [part]) {
      const start = Math.max(0, offset - position);
      const available = CHAT_TEXT_PAGE_CHARS - text.length;
      if (available > 0 && start < segment.length)
        text += segment.slice(start, start + available);
      position += segment.length;
    }
    if (text.length === CHAT_TEXT_PAGE_CHARS) break;
  }
  // Preserve normal Markdown block boundaries without allowing an unbounded
  // paragraph or code block to exceed the hard page size.
  if (offset + text.length < totalChars) {
    const boundary = text.lastIndexOf("\n\n") + 2;
    if (boundary >= CHAT_TEXT_PAGE_CHARS / 2) text = text.slice(0, boundary);
  }
  // Keep UTF-16 surrogate pairs together across transport pages.
  if (/[\uD800-\uDBFF]$/.test(text) && offset + text.length < totalChars)
    text = text.slice(0, -1);
  const nextOffset = offset + text.length;
  return {
    text,
    offset,
    nextOffset: nextOffset < totalChars ? nextOffset : null,
    totalChars,
  };
}

export function chatSnapshot(snapshot: Snapshot, requestedPage = 0) {
  // Count lightweight message references; never serialize historical bodies.
  let total = 0;
  for (const entry of snapshot.view.entries)
    if (entry.kind !== "app.cua-control")
      for (const message of entry.model ?? [])
        if (visibleRole(message)) total++;
  const pages = Math.max(1, Math.ceil(total / CHAT_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const end = total - page * CHAT_PAGE_SIZE;
  const start = Math.max(0, end - CHAT_PAGE_SIZE);
  const visible: { key: string; message: ReturnType<typeof previewMessage> }[] =
    [];
  let position = 0;
  for (const entry of snapshot.view.entries) {
    if (entry.kind === "app.cua-control") continue;
    for (const [index, message] of (entry.model ?? []).entries()) {
      if (!visibleRole(message)) continue;
      if (position >= start && position < end) {
        let cached = messageCache.get(message);
        if (!cached) {
          cached = previewMessage(message);
          messageCache.set(message, cached);
        }
        visible.push({ key: `${entry.id}:${index}`, message: cached });
      }
      position++;
    }
  }
  const live = snapshot.view.docs["pi.live"];
  const generation = live?.generation as
    { message?: NonNullable<EntryRecord["model"]>[number] } | undefined;
  return {
    ...snapshot,
    view: {
      conversation: snapshot.view.conversation,
      entries: [],
      docs: live
        ? {
            "pi.live": {
              run: live.run ? true : null,
              generation: generation?.message
                ? { message: previewMessage(generation.message) }
                : null,
            },
          }
        : {},
    },
    history: {
      version: `${total}:${page}:${visible.map((item) => item.key).join(",")}`,
      messages: visible.map((item) => item.message),
      keys: visible.map((item) => item.key),
      page,
      pages,
      total,
    },
  };
}
