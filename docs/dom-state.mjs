// Keep keyboard focus when a live update replaces an existing view.
export function captureFocus(root) {
  const el = document.activeElement;
  if (!root.contains(el)) return null;
  return {
    id: el.id,
    tag: el.tagName,
    type: el.type,
    form: el.form?.id,
    data: Object.entries(el.dataset).filter(([key]) => key !== "dirty"),
    href: el.getAttribute("href"),
    start: el.selectionStart,
    end: el.selectionEnd,
  };
}
export function restoreFocus(root, state) {
  if (!state) return;
  const candidates = [
    ...root.querySelectorAll("button,a,input,select,textarea"),
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
              el.form?.id === state.form,
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
