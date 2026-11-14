import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseTarget,
  countdownParts,
  countdownMovie,
} from "../docs/countdown-model.mjs";
import { setup } from "./client-fixture.mjs";
import { dbEnv, applyPreferences } from "../backend/storage.mjs";
import { readFileSync } from "node:fs";
test("release countdown targets midnight in China and accepts only real calendar dates", () => {
  assert.equal(releaseTarget("2030-01-01"), Date.parse("2029-12-31T16:00:00Z"));
  assert.ok(releaseTarget("2032-02-29"));
  for (const v of ["2030-02-29", "2030-02-30", "待定", "2030-1-01", null])
    assert.equal(releaseTarget(v), null);
});
test("countdown rolls over at the exact release boundary without negative or premature zero values", () => {
  const target = releaseTarget("2030-01-01");
  assert.deepEqual(
    countdownParts(
      "2030-01-01",
      target - (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000,
    ),
    { kind: "pending", days: 2, hours: 3, minutes: 4, seconds: 5 },
  );
  assert.equal(countdownParts("2030-01-01", target - 1).seconds, 1);
  assert.equal(countdownParts("2030-01-01", target).kind, "released");
  assert.equal(countdownParts("2030-01-01", target + 100000).days, 0);
  assert.equal(countdownParts("待定").kind, "undated");
});
test("an explicit film choice wins over popularity and defaults prefer starred upcoming dated films", () => {
  const movies = [
    { id: "111", release: "2090-01-01", active: true, wish: 10 },
    { id: "222", release: "2090-01-02", wish: 1000 },
    { id: "333", release: "待定", wish: 10000 },
    { id: "444", release: "2020-01-01" },
  ];
  assert.equal(countdownMovie({ movies }).id, "111");
  assert.equal(countdownMovie({ movies, countdownMovieId: "222" }).id, "222");
  assert.equal(countdownMovie({ movies }, "333").id, "333");
  assert.equal(countdownMovie({ movies }, "444").id, "444");
  assert.equal(countdownMovie({ movies }, "unknown").id, "111");
  assert.equal(countdownMovie({ movies: [] }), null);
});
test("countdown selection is encrypted and retains stars and existing rules; invalid film selection does not write", async (t) => {
  const f = await setup(t, {
    movieRules: { 111: { paused: true } },
    readEvents: ["private-read"],
  });
  await f.client.api("countdown", { id: "222" });
  const saved = await f.preferences();
  assert.equal(saved.countdownMovieId, "222");
  assert.deepEqual(saved.stars, ["111"]);
  assert.deepEqual(saved.movieRules, { 111: { paused: true } });
  assert.equal((await f.client.load()).countdownMovieId, "222");
  const count = f.puts();
  await assert.rejects(f.client.api("countdown", { id: "missing" }));
  assert.equal(f.puts(), count);
  assert.ok(
    !f.storage.get("polaris.encrypted-cache.v1").includes("private-read"),
  );
});
test("invalid countdown configuration is rejected before applying other preference changes", async (t) => {
  const e = dbEnv();
  e.db.exec(
    readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8"),
  );
  t.after(() => e.db.close());
  await assert.rejects(
    applyPreferences(e, {
      revision: "bad",
      stars: [],
      countdownMovieId: { id: "111" },
    }),
    /倒计时/,
  );
});
