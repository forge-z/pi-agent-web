import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
class Element {
  children: Element[] = [];
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  required = false;
  type = "";
  id = "";
  htmlFor = "";
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  constructor(readonly tag: string) {}
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
}
function fixture() {
  const source = readFileSync(
    new URL("../public/telegram-deliveries.js", import.meta.url),
    "utf8",
  ).replace("export function", "function");
  const render = runInNewContext(`${source}\nrenderTelegramDeliveries`);
  const calls: unknown[][] = [];
  const ui = {
    node: (tag: string) => new Element(tag),
    t: (s: string, args: string[] = []) =>
      s.replace(/\{(\d+)\}/g, (_, n) => args[Number(n)]!),
    text: (e: Element, fn: () => string) => {
      e.textContent = fn();
      return e;
    },
    errorText: (s: string) => s,
    api: async (...args: unknown[]) => {
      calls.push(args);
    },
    refresh: async (id: string) => {
      calls.push(["refresh", id]);
    },
  };
  return { render, calls, ui };
}
const all = (e: Element): Element[] => [e, ...e.children.flatMap(all)];
test("uncertain delivery explains deletion block and requires explicit verified resolution on its captured conversation", async () => {
  const f = fixture();
  const cards = f.render(
    [
      {
        id: "telegram:control:1:0",
        state: "uncertain",
        blocksDeletion: true,
        canReconcile: true,
      },
    ],
    "12",
    f.ui,
  ) as Element[];
  assert.match(
    all(cards[0]!)
      .map((e) => e.textContent)
      .join(" "),
    /exclusão/,
  );
  const form = all(cards[0]!).find((e) => e.tag === "form")!;
  await form.onsubmit!({ preventDefault() {} });
  assert.equal(f.calls.length, 0);
  const note = all(form).find((e) => e.tag === "textarea")!;
  note.value = "Checked outside Pi";
  const checkbox = all(form).find((e) => e.type === "checkbox")!;
  checkbox.checked = true;
  await form.onsubmit!({ preventDefault() {} });
  assert.equal(
    JSON.stringify(f.calls[0]),
    JSON.stringify([
      "/api/conversations/12/deliveries/telegram%3Acontrol%3A1%3A0/reconcile",
      "POST",
      { note: "Checked outside Pi", confirm: true },
    ]),
  );
  assert.deepEqual(f.calls[1], ["refresh", "12"]);
});
test("sending and foreign-owned delivery blocks are visible without a resolution button", () => {
  const f = fixture();
  for (const row of [
    { state: "sending", canReconcile: false },
    { state: "uncertain", canReconcile: false },
  ]) {
    const cards = f.render(
      [{ id: "shared", ...row, blocksDeletion: true }],
      "12",
      f.ui,
    ) as Element[];
    assert.match(
      all(cards[0]!)
        .map((e) => e.textContent)
        .join(" "),
      /exclusão/,
    );
    assert.equal(
      all(cards[0]!).some((e) => e.tag === "form"),
      false,
    );
  }
});

test("unrelated history snapshots preserve a delivery verification draft", () => {
  const f = fixture();
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  const deliverySource = ");
  const end = source.indexOf("  if (nearBottom)", start);
  assert.ok(
    start >= 0,
    "delivery rendering must preserve drafts between identical ledgers",
  );
  const container = new Element("section") as Element & {
    replaceChildren: (...items: Element[]) => void;
  };
  container.replaceChildren = (...items) => {
    container.children = items;
  };
  const context = {
    snapshot: {
      deliveries: [
        {
          id: "uncertain",
          state: "uncertain",
          blocksDeletion: true,
          canReconcile: true,
        },
      ],
    },
    conversationId: "12",
    renderedDeliveries: "",
    renderTelegramDeliveries: f.render,
    telegramMirrorCard: () => null,
    ...f.ui,
    $: () => container,
    render: () => {},
  };
  const code = `{${source.slice(start, end)}}`;
  runInNewContext(code, context);
  const note = all(container).find((e) => e.tag === "textarea")!;
  note.value = "Verification in progress";
  runInNewContext(code, context);
  assert.equal(
    all(container).find((e) => e.tag === "textarea"),
    note,
  );
  assert.equal(note.value, "Verification in progress");
});

test("a web-input in flight is described as a pending copy, without claiming failure or offering unsafe recovery", () => {
  const f = fixture();
  const cards = f.render(
    [
      {
        id: "12:synthetic:web-input:0",
        state: "sending",
        blocksDeletion: true,
        canReconcile: false,
      },
    ],
    "12",
    f.ui,
  ) as Element[];
  const message = all(cards[0]!)
    .map((e) => e.textContent)
    .join(" ");
  assert.match(message, /mensagem da web.*copiada.*Telegram/);
  assert.doesNotMatch(message, /12:synthetic|falh|incerta/);
  assert.equal(
    all(cards[0]!).some((e) => e.tag === "form"),
    false,
  );
  assert.equal(f.calls.length, 0);
});

test("Telegram history can read an uncertain delivery without transport resolution controls", () => {
  const f = fixture();
  const cards = f.render(
    [{ id: "owned", state: "uncertain", canReconcile: true }],
    "12",
    { ...f.ui, readOnly: true },
  ) as Element[];
  assert.ok(all(cards[0]!).some((e) => /incerta/.test(e.textContent)));
  assert.equal(
    all(cards[0]!).some((e) => e.tag === "form"),
    false,
  );
  assert.equal(f.calls.length, 0);
});
