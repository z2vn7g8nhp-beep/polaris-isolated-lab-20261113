import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { keyBytes, seal, unseal, openPreferences } from "../docs/crypto.mjs";
import worker from "./monitor.mjs";
import { normalizeRule } from "../docs/rules.mjs";
import { validateSubscription } from "./push.mjs";
import { vapidKeys } from "./push.mjs";

export function dbEnv(path = ":memory:", master = "test-only") {
  const db = new DatabaseSync(path);
  function stmt(sql, args = []) {
    return {
      bind(...v) {
        return stmt(sql, v);
      },
      async first() {
        return db.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    db,
    DB: {
      prepare: stmt,
      async batch(stmts) {
        db.exec("BEGIN");
        try {
          const r = [];
          for (const s of stmts) r.push(await s.run());
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    PUSH_KEYS: vapidKeys(master),
    BARK_ENCRYPTION_KEY: createHash("sha256")
      .update("polaris-bark:" + master)
      .digest("base64"),
  };
}
export async function call(env, path, body) {
  const r = await worker.fetch(
    new Request("https://local.invalid/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    {},
  );
  const result = await r.json();
  if (!r.ok || result.error) throw new Error(result.error || "监测操作失败");
  return result;
}
const value = (env, key, defaultValue = null) => {
  const r = env.db.prepare("SELECT value FROM radar_kv WHERE key=?").get(key);
  return r ? JSON.parse(r.value) : defaultValue;
};
const set = (env, key, v) =>
  env.db
    .prepare(
      "INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, JSON.stringify(v));

export async function applyPreferences(env, prefs) {
  if (
    !prefs ||
    typeof prefs.revision !== "string" ||
    !Array.isArray(prefs.stars) ||
    prefs.stars.length > 2000 ||
    prefs.stars.some((id) => !/^\d+$/.test(id))
  )
    throw new Error("偏好数据格式无效");
  if (value(env, "preferences_revision") === prefs.revision) return false;
  const rules = {};
  if (prefs.movieRules !== undefined) {
    if (
      !prefs.movieRules ||
      typeof prefs.movieRules !== "object" ||
      Array.isArray(prefs.movieRules) ||
      Object.keys(prefs.movieRules).length > 2000
    )
      throw new Error("规则数据无效");
    for (const [id, rule] of Object.entries(prefs.movieRules)) {
      if (!/^\d+$/.test(id)) throw new Error("电影编号无效");
      rules[id] = normalizeRule(rule);
    }
  }
  let devices = null;
  if (prefs.pushDevices !== undefined) {
    if (
      !Array.isArray(prefs.pushDevices) ||
      prefs.pushDevices.length > 8 ||
      new Set(prefs.pushDevices.map((d) => d.id)).size !==
        prefs.pushDevices.length
    )
      throw new Error("最多连接 8 台设备，设备编号不能重复");
    devices = prefs.pushDevices.map((d) => {
      if (
        typeof d.id !== "string" ||
        d.id.length > 100 ||
        !d.id ||
        typeof d.name !== "string" ||
        !d.name.trim() ||
        d.name.length > 40 ||
        typeof d.registration !== "string" ||
        d.registration.length > 100
      )
        throw new Error("设备信息无效");
      return {
        id: d.id,
        name: d.name,
        registration: d.registration,
        subscription: validateSubscription(d.subscription),
      };
    });
  }
  if (
    prefs.readEvents !== undefined &&
    (!Array.isArray(prefs.readEvents) ||
      prefs.readEvents.length > 500 ||
      prefs.readEvents.some((id) => typeof id !== "string" || id.length > 100))
  )
    throw new Error("已读记录无效");
  const current = await call(env, "state");
  if (prefs.movieRules !== undefined) set(env, "movie_rules", rules);
  if (prefs.starRevisions) set(env, "star_revisions", prefs.starRevisions);
  if (prefs.readEvents) set(env, "read_events", prefs.readEvents);
  if (prefs.receivedTest) set(env, "received_test", prefs.receivedTest);
  const wanted = new Set(prefs.stars);
  for (const movie of current.movies)
    if (Boolean(movie.active) !== wanted.has(movie.id))
      await call(env, "star", { id: movie.id, active: wanted.has(movie.id) });
  const signature = (v) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  if (
    Object.hasOwn(prefs, "barkKey") &&
    signature(prefs.barkKey) !== value(env, "bark_signature")
  ) {
    if (prefs.barkKey === null) await call(env, "bark/remove", {});
    else if (typeof prefs.barkKey === "string")
      await call(env, "bark", { key: prefs.barkKey });
    else throw new Error("Bark 配置格式无效");
    set(env, "bark_signature", signature(prefs.barkKey));
  }
  if (
    Object.hasOwn(prefs, "pushSubscription") &&
    signature(prefs.pushSubscription) !== value(env, "push_signature")
  ) {
    await call(
      env,
      prefs.pushSubscription === null ? "push/remove" : "push",
      prefs.pushSubscription === null
        ? {}
        : { subscription: prefs.pushSubscription },
    );
    set(env, "push_signature", signature(prefs.pushSubscription));
  }
  if (devices !== null) {
    const hash = signature(devices);
    if (hash !== value(env, "devices_signature")) {
      const revoked = value(env, "revoked_devices", []);
      const prior = value(env, "push_devices", []) || [];
      set(
        env,
        "push_devices",
        devices.map((d) => ({
          ...prior.find((x) => x.registration === d.registration),
          ...d,
          ...(revoked.includes(d.registration)
            ? { expired: true, error: "连接已失效，请在该设备重新启用" }
            : {}),
        })),
      );
      set(env, "devices_signature", hash);
    }
  }
  if (["push", "bark", "off"].includes(prefs.notificationMode))
    set(env, "notification_mode", prefs.notificationMode);
  const control = prefs.control;
  if (
    control &&
    control.id !== value(env, "last_control") &&
    ["pause", "resume"].includes(control.action)
  ) {
    await call(env, control.action, {});
    set(env, "last_control", control.id);
  }
  const request = prefs.request;
  if (
    request?.id &&
    request.id !== value(env, "last_request") &&
    ["bark/test", "push/test"].includes(request.action)
  ) {
    try {
      await call(env, request.action, { deviceId: request.deviceId });
      set(env, "request_result", {
        id: request.id,
        deviceId: request.deviceId,
        at: Math.floor(Date.now() / 1000),
        ok: true,
      });
    } catch {
      set(env, "request_result", {
        id: request.id,
        ok: false,
        message: "测试推送失败，请检查通知权限、连接或推送服务状态。",
      });
    }
    set(env, "last_request", request.id);
  }
  set(env, "preferences_revision", prefs.revision);
  return true;
}
export function publicView(state) {
  return {
    snapshotAt: state.snapshotAt,
    lastRunOutcome: state.lastRunOutcome,
    schedulerHeartbeat: state.schedulerHeartbeat,
    cadence: state.cadence,
    releasedUpdated: state.releasedUpdated,
    movies: state.movies.map(({ active, ...movie }) => movie),
    cinemas: state.cinemas,
    lastSuccess: state.lastSuccess,
    lastError: state.lastError,
    checks: state.checks,
    sessions: state.sessions || [],
    healthHistory: state.healthHistory || [],
    catalogUpdated: state.catalogUpdated,
    catalogCompleted: state.catalogCompleted,
    catalogNextRefresh: state.catalogNextRefresh,
    catalogPending: state.catalogPending,
    comingTotal: state.comingTotal,
    comingSourceReady: state.comingSourceReady,
    comingUpdated: state.comingUpdated,
    schedule: {
      provider: "github-actions",
      frequency: "two_minutes",
      intervalMinutes: 2,
      fallbackMinutes: 5,
    },
  };
}
export async function createRuntime({ master, identity, snapshot, path }) {
  const masterKey = await keyBytes(master, "server");
  const secrets = await unseal(identity, masterKey);
  mkdirSync(new URL("../.runtime/", import.meta.url), { recursive: true });
  if (snapshot) writeFileSync(path, await unseal(snapshot, masterKey, true));
  const env = dbEnv(path, master);
  if (!snapshot) {
    env.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    for (const row of secrets.kv || [])
      if (
        !["schedule", "scheduler_heartbeat", "seed_count", "seeded"].includes(
          row.key,
        )
      )
        set(env, row.key, JSON.parse(row.value));
  }
  return { env, masterKey, secrets, path };
}
export async function processRun(runtime, envelope, { mode = "check" } = {}) {
  const { env, secrets, masterKey } = runtime;
  let personalKey = null;
  if (envelope) {
    const opened = await openPreferences(envelope, secrets.privateKey);
    personalKey = opened.rawKey;
    await applyPreferences(env, opened.prefs);
  }
  let result = { status: true };
  if (mode !== "status")
    try {
      result = await call(env, "tick", { source: "github-actions" });
    } catch (error) {
      result = { error: error.message };
    }
  const state = await call(env, "state");
  state.snapshotAt = Math.floor(Date.now() / 1000);
  state.lastRunOutcome = result.paused
    ? "paused"
    : result.cooldown
      ? "cooldown"
      : result.error
        ? "error"
        : result.busy
          ? "busy"
          : mode === "status"
            ? "status"
            : "checked";
  const personal = {
    ...state,
    processedRevision: value(env, "preferences_revision"),
    requestResult: value(env, "request_result"),
  };
  const publicData = publicView(state);
  const privateData = personalKey ? await seal(personal, personalKey) : null;
  env.db.close();
  const snapshot = await seal(
    new Uint8Array(readFileSync(runtime.path)),
    masterKey,
  );
  return { snapshot, publicData, privateData, result };
}
