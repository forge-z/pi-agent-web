import { renderHumanControls } from "/human-controls.js";

const $ = (id) => document.getElementById(id);
const { t, text, errorText, locale, language } = globalThis.PiI18n;
const id = new URLSearchParams(location.search).get("c");
const valid = /^[0-9]+$/.test(id || "");
let generation = 0,
  rendered = "",
  busy = 0,
  readVersion = 0,
  reading = false;
let authenticated = false;
function clearSession() {
  generation++;
  readVersion++;
  reading = false;
  busy = 0;
  authenticated = false;
  rendered = "";
  $("human-cards").replaceChildren();
  $("human-session").hidden = true;
  $("human-login").hidden = !valid;
}
async function api(path, method = "GET", body) {
  const requestGeneration = generation;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && requestGeneration === generation)
    clearSession();
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value.error || t("Não foi possível atualizar os controles."),
    );
  return value;
}
const node = (tag, value, cls) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (cls) element.className = cls;
  return element;
};
async function refresh(force = false) {
  if (!valid || (reading && !force)) return;
  const current = generation;
  const version = ++readVersion;
  reading = true;
  try {
    const value = await api(`/api/human-controls/${encodeURIComponent(id)}`);
    if (current !== generation || version !== readVersion) return;
    authenticated = true;
    $("human-login").hidden = true;
    $("human-session").hidden = false;
    const encoded = JSON.stringify(value);
    if (encoded === rendered) return;
    const drafts = new Map(
      [...$("human-cards").querySelectorAll("input,textarea,select")]
        .filter((e) => e.id)
        .map((e) => [e.id, { value: e.value, checked: e.checked }]),
    );
    const cards = renderHumanControls(value, id, {
      node,
      t,
      text,
      errorText,
      locale,
      api,
      refresh: () =>
        current === generation && authenticated
          ? refresh(true)
          : Promise.resolve(),
      busy: (value) => {
        if (current === generation) busy = Math.max(0, busy + (value ? 1 : -1));
      },
    });
    $("human-cards").replaceChildren(...cards);
    $("human-empty").hidden = cards.length > 0;
    for (const input of $("human-cards").querySelectorAll(
      "input,textarea,select",
    )) {
      const draft = drafts.get(input.id);
      if (draft) {
        input.value = draft.value;
        input.checked = draft.checked;
      }
    }
    rendered = encoded;
  } finally {
    if (version === readVersion) reading = false;
  }
}
const showError = (error) =>
  text($("human-error"), () => errorText(error.message));
$("interface-language").value = language();
$("human-login").onsubmit = async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector("button");
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    await api("/api/login", "POST", { password: $("human-password").value });
    $("human-password").value = "";
    generation++;
    await refresh(true);
    text($("human-error"), "");
  } catch (error) {
    showError(error);
  } finally {
    submit.disabled = false;
  }
};
$("human-refresh").onclick = () => {
  if (!busy) void refresh().catch(showError);
};
$("human-logout").onclick = async () => {
  clearSession();
  try {
    await api("/api/logout", "POST", {});
  } catch (error) {
    showError(error);
  } finally {
    clearSession();
  }
};
if (valid) void refresh().catch(showError);
else showError(new Error(t("Abra o link de controles enviado no Telegram.")));
setInterval(() => {
  if (authenticated && !busy && !document.hidden)
    void refresh().catch(showError);
}, 5000);
