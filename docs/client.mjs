import { normalizeRule } from "./rules.mjs?v=planner-1";
import { keyBytes, sealPreferences, unseal } from "./crypto.mjs";
import { newerPublic, mergeStatus } from "./status.mjs?v=calm-1";
import { normalizePlannerPrefs, normalizeNotificationPrefs, normalizeTemplates, normalizeFilmJournal, normalizeJournalEntry, templatesFor } from "./planner-model.mjs?v=planner-1";
const REPO = "z2vn7g8nhp-beep/polaris-isolated-lab-20261113";
const API = `https://api.github.com/repos/${REPO}`;
const storageKey = "polaris.github-token.v1";
const publicCacheKey = "polaris.public-cache.v1",
  personalCacheKey = "polaris.encrypted-cache.v1";
function readCache(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function getLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
let token = getLocal(storageKey) || "",
  rawKey = null,
  prefs = null,
  latest = null;
let base = readCache(publicCacheKey),
  envelopes = {},
  hydrated = false,
  epoch = 0,
  flight = null,
  syncing = false,
  syncError = null;
let watchdogStatus = null;
if (!Array.isArray(base?.movies)) base = null;
const observers = new Set(),
  mutations = new Map();
let writeQueue = Promise.resolve(),
  sessionId = 0,
  refreshId = 0;
const session = () => ({ token, id: sessionId });
const sameSession = (ctx) => ctx.id === sessionId && ctx.token === token;
function checkSession(ctx) {
  if (!sameSession(ctx))
    throw new Error(
      "连接已改变，本次操作已结束；已提交的配置请重新连接后同步确认",
    );
}
function beginSession(secret) {
  token = secret;
  sessionId++;
  epoch++;
  refreshId++;
  flight = null;
  syncError = null;
  syncing = false;
  return session();
}

let memoryDeviceId;
export function deviceId() {
  let id = memoryDeviceId || getLocal("polaris.device-id");
  if (!id) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem("polaris.device-id", id);
    } catch {}
  }
  memoryDeviceId = id;
  return id;
}
function serial(work) {
  const ctx = session();
  const result = writeQueue.then(() => {
    checkSession(ctx);
    return work();
  });
  writeQueue = result.catch(() => {});
  return result;
}
export const connected = () => Boolean(token);
export const pending = () =>
  Boolean(prefs && latest?.processedRevision !== prefs.revision);
export const repository = REPO;
async function request(
  path,
  { method = "GET", body, optional = false, credential = token } = {},
) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(API + path, {
      signal: controller.signal,
      method,
      redirect: "error",
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) {
      const text =
        response.status === 401
          ? "GitHub 密钥无效或已到期"
          : response.status === 403
            ? "GitHub 权限不足：请检查新仓库的 Contents 和 Actions 读写权限"
            : response.status === 409
              ? "同步冲突，请稍后再试"
              : `GitHub 请求失败（${response.status}）`;
      throw new Error(text);
    }
    if (response.status === 204) return null;
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("GitHub 连接超时，暂时显示上次保存的私人数据");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function decodeContent(value) {
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(value.content.replace(/\s/g, "")), (c) =>
        c.charCodeAt(0),
      ),
    ),
  );
}
function encodeContent(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let text = "";
  for (const c of bytes) text += String.fromCharCode(c);
  return btoa(text);
}
async function file(path, branch, optional = false, credential = token) {
  const r = await request(`/contents/${path}?ref=${branch}`, {
    optional,
    credential,
  });
  return r ? { value: decodeContent(r), sha: r.sha } : null;
}
async function readPreferences(ctx = session()) {
  checkSession(ctx);
  const key = rawKey || (await keyBytes(ctx.token));
  const saved = await file(
    "preferences.enc.json",
    "preferences",
    true,
    ctx.token,
  );
  checkSession(ctx);
  if (!saved) return { value: { revision: "", stars: [] }, sha: null, key };
  let value;
  try {
    value = await unseal(saved.value, key);
  } catch {
    throw new Error(
      "同步密钥与现有配置不匹配。请使用最初连接时的同一个 GitHub 密钥；不要覆盖原配置。",
    );
  }
  checkSession(ctx);
  return { value, sha: saved.sha, key };
}
export function connect(value) {
  return serial(async () => {
    const previous = { token, rawKey, prefs, latest, envelopes, hydrated };
    const ctx = beginSession(value.trim());
    rawKey = null;
    prefs = null;
    latest = null;
    envelopes = {};
    hydrated = true;
    try {
      if (!token) throw new Error("请填写新仓库的 GitHub 密钥");
      const repo = await request("", { credential: ctx.token });
      checkSession(ctx);
      if (!repo.permissions?.push)
        throw new Error("这个密钥没有新仓库的写入权限");
      await update((v) => v);
      checkSession(ctx);
      try {
        localStorage.setItem(storageKey, token);
      } catch {
        window.dispatchEvent(
          new CustomEvent("polaris-notice", {
            detail: "连接成功，但本机无法保存登录。下次打开时请重新连接。",
          }),
        );
      }
      publish();
    } catch (error) {
      if (sameSession(ctx)) {
        ({ rawKey, prefs, latest, envelopes, hydrated } = previous);
        beginSession(previous.token);
        publish();
      }
      throw error;
    }
  });
}
export function disconnect() {
  mutations.clear();
  watchdogStatus = null;
  beginSession("");
  rawKey = null;
  prefs = null;
  latest = null;
  envelopes = {};
  hydrated = false;
  epoch++;
  try {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(personalCacheKey);
  } catch {}
  publish();
}
async function trigger(ctx = session()) {
  checkSession(ctx);
  await request("/actions/workflows/scheduled-watch.yml/dispatches", {
    method: "POST",
    body: { ref: "main", inputs: { mode: "check" } },
    credential: ctx.token,
  });
}
async function update(change) {
  const ctx = session();
  if (!ctx.token)
    throw new Error("先到「监测与推送」连接 GitHub；只需设置一次");
  const send = (path, options = {}) => {
    checkSession(ctx);
    return request(path, { ...options, credential: ctx.token });
  };
  epoch++;
  const main = await send("/git/ref/heads/main");
  if (!(await send("/git/ref/heads/preferences", { optional: true }))) {
    try {
      await send("/git/refs", {
        method: "POST",
        body: { ref: "refs/heads/preferences", sha: main.object.sha },
      });
    } catch (error) {
      if (!(await send("/git/ref/heads/preferences", { optional: true })))
        throw error;
    }
  }
  const saved = await readPreferences(ctx);
  checkSession(ctx);
  const changed = change(structuredClone(saved.value));
  normalizePlannerPrefs(changed);
  changed.revision = crypto.randomUUID();
  const publicKey = await (
    await fetch("./data/public-key.json", {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    })
  ).json();
  const envelope = await sealPreferences(changed, saved.key, publicKey.spki);
  checkSession(ctx);
  await send("/contents/preferences.enc.json", {
    method: "PUT",
    body: {
      message: "Update encrypted preferences",
      branch: "preferences",
      content: encodeContent(envelope),
      ...(saved.sha ? { sha: saved.sha } : {}),
    },
  });
  checkSession(ctx);
  epoch++;
  rawKey = saved.key;
  prefs = changed;
  envelopes.preferences = envelope;
  writeCache(personalCacheKey, envelopes);
  try {
    await trigger(ctx);
  } catch (error) {
    checkSession(ctx);
    window.dispatchEvent(
      new CustomEvent("polaris-notice", {
        detail: "配置已加密保存；立即触发未成功，定时任务会在下一轮处理。",
      }),
    );
  }
  checkSession(ctx);
  publish();
  return { queued: true };
}
function currentState() {
  if (!base) return null;
  const starred = new Set(prefs?.stars || []);
  const combined = mergeStatus(base, latest);
  return {
    ...combined,
    ...normalizePlannerPrefs(prefs || {}),
    watchdogStatus,
    syncError,
    syncing,
    personalReady: !token || prefs !== null,
    events: latest?.events || [],
    pushConfigured:
      latest?.processedRevision === prefs?.revision
        ? Boolean(latest?.pushConfigured)
        : Boolean(prefs?.pushSubscription || latest?.pushConfigured),
    notificationMode:
      prefs?.notificationMode || latest?.notificationMode || "off",
    barkConfigured: Object.hasOwn(prefs || {}, "barkKey")
      ? Boolean(prefs.barkKey)
      : Boolean(latest?.barkConfigured),
    paused:
      prefs?.control?.action === "pause" && pending()
        ? "暂停请求待后台处理"
        : combined.paused || null,
    connected: Boolean(token),
    pending: pending(),
    requestResult: latest?.requestResult,
    countdownMovieId: prefs?.countdownMovieId || null,
    movieRules: prefs?.movieRules || latest?.movieRules || {},
    readEvents: prefs?.readEvents || latest?.readEvents || [],
    receivedTest: prefs?.receivedTest || null,
    pushDevices: prefs?.pushDevices
      ? prefs.pushDevices.map((d) => {
          const applied = latest?.pushDevices?.find(
            (x) => x.id === d.id && x.registration === d.registration,
          );
          return {
            ...applied,
            id: d.id,
            name: d.name,
            registration: d.registration,
          };
        })
      : latest?.pushDevices || null,
    hasLegacyPush: !!prefs?.pushSubscription && !prefs?.pushDevices,
    mutationErrors: Object.fromEntries(
      [...mutations].filter(([, v]) => v.error).map(([id, v]) => [id, v]),
    ),
    movies: combined.movies.map((m) => {
      const operation = mutations.get(m.id),
        active = operation?.desired ?? starred.has(m.id);
      return {
        ...m,
        active,
        syncState: operation?.saving
          ? "saving"
          : operation?.error
            ? "error"
            : prefs?.starRevisions?.[m.id] &&
                prefs.starRevisions[m.id] !== latest?.starRevisions?.[m.id]
              ? "pending"
              : "applied",
      };
    }),
  };
}
function publish() {
  const state = currentState();
  if (state) {
    for (const observer of observers) observer(state);
    window.dispatchEvent(new CustomEvent("polaris-state", { detail: state }));
  }
}
function acceptPublic(value) {
  if (!Array.isArray(value?.movies)) throw new Error("片库数据无效");
  base = newerPublic(base, value);
  writeCache(publicCacheKey, base);
  publish();
}
async function restorePersonal(secret, version) {
  if (hydrated) return;
  hydrated = true;
  const cached = readCache(personalCacheKey);
  if (!cached) return;
  try {
    const key = await keyBytes(secret);
    const [saved, personal] = await Promise.all([
      cached.preferences ? unseal(cached.preferences, key) : null,
      cached.private ? unseal(cached.private, key) : null,
    ]);
    if (secret !== token || version !== epoch) return;
    rawKey = key;
    envelopes = cached;
    prefs = saved;
    latest = personal;
    publish();
  } catch {
    /* A cache encrypted for another connection must never replace its data. */
  }
}
async function refresh() {
  const run = ++refreshId;
  syncing = true;
  syncError = null;
  publish();
  const secret = token,
    version = epoch,
    errors = [];
  const page = (async () => {
    const response = await fetch("./data/state.json", {
      cache: "no-cache",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error("片库暂时无法更新，正在显示上次保存的数据");
    acceptPublic(await response.json());
  })();
  const personal = (async () => {
    if (!secret) return;
    await restorePersonal(secret, version);
    const key = await keyBytes(secret),
      current = () => secret === token && version === epoch;
    const remember = (name, value) => {
      if (value) envelopes[name] = value;
      else delete envelopes[name];
      writeCache(personalCacheKey, envelopes);
    };
    const results = await Promise.allSettled([
      file("public.json", "watchdog-state", true, secret).then((saved) => {
        if (current()) watchdogStatus = saved?.value || null;
      }).catch(() => {}),
      file("public.json", "monitor-state", true, secret).then((remote) => {
        if (remote) acceptPublic(remote.value);
      }),
      file("preferences.enc.json", "preferences", true, secret).then(
        async (saved) => {
          let value;
          try {
            value = saved
              ? await unseal(saved.value, key)
              : { revision: "", stars: [] };
          } catch {
            throw new Error(
              "同步密钥与现有配置不匹配，请使用最初连接时的同一个 GitHub 密钥。",
            );
          }
          if (current()) {
            rawKey = key;
            prefs = value;
            remember("preferences", saved?.value);
            publish();
          }
        },
      ),
      file("private.enc.json", "monitor-state", true, secret).then(
        async (saved) => {
          const value = saved ? await unseal(saved.value, key) : null;
          if (current()) {
            latest = value;
            remember("private", saved?.value);
            publish();
          }
        },
      ),
    ]);
    if (current())
      for (const result of results)
        if (result.status === "rejected") errors.push(result.reason.message);
  })();
  const results = await Promise.allSettled([page, personal]);
  for (const result of results)
    if (result.status === "rejected")
      errors.push(result.reason.message || "连接暂时失败");
  if (run !== refreshId) return;
  syncing = false;
  syncError = errors[0] || null;
  if (!base) throw new Error(syncError || "片库暂时无法连接");
  publish();
}
export async function load({ onUpdate } = {}) {
  if (onUpdate) {
    observers.add(onUpdate);
    const cached = currentState();
    if (cached) onUpdate(cached);
  }
  if (!flight) {
    const next = refresh().finally(() => {
      if (flight === next) flight = null;
    });
    flight = next;
  }
  try {
    await flight;
    return currentState();
  } finally {
    if (onUpdate) observers.delete(onUpdate);
  }
}
export async function api(path, body) {
  if (path === "state") return load(body);
  if (path === "star") {
    if (!token) throw new Error("先到「监测与推送」连接 GitHub；只需设置一次");
    if (mutations.get(body.id)?.saving)
      throw new Error("该电影正在保存，请稍候");
    const ctx = session();
    mutations.set(body.id, { desired: body.active, saving: true });
    publish();
    try {
      const result = await serial(() =>
        update((p) => {
          const stars = new Set(p.stars);
          const wasStarred = stars.has(body.id);
          body.active ? stars.add(body.id) : stars.delete(body.id);
          p.stars = [...stars];
          if (body.active && !wasStarred && p.defaultRuleTemplateId && !Object.hasOwn(p.movieRules || {}, body.id)) {
            const template = templatesFor(p).find((t) => t.id === p.defaultRuleTemplateId);
            if (template) p.movieRules = { ...p.movieRules, [body.id]: normalizeRule(template.rule) };
          }
          p.starRevisions = {
            ...p.starRevisions,
            [body.id]: crypto.randomUUID(),
          };
          return p;
        }),
      );
      checkSession(ctx);
      mutations.delete(body.id);
      publish();
      return result;
    } catch (error) {
      if (sameSession(ctx)) {
        mutations.set(body.id, { error: error.message, retry: body.active });
        publish();
      }
      throw error;
    }
  }
  if (path === "countdown")
    return serial(() =>
      update((p) => {
        if (
          typeof body.id !== "string" ||
          !/^\d+$/.test(body.id) ||
          !base?.movies.some((m) => m.id === body.id)
        )
          throw new Error("请选择片库中的电影");
        p.countdownMovieId = body.id;
        return p;
      }),
    );
  if (path === "rule")
    return serial(() =>
      update((p) => {
        p.movieRules = { ...p.movieRules, [body.id]: normalizeRule(body.rule) };
        return p;
      }),
    );
  if (["planner/settings", "template/save", "template/delete", "template/default", "template/apply", "journal/save", "journal/entry", "journal/entry-state", "journal/remove-entry"].includes(path))
    return serial(() => update((p) => {
      const ensureMovie = (id) => {
        if (typeof id !== "string" || !base?.movies.some((m) => m.id === id)) throw new Error("请选择片库中的电影");
        return id;
      };
      if (path === "planner/settings") p.notificationPrefs = normalizeNotificationPrefs(body);
      if (path === "template/save") {
        const item = { id: body.id || crypto.randomUUID(), name: body.name, rule: normalizeRule(body.rule) };
        p.ruleTemplates = normalizeTemplates([...(p.ruleTemplates || []).filter((t) => t.id !== item.id), item]);
      }
      if (path === "template/delete") {
        p.ruleTemplates = (p.ruleTemplates || []).filter((t) => t.id !== body.id);
        if (p.defaultRuleTemplateId === body.id) p.defaultRuleTemplateId = "";
      }
      if (path === "template/default") {
        if (body.id && !templatesFor(p).some((t) => t.id === body.id)) throw new Error("找不到这个规则模板");
        p.defaultRuleTemplateId = body.id || "";
      }
      if (path === "template/apply") {
        const template = templatesFor(p).find((t) => t.id === body.id);
        if (!template) throw new Error("找不到这个规则模板");
        const ids = body.allStars ? p.stars : body.movieIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > 2000) throw new Error("请至少选择一部电影");
        p.movieRules = { ...p.movieRules };
        for (const id of new Set(ids)) {
          ensureMovie(id);
          if (!body.onlyUnset || !Object.hasOwn(p.movieRules, id)) p.movieRules[id] = normalizeRule(template.rule);
        }
      }
      if (path.startsWith("journal/")) {
        const id = ensureMovie(body.id), journals = { ...p.filmJournal };
        const record = journals[id] || { tags: [], review: "", entries: [] };
        if (path === "journal/save") journals[id] = { ...record, tags: body.tags, review: body.review };
        if (path === "journal/entry") {
          const entry = normalizeJournalEntry({ ...body.entry, id: body.entry.id || crypto.randomUUID() });
          journals[id] = { ...record, entries: [...record.entries, entry] };
          if (body.stopMonitoring) p.movieRules = { ...p.movieRules, [id]: normalizeRule({ ...p.movieRules?.[id], paused: true }) };
        }
        if (path === "journal/entry-state") {
          const target = record.entries.find((e) => e.id === body.entryId);
          if (!target) throw new Error("找不到这条观影记录");
          journals[id] = { ...record, entries: record.entries.map((e) => e.id === body.entryId ? normalizeJournalEntry({ ...e, type: body.type }) : e) };
        }
        if (path === "journal/remove-entry") journals[id] = { ...record, entries: record.entries.filter((e) => e.id !== body.entryId) };
        p.filmJournal = normalizeFilmJournal(journals);
      }
      normalizePlannerPrefs(p);
      return p;
    }));
  if (path === "events/read")
    return serial(() =>
      update((p) => {
        p.readEvents = [
          ...new Set([...(p.readEvents || []), ...body.ids]),
        ].slice(-500);
        return p;
      }),
    );
  if (path === "test/received")
    return serial(() =>
      update((p) => {
        p.receivedTest = {
          id: body.id,
          deviceId: deviceId(),
          at: Date.now() / 1000,
        };
        return p;
      }),
    );
  if (path === "bark")
    return serial(() =>
      update((p) => {
        if (!/^[A-Za-z0-9_-]{8,200}$/.test(body.key))
          throw new Error("请输入 Bark 设备 Key，而不是完整网址");
        p.barkKey = body.key;
        p.notificationMode = "bark";
        return p;
      }),
    );
  if (path === "bark/remove")
    return serial(() =>
      update((p) => {
        p.barkKey = null;
        if (p.notificationMode === "bark") p.notificationMode = "off";
        return p;
      }),
    );
  if (path === "pause" || path === "resume")
    return serial(() =>
      update((p) => {
        p.control = { id: crypto.randomUUID(), action: path };
        return p;
      }),
    );
  if (path === "push")
    return serial(() =>
      update((p) => {
        let devices = p.pushDevices || [];
        if (
          !p.pushDevices &&
          p.pushSubscription &&
          p.pushSubscription.endpoint !== body.subscription.endpoint &&
          p.pushSubscription.endpoint !== body.previousEndpoint
        )
          devices = [
            {
              id: "legacy",
              name: "原有设备",
              registration: crypto.randomUUID(),
              subscription: p.pushSubscription,
            },
          ];
        const id = deviceId(),
          existing = devices.find(
            (d) =>
              d.id === id &&
              d.subscription.endpoint === body.subscription.endpoint,
          );
        devices = devices.filter(
          (d) =>
            d.id !== id &&
            d.subscription.endpoint !== body.subscription.endpoint &&
            d.subscription.endpoint !== body.previousEndpoint,
        );
        if (devices.length >= 8)
          throw new Error("最多连接 8 台设备，请先移除旧设备");
        p.pushDevices = [
          ...devices,
          {
            id,
            name: String(body.name || "我的设备")
              .trim()
              .slice(0, 40),
            registration:
              existing && !body.renew
                ? existing.registration
                : crypto.randomUUID(),
            subscription: body.subscription,
          },
        ];
        p.pushSubscription = null;
        p.notificationMode = "push";
        return p;
      }),
    );
  if (path === "device/remove")
    return serial(() =>
      update((p) => {
        p.pushDevices = (p.pushDevices || []).filter((d) => d.id !== body.id);
        if (!p.pushDevices.length && p.notificationMode === "push")
          p.notificationMode = "off";
        return p;
      }),
    );
  if (path === "device/rename")
    return serial(() =>
      update((p) => {
        const name = String(body.name || "")
          .trim()
          .slice(0, 40);
        if (!name) throw new Error("请输入设备名称");
        p.pushDevices = (p.pushDevices || []).map((d) =>
          d.id === body.id ? { ...d, name } : d,
        );
        return p;
      }),
    );
  if (path === "push/remove")
    return serial(() =>
      update((p) => {
        p.pushSubscription = null;
        if (p.pushDevices) {
          p.pushDevices = p.pushDevices.filter((d) => d.id !== deviceId());
          if (!p.pushDevices.length && p.notificationMode === "push")
            p.notificationMode = "off";
        } else if (p.notificationMode === "push") p.notificationMode = "off";
        return p;
      }),
    );
  if (path === "push/test")
    return serial(() =>
      update((p) => {
        p.request = {
          id: crypto.randomUUID(),
          action: path,
          deviceId: body?.deviceId || deviceId(),
        };
        return p;
      }),
    );
  if (path === "bark/test")
    return serial(() =>
      update((p) => {
        p.request = { id: crypto.randomUUID(), action: path };
        return p;
      }),
    );
  if (path === "tick") {
    if (!token) throw new Error("请先连接 GitHub");
    await trigger();
    return { queued: true };
  }
  throw new Error("不支持的操作");
}

// Read with the new credential, decrypt with the old one, then atomically replace
// the envelope. This still works when the old GitHub token has expired.
export async function rotateToken(nextToken, oldToken = token) {
  return serial(async () => {
    const next = nextToken.trim(),
      old = oldToken.trim();
    if (!next || !old) throw new Error("请填写旧密钥和新密钥");
    const previous = { token, rawKey, prefs, latest, envelopes, hydrated };
    const ctx = beginSession(next);
    rawKey = null;
    prefs = null;
    latest = null;
    envelopes = {};
    hydrated = true;
    try {
      const repo = await request("", { credential: ctx.token });
      checkSession(ctx);
      if (!repo.permissions?.push) throw new Error("新密钥缺少仓库写入权限");
      const saved = await file(
        "preferences.enc.json",
        "preferences",
        false,
        ctx.token,
      );
      checkSession(ctx);
      if (!saved) throw new Error("未找到可迁移的配置");
      let value;
      try {
        value = await unseal(saved.value, await keyBytes(old));
      } catch {
        throw new Error("旧密钥无法解密现有配置，未覆盖任何数据");
      }
      const key = await keyBytes(next),
        publicKey = await (
          await fetch("./data/public-key.json", { cache: "no-store" })
        ).json();
      value.revision = crypto.randomUUID();
      const envelope = await sealPreferences(value, key, publicKey.spki);
      checkSession(ctx);
      await request("/contents/preferences.enc.json", {
        method: "PUT",
        credential: ctx.token,
        body: {
          message: "Rotate encrypted preferences key",
          branch: "preferences",
          content: encodeContent(envelope),
          sha: saved.sha,
        },
      });
      checkSession(ctx);
      rawKey = key;
      prefs = value;
      latest = null;
      envelopes = { preferences: envelope };
      hydrated = true;
      epoch++;
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        window.dispatchEvent(
          new CustomEvent("polaris-notice", {
            detail:
              "配置已迁移，但本机无法保存登录。请保留新密钥，下次打开时重新连接。",
          }),
        );
      }
      writeCache(personalCacheKey, envelopes);
      publish();
      try {
        await trigger(ctx);
        checkSession(ctx);
      } catch {
        checkSession(ctx);
        window.dispatchEvent(
          new CustomEvent("polaris-notice", {
            detail: "密钥已迁移，立即触发失败；等待定时任务应用。",
          }),
        );
      }
      return { queued: true };
    } catch (error) {
      if (sameSession(ctx)) {
        ({ rawKey, prefs, latest, envelopes, hydrated } = previous);
        beginSession(previous.token);
        publish();
      }
      throw error;
    }
  });
}
