"""Trigger the existing Site; leave its monitoring logic and storage in place."""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class WatchError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Site:
    def __init__(self, url, token, opener=None):
        parts = urllib.parse.urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname
                or not re.fullmatch(r"[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site", parts.hostname)
                or parts.username or parts.password or parts.port not in (None, 443)
                or parts.path not in ("", "/") or parts.query or parts.fragment):
            raise WatchError("WATCH_SITE_URL must be the HTTPS origin of a Sites website.")
        if not token.strip() or "\n" in token or "\r" in token:
            raise WatchError("WATCH_SITE_TOKEN is missing or invalid.")
        self.origin = f"https://{parts.hostname}"
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, path, body=None):
        if path not in ("/api/state", "/api/tick", "/api/schedule"):
            raise WatchError("Unsupported Site operation.")
        request = urllib.request.Request(
            self.origin + path,
            data=None if body is None else json.dumps(body).encode(),
            method="GET" if body is None else "POST",
            headers={"OAI-Sites-Authorization": "Bearer " + self.token,
                     "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=110) as response:
                if response.status != 200:
                    raise WatchError("Site returned an unexpected HTTP status.")
                if "application/json" not in response.headers.get("Content-Type", ""):
                    raise WatchError("Site did not return JSON; check service access.")
                raw = response.read(2_000_001)
        except urllib.error.HTTPError as error:
            raise WatchError(f"Site HTTP {error.code}; no redirected request was followed.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise WatchError("Site request failed or timed out; not automatically retried.") from None
        if len(raw) > 2_000_000:
            raise WatchError("Site response exceeded the size limit.")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise WatchError("Site returned invalid JSON.") from None
        if not isinstance(result, dict):
            raise WatchError("Site returned an unexpected response shape.")
        if result.get("error"):
            raise WatchError("The Site reported a monitoring error; inspect the Site's settings.")
        return result


def read_status(site):
    state = site.request("/api/state")
    if not isinstance(state.get("movies"), list) or not isinstance(state.get("cinemas"), list):
        raise WatchError("Site status is missing movie or cinema data.")
    if {str(c.get("id")) for c in state["cinemas"]} != {"25769", "39869"}:
        raise WatchError("Site is not configured for the expected two cinemas.")
    return state


def run(site, mode="check", repository="", clock=time.time):
    before = read_status(site)
    if mode == "status":
        return {"outcome": "status", "paused": bool(before.get("paused")),
                "last_success": before.get("lastSuccess"),
                "scheduler_heartbeat": before.get("schedulerHeartbeat"),
                "stars": sum(bool(m.get("active")) for m in before["movies"]),
                "bark_configured": bool(before.get("barkConfigured"))}
    if before.get("paused"):
        return {"outcome": "paused", "note": "Site pause preserved; no tick requested."}
    started = int(clock())
    result = site.request("/api/tick", {"source": "github-actions"})
    if result.get("paused"):
        return {"outcome": "paused", "note": "Site paused monitoring; no automatic resume."}
    if result.get("busy"):
        return {"outcome": "busy", "note": "Another check holds the Site lock."}
    if result.get("cooldown"):
        return {"outcome": "cooldown", "note": "Site cooldown or backoff preserved."}
    checks = result.get("checks")
    if (not isinstance(checks, list) or len(checks) != 2
            or any(not isinstance(c, dict) or not isinstance(c.get("sessions"), int) for c in checks)):
        raise WatchError("Tick did not confirm checks of both cinemas.")
    after = read_status(site)
    if (not isinstance(after.get("lastSuccess"), (int, float))
            or after["lastSuccess"] < started - 2
            or not isinstance(after.get("schedulerHeartbeat"), (int, float))
            or after["schedulerHeartbeat"] < started - 2):
        raise WatchError("Site readback did not confirm a fresh check and scheduler heartbeat.")
    if mode == "configure":
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise WatchError("GITHUB_REPOSITORY is required to record the scheduler.")
        schedule = {"provider": "github-actions", "frequency": "five_minutes",
                    "repository": repository, "workflow": "scheduled-watch.yml"}
        if site.request("/api/schedule", {"schedule": schedule}).get("ok") is not True:
            raise WatchError("Site did not accept scheduler configuration.")
        if read_status(site).get("schedule") != schedule:
            raise WatchError("Site scheduler configuration was not confirmed by readback.")
    return {"outcome": "checked", "cinemas_checked": len(checks),
            "notifications_queued": result.get("newNotifications", 0),
            "bark_configured": bool(after.get("barkConfigured")),
            "last_success": after["lastSuccess"],
            "scheduler_heartbeat": after["schedulerHeartbeat"],
            "scheduler_recorded": mode == "configure"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("check", "status", "configure"), default="check")
    args = parser.parse_args()
    try:
        site = Site(os.environ.get("WATCH_SITE_URL", ""), os.environ.get("WATCH_SITE_TOKEN", ""))
        report = run(site, args.mode, os.environ.get("GITHUB_REPOSITORY", ""))
        output = json.dumps(report, ensure_ascii=False)
        print(output)
        if report["outcome"] == "paused":
            print("::warning::Monitoring is paused in the Site; the scheduler did not resume it.")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a") as stream:
                stream.write("### Scheduled watch\n\n```json\n" + output + "\n```\n")
    except WatchError as error:
        print(f"::error::{error}")
        return 1
    except ValueError:
        print("::error::Watch could not verify the requested operation. Check configuration and Site status.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
