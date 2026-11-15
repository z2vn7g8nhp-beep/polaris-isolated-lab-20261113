import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRuntime } from "./storage.mjs";
import { notify, crypt } from "./monitor.mjs";
import { keyBytes, unseal, seal, openPreferences } from "../docs/crypto.mjs";
import { normalizeNotificationPrefs, notificationDue } from "../docs/planner-model.mjs";

const get = (env, key, fallback = null) => {
  const row = env.db.prepare("SELECT value FROM radar_kv WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : fallback;
};
const put = (env, key, value) => env.db.prepare("INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
export function heartbeatHealth({ lastSuccess, heartbeat, firstSeenAt, thresholdMinutes, enabled, manuallyPaused }, at = Date.now() / 1000) {
  if (!enabled) return { kind: "disabled", ageMinutes: 0 };
  if (manuallyPaused) return { kind: "paused", ageMinutes: 0 };
  const anchor = lastSuccess || heartbeat || firstSeenAt || at;
  const ageMinutes = Math.max(0, (at - anchor) / 60);
  return { kind: ageMinutes >= thresholdMinutes ? "outage" : lastSuccess ? "healthy" : "waiting", ageMinutes };
}
export async function checkWatchdog({ env, prefs, previous = {}, at = Date.now() / 1000, sender = notify }) {
  const config = normalizeNotificationPrefs(prefs.notificationPrefs);
  const state = structuredClone(previous);
  state.firstSeenAt ||= at;
  state.receipts ||= {};
  let mode = prefs.notificationMode || get(env, "notification_mode") || (get(env, "push_subscription") ? "push" : get(env, "bark") ? "bark" : "off");
  if (!["push", "bark", "off"].includes(mode)) throw new Error("通知渠道格式无效");
  const pendingControl = prefs.control && prefs.control.id !== get(env, "last_control");
  const manuallyPaused = pendingControl ? prefs.control.action === "pause" : String(get(env, "paused", "") || "").startsWith("你已手动暂停");
  const lastSuccess = get(env, "last_success"), heartbeat = get(env, "scheduler_heartbeat");
  const health = heartbeatHealth({ lastSuccess, heartbeat, firstSeenAt: state.firstSeenAt, thresholdMinutes: config.watchdogMinutes, enabled: config.watchdogEnabled, manuallyPaused }, at);
  if (["disabled", "paused"].includes(health.kind)) state.incident = null;
  put(env, "notification_mode", mode);
  if (prefs.pushDevices) {
    const prior = get(env, "push_devices", []) || [], revoked = get(env, "revoked_devices", []);
    put(env, "push_devices", prefs.pushDevices.map((d) => ({ ...prior.find((old) => old.registration === d.registration), ...d, ...(revoked.includes(d.registration) ? { expired: true } : {}) })));
  } else if (Object.hasOwn(prefs, "pushSubscription")) put(env, "push_subscription", prefs.pushSubscription);
  if (mode === "bark" && Object.hasOwn(prefs, "barkKey")) {
    if (prefs.barkKey === null) { mode = "off"; put(env, "notification_mode", "off"); }
    else if (typeof prefs.barkKey === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(prefs.barkKey)) put(env, "bark", await crypt(env, prefs.barkKey));
    else throw new Error("Bark 配置格式无效");
  }
  const notificationConfigured = mode !== "off";
  let notificationError = null;
  if (health.kind === "outage" && (!state.incident || state.incident.phase === "recovery"))
    state.incident = { id: "watchdog-" + crypto.randomUUID(), phase: "outage", channel: mode, legacyEndpoint: get(env, "push_subscription")?.endpoint || null, detectedAt: at, alertAcceptedAt: null };
  let incident = state.incident;
  const alertReceipts = incident ? state.receipts[incident.id] || [] : [];
  if (health.kind === "healthy" && incident) {
    if (incident.alertAcceptedAt || alertReceipts.length) {
      incident.phase = "recovery";
      incident.recoveryDetectedAt ||= at;
      incident.recoveryRecipients ||= [...alertReceipts];
      // A newly selected channel or device must not receive recovery for an
      // outage it never received. Removed devices are no longer contacted.
      if ((incident.channel && incident.channel !== mode) ||
          (incident.legacyEndpoint && get(env, "push_subscription")?.endpoint !== incident.legacyEndpoint)) state.incident = null;
    } else state.incident = null;
  }
  incident = state.incident;
  const recovery = health.kind === "healthy" && incident?.phase === "recovery";
  const alert = health.kind === "outage" && incident && !incident.alertAcceptedAt;
  if ((alert || recovery) && notificationConfigured) {
    const id = recovery ? incident.id + "-recovery" : incident.id;
    const createdAt = recovery ? incident.recoveryDetectedAt : incident.detectedAt;
    const plan = notificationDue({ kind: "watchdog", created_at: createdAt }, {}, config, at);
    if (plan.due <= at) {
      const allDevices = get(env, "push_devices");
      const targeted = recovery && mode === "push" && Array.isArray(allDevices);
      const recipients = targeted ? allDevices.filter((d) => !d.expired && incident.recoveryRecipients.includes(d.registration)) : null;
      if (targeted && !recipients.length) state.incident = null;
      else {
        put(env, "delivery_" + id, state.receipts[id] || []);
        if (targeted) put(env, "push_devices", recipients);
        try {
          await sender(env, recovery ? "开票雷达 · 检查已恢复" : "开票雷达 · 检查长时间未更新", recovery ? "影院检查已恢复成功。打开监测与推送查看最新检查时间。" : `已约 ${Math.floor(health.ageMinutes)} 分钟没有成功完成检查。独立任务检测到失联，请打开监测与推送查看状态。`, id, false, null, id, "settings");
          if (recovery) { state.lastRecoveryAt = at; state.incident = null; }
          else { incident.alertAcceptedAt = at; state.lastAlertAt = at; }
        } catch { notificationError = "部分设备推送失败，下次独立检查会跳过已接收设备并重试"; }
        finally {
          state.receipts[id] = get(env, "delivery_" + id, []);
          if (targeted) {
            const updated = get(env, "push_devices", []);
            put(env, "push_devices", allDevices.map((d) => updated.find((u) => u.registration === d.registration) || d));
          }
        }
      }
    }
  }
  const receiptIds = Object.keys(state.receipts);
  for (const id of receiptIds.slice(0, Math.max(0, receiptIds.length - 12))) delete state.receipts[id];
  return { state, publicStatus: { checkedAt: at, health: health.kind, lastSuccess, thresholdMinutes: config.watchdogMinutes, incidentActive: health.kind === "outage", alertAcceptedAt: state.lastAlertAt || null, recoveryAcceptedAt: state.lastRecoveryAt || null, notificationConfigured, notificationError } };
}

async function run() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, master = process.env.STATE_MASTER_KEY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !token || !master) throw new Error("Watchdog runtime secrets are not configured.");
  async function github(path, body, method = body === undefined ? "GET" : "POST", missing = false, raw = false) {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { method, redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Watchdog storage HTTP ${response.status}`);
    return response.json();
  }
  const content = (path, branch) => github(`/contents/${path}?ref=${branch}`, undefined, "GET", true, true);
  const snapshot = await content("backend.enc.json", "monitor-state");
  if (!snapshot) throw new Error("Monitor snapshot is unavailable; refusing to infer an outage from missing storage.");
  const envelope = await content("preferences.enc.json", "preferences");
  if (!envelope) { console.log("No personal notification configuration yet."); return; }
  const runtime = await createRuntime({ master, identity: JSON.parse(readFileSync("bootstrap/identity.enc.json", "utf8")), snapshot, path: ".runtime/watchdog.sqlite" });
  try {
    const { prefs } = await openPreferences(envelope, runtime.secrets.privateKey), key = await keyBytes(master, "watchdog");
    const saved = await content("watchdog.enc.json", "watchdog-state"), previous = saved ? await unseal(saved, key) : {};
    const output = await checkWatchdog({ env: runtime.env, prefs, previous });
    const files = { "watchdog.enc.json": await seal(output.state, key), "public.json": output.publicStatus }, tree = [];
    for (const [path, value] of Object.entries(files)) {
      const blob = await github("/git/blobs", { content: JSON.stringify(value), encoding: "utf-8" });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const built = await github("/git/trees", { tree });
    const commit = await github("/git/commits", { message: "Update independent watchdog snapshot", tree: built.sha, parents: [] });
    const ref = await github("/git/ref/heads/watchdog-state", undefined, "GET", true);
    if (ref) await github("/git/refs/heads/watchdog-state", { sha: commit.sha, force: true }, "PATCH");
    else await github("/git/refs", { ref: "refs/heads/watchdog-state", sha: commit.sha });
    console.log(JSON.stringify(output.publicStatus));
  } finally { runtime.env.db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
