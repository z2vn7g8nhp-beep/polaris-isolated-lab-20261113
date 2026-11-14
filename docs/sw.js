self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
function notificationTarget(value) {
  const base = new URL("./", self.registration.scope),
    fallback = new URL("?view=events", base);
  try {
    const target = new URL(
      typeof value === "string" ? value : "?view=events",
      base,
    );
    return target.origin === base.origin &&
      target.pathname.startsWith(base.pathname)
      ? target
      : fallback;
  } catch {
    return fallback;
  }
}
function pushMessage(event) {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    try {
      data = { body: event.data?.text() || "" };
    } catch {
      data = {};
    }
  }
  if (typeof data === "string") data = { body: data };
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const proposed =
    data.web_push === 8030 &&
    data.notification &&
    typeof data.notification === "object"
      ? data.notification
      : {};
  const title =
    typeof proposed.title === "string" && proposed.title.trim()
      ? proposed.title
      : typeof data.title === "string" && data.title.trim()
        ? data.title
        : "开票雷达";
  const body =
    typeof proposed.body === "string"
      ? proposed.body
      : typeof data.body === "string"
        ? data.body
        : "你关注的电影有新消息，点开查看。";
  return {
    title,
    body,
    tag:
      typeof data.id === "string"
        ? "polaris-" + data.id
        : typeof proposed.tag === "string"
          ? proposed.tag
          : undefined,
    url: notificationTarget(proposed.navigate || data.url).href,
  };
}
self.addEventListener("push", (event) => {
  // No open window, page timer, local credential or network request is needed.
  // Supporting Safari versions can display the declarative payload themselves
  // if this handler cannot run; older browsers use this same visible path.
  const data = pushMessage(event),
    base = new URL("./", self.registration.scope);
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: new URL("icon-192.png", base).href,
      badge: new URL("icon-192.png", base).href,
      tag: data.tag,
      navigate: data.url,
      lang: "zh-CN",
      silent: false,
      data: { url: data.url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const base = new URL("./", self.registration.scope),
    target = notificationTarget(
      event.notification.data?.url || event.notification.navigate,
    );
  event.waitUntil(
    (async () => {
      for (const client of await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })) {
        const current = new URL(client.url);
        if (
          current.origin === base.origin &&
          current.pathname.startsWith(base.pathname)
        ) {
          try {
            const navigated = await client.navigate(target.href);
            if (navigated) return navigated.focus();
          } catch {}
        }
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
