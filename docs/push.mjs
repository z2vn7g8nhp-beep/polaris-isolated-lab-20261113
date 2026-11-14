import { connected, api } from "./client.mjs?v=audit-1";

const registration =
  "serviceWorker" in navigator
    ? navigator.serviceWorker.register("./sw.js", { scope: "./" })
    : Promise.resolve(null);
registration.catch(() => {});
export function pushSupport() {
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  return {
    ios,
    standalone,
    supported:
      "Notification" in window &&
      "PushManager" in window &&
      "serviceWorker" in navigator,
    permission:
      "Notification" in window ? Notification.permission : "unsupported",
  };
}
function bytes(value) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
export async function enablePhonePush(name, { renew = false } = {}) {
  if (!connected()) throw new Error("请先在此页面连接 GitHub，再启用手机通知");
  const support = pushSupport();
  if (support.ios && !support.standalone)
    throw new Error("请先将网站添加到主屏幕，再从桌面图标打开并启用通知");
  if (!support.supported)
    throw new Error(
      "当前浏览器不支持系统通知。iPhone 请使用 iOS 16.4 以上的主屏幕网页版",
    );
  // Request permission directly from the user's click, before any network await.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("尚未允许通知，请在系统通知设置中允许这个网页发送通知");
  await registration;
  const worker = await navigator.serviceWorker.ready;
  const response = await fetch("./data/push-key.json", {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("通知服务尚未就绪，请稍后刷新重试");
  const { publicKey } = await response.json();
  const existing = await worker.pushManager.getSubscription();
  const wanted = bytes(publicKey),
    current = existing?.options?.applicationServerKey;
  const sameKey =
    !current ||
    (new Uint8Array(current).length === wanted.length &&
      new Uint8Array(current).every((v, i) => v === wanted[i]));
  let subscription = existing;
  if (!existing || renew || !sameKey) {
    if (existing) await existing.unsubscribe();
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wanted,
    });
  }
  return api("push", {
    subscription: subscription.toJSON(),
    name,
    previousEndpoint: existing?.endpoint,
    renew,
  });
}
export async function disablePhonePush() {
  const result = await api("push/remove", {});
  try {
    const worker = await registration;
    const subscription = await worker?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    window.dispatchEvent(
      new CustomEvent("polaris-notice", {
        detail:
          "本机通知停用配置已保存；本地订阅清理暂未完成，后台应用后停止发送。",
      }),
    );
  }
  return result;
}
