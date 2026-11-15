// Shared by the browser and the monitor. All dates and times use Asia/Shanghai.
export const cinemaIds = ["25769", "39869"];
export const chinaDay = (at = Date.now()) =>
  new Date(at + 8 * 3600e3).toISOString().slice(0, 10);
const date = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v + "T00:00:00Z")) &&
  new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
export function normalizeRule(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("提醒规则格式无效");
  const r = {
    paused: value.paused === true,
    priority: value.priority ?? "normal",
    cinemas: [],
    formats: [],
    weekdays: [],
    from: "",
    until: "",
    timeFrom: "",
    timeUntil: "",
    continueUntil: "",
  };
  if (!["normal", "urgent"].includes(r.priority)) throw new Error("提醒优先级无效");
  for (const key of ["cinemas", "formats", "weekdays"]) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) || value[key].length > 10)
    )
      throw new Error("提醒筛选格式无效");
    r[key] = [...new Set(value[key] || [])];
  }
  if (r.cinemas.some((id) => !cinemaIds.includes(id)))
    throw new Error("请选择已支持的影院");
  if (
    r.formats.some((v) => typeof v !== "string" || !v.trim() || v.length > 32)
  )
    throw new Error("制式筛选格式无效");
  if (r.weekdays.some((v) => !Number.isInteger(v) || v < 0 || v > 6))
    throw new Error("星期筛选格式无效");
  for (const key of ["from", "until", "continueUntil"])
    if (value[key]) {
      if (!date(value[key])) throw new Error("请选择有效日期");
      r[key] = value[key];
    }
  for (const key of ["timeFrom", "timeUntil"])
    if (value[key]) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key]))
        throw new Error("请选择有效时间");
      r[key] = value[key];
    }
  if (r.from && r.until && r.from > r.until)
    throw new Error("结束日期不能早于开始日期");
  return r;
}
export function monitorEligible(movie, rule = {}, today = chinaDay()) {
  if (rule.paused) return false;
  const release = movie.rt || movie.release || "";
  const before = date(release)
    ? release > today
    : movie.globalReleased === false || movie.upcoming === true;
  return before || Boolean(rule.continueUntil && rule.continueUntil >= today);
}
export function matchesSession(row, rule = {}) {
  const r = normalizeRule(rule),
    day = row.starts_at.slice(0, 10),
    time = row.starts_at.slice(11, 16);
  if (
    r.paused ||
    (r.cinemas.length && !r.cinemas.includes(String(row.cinema_id)))
  )
    return false;
  if (
    r.formats.length &&
    !r.formats.some((f) =>
      (row.format + " " + row.hall).toLowerCase().includes(f.toLowerCase()),
    )
  )
    return false;
  if ((r.from && day < r.from) || (r.until && day > r.until)) return false;
  if (
    r.weekdays.length &&
    !r.weekdays.includes(new Date(day + "T12:00:00+08:00").getUTCDay())
  )
    return false;
  // Overnight ranges, e.g. 22:00–02:00, include either side of midnight.
  if (r.timeFrom && r.timeUntil && r.timeFrom > r.timeUntil) {
    if (time < r.timeFrom && time > r.timeUntil) return false;
  } else if (
    (r.timeFrom && time < r.timeFrom) ||
    (r.timeUntil && time > r.timeUntil)
  )
    return false;
  return true;
}
export function visibleMovies(
  movies,
  {
    search = "",
    scope = "all",
    sort = "release",
    month = "",
    today = chinaDay(),
  } = {},
) {
  const end = new Date(today + "T12:00:00Z");
  end.setUTCDate(end.getUTCDate() + 6);
  const weekEnd = end.toISOString().slice(0, 10);
  const query = search.trim().toLowerCase();
  const list = movies.filter(
    (m) =>
      (!query ||
        (m.name + " " + (m.actors || "")).toLowerCase().includes(query)) &&
      (!month || String(m.release).startsWith(month)) &&
      (scope === "all" ||
        (scope === "week" && m.release >= today && m.release <= weekEnd) ||
        (scope === "month" &&
          String(m.release).startsWith(today.slice(0, 7))) ||
        (scope === "undated" && !date(m.release))),
  );
  return list.sort(
    sort === "wish"
      ? (a, b) => (b.wish || 0) - (a.wish || 0)
      : sort === "score"
        ? (a, b) => (b.score || 0) - (a.score || 0)
        : (a, b) =>
            (date(a.release) ? a.release : "9999").localeCompare(
              date(b.release) ? b.release : "9999",
            ) || (b.wish || 0) - (a.wish || 0),
  );
}
export function countdown(release, today = chinaDay()) {
  if (!date(release)) return "档期待定";
  const days = Math.round((Date.parse(release) - Date.parse(today)) / 86400000);
  return days > 0 ? `${days} 天后上映` : days === 0 ? "今日上映" : "已上映";
}
