import { chinaDay, normalizeRule, matchesSession } from "./rules.mjs?v=planner-1";

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
export const validDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const clock = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const numericId = (v) => typeof v === "string" && /^\d+$/.test(v);
export function watchdogFreshness(status, at = Date.now() / 1000) {
  if (!Number.isFinite(status?.checkedAt)) return { kind: "unknown", minutes: null };
  const minutes = Math.max(0, Math.floor((at - status.checkedAt) / 60));
  return { kind: at - status.checkedAt >= 20 * 60 ? "stale" : "recent", minutes };
}
const boundedText = (v, max, label) => {
  if (typeof v !== "string" || v.length > max) throw new Error(`${label}格式无效`);
  return v.trim();
};
export const PRESET_TEMPLATES = [
  { id: "preset-evening", name: "工作日晚上", rule: { weekdays: [1, 2, 3, 4, 5], timeFrom: "19:00" } },
  { id: "preset-weekend-imax", name: "周末 IMAX", rule: { weekdays: [0, 6], formats: ["IMAX"] } },
  { id: "preset-imax", name: "只看 IMAX", rule: { formats: ["IMAX"] } },
];
export function templatesFor(prefs = {}) {
  return [...PRESET_TEMPLATES, ...normalizeTemplates(prefs.ruleTemplates || [])];
}
export function normalizeTemplates(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error("最多保存 30 个规则模板");
  const ids = new Set();
  return value.map((t) => {
    if (!object(t) || typeof t.id !== "string" || !/^[\w-]{1,80}$/.test(t.id) || t.id.startsWith("preset-") || ids.has(t.id)) throw new Error("模板编号无效");
    ids.add(t.id);
    const name = boundedText(t.name, 40, "模板名称");
    if (!name) throw new Error("请填写模板名称");
    return { id: t.id, name, rule: normalizeRule(t.rule) };
  });
}
export function normalizeNotificationPrefs(value = {}) {
  if (!object(value)) throw new Error("通知偏好格式无效");
  const out = {
    quietEnabled: value.quietEnabled === true,
    quietFrom: value.quietFrom ?? "23:00",
    quietUntil: value.quietUntil ?? "08:00",
    urgentBypassQuiet: value.urgentBypassQuiet === true,
    digestMinutes: value.digestMinutes ?? 0,
    releaseChanges: value.releaseChanges !== false,
    watchdogEnabled: value.watchdogEnabled !== false,
    watchdogMinutes: value.watchdogMinutes ?? 15,
  };
  if (!clock(out.quietFrom) || !clock(out.quietUntil) || (out.quietEnabled && out.quietFrom === out.quietUntil)) throw new Error("免打扰起止时间需有效且不同");
  if (![0, 15, 30, 60].includes(out.digestMinutes)) throw new Error("请选择即时通知或 15／30／60 分钟汇总");
  if (![15, 30, 60].includes(out.watchdogMinutes)) throw new Error("失联阈值请选择 15／30／60 分钟");
  return out;
}
export function notificationDue(event, rule, prefs, at = Date.now() / 1000) {
  const p = normalizeNotificationPrefs(prefs);
  const urgent = rule?.priority === "urgent" || ["risk", "watchdog"].includes(event.kind);
  const digest = !urgent && p.digestMinutes > 0;
  const created = event.created_at ?? at;
  const scheduled = digest ? (Math.floor(created / (p.digestMinutes * 60)) + 1) * p.digestMinutes * 60 : created;
  let due = Math.max(event.next_try || 0, scheduled);
  if (p.quietEnabled && !(urgent && p.urgentBypassQuiet)) {
    const local = new Date(at * 1000 + 8 * 3600e3);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    const min = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    const from = min(p.quietFrom), until = min(p.quietUntil);
    const quiet = from < until ? minutes >= from && minutes < until : minutes >= from || minutes < until;
    if (quiet) {
      const midnight = Date.parse(chinaDay(at * 1000) + "T00:00:00+08:00") / 1000;
      due = Math.max(due, midnight + until * 60 + (minutes >= until ? 86400 : 0));
    }
  }
  return { due, digest, urgent };
}
export function normalizeJournalEntry(v) {
  if (!object(v) || typeof v.id !== "string" || !/^[\w-]{1,80}$/.test(v.id) || !["booked", "watched"].includes(v.type)) throw new Error("观影记录格式无效");
  if (typeof v.startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(v.startsAt) || !validDay(v.startsAt.slice(0, 10)) || !clock(v.startsAt.slice(11, 16))) throw new Error("请选择有效的北京时间场次");
  if (v.type === "watched" && v.startsAt.slice(0, 10) > chinaDay()) throw new Error("已看记录不能填写未来日期");
  if (!Number.isInteger(v.durationMinutes) || v.durationMinutes < 1 || v.durationMinutes > 720) throw new Error("预计片长需在 1～720 分钟之间");
  if (![0, 15, 30, 60, 120].includes(v.reminderMinutes)) throw new Error("请选择有效的日历提醒时间");
  return {
    id: v.id, type: v.type, startsAt: v.startsAt,
    cinemaId: v.cinemaId ? boundedText(v.cinemaId, 40, "影院编号") : "",
    cinemaName: boundedText(v.cinemaName || "", 100, "影院名称"),
    hall: boundedText(v.hall || "", 100, "影厅"),
    durationMinutes: v.durationMinutes, reminderMinutes: v.reminderMinutes,
  };
}
export function normalizeFilmJournal(value = {}) {
  if (!object(value) || Object.keys(value).length > 2000) throw new Error("电影手记格式无效");
  let total = 0;
  return Object.fromEntries(Object.entries(value).map(([id, record]) => {
    if (!numericId(id) || !object(record) || !Array.isArray(record.entries || []) || (record.entries || []).length > 100) throw new Error("单部电影最多保存 100 次观影记录");
    const entries = (record.entries || []).map(normalizeJournalEntry);
    total += entries.length;
    if (total > 2000 || new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error("观影记录过多或编号重复");
    if (!Array.isArray(record.tags || []) || (record.tags || []).length > 12) throw new Error("每部电影最多添加 12 个标签");
    const tags = [...new Set((record.tags || []).map((t) => boundedText(t, 20, "标签")).filter(Boolean))];
    return [id, { tags, review: boundedText(record.review || "", 2000, "短评"), entries }];
  }));
}
export function normalizePlannerPrefs(prefs = {}) {
  if (new TextEncoder().encode(JSON.stringify(prefs)).length > 700000) throw new Error("个人配置已接近容量上限，请先精简旧手记或观影记录");
  const ruleTemplates = normalizeTemplates(prefs.ruleTemplates || []);
  const defaultRuleTemplateId = prefs.defaultRuleTemplateId || "";
  if (typeof defaultRuleTemplateId !== "string" || (defaultRuleTemplateId && ![...PRESET_TEMPLATES, ...ruleTemplates].some((t) => t.id === defaultRuleTemplateId))) throw new Error("默认规则模板不存在");
  return { filmJournal: normalizeFilmJournal(prefs.filmJournal || {}), ruleTemplates, defaultRuleTemplateId, notificationPrefs: normalizeNotificationPrefs(prefs.notificationPrefs) };
}
export function selectSessions(data, options = {}, at = Date.now()) {
  const today = chinaDay(at), dayStart = Date.parse(today + "T00:00:00+08:00");
  const add = (n) => chinaDay(dayStart + n * 86400000);
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();
  const saturday = weekday === 0 ? -1 : 6 - weekday;
  const movies = new Map(data.movies.map((m) => [m.id, m]));
  return (data.sessions || []).filter((row) => {
    const film = movies.get(row.movie_id), day = row.starts_at.slice(0, 10);
    if (!film || Date.parse(row.starts_at) <= at || (options.available !== false && !row.available)) return false;
    if (options.day === "today" && day !== today) return false;
    if (options.day === "tomorrow" && day !== add(1)) return false;
    if (options.day === "weekend" && (day < add(saturday) || day > add(saturday + 1))) return false;
    if (options.cinema && row.cinema_id !== options.cinema) return false;
    if (options.format && !(row.hall + " " + row.format).toLowerCase().includes(options.format.toLowerCase())) return false;
    if (options.starred && !film.active) return false;
    if (options.matching && !matchesSession(row, data.movieRules?.[film.id])) return false;
    return true;
  }).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.cinema_id.localeCompare(b.cinema_id));
}
const icsEscape = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
function foldLine(line) {
  const lines = [];
  let current = "", size = 0;
  for (const char of line) {
    const bytes = new TextEncoder().encode(char).length;
    if (size + bytes > 75) { lines.push(current); current = " "; size = 1; }
    current += char; size += bytes;
  }
  return [...lines, current].join("\r\n");
}
export function calendarFile(movie, entry, cinema = {}, at = Date.now()) {
  const e = normalizeJournalEntry(entry);
  const stamp = (n) => new Date(n).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const start = Date.parse(e.startsAt), end = start + e.durationMinutes * 60000;
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Polaris//Cinema Journal//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT", `UID:${e.id}@polaris-cinema`, `DTSTAMP:${stamp(at)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${icsEscape(movie.name)}`, `LOCATION:${icsEscape([e.cinemaName || cinema.name, cinema.address, e.hall].filter(Boolean).join(" · "))}`, `DESCRIPTION:${icsEscape("预计片长 " + e.durationMinutes + " 分钟，可在日历中调整。\nhttps://m.maoyan.com/cinema/" + (e.cinemaId || "" ) + "?movieId=" + movie.id)}`, ...(e.reminderMinutes ? ["BEGIN:VALARM", `TRIGGER:-PT${e.reminderMinutes}M`, "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(movie.name + " 即将开场")}`, "END:VALARM"] : []), "END:VEVENT", "END:VCALENDAR"].map(foldLine).join("\r\n") + "\r\n";
}
