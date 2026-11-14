import test from "node:test";
import assert from "node:assert/strict";
import {
  keyBytes,
  seal,
  sealPreferences,
  unseal,
  encode64,
} from "../docs/crypto.mjs";
async function setup(t) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = encode64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const old = "expired-original-token",
    next = "replacement-token",
    prefs = {
      revision: "old",
      stars: ["111"],
      movieRules: { 111: { paused: true } },
      readEvents: ["event-one"],
      pushDevices: [],
    };
  let envelope = await sealPreferences(prefs, await keyBytes(old), spki),
    sha = "old-sha",
    putCount = 0;
  const store = new Map([["polaris.github-token.v1", old]]),
    previous = {
      fetch: globalThis.fetch,
      localStorage: globalThis.localStorage,
      window: globalThis.window,
    };
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = new EventTarget();
  const contents = (value) =>
    new Response(
      JSON.stringify({
        content: Buffer.from(JSON.stringify(value)).toString("base64"),
        sha,
      }),
    );
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "./data/public-key.json")
      return new Response(JSON.stringify({ spki }));
    if (String(url) === "./data/state.json")
      return new Response(
        JSON.stringify({
          movies: [
            { id: "111", name: "一" },
            { id: "222", name: "二" },
          ],
        }),
      );
    const u = new URL(url);
    if (options.method === "POST") return new Response(null, { status: 204 });
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, sha);
      envelope = JSON.parse(Buffer.from(body.content, "base64").toString());
      sha = "next-sha";
      putCount++;
      return new Response("{}");
    }
    if (u.pathname.endsWith("preferences.enc.json")) return contents(envelope);
    if (u.pathname.endsWith("private.enc.json"))
      return new Response("{}", { status: 404 });
    if (u.pathname.endsWith("public.json"))
      return new Response("{}", { status: 404 });
    if (u.pathname.includes("/git/ref/"))
      return new Response(JSON.stringify({ object: { sha: "head" } }));
    assert.equal(
      options.headers.Authorization,
      "Bearer " + next,
      "rotation must read GitHub with the new token",
    );
    return new Response(JSON.stringify({ permissions: { push: true } }));
  };
  t.after(() => Object.assign(globalThis, previous));
  const client = await import(
    "../docs/client.mjs?migration=" + crypto.randomUUID()
  );
  return {
    client,
    old,
    next,
    prefs,
    store,
    get: () => ({ envelope, putCount }),
  };
}
test("rotation reads with a new credential, preserves all encrypted configuration and supports an expired old token", async (t) => {
  const { client, old, next, prefs, store, get } = await setup(t);
  await client.rotateToken(next, old);
  const { envelope, putCount } = get();
  assert.equal(putCount, 1);
  const result = await unseal(envelope, await keyBytes(next));
  assert.deepEqual(result.stars, prefs.stars);
  assert.deepEqual(result.movieRules, prefs.movieRules);
  assert.deepEqual(result.readEvents, prefs.readEvents);
  assert.notEqual(result.revision, prefs.revision);
  await assert.rejects(unseal(envelope, await keyBytes(old)));
  assert.equal(store.get("polaris.github-token.v1"), next);
  assert.ok(!store.get("polaris.encrypted-cache.v1").includes("event-one"));
});
test("wrong decryption key never overwrites the remote envelope or the local credential", async (t) => {
  const { client, old, next, store, get } = await setup(t);
  await assert.rejects(client.rotateToken(next, "wrong-old-key"), /未覆盖/);
  assert.equal(get().putCount, 0);
  assert.equal(store.get("polaris.github-token.v1"), old);
});
test("parallel star edits publish optimistic state and serialize writes without dropping another film", async (t) => {
  const { client, old, get } = await setup(t);
  await client.load();
  const updates = [];
  window.addEventListener("polaris-state", (e) => updates.push(e.detail));
  await Promise.all([
    client.api("star", { id: "111", active: false }),
    client.api("star", { id: "222", active: true }),
  ]);
  const prefs = await unseal(get().envelope, await keyBytes(old));
  assert.deepEqual(prefs.stars, ["222"]);
  assert.ok(
    updates.some(
      (s) => s.movies.find((m) => m.id === "222")?.syncState === "saving",
    ),
  );
  assert.equal(get().putCount, 2);
});

test("a failed optimistic star edit rolls back and can be retried without losing saved stars", async (t) => {
  const { client, old, get } = await setup(t);
  await client.load();
  const original = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (url, options = {}) =>
    options.method === "PUT" && fail
      ? new Response("{}", { status: 409 })
      : original(url, options);
  await assert.rejects(
    client.api("star", { id: "222", active: true }),
    /同步冲突/,
  );
  const state = await client.load();
  assert.equal(state.movies.find((m) => m.id === "222").active, false);
  assert.equal(state.movies.find((m) => m.id === "222").syncState, "error");
  assert.equal(state.mutationErrors["222"].retry, true);
  fail = false;
  await client.api("star", { id: "222", active: true });
  const prefs = await unseal(get().envelope, await keyBytes(old));
  assert.deepEqual(prefs.stars, ["111", "222"]);
});
