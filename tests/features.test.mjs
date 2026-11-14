import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeRule,
  matchesSession,
  monitorEligible,
  visibleMovies,
  countdown,
} from "../docs/rules.mjs";
import {
  dbEnv,
  call,
  applyPreferences,
  publicView,
} from "../backend/storage.mjs";
import { freshCatalog } from "./catalog-fixture.mjs";
import { vapidKeys } from "../backend/push.mjs";
const row = {
  movie_id: "111",
  cinema_id: "25769",
  starts_at: "2030-09-20T19:30:00+08:00",
  hall: "激光 IMAX",
  format: "3D",
  available: true,
};
const movie = {
  id: 111,
  nm: "规则测试片",
  rt: "2030-01-01",
  globalReleased: true,
};
function env() {
  const e = dbEnv();
  e.db.exec(
    readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8"),
  );
  return e;
}
const put = (e, k, v) =>
  e.db
    .prepare(
      "INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(k, JSON.stringify(v));
const sub = (id) => ({
  endpoint: "https://web.push.apple.com/test-" + id,
  keys: {
    p256dh: vapidKeys("test-" + id).publicKey,
    auth: Buffer.alloc(16, 2).toString("base64url"),
  },
});
const device = (id) => ({
  id,
  name: "设备 " + id,
  registration: "registration-" + id,
  subscription: sub(id),
});
test("reminder rules combine venue, format, weekday and inclusive dates; midnight ranges work", () => {
  const rule = normalizeRule({
    cinemas: ["25769"],
    formats: ["imax"],
    weekdays: [5],
    from: "2030-09-20",
    until: "2030-09-20",
    timeFrom: "18:00",
    timeUntil: "20:00",
  });
  assert.equal(matchesSession(row, rule), true);
  for (const override of [
    { cinema_id: "39869" },
    { hall: "普通厅" },
    { starts_at: "2030-09-21T19:30:00+08:00" },
    { starts_at: "2030-09-20T21:30:00+08:00" },
  ])
    assert.equal(matchesSession({ ...row, ...override }, rule), false);
  assert.equal(
    matchesSession(
      { ...row, starts_at: "2030-09-20T01:30:00+08:00" },
      { timeFrom: "22:00", timeUntil: "02:00" },
    ),
    true,
  );
  assert.equal(
    matchesSession(row, { timeFrom: "22:00", timeUntil: "02:00" }),
    false,
  );
  for (const invalid of [
    { from: "2030-02-31" },
    { timeFrom: "25:00" },
    { weekdays: [7] },
    { cinemas: ["unknown"] },
    { from: "2030-09-21", until: "2030-09-20" },
  ])
    assert.throws(() => normalizeRule(invalid));
  assert.equal(monitorEligible(movie, {}, "2030-09-20"), false);
  assert.equal(
    monitorEligible(movie, { continueUntil: "2030-09-20" }, "2030-09-20"),
    true,
  );
  assert.equal(
    monitorEligible(
      movie,
      { continueUntil: "2030-09-20", paused: true },
      "2030-09-20",
    ),
    false,
  );
});
test("calendar filters and sorting handle undated movies, actors, month boundaries and zero scores", () => {
  const movies = [
    {
      id: "a",
      name: "甲",
      actors: "张三",
      release: "2030-09-30",
      wish: 10,
      score: 0,
    },
    { id: "b", name: "乙", release: "2030-10-01", wish: 20, score: 9 },
    { id: "c", name: "丙", release: "待定", wish: 30 },
  ];
  assert.deepEqual(
    visibleMovies(movies, { scope: "week", today: "2030-09-29" }).map(
      (m) => m.id,
    ),
    ["a", "b"],
  );
  assert.deepEqual(
    visibleMovies(movies, { scope: "month", today: "2030-09-29" }).map(
      (m) => m.id,
    ),
    ["a"],
  );
  assert.deepEqual(
    visibleMovies(movies, { scope: "undated" }).map((m) => m.id),
    ["c"],
  );
  assert.equal(visibleMovies(movies, { search: "张三" })[0].id, "a");
  assert.deepEqual(
    visibleMovies(movies, { sort: "score" }).map((m) => m.id),
    ["b", "a", "c"],
  );
  assert.equal(countdown("2030-10-01", "2030-09-30"), "1 天后上映");
});
test("rules control actual post-release alerts, retain deduplication, and publish sessions without private rules", async (t) => {
  const e = env();
  t.after(() => e.db.close());
  await call(e, "state");
  e.db
    .prepare("INSERT INTO radar_movies VALUES (?,?,?)")
    .run("111", JSON.stringify({ ...movie, rt: "2020-01-01" }), 1);
  freshCatalog(e);
  const prefs = {
    revision: "1",
    stars: ["111"],
    movieRules: {
      111: {
        continueUntil: "2030-12-31",
        cinemas: ["25769"],
        formats: ["IMAX"],
        timeFrom: "19:00",
        timeUntil: "22:00",
      },
    },
    readEvents: ["old-private-event"],
    starRevisions: { 111: "star-v1" },
  };
  await applyPreferences(e, prefs);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const id = String(url).includes("39869") ? 39869 : 25769;
    return new Response(
      JSON.stringify({
        showData: {
          cinemaId: id,
          movies: [
            {
              ...movie,
              rt: "2020-01-01",
              shows: [
                {
                  plist: [
                    {
                      seqNo: "match",
                      dt: "2030-09-20",
                      tm: "19:30",
                      th: "激光 IMAX",
                      enterShowSeat: 1,
                    },
                    {
                      seqNo: "no-match",
                      dt: "2030-09-20",
                      tm: "10:30",
                      th: "普通厅",
                      enterShowSeat: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  t.after(() => (globalThis.fetch = original));
  await call(e, "tick", {});
  let state = await call(e, "state");
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].sessions.length, 1);
  assert.equal(state.events[0].sessions[0].cinema_id, "25769");
  assert.equal(state.sessions.length, 4);
  assert.equal(
    state.events[0].sessions[0].url,
    "https://m.maoyan.com/cinema/25769?movieId=111",
  );
  const pub = publicView(state);
  assert.ok(!JSON.stringify(pub).includes("old-private-event"));
  assert.ok(!("movieRules" in pub));
  assert.ok(!("starRevisions" in pub));
  assert.equal(pub.sessions.length, 4);
  assert.ok(state.healthHistory.length);
  put(e, "next_request", 0);
  await call(e, "tick", {});
  state = await call(e, "state");
  assert.equal(state.events.length, 1);
  await applyPreferences(e, {
    ...prefs,
    revision: "2",
    movieRules: { 111: { paused: true } },
  });
  put(e, "next_request", 0);
  await call(e, "tick", {});
  assert.equal((await call(e, "state")).movieRules["111"].paused, true);
});
test("multi-device retries skip successful devices and expiration cannot be revived by an unrelated edit", async (t) => {
  const e = env();
  t.after(() => e.db.close());
  await call(e, "state");
  const prefs = {
    revision: "1",
    stars: [],
    notificationMode: "push",
    pushDevices: [device("a"), device("b")],
  };
  await applyPreferences(e, prefs);
  let calls = [];
  e.PUSH_SEND = async (subscription) => {
    calls.push(subscription.endpoint);
    if (subscription.endpoint.endsWith("-b"))
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    return { statusCode: 201 };
  };
  e.db
    .prepare(
      "INSERT INTO radar_events(id,kind,title,body,created_at) VALUES (?,?,?,?,?)",
    )
    .run("multi", "risk", "测试", "内容", 1);
  put(e, "paused", "manual test");
  await call(e, "tick", {});
  assert.equal(calls.length, 2);
  let state = await call(e, "state");
  assert.ok(state.pushDevices.find((d) => d.id === "b").expired);
  assert.ok(!("subscription" in state.pushDevices[0]));
  assert.equal(state.events[0].sent_at, null);
  await applyPreferences(e, {
    ...prefs,
    revision: "2",
    pushDevices: [{ ...device("a"), name: "新名字" }, device("b")],
  });
  assert.deepEqual(
    (await call(e, "state")).pushDevices
      .filter((d) => !d.expired)
      .map((d) => d.id),
    ["a"],
  );
  e.db.prepare("UPDATE radar_events SET next_try=0").run();
  put(e, "next_request", 0);
  await call(e, "tick", {});
  assert.equal(
    calls.length,
    2,
    "successful device is not sent the same event again",
  );
  assert.ok((await call(e, "state")).events[0].sent_at);
  await applyPreferences(e, {
    ...prefs,
    revision: "3",
    pushDevices: [
      device("a"),
      { ...device("b"), registration: "reconnected-b" },
    ],
  });
  assert.equal((await call(e, "state")).pushDevices.length, 2);
});
test("invalid rules and device duplicates are rejected before changing existing preferences", async (t) => {
  const e = env();
  t.after(() => e.db.close());
  await applyPreferences(e, {
    revision: "1",
    stars: [],
    movieRules: { 111: { paused: true } },
  });
  await assert.rejects(
    applyPreferences(e, {
      revision: "2",
      stars: [],
      movieRules: { 111: { paused: false } },
      pushDevices: [device("a"), device("a")],
    }),
  );
  assert.equal((await call(e, "state")).movieRules["111"].paused, true);
});

test("queued notifications are reduced to currently matching sessions before delivery", async (t) => {
  const e = env();
  t.after(() => e.db.close());
  await call(e, "state");
  e.db
    .prepare("INSERT INTO radar_movies VALUES (?,?,?)")
    .run("111", JSON.stringify(movie), 1);
  await applyPreferences(e, {
    revision: "rules",
    stars: ["111"],
    pushSubscription: sub("single"),
    notificationMode: "push",
    movieRules: { 111: { continueUntil: "2030-12-31", formats: ["IMAX"] } },
  });
  put(e, "paused", "skip source during delivery test");
  e.db
    .prepare(
      "INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run("filtered", "111", "release", "开票", "原始的两个场次", 1);
  put(e, "event_filtered", {
    cinema: "测试影院",
    sessions: [
      row,
      {
        ...row,
        id: "ordinary",
        hall: "普通厅",
        starts_at: "2030-09-20T10:00:00+08:00",
      },
    ],
  });
  let body;
  e.PUSH_SEND = async (s, payload) => {
    body = JSON.parse(payload).body;
    return { statusCode: 201 };
  };
  await call(e, "tick", {});
  assert.match(body, /新开售 1 场/);
  assert.match(body, /19:30/);
  assert.ok(!body.includes("10:00"));
  assert.equal((await call(e, "state")).events[0].sessions.length, 1);
});
