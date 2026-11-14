import test from "node:test";
import assert from "node:assert/strict";
import { setup, deferred } from "./client-fixture.mjs";
test("disconnect during an accepted save cannot restore private cache or optimistic state", async (t) => {
  const f = await setup(t),
    started = deferred(),
    finish = deferred();
  f.setIntercept(async (url, opts, next) => {
    if (opts.method === "PUT") {
      const response = await next(url, opts);
      started.resolve();
      await finish.promise;
      return response;
    }
    return next(url, opts);
  });
  const saving = f.client.api("star", { id: "222", active: true });
  const result = saving.catch((e) => e);
  await started.promise;
  f.client.disconnect();
  finish.resolve();
  await result;
  const state = await f.client.load();
  assert.equal(state.connected, false);
  assert.ok(state.movies.every((m) => !m.active));
  assert.equal(f.storage.has("polaris.encrypted-cache.v1"), false);
  assert.deepEqual(state.mutationErrors, {});
});
test("queued writes are cancelled when their connection is disconnected", async (t) => {
  const f = await setup(t),
    started = deferred(),
    finish = deferred();
  f.setIntercept(async (url, opts, next) => {
    if (opts.method === "PUT") {
      started.resolve();
      await finish.promise;
    }
    return next(url, opts);
  });
  const first = f.client
    .api("star", { id: "222", active: true })
    .catch((e) => e);
  const second = f.client
    .api("rule", { id: "111", rule: { paused: true } })
    .catch((e) => e);
  await started.promise;
  f.client.disconnect();
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(f.puts(), 1);
  assert.equal(f.storage.has("polaris.encrypted-cache.v1"), false);
});
test("removing phone devices preserves an independently selected Bark channel", async (t) => {
  for (const action of ["device/remove", "push/remove"]) {
    const f = await setup(t, {
      notificationMode: "bark",
      barkKey: "test_only_bark",
      pushDevices: [
        {
          id: "local",
          name: "手机",
          registration: "r-local",
          subscription: {
            endpoint: "https://web.push.apple.com/test",
            keys: {},
          },
        },
      ],
    });
    localStorage.setItem("polaris.device-id", "local");
    await f.client.api(action, { id: "local" });
    assert.equal((await f.preferences()).notificationMode, "bark", action);
  }
});
test("renaming a device immediately shows the new name while its applied health is retained", async (t) => {
  const f = await setup(t, {
    pushDevices: [
      {
        id: "local",
        name: "旧名称",
        registration: "r-local",
        subscription: { endpoint: "https://web.push.apple.com/test", keys: {} },
      },
    ],
  });
  await f.client.api("device/rename", { id: "local", name: "新名称" });
  const state = await f.client.load();
  assert.equal(state.pushDevices[0].name, "新名称");
});
test("disconnect while a migration is finishing does not save or reinstate the new credential", async (t) => {
  const f = await setup(t),
    started = deferred(),
    finish = deferred();
  f.setIntercept(async (url, opts, next) => {
    if (opts.method === "PUT") {
      const response = await next(url, opts);
      started.resolve();
      await finish.promise;
      return response;
    }
    return next(url, opts);
  });
  const work = f.client.rotateToken(f.nextToken, f.token).catch((e) => e);
  await started.promise;
  f.client.disconnect();
  finish.resolve();
  await work;
  assert.equal(f.client.connected(), false);
  assert.equal(f.storage.has("polaris.github-token.v1"), false);
  assert.equal(f.storage.has("polaris.encrypted-cache.v1"), false);
});
test("a rejected connection attempt cannot undo a later explicit disconnect", async (t) => {
  const f = await setup(t),
    started = deferred(),
    finish = deferred();
  f.setIntercept(async (url, opts, next) => {
    if (url.endsWith("/polaris-isolated-lab-20261113")) {
      started.resolve();
      await finish.promise;
      return new Response("{}", { status: 401 });
    }
    return next(url, opts);
  });
  const work = f.client.connect("invalid-token").catch((e) => e);
  await started.promise;
  f.client.disconnect();
  finish.resolve();
  await work;
  assert.equal(f.client.connected(), false);
  assert.equal(f.storage.has("polaris.github-token.v1"), false);
});

test("blocked browser storage still allows public browsing, a stable in-memory device ID and disconnect", async (t) => {
  const f = await setup(t);
  globalThis.localStorage = {
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const client = await import(
    "../docs/client.mjs?blocked=" + crypto.randomUUID()
  );
  assert.equal(client.connected(), false);
  assert.equal(client.deviceId(), client.deviceId());
  const state = await client.load();
  assert.equal(state.movies.length, 2);
  assert.doesNotThrow(() => client.disconnect());
});
