import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dbEnv, call, applyPreferences, publicView } from "../backend/storage.mjs";
import { vapidKeys, sendPush } from "../backend/push.mjs";
import { checkWatchdog, heartbeatHealth } from "../backend/watchdog.mjs";
import { updateCatalog } from "../backend/monitor.mjs";
function env(t) { const e = dbEnv(); e.db.exec(readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8")); t.after(() => e.db.close()); return e; }
const put = (e, k, v) => e.db.prepare("INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));
const device = (id) => ({ id, name: id, registration: "r-" + id, subscription: { endpoint: "https://web.push.apple.com/" + id, keys: { p256dh: vapidKeys(id).publicKey, auth: Buffer.alloc(16, 1).toString("base64url") } } });
async function queue(e, id, created, mid = "111") {
  e.db.prepare("INSERT OR REPLACE INTO radar_movies VALUES (?,?,?)").run(mid, JSON.stringify({ id: Number(mid), nm: "测试片" + mid, rt: "2099-01-01" }), 1);
  e.db.prepare("INSERT OR REPLACE INTO radar_stars VALUES (?,?,?)").run(mid, 1, 1);
  e.db.prepare("INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)").run(id, mid, "release", "测试片" + mid + "开票", "影院新开售", created);
}
test("planner private fields never appear in the public snapshot; invalid preferences do not apply", async (t) => {
  const e = env(t);
  await applyPreferences(e, { revision: "one", stars: [], filmJournal: { 111: { tags: ["私密标签"], review: "私密短评", entries: [] } }, ruleTemplates: [{ id: "private", name: "私密模板", rule: {} }], notificationPrefs: { quietEnabled: true } });
  const state = await call(e, "state");
  assert.equal(state.filmJournal[111].review, "私密短评");
  assert.ok(!JSON.stringify(publicView(state)).includes("私密"));
  await assert.rejects(applyPreferences(e, { revision: "two", stars: [], notificationPrefs: { digestMinutes: 2 } }));
  assert.equal(e.db.prepare("SELECT value FROM radar_kv WHERE key='preferences_revision'").get().value, '"one"');
});
test("due ordinary events are batched, quiet events wait, and per-device receipts prevent duplicate retries", async (t) => {
  const e = env(t), original = Date.now;
  let at = Date.parse("2030-09-20T23:30:00+08:00"); Date.now = () => at; t.after(() => { Date.now = original; });
  await call(e, "state"); put(e, "paused", "test"); put(e, "notification_mode", "push"); put(e, "push_devices", [device("a"), device("b")]);
  put(e, "notification_prefs", { quietEnabled: true, quietFrom: "23:00", quietUntil: "08:00", digestMinutes: 15 });
  await queue(e, "first", at / 1000 - 3600); await queue(e, "second", at / 1000 - 3600, "222");
  const sent = []; let fail = true;
  e.PUSH_SEND = async (sub, body) => { if (sub.endpoint.endsWith("/b") && fail) throw new Error("temporary"); sent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); };
  await call(e, "tick", {}); assert.equal(sent.length, 0);
  at = Date.parse("2030-09-21T08:01:00+08:00");
  await call(e, "tick", {}); assert.equal(sent.length, 1); assert.match(sent[0].body.title, /汇总 · 2 条/);
  assert.equal(e.db.prepare("SELECT sent_at FROM radar_events WHERE id='first'").get().sent_at, null);
  fail = false; at += 120000;
  await call(e, "tick", {});
  assert.equal(sent.filter((x) => x.endpoint.endsWith("/a")).length, 1);
  assert.equal(sent.filter((x) => x.endpoint.endsWith("/b")).length, 1);
  assert.ok(e.db.prepare("SELECT sent_at FROM radar_events WHERE id='first'").get().sent_at);
  assert.match(sent[0].body.url, /event=first/);
});
test("urgent film bypasses digest and only bypasses quiet hours when explicitly allowed", async (t) => {
  const e = env(t), now = Date.now; const at = Date.parse("2030-09-20T23:30:00+08:00"); Date.now = () => at; t.after(() => { Date.now = now; });
  await call(e, "state"); put(e, "paused", "test"); put(e, "notification_mode", "push"); put(e, "push_devices", [device("a")]); put(e, "movie_rules", { 111: { priority: "urgent" } });
  put(e, "notification_prefs", { quietEnabled: true, urgentBypassQuiet: true, digestMinutes: 60 });
  await queue(e, "urgent", at / 1000);
  const messages = []; e.PUSH_SEND = async (_, body) => messages.push(JSON.parse(body));
  await call(e, "tick", {}); assert.equal(messages.length, 1); assert.ok(!messages[0].title.includes("汇总"));
});
test("catalog emits one confirmed release-date change, ignores empty dates and establishes a first baseline silently", async (t) => {
  const e = env(t); await call(e, "state");
  e.db.prepare("INSERT OR REPLACE INTO radar_movies VALUES (?,?,?)").run("111", JSON.stringify({ id: 111, nm: "改档片", rt: "2030-01-01" }), 1);
  e.db.prepare("INSERT INTO radar_stars VALUES (?,?,?)").run("111", 1, 1);
  const at = Math.floor(Date.now() / 1000); put(e, "catalog_refreshed", { 111: at - 600 });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let release = "2030-02-01";
  globalThis.fetch = async () => new Response(JSON.stringify({ movieList: [{ id: 111, nm: "改档片", rt: release }], movieIds: [111] }), { headers: { "content-type": "application/json" } });
  async function refresh() { put(e, "catalog_next_refresh", 0); put(e, "catalog_cycle", { scheduled: at, phase: "released", remaining: null }); put(e, "catalog_refreshed", Object.fromEntries(e.db.prepare("SELECT id FROM radar_movies").all().map((m) => [m.id, m.id === "111" ? at - 600 : at]))); await updateCatalog(e, at); }
  await refresh(); await refresh();
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM radar_events WHERE kind='release-date'").get().n, 1);
  release = ""; await refresh();
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM radar_events WHERE kind='release-date'").get().n, 1);
  release = "2030-02-01"; await refresh();
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM radar_events WHERE kind='release-date'").get().n, 1);
});
test("independent watchdog deduplicates outage and recovery, defers during quiet hours and respects manual pause", async (t) => {
  const e = env(t); let at = Date.parse("2030-09-20T12:00:00+08:00") / 1000;
  put(e, "last_success", at - 2000); put(e, "notification_mode", "push");
  const messages = [], sender = async (_, title) => messages.push(title);
  let output = await checkWatchdog({ env: e, prefs: {}, at, sender });
  assert.equal(messages.length, 1); assert.equal(output.publicStatus.health, "outage");
  output = await checkWatchdog({ env: e, prefs: {}, previous: output.state, at: at + 600, sender }); assert.equal(messages.length, 1);
  put(e, "last_success", at + 600);
  output = await checkWatchdog({ env: e, prefs: {}, previous: output.state, at: at + 700, sender }); assert.equal(messages.length, 2); assert.equal(output.state.incident, null);
  put(e, "paused", "你已手动暂停监测；星标保留。"); put(e, "last_success", at - 2000);
  output = await checkWatchdog({ env: e, prefs: {}, previous: output.state, at, sender }); assert.equal(messages.length, 2); assert.equal(output.publicStatus.health, "paused");
  put(e, "paused", null); at = Date.parse("2030-09-20T23:30:00+08:00") / 1000;
  output = await checkWatchdog({ env: e, prefs: { notificationPrefs: { quietEnabled: true } }, at, sender }); assert.equal(messages.length, 2);
  assert.equal(heartbeatHealth({ enabled: true, thresholdMinutes: 15, firstSeenAt: at }, at).kind, "waiting");
});
test("watchdog retains accepted-device receipts across its independent retries", async (t) => {
  const e = env(t), at = Math.floor(Date.now() / 1000);
  put(e, "last_success", at - 2000); put(e, "notification_mode", "push"); put(e, "push_devices", [device("a"), device("b")]);
  const sent = []; let fail = true;
  e.PUSH_SEND = async (sub, body) => { if (sub.endpoint.endsWith("/b") && fail) throw new Error("temporary"); sent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); };
  let output = await checkWatchdog({ env: e, prefs: {}, at });
  assert.equal(sent.length, 1); assert.equal(output.state.incident.alertAcceptedAt, null);
  fail = false;
  output = await checkWatchdog({ env: e, prefs: {}, previous: output.state, at: at + 600 });
  assert.equal(sent.filter((s) => s.endpoint.endsWith("/a")).length, 1);
  assert.equal(sent.filter((s) => s.endpoint.endsWith("/b")).length, 1);
  assert.ok(output.state.incident.alertAcceptedAt);
  assert.match(sent[0].body.url, /view=settings/);
});
test("long bilingual and emoji notifications fit the duplicated declarative Web Push payload", async (t) => {
  const e = env(t); let text;
  e.PUSH_SEND = async (_, value) => { text = value; };
  await sendPush(e, device("a").subscription, { title: "中文电影🎬".repeat(100), body: "新开票🎟️".repeat(1000), id: "test-size" });
  assert.ok(Buffer.byteLength(text) < 3800);
  const message = JSON.parse(text);
  assert.ok(message.body.endsWith("…"));
  assert.equal(message.body, message.notification.body);
});
