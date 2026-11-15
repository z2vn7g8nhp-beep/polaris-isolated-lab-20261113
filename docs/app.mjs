import { installPlanner, sessionOverview, journalView, plannerSettings } from "./planner.mjs?v=audit-2";
import { countdownHero, installCountdown } from "./countdown.mjs?v=audit-2";
import { captureFocus, restoreFocus, captureDrafts, restoreDrafts, patchHTML, beginBusy, clearDrafts } from "./dom-state.mjs?v=audit-2";
import { monitorEligible, visibleMovies } from "./rules.mjs?v=planner-1";
import {
  installFeatures,
  selection,
  libraryControls,
  filmStatus,
  settingsExtras,
  onboarding,
  tokenMigration,
  eventView,
  browsing,
  restoreBrowsing,
} from "./features.mjs?v=audit-2";
import { api, connect, disconnect, deviceId } from "./client.mjs?v=audit-2";
import {
  pushSupport,
  enablePhonePush,
  disablePhonePush,
} from "./push.mjs?v=audit-2";
import { isComing, groupComing, posterUrl } from "./catalog.mjs?v=calm-1";
import { checkHealth } from "./status.mjs?v=audit-2";
import { icon, wishCount, rememberDisclosures, restoreDisclosures } from "./ui.mjs?v=journal-3";
let data = null,
  view = ["library", "sessions", "stars", "journal", "events", "settings"].includes(
    new URLSearchParams(location.search).get("view"),
  )
    ? new URLSearchParams(location.search).get("view")
    : "library",
  filter = view === "stars" ? "all" : "upcoming",
  search = "";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const viewMemory = {};
function remember() {
  try {
    sessionStorage.setItem(
      "polaris.browse.v1",
      JSON.stringify({ view, filter, search, browsing, viewMemory }),
    );
  } catch {}
}
const countdownUI = installCountdown({ getData: () => data, rerender: () => render(), toast });
const features = installFeatures({
  getData: () => data,
  refresh: load,
  rerender: () => render(),
  toast: (text) => toast(text),
});
const planner = installPlanner({ getData: () => data, refresh: load, rerender: () => render(), toast });
let frame = null, renderedView = null;
function toast(text) {
  $("#toast").textContent = text;
  document.querySelectorAll(".dialog-toast").forEach((el) => el.remove());
  const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
  $("#toast").classList.toggle("hidden", !!modal);
  const target = modal ? $("#toast").cloneNode(true) : $("#toast");
  if (modal) { target.removeAttribute("id"); target.classList.add("dialog-toast"); modal.append(target); }
  target.classList.remove("hidden");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(
    () => { target.classList.add("hidden"); if (modal) target.remove(); },
    4200,
  );
}
function time(t) {
  return t
    ? new Date(t * 1000).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "尚未检查";
}
function showState(next) {
  const changedConnection = data && data.connectionId !== next.connectionId;
  data = next;
  if (changedConnection) {
    planner.resetSession(); features.resetSession(); countdownUI.resetSession();
    renderedView = null;
    document.querySelectorAll('input[type="password"]').forEach((el) => { delete el.dataset.dirty; el.value = ""; });
  }
  if (frame === null) frame = requestAnimationFrame(() => { frame = null; render(); });
}

async function load() {
  try {
    showState(await api("state"));
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; render(); }
  } catch (e) {
    if (!data)
      $("#content").innerHTML =
        '<div class="empty"><strong>暂时无法连接</strong><p>' +
        esc(e.message) +
        '</p><button class="secondary" data-action="reload">重新连接</button></div>';
    else {
      render();
      toast(e.message);
    }
  }
}
function banner() {
  const health = checkHealth(data);
  if (health.kind === "paused")
    return `<div class="statusbox warn"><span>◉ 监测已暂停 · ${esc(data.paused || health.message)}</span><button class="secondary" data-action="resume">手动恢复</button></div>`;
  if (
    health.kind === "error" ||
    health.kind === "delayed" ||
    health.kind === "unknown"
  )
    return `<div class="statusbox warn"><details class="status-detail" data-disclosure="monitor-warning"><summary id="monitor-warning-summary">${health.kind === "delayed" ? "检查已延迟" : health.kind === "error" ? "检查失败" : "尚无检查记录"}<span>查看详情</span></summary><p>${esc(health.message)}</p></details><button class="secondary" data-action="tick">检查一次</button></div>`;
  if (!data.connected)
    return `<div class="statusbox"><span>连接 GitHub 后可保存星标和接收提醒。</span><button class="secondary" data-view="settings">连接 GitHub →</button></div>`;
  if (data.syncError)
    return `<div class="statusbox warn"><div>同步失败，显示已保存的数据。<details class="notice-reason"><summary>查看原因</summary>${esc(data.syncError)}</details></div><button class="secondary" data-action="reload">重试同步</button></div>`;
  if (data.connected && !data.personalReady)
    return '<div class="statusbox"><span>正在同步星标和提醒…</span></div>';
  if (data.pending)
    return `<div class="statusbox"><span>已保存，等待后台应用。</span></div>`;
  if (data.notificationMode === "push" && data.pushError)
    return `<div class="statusbox warn"><span>${esc(data.pushError)}</span><button class="secondary" data-view="settings">检查手机通知 →</button></div>`;
  if (
    !(data.notificationMode === "push"
      ? data.pushConfigured
      : data.notificationMode === "bark"
        ? data.barkConfigured
        : false)
  )
    return '<div class="statusbox warn"><span>尚未启用通知。</span><button class="secondary" data-view="settings">启用手机通知 →</button></div>';
  return "";
}
function card(m) {
  const img = posterUrl(m.img);
  const safe = /^https:\/\//.test(img) ? img : "";
  return `<article class="card"><div class="poster">${safe ? `<img src="${esc(safe)}" alt="${esc(m.name)}海报" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : ""}<button class="poster-open" data-detail="${esc(m.id)}" aria-label="查看${esc(m.name)}详情"></button><button class="star ${m.active ? "on" : ""}" data-star="${esc(m.id)}" ${(data.connected && !data.personalReady) || m.syncState === "saving" ? "disabled" : ""} aria-label="${m.active ? "停止监测" : "星标监测"}${esc(m.name)}" aria-pressed="${m.active}">${m.active ? "★" : "☆"}</button><span class="badge">${m.active ? (data.movieRules?.[m.id]?.paused ? "提醒已暂停" : monitorEligible(m, data.movieRules?.[m.id]) ? "持续监测中" : "星标保留") : m.upcoming ? "待上映" : "已上映"}</span></div><h3 title="${esc(m.name)}"><button class="film-title" data-detail="${esc(m.id)}">${esc(m.name)}</button></h3><div class="meta"><span>${esc(m.release)}</span><span>${m.score ? esc(m.score) + " 分" : m.wish ? wishCount(m.wish) + "人想看" : ""}</span></div>${filmStatus(m, data)}</article>`;
}
function baseMovies() {
  return data.movies.filter(
    (m) =>
      (view !== "stars" || m.active) &&
      (filter === "all" || (filter === "upcoming" ? isComing(m) : !m.upcoming)),
  );
}
function renderCards() {
  if (!data || !$("#cards")) return;
  const list = selection(baseMovies(), search);
  const cardsHTML = list.length
    ? filter === "upcoming" && browsing.sort === "release"
      ? comingList(list)
      : list.map(card).join("")
    : '<div class="empty"><strong>' +
      (view === "stars" && !data.movies.some((m) => m.active)
        ? "还没有星标电影"
        : "没有匹配的电影") +
      "</strong><p>" +
      (view === "stars" && !data.movies.some((m) => m.active)
        ? "在片库点击 ☆，待上映电影每轮新开票都会提醒。"
        : "试试其他片名，或清除日期与分类筛选。") +
      "</p></div>";
  patchHTML($("#cards"), cardsHTML);
  $("#listcount").textContent =
    `共 ${list.length} 部${view === "stars" ? "星标电影" : "电影"} · ${{ release: "按上映日期", wish: "按想看热度", score: "按评分" }[browsing.sort]}排列 · 数据来自猫眼`;
}
function cinemaMinutes() {
  return (
    Number(data.cadence?.cinemaMinutes) ||
    Number(data.schedule?.intervalMinutes) ||
    5
  );
}
function statusLabel() {
  const health = checkHealth(data);
  return health.kind === "paused"
    ? "已暂停"
    : health.kind === "error"
      ? "检查失败，等待重试"
      : health.kind === "delayed"
        ? "检查已延迟"
        : data.schedule
          ? `目标约每 ${cinemaMinutes()} 分钟，以成功时间为准`
          : "调度计划未确认";
}
function library() {
  const stars = data.movies.filter(
    (m) => m.active && monitorEligible(m, data.movieRules?.[m.id]),
  ).length;
  if (view === "stars" && data.personalReady !== false && !data.movies.some((m) => m.active))
    return `<div class="hero"><div><h1>我的星标</h1><p class="intro">为想看的电影留一个位置。</p></div></div><div class="empty empty-stars"><span class="empty-art">${icon("ticket")}${icon("star")}</span><strong>下一场期待，从这里开始</strong><p>星标喜欢的电影，连接通知后关注它的新开票。</p><button class="primary" data-view="library">去发现电影 →</button></div>`;
  return `${view === "library" ? countdownHero(data) : '<div class="hero"><div><h1>我的星标</h1><p class="intro">想看的电影，和它们的下一场。</p></div></div>'}<div class="stats"><div class="stat"><label>监测中</label><strong>${data.personalReady === false ? "同步中" : stars}<span style="font-size:12px;color:var(--muted);margin-left:7px">部</span></strong></div><div class="stat"><label>监测影院</label><strong>2<span style="font-size:12px;color:var(--muted);margin-left:7px">家</span></strong><small>MOMOPARK / 西安荟聚</small></div><div class="stat"><label>最近检查</label><strong style="font-size:19px;padding:7px 0">${esc(time(data.lastSuccess))}</strong><button class="text-button" data-action="tick">检查开票 ↻</button></div></div>${banner()}<div class="tools"><div class="tabs" role="group" aria-label="电影分类"><button data-filter="upcoming" class="${filter === "upcoming" ? "active" : ""}" aria-pressed="${filter === "upcoming"}">猫眼待映</button><button data-filter="released" class="${filter === "released" ? "active" : ""}" aria-pressed="${filter === "released"}">已上映</button><button data-filter="all" class="${filter === "all" ? "active" : ""}" aria-pressed="${filter === "all"}">全部电影</button></div><label class="search">${icon("search")}<input id="search" type="search" placeholder="搜索片名…" aria-label="搜索片名" value="${esc(search)}"></label></div>${libraryControls({ ...data, movies: visibleMovies(baseMovies(), { search, sort: browsing.sort }) })}<p class="countlabel" id="listcount"></p><div class="grid" id="cards"></div><div class="footnote"><span>片库整轮更新 ${esc(time(data.catalogCompleted || data.catalogUpdated))}</span></div>`;
}
function settings() {
  return `<div class="hero"><div><h1>监测与推送</h1></div></div>${onboarding(data)}${banner()}<div class="settings-steps"><details class="setup-step" data-disclosure="setup-connection" ${!data.connected ? "open" : ""}><summary id="setup-connection-summary"><span class="step-number">1</span><span>连接片库<small>加密同步星标和提醒设置</small></span><span class="step-state">${data.connected ? "已连接" : "待连接"}</span></summary>${connectionBox()}</details><details class="setup-step" data-disclosure="setup-notifications" ${data.connected ? "open" : ""}><summary id="setup-notifications-summary"><span class="step-number">2</span><span>启用并测试通知<small>让开票消息找到你</small></span><span class="step-state">${data.pushConfigured ? "已启用" : "待设置"}</span></summary>${phoneBox()}</details></div>${settingsExtras(data)}${plannerSettings(data)}<details class="settings-advanced" data-disclosure="advanced-settings"><summary id="advanced-settings-summary">高级设置<small>密钥迁移、Bark 与监测说明</small></summary>${tokenMigration(data)}<div class="settingsgrid"><section class="section"><h2>Bark（可选）</h2><p>复用已有设备 Key，使用独立「电影开票」分组。不会修改或覆盖你的其他通知。</p><form id="barkform"><label for="barkkey" class="note">设备 Key</label><br><input id="barkkey" name="key" type="password" autocomplete="off" placeholder="${data.barkConfigured ? "已加密保存；输入可更换" : "从 Bark App 复制设备 Key"}" required minlength="8"><div class="actions"><button type="submit" class="primary">${data.barkConfigured ? "更新 Key" : "保存并启用"}</button>${data.barkConfigured ? '<button type="button" class="secondary" data-action="bark/test">发送测试通知</button><button type="button" class="secondary" data-action="bark/remove">移除</button>' : ""}</div></form><div class="privacy">⌑ Key 加密保存于新仓库，公开文件中不会出现明文。<br>若 Bark 显示 https://api.day.app/你的Key/，只复制中间的 Key。</div>${data.barkError ? '<p style="color:#e6c38b">' + esc(data.barkError) + "</p>" : ""}</section><section class="section"><h2>监测状态</h2><p><span class="dot"></span>${statusLabel()}</p><div class="note">${data.schedule ? `配置外部定时后目标每 ${cinemaMinutes()} 分钟检查两家影院，GitHub 原生每 ${Number(data.schedule.fallbackMinutes) || 5} 分钟计划保留兜底。任务启动可能延迟，请以最近成功检查时间为准。` : "调度状态尚未确认。"}<br>猫眼待映、热映名单、想看人数和电影资料以每 5 分钟整轮更新为目标；实际时间受任务启动和来源响应影响。请求串行进行，连续失败自动退避；遇到验证码或访问限制，暂停并通过已启用的通知渠道提示。<br>低频轮询可能错过短暂开票窗口，不保证秒级送达。</div><div class="actions"><button class="secondary" data-action="tick">立即检查一次</button><button class="secondary" data-action="${data.paused ? "resume" : "pause"}">${data.paused ? "手动恢复" : "暂停全部监测"}</button></div></section></div></details><section class="section"><h2>监测影院</h2>${data.cinemas.map((c, i) => `<div class="cinemaitem"><div><strong>${esc(c.name)}</strong><br><small>${esc(c.address)} · 猫眼 ID ${c.id}</small></div><div><small>最近检查 ${esc(time(data.checks[i]?.checked))}</small><br><a href="https://m.maoyan.com/cinema/${c.id}" target="_blank" rel="noopener noreferrer">在猫眼打开 ↗</a></div></div>`).join("")}</section><section class="section"><h2>什么算一轮新开票？</h2><div class="note">新场次首次可售、明确不可售后再次可售，以及可识别的售票批次变化，都会产生提醒。同一状态反复出现不会重复提醒。首次星标后，当前已可售场次也会提醒一次。<br>默认仅提醒正式上映前的开票。可在电影详情设置上映后继续监测的截止日期；星标始终保留。提醒发送失败会保留并重试；手动取消星标会取消尚未发送的提醒。轮询间隔内发生且结束的变化可能无法被观察到。</div></section>`;
}
function events() {
  return eventView(data);
}
function render() {
  if (!data) return;
  if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
  const content = $("#content"), sameView = renderedView === view;
  const focus = sameView ? captureFocus(content) : null;
  const drafts = sameView ? captureDrafts(content) : [];
  const scroll = window.scrollY, strip = $(".expected-strip")?.scrollLeft;
  const names = {
    library: "电影片库",
    stars: "我的星标",
    sessions: "场次总览",
    journal: "我的手记",
    events: "提醒记录",
    settings: "监测与推送",
  };
  document.title = names[view] + " · 开票雷达";
  $("#navstars").textContent =
    data.personalReady === false
      ? "…"
      : data.movies.filter((m) => m.active).length;
  document.querySelectorAll("nav button").forEach((b) => {
    b.classList.toggle("selected", b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  rememberDisclosures($("#content"));
  const html =
    view === "settings" ? settings() : view === "events" ? events() : view === "sessions" ? sessionOverview(data) : view === "journal" ? journalView(data) : library();
  if (sameView) patchHTML(content, html, { preserveChildren: ["cards", "listcount"] });
  else content.innerHTML = html;
  renderedView = view;
  if (view === "library" || view === "stars") renderCards();
  restoreDisclosures($("#content"));
  restoreDrafts(content, drafts);
  features.afterRender();
  planner.afterRender();
  if (sameView) { if (strip && $(".expected-strip")) $(".expected-strip").scrollLeft = strip; restoreFocus(content, focus); window.scrollTo(0, scroll); }
  remember();
}
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    search = e.target.value;
    renderCards();
    remember();
  } else if (e.target.matches("input,select,textarea") && !e.target.closest(".discovery, .event-filters, #session-filters") && e.target.closest("#content, #movie-dialog, #entry-dialog"))
    e.target.dataset.dirty = "true";
});
document.addEventListener("change", (e) => {
  if (e.target.matches("input,select,textarea") && !e.target.closest(".discovery, .event-filters, #session-filters") && e.target.closest("#content, #movie-dialog, #entry-dialog")) e.target.dataset.dirty = "true";
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "barkform") return;
  e.preventDefault();
  const b = e.target.querySelector("button");
  const done = beginBusy(b); if (!done) return;
  try {
    await api("bark", { key: $("#barkkey").value.trim() });
    $("#barkkey").value = "";
    clearDrafts(e.target);
    toast("Bark Key 已加密保存，后台将在下一轮应用");
    await load();
  } catch (e) {
    toast(e.message);
  } finally {
    done();
  }
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.view) {
    if (!data) return;
    viewMemory[view] = {
      search,
      filter,
      browsing: { ...browsing },
      scroll: window.scrollY,
      strip: $(".expected-strip")?.scrollLeft || 0,
    };
    view = b.dataset.view;
    const saved = viewMemory[view];
    search = saved?.search || "";
    filter = saved?.filter || (view === "stars" ? "all" : "upcoming");
    restoreBrowsing(saved?.browsing);
    const url = new URL(location.href);
    url.searchParams.set("view", view);
    history.replaceState(null, "", url);
    render();
    if ($(".expected-strip"))
      $(".expected-strip").scrollLeft = saved?.strip || 0;
    window.scrollTo({ top: saved?.scroll || 0 });
    return;
  }
  if (b.dataset.filter) {
    filter = b.dataset.filter;
    render();
    return;
  }
  if (b.dataset.star) {
    if (b.disabled) return;
    const done = beginBusy(b); if (!done) return;
    const m = data.movies.find((m) => m.id === b.dataset.star);
    try {
      await api("star", { id: m.id, active: !m.active });
      toast(
        m.active ? "已保存停止监测，等待后台应用" : "已保存星标，等待后台应用",
      );
      await load();
    } catch (e) {
      toast(e.message);
    } finally {
      done();
    }
    return;
  }
  if (b.dataset.action) {
    const done = beginBusy(b); if (!done) return;
    try {
      const action = b.dataset.action;
      if (action === "reload") {
        await load();
        return;
      }
      const result =
        action === "push/remove"
          ? await disablePhonePush()
          : await api(action, {});
      if (action === "tick")
        toast(
          result.queued
            ? "已提交检查，后台完成后自动刷新"
            : result.paused
              ? "监测已暂停，请查看状态"
              : result.cooldown
                ? "冷却中，下一次可检查：" + time(result.next)
                : result.busy
                  ? "正在检查中，请稍后刷新"
                  : result.cinema
                    ? result.cinema +
                      " 已检查，新增 " +
                      result.newNotifications +
                      " 条提醒"
                    : "片库已更新",
        );
      else
        toast(
          ["bark/test", "push/test"].includes(action)
            ? "测试请求已提交，后台执行后会推送到手机"
            : action === "resume"
              ? "已恢复监测，保留原有冷却时间"
              : "设置已更新",
        );
      await load();
    } catch (e) {
      toast(e.message);
    } finally {
      done();
    }
  }
});

function connectionBox() {
  return `<section class="section"><h2>${data.connected ? "GitHub 已连接" : "连接你的片库"}</h2><p>${data.connected ? "星标和推送设置加密同步到新仓库；密钥只保存在当前浏览器。" : "片库可直接浏览。要保存星标和接收提醒，请连接一次 GitHub。"}</p>${data.connected ? '<button class="secondary" data-disconnect="true">断开当前浏览器</button>' : `<form id="connectform"><label class="note" for="githubtoken">GitHub Fine-grained token</label><br><input id="githubtoken" type="password" autocomplete="off" required placeholder="github_pat_…"><div class="actions"><button class="primary" type="submit">连接并同步</button><a class="secondary" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建仅限新仓库的密钥 ↗</a></div></form><details class="connection-help" data-disclosure="connection-help"><summary id="connection-help-summary">如何创建 GitHub 密钥？</summary><div class="note">创建密钥时，Repository access 选择 Only select repositories，只选 <strong>polaris-isolated-lab-20261113</strong>；Repository permissions 中设置 <strong>Contents</strong> 和 <strong>Actions</strong> 为 <strong>Read and write</strong>。<br>以后在其他设备连接时使用同一个密钥，便可解密同步配置。不要把密钥填进仓库文件。</div></details>`}</section>`;
}
window.addEventListener("polaris-state", (e) => showState(e.detail));
window.addEventListener("polaris-notice", (e) => toast(e.detail));
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "connectform") return;
  e.preventDefault();
  const b = e.target.querySelector("button");
  const done = beginBusy(b); if (!done) return;
  try {
    await connect($("#githubtoken").value);
    toast("已连接新仓库，配置将加密同步");
    await load();
  } catch (error) {
    toast(error.message);
  } finally {
    done();
  }
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-disconnect]")) return;
  disconnect();
  toast("已断开当前浏览器，后台监测保持原状");
  await load();
});

function comingList(movies) {
  const expected = [...movies].sort((a, b) => b.wish - a.wish).slice(0, 10);
  const expectedHtml =
    !search && view === "library"
      ? `<section class="expected"><h2>最受期待<span class="heading-note">按想看人数</span></h2><div class="expected-strip">${expected.map((m, i) => `<article class="expected-item"><div class="poster"><img src="${esc(posterUrl(m.img))}" alt="${esc(m.name)}海报" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'"><button class="poster-open" data-detail="${esc(m.id)}" aria-label="查看${esc(m.name)}详情"></button><button class="star ${m.active ? "on" : ""}" data-star="${esc(m.id)}" ${(data.connected && !data.personalReady) || m.syncState === "saving" ? "disabled" : ""} aria-label="${m.active ? "停止监测" : "星标监测"}${esc(m.name)}" aria-pressed="${m.active}">${m.active ? "★" : "☆"}</button><span class="badge">${i + 1}</span></div><h3><button class="film-title" data-detail="${esc(m.id)}">${esc(m.name)}</button></h3><small>${wishCount(m.wish)} 人想看</small></article>`).join("")}</div></section>`
      : "";
  return `<div class="coming-panel">${expectedHtml}${groupComing(movies)
    .map(
      (g) =>
        `<section class="coming-group"><header class="release-heading"><h2>${g.date === "undated" ? esc(g.title) : `<time datetime="${esc(g.date)}">${esc(g.title.replace(/周.$/, ""))}</time><small>${esc(g.title.match(/周.$/)?.[0] || "")}</small>`}</h2><span>${g.movies.length} 部上映</span></header><div class="release-films">${g.movies.map((m) => `<article class="coming-row"><button class="poster-thumb" data-detail="${esc(m.id)}" aria-label="查看${esc(m.name)}详情"><img class="coming-poster" src="${esc(posterUrl(m.img))}" alt="${esc(m.name)}海报" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'"></button><div class="coming-info"><h3><button class="film-title" data-detail="${esc(m.id)}">${esc(m.name)}</button></h3><p class="wish"><strong>${wishCount(m.wish)}</strong> 人想看</p><p class="cast">${m.actors ? "主演：" + esc(m.actors) : "主创信息待补充"}</p><small>${esc(m.release)} 上映</small>${filmStatus(m, data)}</div><button class="row-star ${m.active ? "selected" : ""}" data-star="${esc(m.id)}" ${(data.connected && !data.personalReady) || m.syncState === "saving" ? "disabled" : ""} aria-label="${m.active ? "停止监测" : "星标监测"}${esc(m.name)}" aria-pressed="${m.active}">${m.active ? "★ 已星标" : "☆ 想看"}</button></article>`).join("")}</div></section>`,
    )
    .join(
      "",
    )}${data.comingTotal > data.movies.filter(isComing).length && !search && view === "library" ? '<p class="note">猫眼待映条目正在后台分批补全，已收录 ' + data.movies.filter(isComing).length + " / " + data.comingTotal + " 部。</p>" : ""}</div>`;
}
function phoneBox() {
  const support = pushSupport();
  const own = data.pushDevices?.find((d) => d.id === deviceId());
  const phoneConfigured = own ? !own.expired : data.hasLegacyPush && data.pushConfigured;
  const help =
    support.ios && !support.standalone
      ? "iPhone：在 Safari 点「分享 → 添加到主屏幕」，再从桌面图标打开这个网站，然后启用通知。"
      : !support.supported
        ? "当前浏览器不支持系统通知。iPhone 需 iOS 16.4 以上，并从主屏幕打开。"
        : support.permission === "denied"
          ? "系统未允许通知，请在设备的通知设置中允许这个网页发送通知。"
          : "点击启用后允许系统通知；网页关闭时也能接收。声音和显示方式仍由系统通知设置决定。";
  return `<section class="section phone-section"><h2>手机系统通知</h2><p>直接使用手机自带的通知，不需要 Bark。</p><div class="note">${help}</div><label class="note" for="device-name">本机名称</label><br><input id="device-name" maxlength="40" placeholder="例如：我的 iPhone" value="${esc(data.pushDevices?.find((d) => d.id === deviceId())?.name || "")}"><div class="actions"><button class="primary" data-enable-push ${(data.connected && !data.personalReady) || !support.supported || (support.ios && !support.standalone) || support.permission === "denied" ? "disabled" : ""}>${phoneConfigured ? "重新连接本机通知" : "启用手机通知"}</button>${phoneConfigured ? '<button class="secondary" data-action="push/test">发送测试通知</button><button class="secondary" data-action="push/remove">停用本机通知</button>' : ""}</div><div class="privacy">${phoneConfigured ? "本机通知连接已保存，可在下方管理各设备。" : own?.expired ? "本机通知连接已失效，请重新启用。" : data.connected ? "本机尚未启用通知，可点击上方按钮完成设置。" : "首次启用前，请先连接上方的 GitHub。"}<br>启用后点「发送测试通知」，确认这台手机能收到。</div>${data.pushError ? '<p style="color:#e6c38b">' + esc(data.pushError) + "</p>" : ""}${data.requestResult ? '<p class="note">最近一次测试：' + (data.requestResult.ok ? "推送服务已接收，请查看手机" : esc(data.requestResult.message)) + "</p>" : ""}</section>`;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-enable-push]");
  if (!b) return;
  const done = beginBusy(b); if (!done) return;
  try {
    await enablePhonePush($("#device-name")?.value.trim(), {
      renew:
        !!data.pushDevices?.find((d) => d.id === deviceId())?.expired ||
        !!(data.hasLegacyPush && data.pushError?.includes("失效")),
    });
    toast("手机通知已保存，后台将在下一轮接入；随后可发送测试通知");
    await load();
  } catch (error) {
    toast(error.message);
  } finally {
    done();
  }
});

try {
  const saved = JSON.parse(sessionStorage.getItem("polaris.browse.v1")),
    params = new URLSearchParams(location.search);
  if (saved) {
    Object.assign(viewMemory, saved.viewMemory || {});
    if (!params.has("view") && !params.has("movie") && !params.has("event")) {
      restoreBrowsing(saved.browsing);
      view = ["library", "sessions", "stars", "journal", "events", "settings"].includes(saved.view)
        ? saved.view
        : view;
      filter = ["all", "released", "upcoming"].includes(saved.filter)
        ? saved.filter
        : view === "stars"
          ? "all"
          : "upcoming";
      search = typeof saved.search === "string" ? saved.search : "";
    } else if (params.has("view") && !params.has("event")) {
      const memory = viewMemory[view];
      if (memory) {
        restoreBrowsing(memory.browsing);
        filter = ["all", "released", "upcoming"].includes(memory.filter)
          ? memory.filter
          : filter;
        search = typeof memory.search === "string" ? memory.search : "";
      }
    }
  }
} catch {}

load();
setInterval(() => {
  if (document.visibilityState === "visible") load();
}, 60000);
