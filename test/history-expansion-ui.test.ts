import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { lexer } from "marked";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  disabled = false;
  hidden = false;
  open = true;
  ontoggle?: () => void;
  className = "";
  onclick?: () => Promise<void>;
  private value = "";
  constructor(
    readonly nodeName: string,
    text = "",
  ) {
    this.value = text;
  }
  append(...nodes: Element[]) {
    for (const node of nodes)
      this.children.push(
        ...(node.nodeName === "#fragment" ? node.children : [node]),
      );
  }
  replaceChildren(...nodes: Element[]) {
    this.children = [];
    this.value = "";
    this.append(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  get textContent(): string {
    return (
      this.value + this.children.map((child) => child.textContent).join("")
    );
  }
  set textContent(value: string) {
    this.value = value;
    this.children = [];
  }
}
const document = {
  createElement: (tag: string) => new Element(tag),
  createDocumentFragment: () => new Element("#fragment"),
  createTextNode: (text: string) => new Element("#text", text),
};
const markdownSource = readFileSync(
  new URL("../public/markdown.js", import.meta.url),
  "utf8",
)
  .replace(/^import \{ lexer \} from "\/marked\.js";\s*/m, "")
  .replaceAll("export function ", "function ");
const renderMarkdown = runInNewContext(`${markdownSource}\nrenderMarkdown`, {
  lexer,
  document,
  URL,
}) as (text: string) => Element;
const appSource = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const expansionSource = appSource.slice(
  appSource.indexOf("function fullContentButton("),
  appSource.indexOf("function render(snapshot)"),
);
function fixture(read: (path: string) => Promise<unknown>, role = "assistant") {
  const calls: string[] = [];
  const inputs: string[] = [];
  const controller = runInNewContext(
    `${expansionSource}\n({ inlineHistoryButton: typeof inlineHistoryButton === "function" ? inlineHistoryButton : undefined, navigate(){conversationId="3";conversationSelectionVersion++;} })`,
    {
      document,
      conversationId: "2",
      conversationSelectionVersion: 1,
      api: async (path: string) => {
        calls.push(path);
        return read(path);
      },
      node: document.createElement,
      t: (source: string) => source,
      uiNode: (tag: string, label: () => string) => {
        const node = document.createElement(tag);
        node.textContent = label();
        return node;
      },
      text: (node: Element, label: () => string) => {
        node.textContent = label();
      },
      plain: (node: Element, value: string) => {
        node.textContent = value;
      },
      attr: (node: Element, key: string, label: () => string) =>
        node.setAttribute(key, label()),
      guard: (fn: () => Promise<void>) => fn,
      renderMarkdown: (source: string) => {
        inputs.push(source);
        return renderMarkdown(source);
      },
      renderTextPreview: (source: string) => {
        inputs.push(source);
        const pre = new Element("pre");
        pre.textContent = source;
        return pre;
      },
    },
  ) as {
    navigate(): void;
    inlineHistoryButton?: (
      path: string,
      body: Element,
      role: string,
      details?: Element,
    ) => Element;
  };
  assert.equal(
    typeof controller.inlineHistoryButton,
    "function",
    "truncated history must offer inline expansion",
  );
  const body = new Element("div", "Original preview");
  const details = new Element("details");
  details.ontoggle = () => {
    body.textContent = details.open ? "Original preview" : "";
  };
  const button = controller.inlineHistoryButton!(
    "/api/conversations/2/history/100/0",
    body,
    role,
    role === "toolResult" ? details : undefined,
  );
  return {
    body,
    button,
    calls,
    inputs,
    details,
    navigate: controller.navigate,
  };
}
function findAll(root: Element, tag: string): Element[] {
  return [
    ...(root.nodeName === tag ? [root] : []),
    ...root.children.flatMap((child) => findAll(child, tag)),
  ];
}

test("long history expands inline page by page without unbounded Markdown work or executable HTML", async () => {
  const pieces = [
    "# Readable heading\n\n**Safe bold** [safe](https://example.invalid/)\n\n",
    ...Array.from({ length: 64 }, () => "x".repeat(16384)),
    "<script>alert(1)</script> [bad](javascript:alert(1))" + "z".repeat(13000),
  ];
  let index = 0;
  let offset = 0;
  const ui = fixture(async () => {
    const text = pieces[index++];
    const previous = offset;
    offset += text.length;
    return {
      text,
      offset: previous,
      nextOffset: index === pieces.length ? null : offset,
      totalChars: pieces.join("").length,
    };
  });
  assert.equal(
    ui.calls.length,
    0,
    "collapsed history never fetches full content",
  );
  await ui.button.onclick!();
  assert.ok(ui.body.textContent.includes("Readable heading"));
  assert.ok(!ui.body.textContent.includes("Original preview"));
  assert.equal(findAll(ui.body, "h1").length, 1);
  assert.equal(findAll(ui.body, "strong").length, 1);
  await ui.button.onclick!();
  assert.ok(ui.body.textContent.includes("x".repeat(16384)));
  for (let page = 2; page < pieces.length; page++) await ui.button.onclick!();
  assert.ok(ui.body.textContent.includes("z".repeat(13000)));
  assert.ok(ui.body.textContent.includes("<script>alert(1)</script>"));
  assert.equal(findAll(ui.body, "script").length, 0);
  assert.equal(findAll(ui.body, "a").length, 1);
  assert.ok(ui.inputs.every((input) => input.length <= 16384));
  assert.ok(ui.body.textContent.length > 32768);
  assert.equal(ui.button.hidden, true);
  assert.deepEqual(
    ui.calls,
    pieces.map(
      (_piece, index) =>
        `/api/conversations/2/history/100/0?view=text&offset=${pieces.slice(0, index).join("").length}`,
    ),
  );
});

test("a failed expansion leaves the preview intact and allows retry at the same cursor", async () => {
  let fail = true;
  const ui = fixture(async () => {
    if (fail) throw new Error("offline");
    return {
      text: "Complete text",
      offset: 0,
      nextOffset: null,
      totalChars: 13,
    };
  });
  await assert.rejects(ui.button.onclick!(), /offline/);
  assert.equal(ui.body.textContent, "Original preview");
  assert.equal(ui.button.disabled, false);
  fail = false;
  await ui.button.onclick!();
  assert.equal(ui.body.textContent, "Complete text");
  assert.equal(ui.calls[0], ui.calls[1]);
});

test("collapsed tool results release expansion and reopen with a fresh text cursor", async () => {
  const ui = fixture(
    async () => ({
      text: "Complete tool text",
      offset: 0,
      nextOffset: null,
      totalChars: 18,
    }),
    "toolResult",
  );
  await ui.button.onclick!();
  assert.equal(ui.body.textContent, "Complete tool text");
  assert.equal(ui.button.hidden, true);
  ui.details.open = false;
  ui.details.ontoggle!();
  assert.equal(ui.body.textContent, "");
  ui.details.open = true;
  ui.details.ontoggle!();
  assert.equal(ui.button.hidden, false);
  await ui.button.onclick!();
  assert.equal(ui.body.textContent, "Complete tool text");
  assert.equal(ui.calls[0], ui.calls[1]);
});

test("metadata-only omissions keep short signed answers complete without download warnings or expansion", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking" },
      { type: "text", text: "**Complete answer.**" },
    ],
    previewTruncated: false,
    previewMetadataOmitted: true,
    previewContentTruncated: false,
  };
  const renderHistory = appSource.slice(
    appSource.indexOf(
      "  for (const [index, message] of page.messages.entries())",
    ),
    appSource.indexOf('  const live = snapshot.view.docs["pi.live"];'),
  );
  let downloads = 0;
  let expansions = 0;
  const messages = runInNewContext(
    `const messages=[]; ${renderHistory}; messages`,
    {
      page: { messages: [message], keys: ["100:0"] },
      historyNodes: new Map(),
      conversationId: "2",
      document,
      node: (tag: string) => document.createElement(tag),
      uiNode: (tag: string, label: () => string) => {
        const node = document.createElement(tag);
        node.textContent = label();
        return node;
      },
      t: (value: string) => value,
      piMark: () => new Element("svg"),
      icon: () => new Element("svg"),
      renderTextPreview: (value: string) => new Element("pre", value),
      createToolCalls: () => [],
      renderMarkdown,
      fullContentButton: () => {
        downloads++;
        return new Element("button");
      },
      inlineHistoryButton: () => {
        expansions++;
        return new Element("button");
      },
    },
  ) as Element[];
  assert.equal(messages[0].textContent, "PiComplete answer.");
  assert.equal(downloads, 0);
  assert.equal(expansions, 0);
  assert.equal(findAll(messages[0], "button").length, 0);
});

test("history expansion responses cannot hydrate a conversation after navigation", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((resolvePage) => {
    resolve = resolvePage;
  });
  const ui = fixture(() => pending);
  const read = ui.button.onclick!();
  ui.navigate();
  resolve({
    text: "Stale full text",
    offset: 0,
    nextOffset: null,
    totalChars: 15,
  });
  await read;
  assert.equal(ui.body.textContent, "Original preview");
  assert.equal(ui.button.disabled, false);
});

test("a late tool expansion response stays discarded after collapse", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((resolvePage) => {
    resolve = resolvePage;
  });
  const ui = fixture(() => pending, "toolResult");
  const read = ui.button.onclick!();
  ui.details.open = false;
  ui.details.ontoggle!();
  resolve({
    text: "Stale full text",
    offset: 0,
    nextOffset: null,
    totalChars: 15,
  });
  await read;
  assert.equal(ui.body.textContent, "");
  assert.equal(ui.button.hidden, false);
});
