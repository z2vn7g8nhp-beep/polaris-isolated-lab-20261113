import { pathToFileURL } from "node:url";

// Reuse the established external dispatch of the main workflow. This step
// runs in keepalive, without depending on the movie-monitor job succeeding.
export async function ensureWatchdog({ request, at = Date.now() / 1000 }) {
  const status = await request("/contents/public.json?ref=watchdog-state", { optional: true, raw: true });
  if (Number.isFinite(status?.checkedAt) && at - status.checkedAt < 600) return { triggered: false, reason: "recent" };
  const runs = await request("/actions/workflows/watchdog.yml/runs?per_page=5");
  if (runs.workflow_runs?.some((r) => ["queued", "in_progress", "waiting", "pending", "requested"].includes(r.status) && at - Date.parse(r.created_at) / 1000 < 1800))
    return { triggered: false, reason: "already-running" };
  if (runs.workflow_runs?.some((r) => at - Date.parse(r.created_at) / 1000 < 600))
    return { triggered: false, reason: "recent-attempt" };
  await request("/actions/workflows/watchdog.yml/dispatches", { method: "POST", body: { ref: "main" } });
  return { triggered: true, reason: "stale-or-missing" };
}
async function run() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !token) throw new Error("Watchdog trigger credentials are missing.");
  const request = async (path, { optional = false, raw = false, method = "GET", body } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { method, redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Watchdog fallback HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  console.log(JSON.stringify(await ensureWatchdog({ request })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
