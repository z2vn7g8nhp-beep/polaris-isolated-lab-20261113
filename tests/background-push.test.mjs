import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { sendPush, vapidKeys, APP_URL } from "../backend/push.mjs";
const subscription = {
  endpoint: "https://web.push.apple.com/background-fixture",
  keys: {
    p256dh: vapidKeys("device").publicKey,
    auth: Buffer.alloc(16, 1).toString("base64url"),
  },
};
function worker() {
  const handlers = {},
    shown = [],
    opened = [];
  let promise;
  const scope = APP_URL,
    self = {
      addEventListener: (name, fn) => (handlers[name] = fn),
      registration: {
        scope,
        showNotification: async (title, options) =>
          shown.push({ title, ...options }),
      },
      clients: {
        matchAll: async () => [],
        openWindow: async (url) => opened.push(url),
      },
    };
  runInNewContext(
    readFileSync(new URL("../docs/sw.js", import.meta.url), "utf8"),
    { self, URL },
  );
  return {
    handlers,
    shown,
    opened,
    self,
    async push(data) {
      handlers.push({ data, waitUntil: (p) => (promise = p) });
      await promise;
    },
    async click(notification) {
      handlers.notificationclick({
        notification,
        waitUntil: (p) => (promise = p),
      });
      await promise;
    },
  };
}
test("push payload includes an Apple declarative fallback and matching fields for existing service workers", async () => {
  let payload;
  await sendPush(
    {
      PUSH_KEYS: vapidKeys("server"),
      PUSH_SEND: async (s, p) => {
        payload = JSON.parse(p);
        return { statusCode: 201 };
      },
    },
    subscription,
    { title: "开票测试", body: "后台通知", id: "background-1" },
  );
  assert.equal(payload.web_push, 8030);
  assert.equal(payload.notification.title, payload.title);
  assert.equal(payload.notification.body, payload.body);
  assert.equal(payload.notification.navigate, payload.url);
  assert.equal(payload.notification.data.url, payload.url);
  assert.equal(payload.notification.silent, false);
  assert.equal(payload.notification.tag, "polaris-background-1");
  assert.ok(payload.notification.navigate.startsWith(APP_URL));
  assert.match(payload.url, /event=background-1/);
});
test("the worker displays exactly one declarative notification with no open app window or page networking", async () => {
  const w = worker();
  w.self.clients.matchAll = async () => {
    throw Error("push must not require a window");
  };
  await w.push({
    json: () => ({
      web_push: 8030,
      notification: {
        title: "后台测试",
        body: "App 已关闭",
        navigate: APP_URL + "?view=events",
        tag: "declared-tag",
      },
    }),
  });
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, "后台测试");
  assert.equal(w.shown[0].body, "App 已关闭");
  assert.equal(w.shown[0].tag, "declared-tag");
  assert.equal(w.shown[0].silent, false);
  assert.equal(w.shown[0].navigate, APP_URL + "?view=events");
});
test("malformed or unexpected push data still results in a visible notification rather than a silent failure", async () => {
  const w = worker();
  for (const value of [
    null,
    42,
    [],
    { title: "有效标题", url: "http://[" },
    {
      web_push: 8030,
      notification: { title: "声明式标题", navigate: "https://other.example/" },
    },
  ])
    await w.push({ json: () => value });
  await w.push({
    json() {
      throw Error("invalid JSON");
    },
    text: () => "纯文本通知",
  });
  assert.equal(w.shown.length, 6);
  assert.ok(w.shown.every((n) => n.title && n.data.url.startsWith(APP_URL)));
  assert.equal(w.shown.at(-1).body, "纯文本通知");
});
test("notification clicks open the app when a previously listed app window can no longer be navigated", async () => {
  const w = worker();
  w.self.clients.matchAll = async () => [
    {
      url: APP_URL,
      navigate: async () => null,
      focus: async () => {
        throw Error("closed window");
      },
    },
  ];
  let closed = false;
  await w.click({
    data: { url: APP_URL + "?view=events&event=one" },
    close: () => (closed = true),
  });
  assert.equal(closed, true);
  assert.deepEqual(w.opened, [APP_URL + "?view=events&event=one"]);
});
