// Shared visual language; all labels stay in the surrounding accessible control.
const paths = {
  library: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.7 7.4M3 4v7h7M12 7v5l3 2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 15h.01M12 15h.01M16 15h.01"/>',
  ticket: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4Z"/><path d="M15 5v3M15 11v2M15 16v3M7 10h4M7 14h3"/>',
};
export function icon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.ticket}</svg>`;
}
export function wishCount(value) {
  const n = Math.max(0, Number(value) || 0);
  return n >= 10000
    ? `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万`
    : n.toLocaleString("zh-CN");
}
const disclosures = new Map();
export function rememberDisclosures(root) {
  root.querySelectorAll("details[data-disclosure]").forEach((el) =>
    disclosures.set(el.dataset.disclosure, el.open),
  );
}
export function restoreDisclosures(root) {
  root.querySelectorAll("details[data-disclosure]").forEach((el) => {
    if (disclosures.has(el.dataset.disclosure))
      el.open = disclosures.get(el.dataset.disclosure);
  });
}
