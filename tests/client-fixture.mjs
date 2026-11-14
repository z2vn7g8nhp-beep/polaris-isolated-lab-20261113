import {
  keyBytes,
  seal,
  sealPreferences,
  unseal,
  encode64,
} from "../docs/crypto.mjs";
export const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
export async function setup(t, extra = {}) {
  const token = "audit-token",
    nextToken = "audit-next-token",
    rawKey = await keyBytes(token);
  const pair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
    spki = encode64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const prefs = { revision: "r1", stars: ["111"], ...extra },
    state = {
      snapshotAt: 2000,
      movies: [
        { id: "111", name: "甲" },
        { id: "222", name: "乙" },
      ],
      checks: [],
      cinemas: [],
    };
  let envelope = await sealPreferences(prefs, rawKey, spki),
    intercept = null,
    puts = 0;
  const privateEnvelope = await seal(
    {
      ...state,
      processedRevision: "r1",
      events: [],
      pushDevices: extra.pushDevices?.map(({ subscription, ...d }) => d),
    },
    rawKey,
  );
  const storage = new Map([
      ["polaris.github-token.v1", token],
      ["polaris.public-cache.v1", JSON.stringify(state)],
    ]),
    previous = {
      fetch: globalThis.fetch,
      localStorage: globalThis.localStorage,
      window: globalThis.window,
    };
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) || null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  globalThis.window = new EventTarget();
  const contents = (v) =>
    new Response(
      JSON.stringify({
        content: Buffer.from(JSON.stringify(v)).toString("base64"),
        sha: "head",
      }),
    );
  const handle = async (url, opts = {}) => {
    if (url === "./data/state.json") return new Response(JSON.stringify(state));
    if (url === "./data/public-key.json")
      return new Response(JSON.stringify({ spki }));
    if (opts.method === "PUT") {
      envelope = JSON.parse(
        Buffer.from(JSON.parse(opts.body).content, "base64").toString(),
      );
      puts++;
      return new Response("{}");
    }
    if (opts.method === "POST") return new Response(null, { status: 204 });
    if (url.endsWith("/contents/preferences.enc.json?ref=preferences"))
      return contents(envelope);
    if (url.endsWith("/contents/private.enc.json?ref=monitor-state"))
      return contents(privateEnvelope);
    if (url.endsWith("/contents/public.json?ref=monitor-state"))
      return contents(state);
    if (url.includes("/git/ref/"))
      return new Response(JSON.stringify({ object: { sha: "head" } }));
    return new Response(JSON.stringify({ permissions: { push: true } }));
  };
  globalThis.fetch = (url, opts = {}) =>
    intercept
      ? intercept(String(url), opts, handle)
      : handle(String(url), opts);
  t.after(() => Object.assign(globalThis, previous));
  const client = await import(
    "../docs/client.mjs?audit=" + crypto.randomUUID()
  );
  await client.load();
  return {
    client,
    token,
    nextToken,
    storage,
    setIntercept: (fn) => (intercept = fn),
    puts: () => puts,
    preferences: () => unseal(envelope, rawKey),
  };
}
