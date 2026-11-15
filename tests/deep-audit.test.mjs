import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup } from "./client-fixture.mjs";
import { dbEnv, call } from "../backend/storage.mjs";
import { heartbeatHealth, checkWatchdog } from "../backend/watchdog.mjs";
import { vapidKeys } from "../backend/push.mjs";

const put = (e, k, v) => e.db.prepare("INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));
const device = { id: "phone", name: "手机", registration: "r-phone", subscription: { endpoint: "https://web.push.apple.com/audit", keys: { p256dh: vapidKeys("audit").publicKey, auth: Buffer.alloc(16, 1).toString("base64url") } } };
function environment(t) {
  const e = dbEnv(); e.db.exec(readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8"));
  t.after(() => e.db.close()); return e;
}
async function queued(t, kind = "release") {
  const e = environment(t), at = Date.parse("2030-09-20T12:00:00+08:00");
  const original = Date.now; Date.now = () => at; t.after(() => { Date.now = original; });
  await call(e, "state"); put(e, "paused", "fixture"); put(e, "notification_mode", "push"); put(e, "push_devices", [device]);
  e.db.prepare("INSERT INTO radar_movies VALUES (?,?,?)").run("111", JSON.stringify({ id: 111, nm: "排片测试", rt: "2031-01-01" }), 1);
  e.db.prepare("INSERT INTO radar_stars VALUES (?,?,?)").run("111", 1, 1);
  e.db.prepare("INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)").run("queued", "111", kind, "排片测试", "旧通知", at / 1000 - 600);
  const sent = []; e.PUSH_SEND = async (_, body) => sent.push(JSON.parse(body));
  return { e, at, sent };
}
test("watchdog alerts when startup never succeeds even while failed jobs keep updating the heartbeat", () => {
  assert.equal(heartbeatHealth({ enabled: true, thresholdMinutes: 15, heartbeat: 9999, firstSeenAt: 8000 }, 10000).kind, "outage");
});
test("enabling a channel during an existing outage also allows its matching recovery", async (t) => {
  const e = environment(t), at = 10000; put(e, "last_success", 8000);
  let out = await checkWatchdog({ env: e, prefs: { notificationMode: "off" }, at });
  const sent = []; e.PUSH_SEND = async (_, body) => sent.push(JSON.parse(body));
  const prefs = { notificationMode: "push", pushDevices: [device] };
  out = await checkWatchdog({ env: e, prefs, previous: out.state, at: at + 1 });
  put(e, "last_success", at + 2);
  out = await checkWatchdog({ env: e, prefs, previous: out.state, at: at + 3 });
  assert.equal(sent.length, 2); assert.match(sent[1].title, /已恢复/); assert.equal(out.state.incident, null);
});
test("turning off release-date notices cancels a previously deferred date-change notice", async (t) => {
  const { e, sent } = await queued(t, "release-date"); put(e, "notification_prefs", { releaseChanges: false });
  await call(e, "tick", {});
  assert.equal(sent.length, 0); assert.equal(e.db.prepare("SELECT cancelled FROM radar_events WHERE id='queued'").get().cancelled, 1);
});
test("queued sale alerts use the latest session time and hall before checking personal rules", async (t) => {
  for (const hall of ["IMAX 新厅", "普通厅"]) {
    await t.test(hall, async (t) => {
      const { e, at, sent } = await queued(t);
      const old = { id: "25769:111:show", movie_id: "111", cinema_id: "25769", cinema: "UME", starts_at: "2030-09-21T19:00:00+08:00", hall: "IMAX 旧厅", format: "", available: true };
      put(e, "event_queued", { cinema: "UME", sessions: [old] });
      put(e, "sessions_25769", [{ ...old, starts_at: "2030-09-21T20:00:00+08:00", hall }]);
      put(e, "cinema_25769", { checked: at / 1000 }); put(e, "movie_rules", { 111: { formats: ["IMAX"] } });
      await call(e, "tick", {});
      if (hall.startsWith("IMAX")) { assert.equal(sent.length, 1); assert.match(sent[0].body, /20:00/); assert.match(sent[0].body, /新厅/); }
      else { assert.equal(sent.length, 0); assert.equal(e.db.prepare("SELECT cancelled FROM radar_events WHERE id='queued'").get().cancelled, 1); }
    });
  }
});
test("read receipts, test confirmation and countdown choices only sync personal preferences", async (t) => {
  const f = await setup(t); let dispatches = 0;
  f.setIntercept((url, options, next) => { if (url.includes("/dispatches")) dispatches++; return next(url, options); });
  await f.client.api("events/read", { ids: ["event-one"] });
  await f.client.api("test/received", { id: "test-one" });
  await f.client.api("countdown", { id: "111" });
  assert.equal(dispatches, 0); assert.equal(f.client.pending(), false);
  const prefs = await f.preferences(); assert.deepEqual(prefs.readEvents, ["event-one"]); assert.equal(prefs.countdownMovieId, "111");
});
