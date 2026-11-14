import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./client-fixture.mjs";
import { vapidKeys } from "../backend/push.mjs";
async function environment(
  t,
  { failSave = false, failUnsubscribe = false } = {},
) {
  const publicKey = vapidKeys("browser-fixture").publicKey,
    subscription = {
      endpoint: "https://web.push.apple.com/existing",
      keys: {
        p256dh: publicKey,
        auth: Buffer.alloc(16, 1).toString("base64url"),
      },
    };
  const f = await setup(t, {
    notificationMode: "push",
    pushDevices: [
      {
        id: "local",
        name: "手机",
        registration: "keep-registration",
        subscription,
      },
    ],
  });
  localStorage.setItem("polaris.device-id", "local");
  let unsubscribes = 0,
    subscribes = 0;
  const existing = {
    endpoint: subscription.endpoint,
    options: { applicationServerKey: Buffer.from(publicKey, "base64url") },
    toJSON: () => subscription,
    unsubscribe: async () => {
      unsubscribes++;
      if (failUnsubscribe) throw new Error("provider offline");
      return true;
    },
  };
  const worker = {
    pushManager: {
      getSubscription: async () => existing,
      subscribe: async () => {
        subscribes++;
        return {
          ...existing,
          endpoint: subscription.endpoint + "-renewed",
          toJSON: () => ({
            ...subscription,
            endpoint: subscription.endpoint + "-renewed",
          }),
        };
      },
    },
  };
  const properties = ["navigator", "Notification", "matchMedia"];
  const descriptors = Object.fromEntries(
    properties.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  const Notification = {
    permission: "granted",
    requestPermission: async () => "granted",
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "test-browser",
      platform: "Linux",
      serviceWorker: {
        register: async () => worker,
        ready: Promise.resolve(worker),
      },
    },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: Notification,
  });
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
  window.Notification = Notification;
  window.PushManager = function () {};
  t.after(() => {
    for (const key of properties) {
      if (descriptors[key])
        Object.defineProperty(globalThis, key, descriptors[key]);
      else delete globalThis[key];
    }
  });
  f.setIntercept((url, opts, next) =>
    url === "./data/push-key.json"
      ? new Response(JSON.stringify({ publicKey }))
      : failSave && opts.method === "PUT"
        ? new Response("{}", { status: 503 })
        : next(url, opts),
  );
  const push = await import("../docs/push.mjs?audit=" + crypto.randomUUID());
  return { ...f, push, counts: () => ({ unsubscribes, subscribes }) };
}
test("reconnecting a healthy device reuses its subscription and delivery registration", async (t) => {
  const f = await environment(t);
  await f.push.enablePhonePush("我的手机");
  assert.deepEqual(f.counts(), { unsubscribes: 0, subscribes: 0 });
  const prefs = await f.preferences();
  assert.equal(prefs.pushDevices[0].registration, "keep-registration");
  assert.equal(prefs.pushDevices[0].name, "我的手机");
});
test("a failed configuration save does not destroy the existing healthy phone subscription", async (t) => {
  const f = await environment(t, { failSave: true });
  await assert.rejects(f.push.enablePhonePush("手机"), /503/);
  assert.deepEqual(f.counts(), { unsubscribes: 0, subscribes: 0 });
});
test("an explicitly expired subscription can be renewed with a new delivery registration", async (t) => {
  const f = await environment(t);
  await f.push.enablePhonePush("手机", { renew: true });
  assert.deepEqual(f.counts(), { unsubscribes: 1, subscribes: 1 });
  assert.notEqual(
    (await f.preferences()).pushDevices[0].registration,
    "keep-registration",
  );
});
test("once remote notifications are disabled, local unsubscribe failure is reported without undoing the saved change", async (t) => {
  const f = await environment(t, { failUnsubscribe: true });
  await f.push.disablePhonePush();
  assert.deepEqual((await f.preferences()).pushDevices, []);
  assert.equal((await f.preferences()).notificationMode, "off");
});
