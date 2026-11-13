# Polaris scheduled watch

Independent GitHub Actions scheduler for an existing, owner-only Sites movie-ticket monitor. This repository contains only the scheduler and its tests. The Site, database, Bark settings, movie stars, and notification history remain in Sites.

The workflow requests one check every five minutes. GitHub schedules can be delayed; this is not a guarantee of five-minute delivery. The Site continues to enforce cooldown, backoff, manual pause, and notification deduplication. The previous ChatGPT automation stays disabled.

## Configuration

Repository Actions secrets:

- `WATCH_SITE_URL`: the Site's HTTPS origin.
- `WATCH_SITE_TOKEN`: its supported Sites service-access credential.

The credential is sent only to the configured Site with `OAI-Sites-Authorization`. Redirects are refused. Neither the address nor the credential is included in source or workflow output.

Use **Scheduled watch → Run workflow** for a check, a read-only status check, or to record the verified scheduler in the Site's settings. Status mode does not trigger a check. A paused Site remains paused. Failed checks and unexpected responses fail the job; busy/cooldown/paused results are explicitly reported.

The workflow commits a heartbeat file to this new repository every 25 days, since GitHub can disable scheduled workflows in public repositories after 60 days of inactivity. No other repository is accessed.

## Local verification

```sh
python -m unittest discover -s tests -v
```

Live checks can send the Site's configured Bark notifications. Tests use simulated HTTP responses and do not contact Sites, cinemas, or Bark.

Local reference directories and earlier unrelated investigation files are excluded by `.gitignore` and are not published here.
