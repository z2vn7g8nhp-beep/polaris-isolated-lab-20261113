// Keep keyboard focus when a live update replaces an existing view.
export function captureFocus(root) {
  const el = document.activeElement;
  if (!root.contains(el)) return null;
  return {
    id: el.id,
    tag: el.tagName,
    type: el.type,
    form: el.form?.id,
    name: el.name,
    value: el.type === "checkbox" || el.type === "radio" ? el.value : null,
    data: Object.entries(el.dataset).filter(([key]) => !["dirty", "busy"].includes(key)),
    href: el.getAttribute("href"),
    start: el.selectionStart,
    end: el.selectionEnd,
  };
}
export function restoreFocus(root, state) {
  if (!state) return;
  const candidates = [
    ...root.querySelectorAll("button,a,input,select,textarea,summary"),
  ];
  const el = state.id
    ? candidates.find((el) => el.id === state.id)
    : state.data.length
      ? candidates.find(
          (el) =>
            el.tagName === state.tag &&
            state.data.every(([key, value]) => el.dataset[key] === value),
        )
      : state.form
        ? candidates.find(
            (el) =>
              el.tagName === state.tag &&
              el.type === state.type &&
              el.form?.id === state.form &&
              (!state.name || el.name === state.name) &&
              (state.value === null || el.value === state.value),
          )
        : state.href
          ? candidates.find(
              (el) =>
                el.tagName === state.tag &&
                el.getAttribute("href") === state.href,
            )
          : null;
  if (el) {
    el.focus({ preventScroll: true });
    try {
      el.setSelectionRange(state.start, state.end);
    } catch {}
  }
}

function controlIdentity(el) {
  return { id: el.id, form: el.form?.getAttribute("id"), name: el.name, type: el.type,
    valueKey: ["checkbox", "radio"].includes(el.type) ? el.value : null };
}
export function captureDrafts(root) {
  return [...root.querySelectorAll("input[data-dirty],select[data-dirty],textarea[data-dirty]")]
    .map((el) => ({ ...controlIdentity(el), value: el.value, checked: el.checked,
      values: el.multiple ? [...el.selectedOptions].map((o) => o.value) : null }));
}
export function restoreDrafts(root, drafts, { discardPasswords = false } = {}) {
  const controls = [...root.querySelectorAll("input,select,textarea")];
  for (const draft of drafts) {
    if (discardPasswords && draft.type === "password") continue;
    const el = controls.find((el) => (draft.id ? el.id === draft.id :
      el.form?.getAttribute("id") === draft.form && el.name === draft.name && el.type === draft.type &&
      (draft.valueKey === null || el.value === draft.valueKey)));
    if (!el) continue;
    if (draft.values) [...el.options].forEach((o) => { o.selected = draft.values.includes(o.value); });
    else el.value = draft.value;
    if (["checkbox", "radio"].includes(draft.type)) el.checked = draft.checked;
    el.dataset.dirty = "true";
  }
}
export function clearDrafts(form, submitted) {
  form?.querySelectorAll("[data-dirty]").forEach((el) => {
    // A slow save may finish after the user has continued typing. Only mark
    // the submitted values clean; subsequent edits remain unsaved drafts.
    const current = { ...controlIdentity(el), value: el.value, checked: el.checked,
      values: el.multiple ? [...el.selectedOptions].map((o) => o.value) : null };
    if (!submitted || submitted.some((draft) => JSON.stringify(draft) === JSON.stringify(current))) delete el.dataset.dirty;
  });
}
export function beginBusy(button) {
  const form = button.form;
  if (button.dataset.busy || form?.dataset.busy) return null;
  button.dataset.busy = "true";
  button.disabled = true;
  if (form) form.dataset.busy = "true";
  return () => {
    delete button.dataset.busy;
    button.disabled = false;
    if (form) delete form.dataset.busy;
  };
}

const nodeKey = (node) => node.nodeType === 1 ? node.id || node.getAttribute("data-render-key") : null;
// Reuse existing controls and keyed rows during live updates. An unchanged
// section keeps its DOM, scroll position and browser editing state.
export function patchHTML(root, html, { preserveChildren = [] } = {}) {
  const template = document.createElement("template"); template.innerHTML = html;
  const preserve = new Set(preserveChildren);
  function patch(old, next) {
    if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName) {
      const copy = next.cloneNode(true); old.replaceWith(copy); return copy;
    }
    if (old.nodeType !== 1) { if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue; return old; }
    if (old.isEqualNode(next)) return old;
    const dirty = old.hasAttribute("data-dirty");
    for (const attr of [...old.attributes]) if (!["data-dirty", "data-busy"].includes(attr.name) &&
      !(attr.name === "disabled" && old.hasAttribute("data-busy")) && !next.hasAttribute(attr.name)) old.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
    if (!preserve.has(old.id)) children(old, next);
    if (!dirty && ["INPUT", "TEXTAREA", "SELECT"].includes(old.tagName)) {
      if (old.value !== next.value) old.value = next.value;
      if (old.tagName === "INPUT" && old.checked !== next.checked) old.checked = next.checked;
    }
    return old;
  }
  function children(old, next) {
    const keyed = new Map([...old.childNodes].filter(nodeKey).map((n) => [nodeKey(n), n]));
    let cursor = old.firstChild;
    for (const wanted of [...next.childNodes]) {
      const key = nodeKey(wanted);
      let existing = key ? keyed.get(key) : cursor && !nodeKey(cursor) ? cursor : null;
      if (existing && existing !== cursor) old.insertBefore(existing, cursor);
      if (!existing) { existing = wanted.cloneNode(true); old.insertBefore(existing, cursor); }
      else existing = patch(existing, wanted);
      cursor = existing.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  children(root, template.content);
}
