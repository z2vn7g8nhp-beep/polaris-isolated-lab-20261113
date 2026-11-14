import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dbEnv, call, applyPreferences } from "../backend/storage.mjs";
import { parseSessions, CINEMAS } from "../backend/monitor.mjs";
import { freshCatalog } from "./catalog-fixture.mjs";
import { vapidKeys } from "../backend/push.mjs";
const sub = {
  endpoint: "https://web.push.apple.com/audit",
  keys: {
    p256dh: vapidKeys("audit").publicKey,
    auth: Buffer.alloc(16, 1).toString("base64url"),
  },
};
const movie = {
  id: 111,
  nm: "排片测试",
  rt: "2031-01-01",
  globalReleased: false,
};
const show = {
  seqNo: "known",
  dt: "2030-12-01",
  tm: "19:30",
  th: "IMAX",
  enterShowSeat: 1,
};
function env(t) {
  const e = dbEnv();
  e.db.exec(
    readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8"),
  );
  t.after(() => e.db.close());
  return e;
}
const put = (e, k, v) =>
  e.db
    .prepare(
      "INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(k, JSON.stringify(v));
const fixture = (id, shows) => ({
  showData: {
    cinemaId: id,
    movies: shows === null ? [] : [{ ...movie, shows: [{ plist: shows }] }],
  },
});
test("invalid dates, times and movie identifiers are rejected before generating sale alerts", () => {
  for (const invalid of [
    { ...show, dt: "2030-02-30" },
    { ...show, tm: "25:30" },
    { ...show, dt: {} },
    { ...show, th: {} },
  ])
    assert.throws(() => parseSessions(fixture(25769, [invalid]), CINEMAS[0]));
  const invalid = fixture(25769, [show]);
  invalid.showData.movies[0].id = "not-a-movie";
  assert.throws(() => parseSessions(invalid, CINEMAS[0]));
});
test("queued alerts are rechecked against newly observed unavailable sessions before being sent", async (t) => {
  const e = env(t);
  await call(e, "state");
  e.db
    .prepare("INSERT INTO radar_movies VALUES (?,?,?)")
    .run("111", JSON.stringify(movie), 1);
  freshCatalog(e);
  await applyPreferences(e, {
    revision: "one",
    stars: ["111"],
    pushSubscription: sub,
    notificationMode: "push",
  });
  const row = {
    id: "25769:111:known",
    movie_id: "111",
    cinema_id: "25769",
    cinema: CINEMAS[0].short,
    starts_at: "2030-12-01T19:30:00+08:00",
    hall: "IMAX",
    format: "",
    available: true,
    url: "https://m.maoyan.com/cinema/25769?movieId=111",
  };
  e.db
    .prepare(
      "INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run("stale", "111", "release", "开票", "旧场次", 1);
  put(e, "event_stale", { cinema: CINEMAS[0].short, sessions: [row] });
  put(e, "sessions_25769", [row]);
  put(e, "cinema_25769", { checked: 1 });
  let sends = 0;
  e.PUSH_SEND = async () => {
    sends++;
    return { statusCode: 201 };
  };
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("39869")
          ? fixture(39869, null)
          : fixture(25769, [{ ...show, enterShowSeat: 0 }]),
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  await call(e, "tick", {});
  assert.equal(sends, 0);
  assert.equal((await call(e, "state")).events[0].cancelled, 1);
});
test("different devices cannot share a delivery registration or the same push endpoint", async (t) => {
  for (const duplicate of ["registration", "endpoint"]) {
    const e = env(t),
      devices = [
        { id: "a", name: "a", registration: "a", subscription: sub },
        {
          id: "b",
          name: "b",
          registration: duplicate === "registration" ? "a" : "b",
          subscription: {
            ...sub,
            endpoint:
              duplicate === "endpoint" ? sub.endpoint : sub.endpoint + "-b",
          },
        },
      ];
    await assert.rejects(
      applyPreferences(e, { revision: "bad", stars: [], pushDevices: devices }),
    );
  }
});
