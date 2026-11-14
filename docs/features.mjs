import { captureFocus, restoreFocus } from "./dom-state.mjs";
import { api, rotateToken, deviceId } from "./client.mjs?v=audit-1";
import {
  chinaDay,
  countdown,
  normalizeRule,
  visibleMovies,
  matchesSession,
  monitorEligible,
} from "./rules.mjs";
function getLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const stamp = (t) =>
  t
    ? new Date(t * 1000).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "尚无记录";
const checked = (v) => (v ? "checked" : ""),
  selected = (v) => (v ? "selected" : "");
const browsingDefaults = () => ({
  scope: "all",
  sort: "release",
  month: "",
  day: "",
  calendar: false,
  calendarMonth: chinaDay().slice(0, 7),
  eventMovie: "",
  eventStatus: "all",
  groupEvents: true,
});
export const browsing = browsingDefaults();
export function restoreBrowsing(value = {}) {
  const defaults = browsingDefaults(),
    next = { ...defaults };
  if (value && typeof value === "object") {
    for (const [key, allowed] of Object.entries({
      scope: ["all", "week", "month", "undated"],
      sort: ["release", "wish", "score"],
      eventStatus: ["all", "unread", "pending", "sent", "cancelled"],
    }))
      if (allowed.includes(value[key])) next[key] = value[key];
    for (const key of ["month", "calendarMonth"])
      if (
        typeof value[key] === "string" &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(value[key])
      )
        next[key] = value[key];
    if (typeof value.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.day))
      next.day = value.day;
    if (typeof value.eventMovie === "string" && /^\d+$/.test(value.eventMovie))
      next.eventMovie = value.eventMovie;
    for (const key of ["calendar", "groupEvents"])
      if (typeof value[key] === "boolean") next[key] = value[key];
  }
  Object.assign(browsing, next);
}
let ctx,
  detailId = null,
  modalDirty = false,
  previousFocus = null;
const get = () => ctx.getData();
export function selection(movies, search) {
  return visibleMovies(movies, { ...browsing, search }).filter(
    (m) => !browsing.day || m.release === browsing.day,
  );
}
export function libraryControls(data) {
  const months = [
    ...new Set(
      data.movies
        .map((m) => String(m.release).slice(0, 7))
        .filter((v) => /^\d{4}-\d{2}$/.test(v)),
    ),
  ].sort();
  return `<div class="discovery"><div class="scope-buttons" role="group" aria-label="上映范围">${[
    ["all", "全部日期"],
    ["week", "未来七天"],
    ["month", "本月上映"],
    ["undated", "档期待定"],
  ]
    .map(
      ([v, label]) =>
        `<button data-scope="${v}" class="${browsing.scope === v ? "active" : ""}" aria-pressed="${browsing.scope === v}">${label}</button>`,
    )
    .join(
      "",
    )}</div><div class="discovery-options"><label>月份 <select id="month-filter"><option value="">不限月份</option>${months.map((v) => `<option ${selected(v === browsing.month)}>${v}</option>`).join("")}</select></label><label>排序 <select id="sort-filter">${[
    ["release", "上映日期"],
    ["wish", "想看热度"],
    ["score", "评分优先"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${selected(v === browsing.sort)}>${l}</option>`,
    )
    .join(
      "",
    )}</select></label><button class="secondary" data-calendar aria-pressed="${browsing.calendar}">${browsing.calendar ? "收起日历" : "▦ 上映日历"}</button></div></div><div id="release-calendar">${browsing.calendar ? calendar(data.movies) : ""}</div>${browsing.day ? `<p class="day-selection">正在看 ${esc(browsing.day)} 的电影 <button class="text-button" data-clear-day>清除日期 ×</button></p>` : ""}`;
}
function calendar(movies) {
  const month = browsing.calendarMonth,
    [year, m] = month.split("-").map(Number),
    first = new Date(Date.UTC(year, m - 1, 1)),
    days = new Date(Date.UTC(year, m, 0)).getUTCDate(),
    offset = (first.getUTCDay() + 6) % 7;
  const counts = new Map();
  for (const film of movies)
    if (String(film.release).startsWith(month))
      counts.set(film.release, (counts.get(film.release) || 0) + 1);
  return `<section class="calendar" aria-label="上映日历"><div class="calendar-heading"><button class="secondary" data-calendar-step="-1" aria-label="上个月">←</button><h2>${year} 年 ${m} 月</h2><button class="secondary" data-calendar-step="1" aria-label="下个月">→</button></div><div class="calendar-week">${["一", "二", "三", "四", "五", "六", "日"].map((d) => `<span>${d}</span>`).join("")}</div><div class="calendar-days">${"<span></span>".repeat(offset)}${Array.from(
    { length: days },
    (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, "0")}`,
        n = counts.get(d) || 0;
      return `<button data-calendar-day="${d}" class="${d === chinaDay() ? "today" : ""} ${d === browsing.day ? "chosen" : ""}" aria-pressed="${d === browsing.day}" aria-label="${d}，${n} 部上映"><span>${i + 1}</span><small>${n ? n + " 部" : ""}</small></button>`;
    },
  ).join(
    "",
  )}</div><p class="note">按片库中的正式上映日期展示，档期以片方及影院最新公布为准。</p></section>`;
}
export function filmStatus(movie, data) {
  const sessions = (data.sessions || []).filter(
      (r) => r.movie_id === movie.id && Date.parse(r.starts_at) > Date.now(),
    ),
    available = sessions.filter((r) => r.available).length;
  const rule = data.movieRules?.[movie.id];
  return `<div class="film-status"><span>${esc(countdown(movie.release))}</span><span>${rule?.paused ? "提醒已暂停" : available ? `已观测到 ${available} 场可售` : data.checks?.some(Boolean) ? "暂未观测到可售" : "场次尚未检查"}</span></div>${movie.active || ["saving", "pending", "error"].includes(movie.syncState) ? `<small class="save-state ${movie.syncState === "error" ? "save-error" : ""}">${{ saving: "正在保存星标…", pending: "已保存 · 等待后台应用", error: "保存失败，可重试", applied: "后台已应用" }[movie.syncState] || "星标已保存"}${movie.syncState === "error" ? ` <button class="text-button" data-retry-star="${esc(movie.id)}">重试</button>` : ""}</small>` : ""}`;
}
export function onboarding(data) {
  const tests = data.requestResult,
    received = data.receivedTest && data.receivedTest.id === tests?.id;
  const steps = [
    ["连接 GitHub", data.connected],
    ["启用通知", data.pushConfigured || data.barkConfigured],
    ["手机确认实收", received],
    ["星标一部电影", data.movies.some((m) => m.active)],
  ];
  if (steps.every(([, done]) => done) && getLocal("polaris.guide-complete"))
    return "";
  return `<section class="onboarding"><div><span class="section-kicker">READY FOR YOUR NEXT FILM</span><strong>让雷达开始为你守候</strong></div><ol>${steps.map(([name, done], i) => `<li class="${done ? "done" : ""}"><span>${done ? "✓" : i + 1}</span>${name}</li>`).join("")}</ol><button class="secondary" ${steps.every(([, d]) => d) ? "data-guide-dismiss" : 'data-view="settings"'}>${steps.every(([, d]) => d) ? "完成并收起" : "继续设置 →"}</button></section>`;
}
function health(data) {
  const now = Date.now() / 1000,
    history = (data.healthHistory || []).filter((h) => h.at > now - 86400),
    success = history.filter((h) => h.success),
    intervals = success.slice(1).map((h, i) => (h.at - success[i].at) / 60),
    max = intervals.length ? Math.max(...intervals) : null;
  return `<section class="section health-panel"><span class="section-kicker">THE RADAR, IN REAL TIME</span><h2>监测健康</h2><p>展示真实观测时间；配置保存、任务排队与检查成功分别记录。</p><div class="health-cinemas">${data.cinemas
    .map((c, i) => {
      const check = data.checks?.[i],
        age = check
          ? Math.max(0, Math.floor((now - check.checked) / 60))
          : null;
      return `<article><strong>${esc(c.short)}</strong><span class="health-state ${age === null || age >= 6 ? "late" : ""}">${age === null ? "尚未检查" : age >= 6 ? "检查延迟" : age + " 分钟前检查"}</span><small>${stamp(check?.checked)} · ${check?.movies ?? "—"} 部 / ${check?.sessions ?? "—"} 场</small></article>`;
    })
    .join(
      "",
    )}</div><div class="health-summary"><span>最近 24 小时成功记录 <b>${success.length}</b></span><span>已记录的最长成功间隔 <b>${max === null ? "待积累" : max.toFixed(1) + " 分钟"}</b></span><span>下次允许请求 <b>${data.nextRequest ? stamp(data.nextRequest) : "以后台冷却为准"}</b></span></div>${data.lastError ? `<p class="error-text">${esc(data.lastError)}</p>` : ""}${data.paused ? `<p class="error-text">${esc(data.paused)}</p>` : ""}<div class="health-timeline" aria-label="最近 24 小时的检查记录">${
    history
      .slice(-120)
      .map(
        (h) =>
          `<span class="${h.success ? "ok" : h.error ? "failed" : h.paused ? "paused" : "waiting"}" title="${stamp(h.at)} · ${h.success ? "成功" : h.error ? "失败" : h.paused ? "暂停" : "冷却或未完成"}"></span>`,
      )
      .join("") || '<p class="note">从本版上线后开始积累检查记录。</p>'
  }</div><p class="note">绿：成功 · 红：失败 · 黄：暂停 · 灰：冷却或未完成。间隔是已保存记录的统计，任务未启动期间不会生成记录。最近后台运行：${stamp(data.schedulerHeartbeat)}</p><div class="actions"><button class="secondary" data-action="tick">检查一次</button><button class="secondary" data-action="${data.paused ? "resume" : "pause"}">${data.paused ? "恢复监测" : "暂停全部监测"}</button></div></section>`;
}
export function settingsExtras(data) {
  const own = deviceId(),
    devices = data.pushDevices || [],
    test = data.requestResult,
    received = data.receivedTest?.id === test?.id;
  return `${onboarding(data)}<section class="section"><span class="section-kicker">YOUR CONNECTED SCREENS</span><h2>通知设备</h2><p>最多连接 8 台设备。请在每台设备上打开网站并启用通知；每台设备独立测试、命名和移除。</p>${devices.map((d) => `<div class="device-row"><div><strong>${esc(d.name)} ${d.id === own ? "<small>本机</small>" : ""}</strong><p>${esc(d.error || "已登记")}${d.lastSuccess ? " · 最近交给推送服务 " + stamp(d.lastSuccess) : ""}</p></div><div class="actions"><button class="secondary" data-device-test="${esc(d.id)}">测试</button><button class="secondary" data-device-rename="${esc(d.id)}">命名</button><button class="secondary" data-device-remove="${esc(d.id)}">移除</button></div></div>`).join("") || `<p class="note">${data.hasLegacyPush ? "原有手机通知仍然保留。在本机重新启用后，可继续添加其他设备。" : "还没有登记多设备通知。"}</p>`}${test ? `<div class="test-result"><strong>${test.ok ? "推送服务已接收测试请求" : "测试发送失败"}</strong><p>${test.ok ? "服务接受请求不等于手机实际收到。请查看目标设备通知，再手动确认。" : esc(test.message)}</p>${test.ok ? `<button class="secondary" data-test-received="${esc(test.id)}" ${received ? "disabled" : ""}>${received ? "已确认实际收到" : "我已在手机收到这条测试"}</button>` : ""}</div>` : ""}</section>${health(data)}<section class="section"><span class="section-kicker">KEEP YOUR JOURNAL WITH YOU</span><h2>更换密钥，迁移配置</h2><p>用旧密钥解密原配置，再用新密钥重新加密。星标、规则、设备和已读记录一起保留；旧密钥即使已过期，只要原字符串仍在，也能用于解密。</p><form id="rotate-form"><label class="note" for="old-token">原来的 GitHub 密钥（留空使用本机当前密钥）</label><input id="old-token" type="password" autocomplete="off" placeholder="旧 github_pat_…"><label class="note" for="new-token">新 GitHub 密钥 · 本仓库 Contents / Actions 读写权限</label><input id="new-token" type="password" autocomplete="off" required placeholder="新 github_pat_…"><div class="actions"><button class="primary" type="submit">迁移到新密钥</button></div></form><p class="note">迁移成功后，其他设备也需要改用新密钥。确认所有设备恢复同步后，再撤销旧密钥。旧密钥无法解密时不会覆盖原配置。</p></section>`;
}
export function eventView(data) {
  const read = new Set(data.readEvents || []),
    unread = data.events.filter((e) => !read.has(e.id)).length;
  let events = data.events.filter(
    (e) =>
      (!browsing.eventMovie || e.movie_id === browsing.eventMovie) &&
      (browsing.eventStatus === "all" ||
        (browsing.eventStatus === "unread" && !read.has(e.id)) ||
        (browsing.eventStatus === "pending" && !e.sent_at && !e.cancelled) ||
        (browsing.eventStatus === "sent" && e.sent_at) ||
        (browsing.eventStatus === "cancelled" && e.cancelled)),
  );
  const groups = [];
  for (const e of events) {
    const key = browsing.groupEvents
      ? `${e.movie_id || e.kind}:${e.cinemaId || ""}:${e.cancelled ? "cancelled" : e.sent_at ? "sent" : "pending"}`
      : e.id;
    let group = groups.find(
      (g) =>
        g.key === key &&
        (!browsing.groupEvents ||
          Math.abs(e.created_at - g.events[0].created_at) < 120),
    );
    if (!group) {
      group = { key, events: [] };
      groups.push(group);
    }
    group.events.push(e);
  }
  const movieIds = [
    ...new Set(data.events.map((e) => e.movie_id).filter(Boolean)),
  ];
  return `<div class="eyebrow">EVERY OPENING, REMEMBERED</div><div class="hero"><div><h1>提醒都有迹可循。</h1><p class="intro">最近 60 条记录 · ${unread} 条未读。已交给推送服务不代表手机实际收到。</p></div><button class="secondary" data-action="reload">刷新记录</button></div><div class="event-filters"><label>电影 <select id="event-movie"><option value="">全部电影</option>${movieIds.map((id) => `<option value="${esc(id)}" ${selected(browsing.eventMovie === id)}>${esc(data.movies.find((m) => m.id === id)?.name || id)}</option>`).join("")}</select></label><label>状态 <select id="event-status">${[
    ["all", "全部记录"],
    ["unread", "未读"],
    ["pending", "待发送"],
    ["sent", "交给推送服务"],
    ["cancelled", "已取消"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${selected(browsing.eventStatus === v)}>${l}</option>`,
    )
    .join(
      "",
    )}</select></label><label><input type="checkbox" id="event-group" ${checked(browsing.groupEvents)}> 合并同电影两分钟内的同状态提醒</label><button class="secondary" data-read-all>全部标为已读</button></div><div class="events">${
    groups.length
      ? groups
          .map((g) => {
            const e = g.events[0],
              ids = g.events.map((x) => x.id),
              isNew = ids.some((id) => !read.has(id)),
              movie = data.movies.find((m) => m.id === e.movie_id),
              sessions = g.events.flatMap((x) => x.sessions || []),
              url = sessions[0]?.url;
            return `<article id="event-${esc(e.id)}" data-event-ids="${esc(ids.join(","))}" class="event ${isNew ? "unread" : ""}"><span class="eventicon">${e.kind === "risk" ? "△" : "✦"}</span><div><h3>${esc(e.title)} ${g.events.length > 1 ? `<small>合并 ${g.events.length} 条</small>` : ""}</h3>${g.events.map((x) => `<p>${esc(x.body)}</p>`).join("")}<small>${stamp(e.created_at)}${e.attempts ? " · 重试 " + e.attempts + " 次" : ""}</small><div class="actions">${movie ? `<button class="secondary" data-detail="${esc(movie.id)}">查看电影与场次</button>` : ""}${safePurchase(url) ? `<a class="primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">去猫眼购票 ↗</a>` : ""}${isNew ? `<button class="secondary" data-read="${esc(ids.join(","))}">标为已读</button>` : ""}${movie?.active ? `<button class="text-button" data-pause-film="${esc(movie.id)}">${data.movieRules?.[movie.id]?.paused ? "恢复该片提醒" : "暂停该片提醒"}</button>` : ""}</div></div><span class="pill">${e.cancelled ? "已取消" : e.sent_at ? "已交给推送服务" : data.pushConfigured || data.barkConfigured ? "等待发送" : "待启用通知"}</span></article>`;
          })
          .join("")
      : `<div class="empty"><strong>${data.events.length ? "没有符合筛选的提醒" : "暂时还没有开票提醒"}</strong><p>在片库星标电影后，符合规则的新开票会出现在这里。</p><button class="primary" data-view="library">去电影片库 →</button></div>`
  }</div>`;
}
function safePurchase(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "m.maoyan.com" &&
      u.pathname.startsWith("/cinema/")
    );
  } catch {
    return false;
  }
}
function detail(movie, data) {
  const rule = normalizeRule(data.movieRules?.[movie.id]),
    rows = (data.sessions || [])
      .filter(
        (r) => r.movie_id === movie.id && Date.parse(r.starts_at) > Date.now(),
      )
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    matching = rows.filter((r) => r.available && matchesSession(r, rule)),
    formats = [
      ...new Set([
        "IMAX",
        "CINITY",
        "Dolby",
        ...rows
          .map((r) => r.format)
          .filter(Boolean)
          .filter((v) => v.length <= 32),
        ...rule.formats,
      ]),
    ];
  return `<div class="detail-heading"><span class="section-kicker">A STORY WORTH WAITING FOR</span><h2 id="detail-title">${esc(movie.name)}</h2><p>${esc(movie.release)} · ${esc(countdown(movie.release))}</p><button class="dialog-close secondary" data-close-detail aria-label="关闭电影详情">×</button></div><div class="detail-facts"><span>主演 <b>${esc(movie.actors || "资料待补充")}</b></span><span>猫眼评分 <b>${movie.score ? esc(movie.score) : "暂无"}</b></span><span>想看人数 <b>${Number(movie.wish || 0).toLocaleString()}</b></span></div><div class="detail-actions"><button class="primary" data-star="${esc(movie.id)}" ${movie.syncState === "saving" || (data.connected && !data.personalReady) ? "disabled" : ""}>${movie.active ? "★ 已星标 · 点击停止" : monitorEligible(movie, rule) ? "☆ 星标并监测" : "☆ 收藏这部电影"}</button><button class="secondary" data-copy-film="${esc(movie.id)}">复制电影链接</button></div><div class="detail-status">${filmStatus(movie, data)}</div><section class="detail-section"><h3>影院场次 <small>${matching.length} 场可售符合当前规则</small></h3><p class="note">以下是最近一次检查时观测到的场次；余票、票价和最终可售情况请以猫眼为准。</p>${data.cinemas
    .map((c, i) => {
      const sessions = rows.filter((r) => r.cinema_id === c.id),
        check = data.checks?.[i];
      return `<div class="session-cinema"><div class="session-heading"><strong>${esc(c.short)}</strong><small>检查：${stamp(check?.checked)}</small></div>${sessions.length ? `<div class="session-list">${sessions.map((r) => `<div class="session-row ${matchesSession(r, rule) ? "matches" : "outside-rule"}"><div><strong>${esc(r.starts_at.slice(5, 10))} ${esc(r.starts_at.slice(11, 16))}</strong><small>${esc(r.hall)} ${esc(r.format)}${matchesSession(r, rule) ? "" : " · 不在提醒范围"}</small></div><span>${r.available ? "已观测可售" : "暂不可售"}</span>${safePurchase(r.url) ? `<a class="secondary" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">猫眼 ↗</a>` : ""}</div>`).join("")}</div>` : `<p class="note">${check ? "本次检查未观测到该片未来场次。" : "尚未完成该影院的场次检查。"}</p>`}</div>`;
    })
    .join(
      "",
    )}</section><section class="detail-section"><h3>只为你想看的场次提醒</h3><p class="note">规则按北京时间匹配。留空表示不限；电影需要星标后才会监测。</p><form id="rule-form" data-movie="${esc(movie.id)}">${data.connected && !data.personalReady ? '<p class="note">正在同步原有规则，请稍候…</p>' : ""}<fieldset class="rule-body" ${data.connected && !data.personalReady ? "disabled" : ""}><fieldset><legend>影院</legend>${data.cinemas.map((c) => `<label><input type="checkbox" name="cinemas" value="${esc(c.id)}" ${checked(rule.cinemas.includes(c.id))}> ${esc(c.short)}</label>`).join("")}</fieldset><fieldset><legend>制式／影厅关键词 · 任一匹配</legend>${formats.map((f) => `<label><input type="checkbox" name="formats" value="${esc(f)}" ${checked(rule.formats.includes(f))}> ${esc(f)}</label>`).join("")}<label class="rule-custom">其他关键词 <input name="customFormat" maxlength="32" placeholder="例如：激光"></label></fieldset><fieldset><legend>星期</legend>${[
    [1, "一"],
    [2, "二"],
    [3, "三"],
    [4, "四"],
    [5, "五"],
    [6, "六"],
    [0, "日"],
  ]
    .map(
      ([v, l]) =>
        `<label><input type="checkbox" name="weekdays" value="${v}" ${checked(rule.weekdays.includes(v))}> 周${l}</label>`,
    )
    .join(
      "",
    )}</fieldset><div class="rule-dates"><label>场次开始日期<input type="date" name="from" value="${rule.from}"></label><label>场次结束日期<input type="date" name="until" value="${rule.until}"></label><label>开始时间<input type="time" name="timeFrom" value="${rule.timeFrom}"></label><label>结束时间<input type="time" name="timeUntil" value="${rule.timeUntil}"></label></div><p class="note">结束时间早于开始时间表示跨午夜，如 22:00–02:00。</p><label class="continue-label">上映后继续监测至 <input type="date" name="continueUntil" value="${rule.continueUntil}"></label><p class="note">留空仅提醒正式上映前的开票。填入日期后，包含该日期在内继续监测。</p><label><input type="checkbox" name="paused" ${checked(rule.paused)}> 暂停这部电影的提醒，保留星标</label><div class="actions"><button class="primary" type="submit">保存提醒规则</button><button class="secondary" type="button" data-reset-rule="${esc(movie.id)}">恢复默认规则</button></div></fieldset><p class="form-feedback" role="status" id="rule-feedback"></p></form><p class="note">当前：${monitorEligible(movie, rule) ? (movie.active ? "按规则持续监测" : "尚未星标") : rule.paused ? "该片提醒已暂停" : "已超过监测日期，星标仍保留"}。修改规则不会补发已过去的开票事件；新出现或恢复可售的匹配场次会继续提醒。</p></section>`;
}
function openDetail(id) {
  const movie = get()?.movies.find((m) => m.id === id);
  if (!movie) return;
  detailId = id;
  modalDirty = false;
  previousFocus = document.activeElement;
  const dialog = document.querySelector("#movie-dialog");
  dialog.innerHTML = detail(movie, get());
  dialog.showModal();
  const url = new URL(location.href);
  url.searchParams.set("movie", id);
  history.replaceState(null, "", url);
  dialog.querySelector("[data-close-detail]").focus();
}
function closeDetail() {
  const dialog = document.querySelector("#movie-dialog");
  dialog.close();
  detailId = null;
  modalDirty = false;
  const url = new URL(location.href);
  url.searchParams.delete("movie");
  history.replaceState(null, "", url);
  previousFocus?.isConnected && previousFocus.focus();
}
export function updateDetail() {
  const dialog = document.querySelector("#movie-dialog");
  if (!dialog?.open || !detailId) return;
  const movie = get()?.movies.find((m) => m.id === detailId);
  if (!movie) return;
  if (
    modalDirty ||
    (dialog.contains(document.activeElement) &&
      document.activeElement.matches("input,select"))
  ) {
    const button = dialog.querySelector(".detail-actions [data-star]");
    if (button) {
      button.disabled =
        movie.syncState === "saving" ||
        (get().connected && !get().personalReady);
      button.textContent = movie.active
        ? "★ 已星标 · 点击停止"
        : monitorEligible(movie, get().movieRules?.[movie.id])
          ? "☆ 星标并监测"
          : "☆ 收藏这部电影";
    }
    const status = dialog.querySelector(".detail-status");
    if (status) status.innerHTML = filmStatus(movie, get());
    return;
  }
  const scroll = dialog.scrollTop,
    lists = [...dialog.querySelectorAll(".session-list")].map(
      (el) => el.scrollTop,
    ),
    focus = captureFocus(dialog);
  dialog.innerHTML = detail(movie, get());
  restoreFocus(dialog, focus);
  [...dialog.querySelectorAll(".session-list")].forEach(
    (el, i) => (el.scrollTop = lists[i] || 0),
  );
  dialog.scrollTop = scroll;
}

async function action(button, work, message) {
  button.disabled = true;
  try {
    await work();
    if (message) ctx.toast(message);
    await ctx.refresh();
    updateDetail();
  } catch (e) {
    ctx.toast(e.message);
  } finally {
    button.disabled = false;
  }
}
export function installFeatures(context) {
  ctx = context;
  const dialog = document.createElement("dialog");
  dialog.id = "movie-dialog";
  dialog.className = "movie-dialog";
  dialog.setAttribute("aria-labelledby", "detail-title");
  document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDetail();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        closeDetail();
    }
  });
  dialog.addEventListener("input", () => (modalDirty = true));
  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "month-filter") {
      browsing.month = e.target.value;
      browsing.day = "";
    } else if (id === "sort-filter") browsing.sort = e.target.value;
    else if (id === "event-movie") browsing.eventMovie = e.target.value;
    else if (id === "event-status") browsing.eventStatus = e.target.value;
    else if (id === "event-group") browsing.groupEvents = e.target.checked;
    else return;
    ctx.rerender();
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.detail) {
      openDetail(b.dataset.detail);
      return;
    }
    if (b.hasAttribute("data-close-detail")) {
      closeDetail();
      return;
    }
    if (b.dataset.scope) {
      browsing.scope = b.dataset.scope;
      browsing.day = "";
      ctx.rerender();
      return;
    }
    if (b.hasAttribute("data-calendar")) {
      browsing.calendar = !browsing.calendar;
      ctx.rerender();
      return;
    }
    if (b.dataset.calendarStep) {
      const [y, m] = browsing.calendarMonth.split("-").map(Number);
      browsing.calendarMonth = new Date(
        Date.UTC(y, m - 1 + Number(b.dataset.calendarStep), 1),
      )
        .toISOString()
        .slice(0, 7);
      ctx.rerender();
      return;
    }
    if (b.dataset.calendarDay) {
      browsing.day = b.dataset.calendarDay;
      browsing.scope = "all";
      browsing.month = "";
      ctx.rerender();
      return;
    }
    if (b.hasAttribute("data-clear-day")) {
      browsing.day = "";
      ctx.rerender();
      return;
    }
    if (b.hasAttribute("data-guide-dismiss")) {
      try {
        localStorage.setItem("polaris.guide-complete", "1");
      } catch {}
      ctx.rerender();
      return;
    }
    if (b.dataset.copyFilm) {
      try {
        const url = new URL(location.href);
        url.search = "";
        url.searchParams.set("movie", b.dataset.copyFilm);
        await navigator.clipboard.writeText(url.href);
        ctx.toast("电影链接已复制");
      } catch {
        ctx.toast("复制失败，可直接复制浏览器地址栏中的电影链接");
      }
      return;
    }
    if (b.dataset.read || b.hasAttribute("data-read-all"))
      return action(
        b,
        () =>
          api("events/read", {
            ids: b.dataset.read
              ? b.dataset.read.split(",")
              : get().events.map((e) => e.id),
          }),
        "已标为已读",
      );
    if (b.dataset.pauseFilm) {
      const id = b.dataset.pauseFilm;
      return action(
        b,
        () =>
          api("rule", {
            id,
            rule: {
              ...get().movieRules?.[id],
              paused: !get().movieRules?.[id]?.paused,
            },
          }),
        "该片提醒规则已保存，等待后台应用",
      );
    }
    if (b.dataset.retryStar) {
      const id = b.dataset.retryStar;
      return action(
        b,
        () =>
          api("star", {
            id,
            active: get().mutationErrors?.[id]?.retry ?? true,
          }),
        "星标已重新提交",
      );
    }
    if (b.dataset.resetRule)
      return action(
        b,
        async () => {
          await api("rule", { id: b.dataset.resetRule, rule: {} });
          modalDirty = false;
        },
        "已恢复默认规则",
      );
    if (b.dataset.deviceRemove)
      return action(
        b,
        () => api("device/remove", { id: b.dataset.deviceRemove }),
        "设备已移除，等待后台应用",
      );
    if (b.dataset.deviceTest)
      return action(
        b,
        () => api("push/test", { deviceId: b.dataset.deviceTest }),
        "测试请求已提交，请在目标设备查看通知",
      );
    if (b.dataset.deviceRename) {
      const d = get().pushDevices.find((d) => d.id === b.dataset.deviceRename),
        name = window.prompt("给设备起一个名称", d.name);
      if (name?.trim())
        return action(
          b,
          () => api("device/rename", { id: d.id, name }),
          "设备名称已保存",
        );
      return;
    }
    if (b.dataset.testReceived)
      return action(
        b,
        () => api("test/received", { id: b.dataset.testReceived }),
        "已记录这条测试实际收到",
      );
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id === "rule-form") {
      e.preventDefault();
      const form = e.target,
        b = form.querySelector("button[type=submit]"),
        values = new FormData(form),
        feedback = form.querySelector("#rule-feedback");
      b.disabled = true;
      try {
        const rule = normalizeRule({
          ...Object.fromEntries(values),
          cinemas: values.getAll("cinemas"),
          formats: [
            ...values.getAll("formats"),
            ...(values.get("customFormat")?.trim()
              ? [values.get("customFormat").trim()]
              : []),
          ],
          weekdays: values.getAll("weekdays").map(Number),
          paused: values.has("paused"),
        });
        await api("rule", { id: form.dataset.movie, rule });
        modalDirty = false;
        ctx.toast("提醒规则已保存，后台将在下一轮应用");
        await ctx.refresh();
        updateDetail();
      } catch (error) {
        feedback.textContent = error.message;
        ctx.toast(error.message);
      } finally {
        b.disabled = false;
      }
    }
    if (e.target.id === "rotate-form") {
      e.preventDefault();
      const form = e.target,
        b = form.querySelector("button");
      await action(
        b,
        async () => {
          const old = form.querySelector("#old-token").value.trim(),
            next = form.querySelector("#new-token").value.trim();
          await rotateToken(next, old || undefined);
          form.reset();
          document.querySelector("#rotate-form")?.reset();
        },
        "密钥迁移成功，其他设备请改用新密钥",
      );
    }
  });
  let initialMovie = new URL(location.href).searchParams.get("movie"),
    initialEvent = new URL(location.href).searchParams.get("event"),
    scrolledToEvent = false;
  return {
    afterRender() {
      updateDetail();
      if (initialEvent && get()?.events.length) {
        const match = [...document.querySelectorAll("[data-event-ids]")].find(
          (el) => el.dataset.eventIds.split(",").includes(initialEvent),
        );
        if (match) {
          match.classList.add("linked-event");
          if (!scrolledToEvent)
            requestAnimationFrame(() => {
              const current = [
                ...document.querySelectorAll("[data-event-ids]"),
              ].find((el) =>
                el.dataset.eventIds.split(",").includes(initialEvent),
              );
              if (current) {
                current.scrollIntoView({ block: "center" });
                scrolledToEvent = true;
              }
            });
        }
      }
      if (initialMovie && get()) {
        const id = initialMovie;
        initialMovie = null;
        openDetail(id);
      }
    },
  };
}
