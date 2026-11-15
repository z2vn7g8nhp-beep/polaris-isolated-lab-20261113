import { sendPush, validateSubscription } from "./push.mjs";
import { normalizeNotificationPrefs, notificationDue, validDay } from "../docs/planner-model.mjs";
export const CADENCE = Object.freeze({
  cinemaMinutes: 2,
  cinemaCooldownSeconds: 110,
  catalogMinutes: 5,
  comingListMinutes: 5,
  releasedListMinutes: 5,
  detailsMinAgeMinutes: 5,
  batchSize: 12,
  maxCatalogRequests: 20,
  maxRequestsPerRun: 22,
});
import {
  normalizeRule,
  monitorEligible,
  matchesSession,
} from "../docs/rules.mjs";
const HTML = "__HTML__";
import SEED from "../bootstrap/movies.json" with { type: "json" };
export const CINEMAS = [
  {
    id: "25769",
    name: "UME影城（MOMOPARK激光IMAX店）",
    short: "MOMOPARK · UME",
    address: "小寨西路232号 MOMOPARK 4层",
  },
  {
    id: "39869",
    name: "寰映影城（西安荟聚激光IMAX店）",
    short: "西安荟聚 · 寰映",
    address: "西部大道与子午大道交汇处 荟聚3层",
  },
];
const now = () => Math.floor(Date.now() / 1000);
const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const json = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
class RiskError extends Error {}
const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
async function get(env, key, def = null) {
  const r = await q(env, "SELECT value FROM radar_kv WHERE key=?", key).first();
  return r ? JSON.parse(r.value) : def;
}
async function set(env, key, v) {
  await q(
    env,
    "INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify(v),
  ).run();
}
export function upcoming(m, today = day()) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(m.rt || "")) return m.rt > today;
  return m.globalReleased === false;
}
export function parseSessions(data, cinema) {
  const movies = data?.showData?.movies;
  if (!Array.isArray(movies) || String(data.showData.cinemaId) !== cinema.id)
    throw new Error("影院响应结构或 ID 异常");
  const rows = [];
  for (const m of movies) {
    if (!/^\d+$/.test(String(m.id))) throw new Error("电影编号异常");
    if (!Array.isArray(m.shows)) throw new Error("排片响应缺少日期");
    for (const d of m.shows) {
      if (!Array.isArray(d.plist)) throw new Error("排片响应缺少场次");
      for (const s of d.plist) {
        if (
          typeof s.dt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(s.dt) ||
          !Number.isFinite(Date.parse(s.dt + "T00:00:00Z")) ||
          new Date(s.dt + "T00:00:00Z").toISOString().slice(0, 10) !== s.dt ||
          typeof s.tm !== "string" ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.tm) ||
          typeof s.th !== "string" ||
          !s.th.trim() ||
          (s.tp != null && typeof s.tp !== "string")
        )
          throw new Error("场次时间或影厅格式异常");
        const starts = `${s.dt}T${s.tm}:00+08:00`;
        if (Date.parse(starts) < Date.now()) continue;
        const id = [cinema.id, m.id, s.seqNo || `${s.dt}:${s.tm}:${s.th}`].join(
          ":",
        );
        rows.push({
          id,
          movie_id: String(m.id),
          movie: m,
          cinema_id: cinema.id,
          cinema: cinema.short,
          starts_at: starts,
          hall: s.th,
          format: s.tp || "",
          available: s.enterShowSeat === 1 && !s.forbiddenTip,
          round: String(s.saleDate || ""),
          url: `https://m.maoyan.com/cinema/${cinema.id}?movieId=${m.id}`,
        });
      }
    }
  }
  return { movies, rows };
}
async function source(path) {
  const response = await fetch("https://m.maoyan.com/ajax/" + path, {
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "User-Agent": "MovieRadar/1.0 (personal release notifier)",
    },
    signal: AbortSignal.timeout(20000),
  });
  if ([301, 302, 303, 307, 308, 401, 403, 418, 429].includes(response.status))
    throw new RiskError(`猫眼返回 HTTP ${response.status}，已暂停访问`);
  if (!response.ok) throw new Error(`猫眼 HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("json"))
    throw new RiskError("猫眼返回验证或非数据页面");
  const text = await response.text();
  if (text.length > 3e6) throw new Error("响应过大");
  const data = JSON.parse(text);
  if (
    data.captcha_required ||
    data.risk_control ||
    data.verifyUrl ||
    data.url?.includes("verify")
  )
    throw new RiskError("猫眼要求人工验证");
  return data;
}
function mergeMovie(previous, incoming) {
  const merged = { ...previous, ...incoming };
  if (validDay(previous?.rt) && !validDay(incoming.rt)) merged.rt = previous.rt;
  return merged;
}
function movieStatements(env, movies) {
  return movies.map((m) =>
    q(
      env,
      `INSERT INTO radar_movies VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      String(m.id),
      JSON.stringify(m),
      now(),
    ),
  );
}
async function seed(env) {
  if ((await get(env, "seed_count", -1)) === SEED.length) return;
  for (let i = 0; i < SEED.length; i += 40)
    await env.DB.batch(
      SEED.slice(i, i + 40).map((m) =>
        q(
          env,
          "INSERT OR IGNORE INTO radar_movies VALUES (?,?,?)",
          String(m.id),
          JSON.stringify(m),
          now(),
        ),
      ),
    );
  await set(env, "seed_count", SEED.length);
  await set(env, "seeded", true);
  if (!(await get(env, "catalog_updated")))
    await set(env, "catalog_updated", now());
}
export async function crypt(env, value, decrypt = false) {
  if (!env.BARK_ENCRYPTION_KEY) throw new Error("服务端加密密钥未配置");
  const bytes = Uint8Array.from(atob(env.BARK_ENCRYPTION_KEY), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  if (decrypt) {
    const all = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: all.slice(0, 12) },
      key,
      all.slice(12),
    );
    return new TextDecoder().decode(out);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value),
    ),
  );
  return btoa(String.fromCharCode(...iv, ...out));
}
async function bark(env, title, body) {
  const saved = await get(env, "bark");
  if (!saved) throw new Error("请先配置 Bark");
  const key = await crypt(env, saved, true);
  // Fixed destination prevents credentials being forwarded to arbitrary URLs.
  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_key: key,
      title,
      body,
      group: "电影开票",
      sound: "bell",
      url: "https://m.maoyan.com/",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Bark 服务暂不可用");
  const result = await response.json();
  if (result.code !== 200) throw new Error("Bark 拒绝推送，请检查设备 Key");
}
async function notificationMode(env) {
  return (
    (await get(env, "notification_mode")) ||
    ((await get(env, "push_subscription"))
      ? "push"
      : (await get(env, "bark"))
        ? "bark"
        : "off")
  );
}
export async function notify(
  env,
  title,
  body,
  id,
  forcePush = false,
  deviceId = null,
  navigateId = id,
  targetView = "events",
) {
  if (forcePush || (await notificationMode(env)) === "push") {
    const devices = await get(env, "push_devices");
    if (devices !== null) {
      const targets = devices.filter(
          (d) => !d.expired && (!deviceId || d.id === deviceId),
        ),
        acked = await get(env, "delivery_" + id, []);
      let failure = false,
        sent = 0;
      if (!targets.length) throw new Error("没有可用的通知设备，请重新启用");
      for (const device of targets) {
        if (Date.now() >= (env.DELIVERY_DEADLINE || Infinity)) {
          failure = true;
          break;
        }
        if (acked.includes(device.registration)) {
          sent++;
          continue;
        }
        try {
          await sendPush(env, device.subscription, { title, body, id, navigateId, targetView });
          acked.push(device.registration);
          device.error = null;
          device.lastSuccess = now();
          sent++;
        } catch (error) {
          device.error = [404, 410].includes(error.statusCode)
            ? "连接已失效，请在该设备重新启用"
            : "发送失败，稍后重试";
          failure = true;
          if ([404, 410].includes(error.statusCode)) {
            device.expired = true;
            const revoked = await get(env, "revoked_devices", []);
            await set(
              env,
              "revoked_devices",
              [...new Set([...revoked, device.registration])].slice(-100),
            );
          }
        }
      }
      await set(env, "delivery_" + id, acked);
      await set(env, "push_devices", devices);
      await set(
        env,
        "push_error",
        failure ? "部分设备发送失败，请查看设备列表；失败提醒保留重试。" : null,
      );
      if (failure || !sent) throw new Error("部分设备发送失败");
      return;
    }
    const subscription = await get(env, "push_subscription");
    if (!subscription) throw new Error("请在主屏幕网站中重新启用手机通知");
    try {
      await sendPush(env, subscription, { title, body, id, navigateId, targetView });
      await set(env, "push_error", null);
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await set(env, "push_subscription", null);
        await set(
          env,
          "push_error",
          "通知连接已失效，请在主屏幕网站中重新启用；未发送提醒仍保留。",
        );
      } else
        await set(
          env,
          "push_error",
          "手机通知发送失败，已保留提醒并安排重试。",
        );
      throw new Error("手机通知发送失败");
    }
    return;
  }
  await bark(env, title, body);
}
async function deliver(env) {
  const mode = await notificationMode(env);
  if (
    mode === "off" ||
    (mode === "push" &&
      !(await get(env, "push_subscription")) &&
      !(await get(env, "push_devices"))?.length) ||
    (mode === "bark" && !(await get(env, "bark")))
  )
    return;
  env.DELIVERY_DEADLINE ||= Date.now() + 60000;
  const events = (
    await q(
      env,
      `SELECT e.* FROM radar_events e LEFT JOIN radar_stars s ON e.movie_id=s.movie_id WHERE e.sent_at IS NULL AND e.cancelled=0 AND e.next_try<=? AND (e.movie_id IS NULL OR s.active=1) ORDER BY e.created_at LIMIT 40`,
      now(),
    ).all()
  ).results;
  const prefs = normalizeNotificationPrefs(await get(env, "notification_prefs", {}));
  const rules = await get(env, "movie_rules", {}), ready = [];
  for (const e of events) {
    if (Date.now() >= (env.DELIVERY_DEADLINE || Infinity)) break;
    if (e.kind === "release-date" && !prefs.releaseChanges) {
      await q(env, "UPDATE radar_events SET cancelled=1 WHERE id=?", e.id).run();
      continue;
    }
    const plan = notificationDue(e, rules[e.movie_id], prefs);
    if (plan.due > now()) {
      await q(env, "UPDATE radar_events SET next_try=? WHERE id=?", Math.ceil(plan.due), e.id).run();
      continue;
    }
    // Re-read star immediately before IO so manual stop cancels queued work.
    if (e.movie_id) {
      const star = await q(
        env,
        "SELECT active FROM radar_stars WHERE movie_id=?",
        e.movie_id,
      ).first();
      if (!star?.active) continue;
      const movie = await q(
        env,
        "SELECT data FROM radar_movies WHERE id=?",
        e.movie_id,
      ).first();
      const rule = (await get(env, "movie_rules", {}))[e.movie_id];
      const detail = await get(env, "event_" + e.id);
      const snapshots = new Map();
      if (detail?.sessions)
        for (const id of new Set(detail.sessions.map((r) => r.cinema_id))) {
          const check = await get(env, "cinema_" + id);
          const rows = await get(env, "sessions_" + id);
          if (check?.checked >= e.created_at && Array.isArray(rows))
            snapshots.set(id, new Map(rows.map((r) => [r.id, r])));
        }
      const currentSessions = detail?.sessions?.map((r) => snapshots.has(r.cinema_id)
        ? snapshots.get(r.cinema_id).get(r.id) : r).filter(Boolean);
      const eligible = (r) =>
        Date.parse(r.starts_at) > Date.now() &&
        matchesSession(r, rule) && r.available === true;
      const matching = currentSessions?.filter(eligible);
      const invalidSale = e.kind === "release" &&
        (!movie || !monitorEligible(JSON.parse(movie.data), rule) || (matching && !matching.length));
      if (rule?.paused || invalidSale) {
        await q(
          env,
          "UPDATE radar_events SET cancelled=1 WHERE id=?",
          e.id,
        ).run();
        continue;
      }
      if (matching) {
        if (JSON.stringify(matching) !== JSON.stringify(detail.sessions)) {
          e.body = sessionBody(
            detail.cinema || matching[0]?.cinema || "影院",
            matching,
          );
          await q(
            env,
            "UPDATE radar_events SET body=? WHERE id=?",
            e.body,
            e.id,
          ).run();
          await set(env, "event_" + e.id, { ...detail, sessions: matching });
        }
      }
    }
    ready.push({ event: e, plan });
  }
  const groups = new Map();
  for (const { event, plan } of ready.sort((a, b) => Number(b.plan.urgent) - Number(a.plan.urgent))) {
    const key = plan.digest ? "digest" : event.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const group of groups.values()) {
    if (Date.now() >= env.DELIVERY_DEADLINE) break;
    try {
      await notifyGroup(env, group, mode);
      await env.DB.batch(group.map((e) => q(env, "UPDATE radar_events SET sent_at=? WHERE id=?", now(), e.id)));
      await set(env, "bark_error", null);
    } catch {
      await env.DB.batch(group.map((e) => q(env, "UPDATE radar_events SET attempts=attempts+1,next_try=? WHERE id=?", now() + Math.min(3600, 60 * 2 ** Math.min(e.attempts, 6)), e.id)));
      if (mode === "bark") await set(env, "bark_error", "推送失败，已保留提醒并安排重试；可在设置中测试 Bark。");
      break;
    }
  }
}
function digestMessage(events) {
  return { title: `电影消息汇总 · ${events.length} 条`, body: events.slice(0, 8).map((e) => e.title + "\n" + e.body.split("\n").slice(0, 2).join(" · ")).join("\n\n") + (events.length > 8 ? "\n更多消息请打开提醒记录。" : "") };
}
async function notifyGroup(env, events, mode) {
  if (events.length === 1) return notify(env, events[0].title, events[0].body, events[0].id);
  const devices = mode === "push" ? await get(env, "push_devices") : null;
  if (devices === null) {
    const message = digestMessage(events);
    return notify(env, message.title, message.body, events[0].id);
  }
  const targets = devices.filter((d) => !d.expired);
  if (!targets.length) throw new Error("没有可用的通知设备");
  let failure = false;
  for (const device of targets) {
    const pending = [];
    for (const event of events) if (!(await get(env, "delivery_" + event.id, [])).includes(device.registration)) pending.push(event);
    if (!pending.length) continue;
    try {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.map((e) => e.id).sort().join(","))));
      const batchId = "digest-" + [...hash].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
      const message = pending.length === 1 ? pending[0] : digestMessage(pending);
      await notify(env, message.title, message.body, batchId, true, device.id, pending[0].id);
      for (const event of pending) await set(env, "delivery_" + event.id, [...new Set([...(await get(env, "delivery_" + event.id, [])), device.registration])]);
    } catch { failure = true; }
  }
  if (failure) throw new Error("部分设备发送失败");
}

function sessionBody(cinema, rows) {
  return (
    `${cinema} 新开售 ${rows.length} 场\n` +
    rows
      .slice(0, 5)
      .map(
        (r) =>
          `${r.starts_at.slice(5, 10)} ${r.starts_at.slice(11, 16)} · ${r.hall} ${r.format}`,
      )
      .join("\n") +
    (rows.length > 5 ? "\n更多场次请打开猫眼查看" : "") +
    "\n星标继续监测，每轮符合规则的新开票都会提醒。"
  );
}
async function ingestCinema(env, data, cinema) {
  const { movies, rows } = parseSessions(data, cinema);
  const existing = (await q(env, "SELECT id,data FROM radar_movies").all())
    .results;
  const map = new Map(existing.map((r) => [r.id, JSON.parse(r.data)]));
  // Cinema summaries lack release dates: preserve richer catalog metadata.
  const merged = movies.map((m) => mergeMovie(map.get(String(m.id)), m));
  if (merged.length) await env.DB.batch(movieStatements(env, merged));
  const stars = new Set(
    (
      await q(env, "SELECT movie_id FROM radar_stars WHERE active=1").all()
    ).results.map((r) => r.movie_id),
  );
  const rules = await get(env, "movie_rules", {});
  await set(
    env,
    "sessions_" + cinema.id,
    rows.map(({ movie, ...row }) => row),
  );
  const previous = new Map(
    (await q(env, "SELECT * FROM radar_sessions").all()).results.map((s) => [
      s.id,
      s,
    ]),
  );
  const statements = [],
    groups = new Map();
  for (const row of rows) {
    const m = merged.find((m) => String(m.id) === row.movie_id);
    if (!stars.has(row.movie_id) || !monitorEligible(m, rules[row.movie_id]))
      continue;
    const old = previous.get(row.id);
    const oldData = old ? JSON.parse(old.data) : {};
    const changed =
      row.available && (!old || !old.available || oldData.round !== row.round);
    const generation = (old?.generation || 0) + Number(changed);
    statements.push(
      q(
        env,
        "INSERT INTO radar_sessions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET available=excluded.available,generation=excluded.generation,data=excluded.data",
        row.id,
        row.movie_id,
        Number(row.available),
        generation,
        JSON.stringify(row),
      ),
    );
    if (changed && matchesSession(row, rules[row.movie_id])) {
      if (!groups.has(row.movie_id)) groups.set(row.movie_id, []);
      groups.get(row.movie_id).push(row);
    }
  }
  for (const [mid, newRows] of groups) {
    const m = merged.find((m) => String(m.id) === mid);
    const body = sessionBody(cinema.short, newRows);
    const eventId = crypto.randomUUID();
    await set(env, "event_" + eventId, {
      sessions: newRows.map(({ movie, ...r }) => r),
      cinema: cinema.short,
      cinemaId: cinema.id,
    });
    statements.push(
      q(
        env,
        "INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)",
        eventId,
        mid,
        "release",
        `${m.nm} · 开票了`,
        body,
        now(),
      ),
    );
  }
  // D1 batch is transactional: session state and notifications commit together.
  if (statements.length) await env.DB.batch(statements);
  await set(env, "cinema_" + cinema.id, {
    checked: now(),
    movies: movies.length,
    sessions: rows.length,
  });
  return {
    cinema: cinema.short,
    movies: movies.length,
    sessions: rows.length,
    newNotifications: groups.size,
  };
}
export async function updateCatalog(env, at = now()) {
  const result = {
    requests: 0,
    lists: [],
    movies: 0,
    complete: false,
    pending: 0,
  };
  const interval = CADENCE.catalogMinutes * 60;
  let cycle = await get(env, "catalog_cycle");
  const next = await get(env, "catalog_next_refresh", 0);
  if (!cycle && next > at) return result;
  const known = new Map(
    (await q(env, "SELECT id,data FROM radar_movies").all()).results.map(
      (row) => [row.id, JSON.parse(row.data)],
    ),
  );
  const refreshed = await get(env, "catalog_refreshed", {});
  const releasePrefs = normalizeNotificationPrefs(await get(env, "notification_prefs", {}));
  const releaseStars = new Set((await q(env, "SELECT movie_id FROM radar_stars WHERE active=1").all()).results.map((r) => r.movie_id));
  cycle = cycle || {
    scheduled: next || at,
    phase: "upcoming",
    remaining: null,
  };
  await set(env, "catalog_cycle", cycle);
  const deadline = Date.now() + 75000;
  let previousRequest = 0;
  async function fetchCatalog(path) {
    const wait = 1000 - (Date.now() - previousRequest);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    previousRequest = Date.now();
    result.requests++;
    return source(path);
  }
  async function save(movies) {
    if (!movies.length) return;
    const merged = movies.map((movie) => mergeMovie(known.get(String(movie.id)), movie));
    const statements = movieStatements(env, merged);
    for (const movie of merged) {
      const id = String(movie.id), previous = known.get(id);
      if (releasePrefs.releaseChanges && releaseStars.has(id) && refreshed[id] && previous && validDay(movie.rt) && previous.rt !== movie.rt) {
        const eventId = crypto.randomUUID(), old = validDay(previous.rt) ? previous.rt : "档期待定";
        statements.push(q(env, "INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)", eventId, id, "release-date", `${movie.nm} · ${old === "档期待定" ? "已定档" : "上映日期变更"}`, `${old} → ${movie.rt}\n根据本次猫眼电影资料更新；最终档期以片方公布为准。`, now()));
        statements.push(q(env, "INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "event_" + eventId, JSON.stringify({ oldRelease: previous.rt || "", newRelease: movie.rt })));
      }
    }
    await env.DB.batch(statements);
    for (const movie of merged) {
      known.set(String(movie.id), movie);
      refreshed[String(movie.id)] = at;
    }
    await set(env, "catalog_refreshed", refreshed);
    await set(env, "catalog_updated", at);
    result.movies += movies.length;
  }
  const room = () =>
    result.requests < CADENCE.maxCatalogRequests && Date.now() < deadline;
  for (const which of ["upcoming", "released"]) {
    if (cycle.phase !== which || !room()) continue;
    const data = await fetchCatalog(
      which === "upcoming"
        ? "comingList?ci=42&token=&limit=12"
        : "movieOnInfoList?ci=42",
    );
    const movies = which === "upcoming" ? data.coming : data.movieList;
    if (
      !Array.isArray(movies) ||
      !Array.isArray(data.movieIds) ||
      data.movieIds.some((id) => !/^\d+$/.test(String(id)))
    )
      throw new RiskError("片库响应异常，已暂停以免重复请求");
    const ids = data.movieIds.map(String),
      allowed = new Set(ids);
    if (
      allowed.size !== ids.length ||
      movies.some((movie) => !allowed.has(String(movie.id)))
    )
      throw new RiskError("片库编号不匹配，已暂停访问");
    await save(movies);
    await set(env, which === "upcoming" ? "coming_ids" : "released_ids", ids);
    await set(
      env,
      which === "upcoming" ? "coming_updated" : "released_updated",
      at,
    );
    result.lists.push(which);
    cycle.phase = which === "upcoming" ? "released" : "details";
    // Refresh every retained movie, including new IDs absent from the list heads.
    if (cycle.phase === "details")
      cycle.remaining = [
        ...new Set([
          ...known.keys(),
          ...(await get(env, "coming_ids", [])),
          ...ids,
        ]),
      ].filter((id) => refreshed[id] !== at);
    await set(env, "catalog_cycle", cycle);
  }
  while (cycle.phase === "details" && cycle.remaining.length && room()) {
    const batch = cycle.remaining.slice(0, CADENCE.batchSize);
    const data = await fetchCatalog(
      "moreComingList?ci=42&token=&movieIds=" + batch.join(","),
    );
    const ids = new Set(batch);
    if (
      !Array.isArray(data.coming) ||
      data.coming.length !== batch.length ||
      new Set(data.coming.map((m) => String(m.id))).size !== batch.length ||
      data.coming.some((m) => !ids.has(String(m.id)))
    )
      throw new Error("片库补齐数据不完整，稍后重试");
    await save(data.coming);
    cycle.remaining = cycle.remaining.slice(batch.length);
    await set(env, "catalog_cycle", cycle);
  }
  result.pending = cycle.remaining?.length || 0;
  if (cycle.phase === "details" && !result.pending) {
    // Keep a five-minute clock even when two-minute dispatches arrive late.
    const nextCycle =
      cycle.scheduled +
      (Math.floor(Math.max(0, at - cycle.scheduled) / interval) + 1) * interval;
    await set(env, "catalog_next_refresh", nextCycle);
    await set(env, "catalog_completed", at);
    await set(env, "catalog_cycle", null);
    result.complete = true;
  }
  await set(env, "catalog_job", null);
  return result;
}
async function tick(env) {
  const lease = await q(
    env,
    "UPDATE radar_lock SET expires=? WHERE id=1 AND expires<?",
    now() + 240,
    now(),
  ).run();
  if (!lease.meta.changes) return { busy: true };
  const previousSuccess = await get(env, "last_success");
  try {
    await seed(env);
    const paused = await get(env, "paused");
    if (paused) {
      await deliver(env);
      return { paused };
    }
    const next = await get(env, "next_request", 0);
    if (next > now()) {
      await deliver(env);
      return { cooldown: true, next };
    }
    // Allow ten seconds of runner-start jitter around the two-minute target.
    await set(env, "next_request", now() + CADENCE.cinemaCooldownSeconds);
    const checks = [];
    for (const cinema of CINEMAS) {
      checks.push(
        await ingestCinema(
          env,
          await source("cinemaDetail?cinemaId=" + cinema.id),
          cinema,
        ),
      );
    }
    const catalog = await updateCatalog(env);
    const result = {
      cinema: "两家影院",
      newNotifications: checks.reduce((n, c) => n + c.newNotifications, 0),
      checks,
      catalog,
    };
    await set(env, "last_success", now());
    await set(env, "last_error", null);
    await set(env, "failures", 0);
    await deliver(env);
    return result;
  } catch (error) {
    if (error instanceof RiskError) {
      await set(env, "paused", error.message);
      await q(
        env,
        "INSERT INTO radar_events(id,kind,title,body,created_at) VALUES (?,?,?,?,?)",
        crypto.randomUUID(),
        "risk",
        "电影监测已暂停",
        error.message + "。星标保留，请在工具中查看并手动恢复。",
        now(),
      ).run();
      await deliver(env);
      return { paused: error.message };
    }
    const failures = (await get(env, "failures", 0)) + 1;
    await set(env, "failures", failures);
    await set(
      env,
      "next_request",
      now() + Math.min(21600, 300 * 2 ** Math.min(failures, 6)),
    );
    const msg = error.message?.startsWith("猫眼 HTTP")
      ? error.message
      : "本次数据检查失败，已退避重试；已有记录保留。";
    await set(env, "last_error", msg);
    return { error: msg };
  } finally {
    delete env.DELIVERY_DEADLINE;
    const successfulAt = await get(env, "last_success");
    const succeeded = !!successfulAt && successfulAt !== previousSuccess;
    const at = succeeded ? successfulAt : now();
    const history = await get(env, "health_history", []);
    const checks = await Promise.all(
      CINEMAS.map((c) => get(env, "cinema_" + c.id)),
    );
    if (succeeded || !history.length || at - history.at(-1).at >= 30) {
      history.push({
        at,
        success: succeeded,
        error: !!(await get(env, "last_error")),
        paused: !!(await get(env, "paused")),
        cinemas: checks.map((c, i) => ({
          id: CINEMAS[i].id,
          checked: c?.checked || null,
        })),
      });
      await set(
        env,
        "health_history",
        history.filter((h) => h.at > at - 86400).slice(-720),
      );
    }
    await q(env, "UPDATE radar_lock SET expires=0 WHERE id=1").run();
  }
}
async function state(env) {
  await seed(env);
  const refreshed = await get(env, "catalog_refreshed", {});
  const comingIds = await get(env, "coming_ids");
  const comingOrder = new Map(
    (comingIds || []).map((id, i) => [String(id), i]),
  );
  const movies = (
    await q(
      env,
      "SELECT m.*,s.active FROM radar_movies m LEFT JOIN radar_stars s ON m.id=s.movie_id",
    ).all()
  ).results
    .map((r) => {
      const m = JSON.parse(r.data);
      return {
        id: String(m.id),
        name: m.nm,
        img: m.img,
        release: m.rt || m.comingTitle || "档期待定",
        upcoming: upcoming(m),
        coming:
          comingIds === null ? upcoming(m) : comingOrder.has(String(m.id)),
        comingOrder: comingOrder.get(String(m.id)) ?? 99999,
        comingTitle: m.comingTitle || "",
        detailsUpdated: refreshed[String(m.id)] || null,
        wish: Number(m.wish) || 0,
        score: Number(m.sc) || 0,
        actors: m.star || "",
        active: r.active === 1,
      };
    })
    .sort((a, b) => Number(b.upcoming) - Number(a.upcoming) || b.wish - a.wish);
  const events = await Promise.all(
    (
      await q(
        env,
        "SELECT id,movie_id,kind,title,body,created_at,sent_at,attempts,cancelled FROM radar_events ORDER BY created_at DESC LIMIT 60",
      ).all()
    ).results.map(async (e) => ({
      ...e,
      ...(await get(env, "event_" + e.id, {})),
    })),
  );
  const sessions = (
    await Promise.all(CINEMAS.map((c) => get(env, "sessions_" + c.id, [])))
  )
    .flat()
    .filter((r) => Date.parse(r.starts_at) > Date.now());
  return {
    movies,
    events,
    sessions,
    healthHistory: await get(env, "health_history", []),
    movieRules: await get(env, "movie_rules", {}),
    notificationPrefs: normalizeNotificationPrefs(await get(env, "notification_prefs", {})),
    filmJournal: await get(env, "film_journal", {}),
    ruleTemplates: await get(env, "rule_templates", []),
    defaultRuleTemplateId: await get(env, "default_rule_template", ""),
    starRevisions: await get(env, "star_revisions", {}),
    readEvents: await get(env, "read_events", []),
    receivedTest: await get(env, "received_test", null),
    pushDevices:
      (await get(env, "push_devices", null))?.map(
        ({ subscription, ...d }) => d,
      ) ?? null,
    cadence: CADENCE,
    releasedUpdated: await get(env, "released_updated"),
    comingTotal: comingIds?.length ?? movies.filter((m) => m.coming).length,
    comingSourceReady: comingIds !== null,
    comingUpdated: await get(env, "coming_updated"),
    pushConfigured:
      (await get(env, "push_devices")) !== null
        ? (await get(env, "push_devices", [])).some((d) => !d.expired)
        : !!(await get(env, "push_subscription")),
    pushError: await get(env, "push_error"),
    notificationMode: await notificationMode(env),
    cinemas: CINEMAS,
    paused: await get(env, "paused"),
    lastSuccess: await get(env, "last_success"),
    lastError: await get(env, "last_error"),
    nextRequest: await get(env, "next_request"),
    barkConfigured: !!(await get(env, "bark")),
    barkError: await get(env, "bark_error"),
    catalogUpdated: await get(env, "catalog_updated"),
    catalogCompleted: await get(env, "catalog_completed"),
    catalogNextRefresh: await get(env, "catalog_next_refresh"),
    catalogPending: (await get(env, "catalog_cycle"))?.remaining?.length || 0,
    catalogJob: await get(env, "catalog_job"),
    checks: await Promise.all(CINEMAS.map((c) => get(env, "cinema_" + c.id))),
    schedule: await get(env, "schedule", null),
    schedulerHeartbeat: await get(env, "scheduler_heartbeat", null),
  };
}
async function api(req, env, path) {
  if (req.method === "GET" && path === "/api/state")
    return json(await state(env));
  if (req.method !== "POST") return json({ error: "请求方式不支持" }, 405);
  if (
    req.headers.get("Origin") &&
    req.headers.get("Origin") !== new URL(req.url).origin
  )
    return json({ error: "请求来源不匹配" }, 403);
  const raw = await req.text();
  if (raw.length > 8000) return json({ error: "请求过大" }, 413);
  const body = raw ? JSON.parse(raw) : {};
  if (path === "/api/star") {
    if (typeof body.id !== "string" || typeof body.active !== "boolean")
      throw new Error("星标参数无效");
    const movie = await q(
      env,
      "SELECT id FROM radar_movies WHERE id=?",
      body.id,
    ).first();
    if (!movie) throw new Error("找不到这部电影");
    const statements = [
      q(
        env,
        "INSERT INTO radar_stars VALUES (?,?,?) ON CONFLICT(movie_id) DO UPDATE SET active=excluded.active",
        body.id,
        Number(body.active),
        now(),
      ),
    ];
    if (!body.active)
      statements.push(
        q(
          env,
          "UPDATE radar_events SET cancelled=1 WHERE movie_id=? AND sent_at IS NULL",
          body.id,
        ),
      );
    await env.DB.batch(statements);
    return json({ ok: true });
  }
  if (path === "/api/bark") {
    if (
      typeof body.key !== "string" ||
      !/^[A-Za-z0-9_-]{8,200}$/.test(body.key)
    )
      throw new Error("请输入 Bark App 中的设备 Key，而不是完整网址");
    await set(env, "bark", await crypt(env, body.key));
    await set(env, "bark_error", null);
    await set(env, "notification_mode", "bark");
    return json({ ok: true });
  }
  if (path === "/api/bark/remove") {
    await set(env, "bark", null);
    return json({ ok: true });
  }
  if (path === "/api/bark/test") {
    await bark(
      env,
      "开票雷达 · 测试成功",
      "西安 MOMOPARK UME / 荟聚寰映\n独立分组，不影响你已有的 Bark 推送。",
    );
    return json({ ok: true });
  }
  if (path === "/api/push") {
    await set(
      env,
      "push_subscription",
      validateSubscription(body.subscription),
    );
    await set(env, "notification_mode", "push");
    await set(env, "push_error", null);
    return json({ ok: true });
  }
  if (path === "/api/push/remove") {
    await set(env, "push_subscription", null);
    await set(env, "notification_mode", "off");
    return json({ ok: true });
  }
  if (path === "/api/push/test") {
    await notify(
      env,
      "开票雷达 · 手机通知测试",
      "收到这条通知，说明这台设备的系统通知可以正常接收。",
      crypto.randomUUID(),
      true,
      body.deviceId,
    );
    return json({ ok: true });
  }
  if (path === "/api/tick") {
    const result = await tick(env);
    if (body.source === "github-actions")
      await set(env, "scheduler_heartbeat", now());
    return json(result);
  }
  if (path === "/api/pause") {
    await set(env, "paused", "你已手动暂停监测；星标保留。");
    return json({ ok: true });
  }
  if (path === "/api/resume") {
    await set(env, "paused", null);
    return json({ ok: true });
  }
  if (path === "/api/schedule") {
    await set(env, "schedule", body.schedule);
    return json({ ok: true });
  }
  return json({ error: "找不到此操作" }, 404);
}
async function mcp(req, env) {
  const r = await req.json();
  let result;
  if (r.method === "server/discover")
    result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
  else if (r.method === "initialize")
    result = {
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} },
      serverInfo: { name: "xian-movie-radar", version: "1.0.0" },
    };
  else if (r.method === "tools/list")
    result = {
      tools: [
        {
          name: "check_releases",
          description:
            "检查西安指定影院开票并通过已配置的 Bark 发送待处理提醒。内部限流和风控暂停生效。",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "radar_status",
          description: "读取电影监测状态与片库，不暴露 Bark Key。",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
  else if (r.method === "tools/call") {
    try {
      const out =
        r.params.name === "check_releases"
          ? await tick(env)
          : r.params.name === "radar_status"
            ? await state(env)
            : { error: "未知工具" };
      result = {
        content: [{ type: "text", text: JSON.stringify(out) }],
        isError: !!out.error,
      };
    } catch {
      result = {
        content: [
          { type: "text", text: "监测工具暂时不可用，请在网站查看状态。" },
        ],
        isError: true,
      };
    }
  } else if (r.method?.startsWith("notifications/"))
    return new Response(null, { status: 202 });
  else
    return json({
      jsonrpc: "2.0",
      id: r.id,
      error: { code: -32601, message: "Method not found" },
    });
  return json({ jsonrpc: "2.0", id: r.id, result });
}
export default {
  async fetch(req, env, ctx) {
    try {
      const path = new URL(req.url).pathname;
      if (path === "/mcp" && req.method === "POST") return await mcp(req, env);
      if (path.startsWith("/api/")) return await api(req, env, path);
      if (path === "/")
        return new Response(HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Frame-Options": "SAMEORIGIN",
            "Referrer-Policy": "no-referrer",
          },
        });
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json(
        {
          error:
            error.message?.includes("Bark") ||
            error.message?.includes("通知") ||
            error.message?.includes("订阅")
              ? error.message
              : "操作暂未完成，请稍后重试。",
        },
        500,
      );
    }
  },
};
