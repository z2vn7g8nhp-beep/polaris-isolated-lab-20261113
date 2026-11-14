import { api } from "./client.mjs?v=calm-1";
import { posterUrl } from "./catalog.mjs?v=calm-1";
import { chinaDay } from "./rules.mjs";
import { countdownParts, countdownMovie } from "./countdown-model.mjs";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let ctx,
  previewId = null,
  pendingId = null,
  unsyncedId = null,
  pickerQuery = "",
  onlyStars = false,
  saving = false,
  returnFocus;
const selected = (data) =>
  countdownMovie(data, pendingId || (data.connected ? unsyncedId : previewId));
const hourglass =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3v3c0 3 5 4 5 6s-5 3-5 6v3M17 3v3c0 3-5 4-5 6s5 3 5 6v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m9 18 3-3 3 3H9Z" fill="currentColor"/></svg>';
export function countdownHero(data) {
  const movie = selected(data),
    parts = countdownParts(movie?.release),
    poster = posterUrl(movie?.img),
    safe = /^https:\/\//.test(poster);
  return `<section class="countdown-hero" aria-label="电影上映倒计时"><div class="countdown-header"><span>${hourglass}上映倒计时</span><button class="countdown-change" data-pick-countdown ${saving || (data.connected && !data.personalReady) ? "disabled" : ""}>${saving ? "保存中…" : movie ? "更换电影" : "选择电影"} <span aria-hidden="true">↗</span></button></div>${movie ? `<div class="countdown-layout"><div class="countdown-copy"><h1>${esc(movie.name)}</h1><p class="countdown-date">${parts.kind === "undated" ? "上映日期待定" : esc(movie.release.replaceAll("-", ".")) + " 上映"}</p><div class="countdown-clock" role="timer" aria-live="off" data-release="${esc(movie.release)}" data-kind="${parts.kind}">${clockMarkup(parts, movie.release)}</div></div><button class="countdown-poster" data-detail="${esc(movie.id)}" aria-label="查看${esc(movie.name)}详情"><span class="poster-fallback" aria-hidden="true">${esc(movie.name)}</span>${safe ? `<img src="${esc(poster)}" alt="${esc(movie.name)}海报" referrerpolicy="no-referrer" decoding="async" onerror="this.style.visibility='hidden'">` : ""}</button></div><div class="countdown-footer"><span>${unsyncedId && data.connected ? "本机已选择，尚未同步" : parts.kind === "pending" ? "按上映日零点（北京时间）计算" : parts.kind === "released" ? "可查看当前影院场次" : "公布档期后显示倒计时"}</span>${unsyncedId && data.connected ? '<button class="text-button" data-countdown-retry>重试同步</button>' : ""}<button class="text-button" data-detail="${esc(movie.id)}">电影详情 <span aria-hidden="true">→</span></button></div>` : `<div class="countdown-empty"><h1>选择倒计时电影</h1><button class="primary" data-pick-countdown>选择电影</button></div>`}</section>`;
}
function clockMarkup(parts, release) {
  if (parts.kind !== "pending")
    return `<strong class="countdown-result">${parts.kind === "undated" ? "档期待定" : release === chinaDay() ? "今日上映" : "已上映"}</strong>`;
  return `<div class="countdown-days"><strong data-unit="days">${String(parts.days).padStart(2, "0")}</strong><span>天</span></div><div class="countdown-time">${[
    ["hours", "时"],
    ["minutes", "分"],
    ["seconds", "秒"],
  ]
    .map(
      ([unit, label]) =>
        `<span><b data-unit="${unit}">${String(parts[unit]).padStart(2, "0")}</b><small>${label}</small></span>`,
    )
    .join('<i aria-hidden="true">:</i>')}</div>`;
}
function tick() {
  const clock = document.querySelector(".countdown-clock");
  if (!clock) return;
  const parts = countdownParts(clock.dataset.release);
  if (parts.kind !== clock.dataset.kind) {
    ctx?.rerender();
    return;
  }
  if (parts.kind === "pending") {
    for (const unit of ["days", "hours", "minutes", "seconds"]) {
      const el = clock.querySelector(`[data-unit="${unit}"]`);
      if (el) el.textContent = String(parts[unit]).padStart(2, "0");
    }
    clock.setAttribute(
      "aria-label",
      `${parts.days}天${parts.hours}小时${parts.minutes}分${parts.seconds}秒`,
    );
  }
}
function pickerRows() {
  const data = ctx.getData(),
    query = pickerQuery.trim().toLowerCase(),
    chosen = selected(data);
  const movies = data.movies
    .filter(
      (m) =>
        (!onlyStars || m.active) &&
        (!query ||
          (m.name + " " + (m.actors || "")).toLowerCase().includes(query)),
    )
    .sort(
      (a, b) =>
        Number(b.id === chosen?.id) - Number(a.id === chosen?.id) ||
        Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
        (b.wish || 0) - (a.wish || 0),
    );
  const list = document.querySelector("#countdown-options");
  if (!list) return;
  list.innerHTML = movies.length
    ? movies
        .map((m) => {
          const poster = posterUrl(m.img);
          return `<button class="countdown-option ${chosen?.id === m.id ? "chosen" : ""}" data-countdown-movie="${esc(m.id)}" aria-pressed="${chosen?.id === m.id}" ${saving ? "disabled" : ""}><span class="picker-poster">${/^https:\/\//.test(poster) ? `<img src="${esc(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : ""}</span><span><strong>${esc(m.name)}</strong><small>${esc(m.release)}${m.active ? " · 已星标" : ""}</small></span><span class="picker-check" aria-hidden="true">${chosen?.id === m.id ? "✓" : "+"}</span></button>`;
        })
        .join("")
    : `<p class="picker-empty">${onlyStars ? "没有匹配的星标电影" : "没有匹配的电影"}</p>`;
}
function closePicker() {
  document.querySelector("#countdown-picker").close();
  const button = returnFocus?.isConnected
    ? returnFocus
    : document.querySelector("[data-pick-countdown]");
  button?.focus({ preventScroll: true });
}
function openPicker() {
  const data = ctx.getData();
  if (!data) return;
  if (data.connected && !data.personalReady) {
    ctx.toast("请等待个人配置同步完成");
    return;
  }
  returnFocus = document.activeElement;
  pickerQuery = "";
  onlyStars = false;
  const dialog = document.querySelector("#countdown-picker");
  dialog.innerHTML = `<div class="picker-heading"><h2 id="countdown-picker-title">选择倒计时电影</h2><button class="secondary" data-close-countdown aria-label="关闭电影选择">×</button></div><label class="picker-search"><span aria-hidden="true">⌕</span><input id="countdown-search" type="search" placeholder="搜索片名或主演" aria-label="搜索倒计时电影" autocomplete="off"></label><label class="picker-stars"><input id="countdown-only-stars" type="checkbox"> 只看我的星标</label><div id="countdown-options" class="countdown-options"></div>`;
  pickerRows();
  dialog.showModal();
  dialog.querySelector("#countdown-search").focus();
}
export function installCountdown(context) {
  ctx = context;
  const dialog = document.createElement("dialog");
  dialog.id = "countdown-picker";
  dialog.className = "countdown-picker";
  dialog.setAttribute("aria-labelledby", "countdown-picker-title");
  document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!saving) closePicker();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "countdown-search") {
      pickerQuery = e.target.value;
      pickerRows();
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "countdown-only-stars") {
      onlyStars = e.target.checked;
      pickerRows();
    }
  });
  document.addEventListener("click", async (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-pick-countdown")) {
      openPicker();
      return;
    }
    if (button.hasAttribute("data-close-countdown")) {
      if (!saving) closePicker();
      return;
    }
    const id =
      button.dataset.countdownMovie ||
      (button.hasAttribute("data-countdown-retry") ? unsyncedId : null);
    if (!id || saving) return;
    const data = ctx.getData();
    if (!data.connected) {
      previewId = id;
      closePicker();
      ctx.rerender();
      ctx.toast("已选择电影；连接 GitHub 后可同步保存");
      return;
    }
    saving = true;
    pendingId = id;
    if (dialog.open) closePicker();
    ctx.rerender();
    document
      .querySelector(".countdown-footer [data-detail]")
      ?.focus({ preventScroll: true });
    try {
      await api("countdown", { id });
      previewId = null;
      pendingId = null;
      unsyncedId = null;
      saving = false;
      ctx.rerender();
      ctx.toast("倒计时电影已保存");
    } catch (error) {
      pendingId = null;
      unsyncedId = id;
      saving = false;
      ctx.rerender();
      ctx.toast("已在本机切换，暂未同步：" + error.message);
    }
  });
  setInterval(tick, 1000);
}
