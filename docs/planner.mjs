import { captureDrafts, restoreDrafts, clearDrafts } from "./dom-state.mjs?v=optimize-1";
import { api } from "./client.mjs?v=optimize-1";
import { chinaDay, normalizeRule } from "./rules.mjs?v=planner-1";
import { icon, rememberDisclosures, restoreDisclosures } from "./ui.mjs?v=journal-3";
import { templatesFor, normalizeNotificationPrefs, selectSessions, calendarFile, normalizeJournalEntry, watchdogFreshness } from "./planner-model.mjs?v=optimize-1";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const selected = (v) => v ? "selected" : "", checked = (v) => v ? "checked" : "";
const stamp = (at) => at ? new Date(at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai", hour12: false }) : "尚未检查";
let ctx, dialog, returnFocus, undoState = null, undoTimer, undoNotice;
const sessionFilters = { day: "today", cinema: "", format: "", starred: false, matching: false, available: true };
let journalTag = "", journalSearch = "";
function ruleText(rule) {
  const r = normalizeRule(rule);
  return [r.weekdays.length ? r.weekdays.map((n) => "日一二三四五六"[n]).join("、") : "每天", r.timeFrom || r.timeUntil ? `${r.timeFrom || "00:00"}–${r.timeUntil || "23:59"}` : "全天", r.formats.join(" / ") || "不限影厅", r.priority === "urgent" ? "重点提醒" : "普通提醒"].join(" · ");
}
const recordFor = (data, id) => data.filmJournal?.[id] || { tags: [], review: "", entries: [] };
function entryCard(movie, entry) {
  return `<article class="journal-entry" data-render-key="entry-${esc(entry.id)}"><div><strong>${entry.type === "booked" ? "已购票" : "已看"} <time>${esc(entry.startsAt.slice(0, 16).replace("T", " "))}</time></strong><small>${esc([entry.cinemaName, entry.hall].filter(Boolean).join(" · ") || "未填写影院")}</small></div><div class="actions"><button class="secondary" data-entry-edit="${esc(movie.id)}:${esc(entry.id)}">编辑记录</button>${entry.type === "booked" ? `<button class="secondary" data-entry-watched="${esc(movie.id)}:${esc(entry.id)}">标为已看</button><button class="secondary" data-entry-calendar="${esc(movie.id)}:${esc(entry.id)}">${icon("calendar")}导出日历</button>` : ""}<button class="text-button" data-entry-remove="${esc(movie.id)}:${esc(entry.id)}">删除记录</button></div></article>`;
}
export function moviePlanner(movie, data) {
  const record = recordFor(data, movie.id), watched = record.entries.filter((e) => e.type === "watched").length, booked = record.entries.filter((e) => e.type === "booked").length;
  return `<details class="detail-section movie-planner" id="movie-planner" data-movie="${esc(movie.id)}" data-disclosure="journal-${esc(movie.id)}"><summary id="movie-planner-summary"><span>电影手记<small>${booked} 次购票记录 · 已看 ${watched} 次</small></span><span class="disclosure-hint">记录 +</span></summary><div class="actions"><button class="secondary" data-manual-book="${esc(movie.id)}">记录已购票</button><button class="secondary" data-watch-movie="${esc(movie.id)}">记一次观影</button></div><form id="film-journal-form" data-movie="${esc(movie.id)}"><label for="journal-tags">标签 <small>逗号分隔，最多 12 个</small></label><input id="journal-tags" name="tags" value="${esc(record.tags.join("，"))}" placeholder="例如：二刷、和朋友、IMAX"><label for="journal-review">短评</label><textarea id="journal-review" name="review" maxlength="2000" rows="4" placeholder="给这部电影留几句话…">${esc(record.review)}</textarea><div class="actions"><button class="primary" type="submit">保存手记</button></div></form>${[...record.entries].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).map((e) => entryCard(movie, e)).join("")}</details>`;
}
export function ruleTemplateControls(movie, data) {
  return `<div class="template-controls"><label for="detail-rule-template">应用规则模板</label><select id="detail-rule-template">${templatesFor(data).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select><button type="button" class="secondary" data-apply-template="${esc(movie.id)}">应用</button><button type="button" class="text-button" data-save-rule-template>把当前规则保存为模板</button></div><label class="priority-label">提醒优先级 <select name="priority"><option value="normal" ${selected(data.movieRules?.[movie.id]?.priority !== "urgent")}>普通提醒</option><option value="urgent" ${selected(data.movieRules?.[movie.id]?.priority === "urgent")}>重点电影 · 即时提醒</option></select></label>`;
}
export function sessionOverview(data) {
  const rows = selectSessions(data, sessionFilters), movies = new Map(data.movies.map((m) => [m.id, m]));
  const groups = new Map();
  for (const row of rows) { const day = row.starts_at.slice(0, 10); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(row); }
  return `<div class="hero"><div><h1>场次总览</h1><p class="intro">把想看的电影，放进合适的时间。</p></div></div><div class="session-freshness">${data.cinemas.map((c, i) => `<span>${esc(c.short)}<small>观测于 ${stamp(data.checks?.[i]?.checked)}</small></span>`).join("")}</div><p class="note">场次复用最近一次影院检查。可售状态可能变化，购票前请以猫眼为准。</p><form id="session-filters" class="planner-filters"><label>日期<select name="day">${[["today", "今天"], ["tomorrow", "明天"], ["weekend", "本周末"], ["all", "全部未来场次"]].map(([v, t]) => `<option value="${v}" ${selected(sessionFilters.day === v)}>${t}</option>`).join("")}</select></label><label>影院<select name="cinema"><option value="">全部影院</option>${data.cinemas.map((c) => `<option value="${esc(c.id)}" ${selected(sessionFilters.cinema === c.id)}>${esc(c.short)}</option>`).join("")}</select></label><label>影厅<select name="format">${[["", "不限"], ["IMAX", "IMAX"], ["CINITY", "CINITY"], ["Dolby", "Dolby"], ["激光", "激光"]].map(([v, t]) => `<option value="${v}" ${selected(sessionFilters.format === v)}>${t}</option>`).join("")}</select></label><label><input type="checkbox" name="starred" ${checked(sessionFilters.starred)}>只看星标</label><label><input type="checkbox" name="matching" ${checked(sessionFilters.matching)}>符合我的规则</label><label><input type="checkbox" name="available" ${checked(sessionFilters.available)}>仅观测可售</label></form><p class="countlabel">共 ${rows.length} 场 · 北京时间</p>${rows.length ? [...groups].map(([day, sessions]) => `<section class="overview-day" data-render-key="day-${esc(day)}"><h2>${esc(day)}</h2>${sessions.map((r) => `<article class="overview-session" data-render-key="session-${esc(r.id)}"><time>${esc(r.starts_at.slice(11, 16))}</time><div class="overview-film"><button class="film-title" data-detail="${esc(r.movie_id)}">${esc(movies.get(r.movie_id).name)}</button><small>${esc(r.cinema)} · ${esc(r.hall)} ${esc(r.format)}</small><span class="availability ${r.available ? "available" : ""}">${r.available ? "已观测可售" : "暂不可售"}</span></div><div class="actions"><button class="secondary" data-book-session="${esc(r.id)}">记录购票／日历</button><a class="text-button" href="https://m.maoyan.com/cinema/${esc(r.cinema_id)}?movieId=${esc(r.movie_id)}" target="_blank" rel="noopener noreferrer">去猫眼 ↗</a></div></article>`).join("")}</section>`).join("") : `<div class="empty"><span class="empty-art">${icon("ticket")}${icon("calendar")}</span><strong>这个时间，还没有匹配的场次</strong><p>试试其他日期或影院；新排片会在后续检查后更新。</p></div>`}`;
}
export function journalView(data) {
  const all = data.movies.filter((m) => m.active || data.filmJournal?.[m.id]);
  const tags = [...new Set(all.flatMap((m) => recordFor(data, m.id).tags))].sort();
  const movies = all.filter((m) => (!journalTag || recordFor(data, m.id).tags.includes(journalTag)) && (!journalSearch || (m.name + " " + recordFor(data, m.id).review).toLowerCase().includes(journalSearch.toLowerCase())));
  const entries = Object.values(data.filmJournal || {}).flatMap((r) => r.entries), watched = entries.filter((e) => e.type === "watched").length;
  return `<div class="hero"><div><h1>我的手记</h1><p class="intro">${entries.filter((e) => e.type === "booked").length} 次购票记录 · ${watched} 次观影 · ${tags.length} 个标签</p></div></div><form id="journal-filter-form" class="planner-filters"><label>搜索<input name="query" value="${esc(journalSearch)}" placeholder="片名或短评"></label><label>标签<select name="tag"><option value="">全部标签</option>${tags.map((tag) => `<option value="${esc(tag)}" ${selected(tag === journalTag)}>${esc(tag)}</option>`).join("")}</select></label><button class="secondary" type="submit">筛选手记</button></form><div class="journal-films">${movies.length ? movies.map((m) => {
    const record = recordFor(data, m.id), count = record.entries.filter((e) => e.type === "watched").length;
    return `<section class="journal-film" data-render-key="journal-${esc(m.id)}"><div class="journal-film-heading"><h2><button class="film-title" data-detail="${esc(m.id)}">${esc(m.name)}</button></h2><span>已看 ${count} 次</span></div><div class="journal-tags">${record.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>${record.review ? `<p class="journal-review">${esc(record.review)}</p>` : `<p class="note">还没有短评，为这部电影留几句话吧。</p>`}<div class="actions"><button class="secondary" data-open-journal="${esc(m.id)}">编辑手记</button><button class="secondary" data-watch-movie="${esc(m.id)}">记一次观影</button><button class="text-button" data-manual-book="${esc(m.id)}">记录已购票</button></div>${[...record.entries].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).map((e) => entryCard(m, e)).join("")}</section>`;
  }).join("") : `<div class="empty"><span class="empty-art">${icon("ticket")}${icon("star")}</span><strong>把下一场电影写进手记</strong><p>星标电影，或在电影详情里添加购票、观影记录与短评。</p><button class="primary" data-view="library">去发现电影 →</button></div>`}</div>`;
}
export function plannerSettings(data) {
  const prefs = normalizeNotificationPrefs(data.notificationPrefs), templates = templatesFor(data);
  const freshness = watchdogFreshness(data.watchdogStatus);
  return `<section class="section"><h2>提醒规则模板</h2><p>默认模板只用于以后新增且尚未设置规则的星标。已单独设置的规则会保留。</p><form id="default-template-form"><label for="default-template">新星标的默认规则</label><div class="template-controls"><select id="default-template" name="template"><option value="">不使用模板</option>${templates.map((t) => `<option value="${esc(t.id)}" ${selected(t.id === data.defaultRuleTemplateId)}>${esc(t.name)}</option>`).join("")}</select><button class="secondary" type="submit">保存默认模板</button></div></form><div class="template-list">${templates.map((t) => `<article><div><strong>${esc(t.name)}</strong><small>${esc(ruleText(t.rule))}</small></div>${!t.id.startsWith("preset-") ? `<button class="text-button" data-delete-template="${esc(t.id)}">删除</button>` : '<small class="note">内置</small>'}</article>`).join("")}</div><p class="note">在电影详情的提醒规则中，可将当前规则保存成自定义模板。</p><details data-disclosure="batch-templates"><summary id="batch-templates-summary">批量应用模板 +</summary><form id="batch-template-form"><label>模板<select name="template">${templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select></label><div class="template-movies">${data.movies.filter((m) => m.active).map((m) => `<label><input type="checkbox" name="movies" value="${esc(m.id)}">${esc(m.name)}</label>`).join("") || '<p class="note">先在片库星标电影，再批量设置。</p>'}</div><label><input type="checkbox" name="allStars">应用到全部星标</label><label><input type="checkbox" name="onlyUnset" checked>只应用到尚未设置规则的电影</label><div class="actions"><button class="primary" type="submit">应用所选模板</button></div></form></details></section><section class="section"><h2>通知偏好</h2><p>重点电影保持即时提醒；普通电影可按你的设置汇总。以下时间均为北京时间。</p><p class="note watchdog-status ${freshness.kind === "stale" ? "is-stale" : ""}" data-watchdog-freshness="${freshness.kind}">独立检查：${freshness.kind === "stale" ? `记录已过期，距今 ${freshness.minutes} 分钟；需要等待新的独立检查结果` : data.watchdogStatus?.checkedAt ? `${stamp(data.watchdogStatus.checkedAt)} · ${{ healthy: "检查正常", outage: "长时间未更新", paused: "已手动暂停", disabled: "未启用", waiting: "等待首次成功检查" }[data.watchdogStatus.health] || "状态待确认"}` : "尚未读取到记录，连接后在独立任务首次完成时显示"}${data.watchdogStatus?.notificationError ? " · " + esc(data.watchdogStatus.notificationError) : ""}</p><form id="notification-prefs-form" class="notification-form"><label>普通电影通知<select id="notify-digest" name="digestMinutes">${[[0, "即时通知"], [15, "每 15 分钟汇总"], [30, "每 30 分钟汇总"], [60, "每 60 分钟汇总"]].map(([v, t]) => `<option value="${v}" ${selected(prefs.digestMinutes === v)}>${t}</option>`).join("")}</select></label><label><input id="notify-quiet" type="checkbox" name="quietEnabled" ${checked(prefs.quietEnabled)}>开启夜间免打扰</label><div class="rule-dates"><label>开始时间<input id="notify-from" type="time" name="quietFrom" value="${prefs.quietFrom}" required></label><label>结束时间<input id="notify-until" type="time" name="quietUntil" value="${prefs.quietUntil}" required></label></div><label><input id="notify-bypass" type="checkbox" name="urgentBypassQuiet" ${checked(prefs.urgentBypassQuiet)}>允许重点电影及监测告警在免打扰时段通知</label><label><input id="notify-release-changes" type="checkbox" name="releaseChanges" ${checked(prefs.releaseChanges)}>星标电影定档／改档时提醒</label><label><input id="notify-watchdog" type="checkbox" name="watchdogEnabled" ${checked(prefs.watchdogEnabled)}>启用独立失联检查与恢复提醒</label><label>超过多久没有成功检查时告警<select id="notify-watchdog-minutes" name="watchdogMinutes">${[15, 30, 60].map((v) => `<option value="${v}" ${selected(prefs.watchdogMinutes === v)}>${v} 分钟</option>`).join("")}</select></label><p class="note">独立检查约每 10 分钟执行，并由现有定时入口提供触发兜底；记录超过 20 分钟未更新会标记为过期。GitHub 调度延迟仍会影响告警时间。手动暂停监测时不会发送失联告警。免打扰结束后，仍有效的开票消息才会发送。</p><div class="actions"><button class="primary" type="submit">保存通知偏好</button></div></form></section>`;
}
function formEntry(form) {
  const f = new FormData(form);
  return normalizeJournalEntry({ id: form.dataset.entry, type: form.dataset.type, startsAt: `${f.get("day")}T${f.get("time")}:00+08:00`, cinemaId: f.get("cinemaId") || "", cinemaName: f.get("cinemaName") || "", hall: f.get("hall") || "", durationMinutes: Number(f.get("duration")), reminderMinutes: Number(f.get("reminder")) });
}
function downloadCalendar(movie, entry) {
  const cinema = ctx.getData().cinemas.find((c) => c.id === entry.cinemaId);
  const url = URL.createObjectURL(new Blob([calendarFile(movie, entry, cinema)], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${movie.name.replace(/[\\/:*?"<>|]/g, "_")}-${entry.startsAt.slice(0, 10)}.ics`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  ctx.toast("日历文件已导出，请在系统日历中确认添加");
}
function closeEntry() {
  dialog.close();
  (returnFocus?.isConnected ? returnFocus : document.querySelector('.movie-dialog[open] [data-close-detail], nav button.selected'))?.focus({ preventScroll: true });
}
function openEntry(id, session, type = "booked", existing = null) {
  const data = ctx.getData(), movie = data.movies.find((m) => m.id === id);
  if (!movie) return;
  const cinema = data.cinemas.find((c) => c.id === (existing?.cinemaId || session?.cinema_id)), starts = existing?.startsAt || session?.starts_at;
  returnFocus = document.activeElement;
  dialog.innerHTML = `<div class="picker-heading"><h2 id="entry-title">${existing ? "编辑观影记录" : type === "booked" ? "记录已购票" : "记一次观影"}</h2><button class="secondary" data-close-entry aria-label="关闭观影记录">×</button></div><p class="intro">${esc(movie.name)}</p><p class="note">${type === "booked" ? "手动记录已购买的场次，不会在猫眼下单。日历也可单独导出。" : "每条已看记录计入一次观影，可在手记中管理。"}</p><form id="entry-form" data-movie="${esc(id)}" data-type="${type}" data-entry="${esc(existing?.id || crypto.randomUUID())}" data-edit="${existing ? "true" : ""}"><div class="rule-dates"><label>日期<input name="day" type="date" required value="${starts?.slice(0, 10) || chinaDay()}" ${type === "watched" ? `max="${chinaDay()}"` : ""}></label><label>时间<input name="time" type="time" required value="${starts?.slice(11, 16) || (type === "watched" ? "12:00" : "19:00")}"></label></div><label>影院<select name="cinemaId"><option value="">其他影院／未填写</option>${data.cinemas.map((c) => `<option value="${esc(c.id)}" ${selected(cinema?.id === c.id)}>${esc(c.short)}</option>`).join("")}</select></label><label>影院名称<input name="cinemaName" maxlength="100" value="${esc(existing?.cinemaName || cinema?.short || session?.cinema || "")}" placeholder="其他影院可直接填写"></label><label>影厅<input name="hall" maxlength="100" value="${esc(existing?.hall || session?.hall || "")}"></label><div class="rule-dates"><label>预计片长（可调整）<input name="duration" type="number" min="1" max="720" required value="${existing?.durationMinutes || 120}"></label><label>日历提前提醒<select name="reminder">${[0, 15, 30, 60, 120].map((n) => `<option value="${n}" ${selected(n === (existing?.reminderMinutes ?? 30))}>${n ? n + " 分钟" : "不提醒"}</option>`).join("")}</select></label></div>${type === "booked" ? '<label><input name="stopMonitoring" type="checkbox">同时暂停这部电影的开票提醒，保留星标</label>' : ""}<div class="actions"><button class="primary" type="submit">保存${type === "booked" ? "购票" : "观影"}记录</button>${type === "booked" ? '<button class="secondary" type="button" data-draft-calendar>仅导出日历</button>' : ""}</div><p class="form-feedback" role="status"></p></form>`;
  dialog.showModal();
  dialog.querySelector('input[name="day"]').focus();
}
function currentRule() {
  const f = new FormData(document.querySelector("#rule-form"));
  return normalizeRule({ ...Object.fromEntries(f), cinemas: f.getAll("cinemas"), formats: [...f.getAll("formats"), ...(f.get("customFormat")?.trim() ? [f.get("customFormat").trim()] : [])], weekdays: f.getAll("weekdays").map(Number), paused: f.has("paused") });
}
function refreshMoviePlanner(id) {
  const root = document.querySelector("#movie-dialog"), section = root?.querySelector("#movie-planner");
  const movie = ctx.getData().movies.find((m) => m.id === id);
  if (section?.dataset.movie !== id || !movie) return;
  const drafts = captureDrafts(section);
  rememberDisclosures(root); section.outerHTML = moviePlanner(movie, ctx.getData()); restoreDisclosures(root);
  restoreDrafts(root.querySelector("#movie-planner"), drafts);
}
async function save(button, work, message, id, afterSuccess) {
  button.disabled = true;
  try {
    const result = await work();
    clearDrafts(button.form);
    if (result?.synced && !result.queued) ctx.rerender();
    else await ctx.refresh();
    if (id) refreshMoviePlanner(id);
    afterSuccess?.(result);
    if (message) ctx.toast(message);
    return true;
  } catch (e) { ctx.toast(e.message); return false; }
  finally { button.disabled = false; }
}
function clearUndo() {
  clearTimeout(undoTimer); undoState = null; undoNotice?.remove(); undoNotice = null;
}
function offerUndo(data) {
  clearUndo(); undoState = { data, expiresAt: Date.now() + 12000 };
  undoTimer = setTimeout(clearUndo, 12000); syncUndoNotice();
}
function syncUndoNotice() {
  if (!undoState || undoState.expiresAt <= Date.now()) { clearUndo(); return; }
  const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
  if (!undoNotice) {
    undoNotice = document.createElement("div"); undoNotice.className = "undo-notice"; undoNotice.setAttribute("role", "status");
    const message = document.createElement("span"), button = document.createElement("button");
    const movie = ctx.getData().movies.find((m) => m.id === undoState.data.id);
    message.textContent = `已删除《${movie?.name || "电影"}》的记录`;
    button.type = "button"; button.dataset.undoEntry = "true"; button.textContent = "撤销删除";
    undoNotice.append(message, button);
  }
  if (undoNotice.parentElement !== host || !undoNotice.isConnected) host.append(undoNotice);
}
export function installPlanner(context) {
  ctx = context;
  dialog = document.createElement("dialog"); dialog.id = "entry-dialog"; dialog.className = "planner-dialog"; dialog.setAttribute("aria-labelledby", "entry-title"); document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); closeEntry(); });
  document.addEventListener("change", (e) => {
    if (e.target.closest("#session-filters")) {
      const form = e.target.form, f = new FormData(form);
      Object.assign(sessionFilters, { day: f.get("day"), cinema: f.get("cinema"), format: f.get("format"), starred: f.has("starred"), matching: f.has("matching"), available: f.has("available") });
      ctx.rerender();
    }
    if (e.target.closest("#entry-form") && e.target.name === "cinemaId") {
      const cinema = ctx.getData().cinemas.find((c) => c.id === e.target.value);
      e.target.form.elements.cinemaName.value = cinema?.short || "";
    }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.hasAttribute("data-close-entry")) return closeEntry();
    if (b.dataset.bookSession) { const session = ctx.getData().sessions.find((s) => s.id === b.dataset.bookSession); if (session) openEntry(session.movie_id, session); return; }
    if (b.dataset.manualBook) return openEntry(b.dataset.manualBook);
    if (b.dataset.watchMovie) return openEntry(b.dataset.watchMovie, null, "watched");
    if (b.dataset.openJournal) {
      document.querySelector(`[data-detail="${CSS.escape(b.dataset.openJournal)}"]`)?.click();
      const memo = document.querySelector("#movie-planner"); if (memo) { memo.open = true; memo.scrollIntoView({ block: "start" }); }
      return;
    }
    if (b.hasAttribute("data-draft-calendar")) {
      try { const form = b.form; downloadCalendar(ctx.getData().movies.find((m) => m.id === form.dataset.movie), formEntry(form)); } catch (error) { ctx.toast(error.message); } return;
    }
    if (b.dataset.entryCalendar) { const [id, entryId] = b.dataset.entryCalendar.split(":"); const entry = recordFor(ctx.getData(), id).entries.find((v) => v.id === entryId); if (entry) downloadCalendar(ctx.getData().movies.find((m) => m.id === id), entry); return; }
    if (b.dataset.entryEdit) {
      const [id, entryId] = b.dataset.entryEdit.split(":");
      const entry = recordFor(ctx.getData(), id).entries.find((v) => v.id === entryId);
      if (entry) openEntry(id, null, entry.type, entry);
      return;
    }
    if (b.hasAttribute("data-undo-entry")) {
      if (!undoState || undoState.expiresAt <= Date.now()) return clearUndo();
      const undo = undoState;
      return save(b, () => api("journal/restore-entry", undo.data), "已撤销删除", undo.data.id, () => { if (undoState === undo) clearUndo(); });
    }
    if (b.dataset.entryWatched || b.dataset.entryRemove) {
      const [id, entryId] = (b.dataset.entryWatched || b.dataset.entryRemove).split(":");
      return save(b, () => api(b.dataset.entryWatched ? "journal/entry-state" : "journal/remove-entry", { id, entryId, type: "watched" }), b.dataset.entryWatched ? "已记录这次观影" : "", id, (result) => { if (result.undo) offerUndo(result.undo); });
    }
    if (b.dataset.deleteTemplate) return save(b, () => api("template/delete", { id: b.dataset.deleteTemplate }), "模板已删除");
    if (b.hasAttribute("data-save-rule-template")) {
      const name = window.prompt("给当前规则模板起一个名称");
      if (name?.trim()) return save(b, () => api("template/save", { name: name.trim(), rule: currentRule() }), "规则模板已保存");
      return;
    }
    if (b.dataset.applyTemplate) {
      const id = b.dataset.applyTemplate, templateId = document.querySelector("#detail-rule-template").value;
      if (await save(b, () => api("template/apply", { id: templateId, movieIds: [id] }), "模板已应用，等待后台处理")) {
        const rule = normalizeRule(ctx.getData().movieRules[id]), form = document.querySelector("#rule-form");
        if (form) {
          for (const input of form.elements) {
            if (input.type === "checkbox") input.checked = input.name === "paused" ? rule.paused : (rule[input.name] || []).map(String).includes(input.value);
            else if (Object.hasOwn(rule, input.name)) input.value = rule[input.name];
          }
          const formats = form.querySelector('input[name="formats"]')?.closest("fieldset");
          for (const value of rule.formats) if (![...form.querySelectorAll('input[name="formats"]')].some((i) => i.value === value)) {
            const label = document.createElement("label"), input = document.createElement("input"); input.type = "checkbox"; input.name = "formats"; input.value = value; input.checked = true; label.append(input, document.createTextNode(" " + value)); formats?.append(label);
          }
          form.elements.customFormat.value = "";
        }
      }
    }
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target, f = new FormData(form), button = form.querySelector('button[type="submit"]');
    if (!["entry-form", "film-journal-form", "default-template-form", "batch-template-form", "notification-prefs-form", "journal-filter-form"].includes(form.id)) return;
    e.preventDefault();
    if (form.id === "journal-filter-form") { journalSearch = String(f.get("query") || "").trim(); journalTag = String(f.get("tag") || ""); ctx.rerender(); return; }
    if (form.id === "entry-form") {
      const ok = await save(button, () => api(form.dataset.edit ? "journal/edit-entry" : "journal/entry", { id: form.dataset.movie, entry: formEntry(form), stopMonitoring: f.has("stopMonitoring") }), "观影记录已加密保存", form.dataset.movie);
      if (ok) { closeEntry(); ctx.toast("观影记录已加密保存"); }
    }
    if (form.id === "film-journal-form") await save(button, () => api("journal/save", { id: form.dataset.movie, tags: String(f.get("tags")).split(/[,，]/).map((t) => t.trim()).filter(Boolean), review: f.get("review") }), "手记已加密保存", form.dataset.movie);
    if (form.id === "default-template-form") await save(button, () => api("template/default", { id: f.get("template") }), "默认模板已保存");
    if (form.id === "batch-template-form") await save(button, () => api("template/apply", { id: f.get("template"), movieIds: f.getAll("movies"), allStars: f.has("allStars"), onlyUnset: f.has("onlyUnset") }), "已批量应用模板，等待后台处理");
    if (form.id === "notification-prefs-form") await save(button, () => api("planner/settings", { ...Object.fromEntries(f), quietEnabled: f.has("quietEnabled"), urgentBypassQuiet: f.has("urgentBypassQuiet"), releaseChanges: f.has("releaseChanges"), watchdogEnabled: f.has("watchdogEnabled"), digestMinutes: Number(f.get("digestMinutes")), watchdogMinutes: Number(f.get("watchdogMinutes")) }), "通知偏好已保存，等待后台处理");
  });
  return { afterRender: syncUndoNotice, resetSession() { clearUndo(); if (dialog.open) closeEntry(); } };
}
