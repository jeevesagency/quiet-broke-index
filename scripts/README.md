# scripts/

## sub-count.mjs

Read-only probe that records the current Henry Finance Substack subscriber counts
(total / free / paid) so we can track the delta over time.

### What it does

1. Verifies the `substack-jimmy` Chrome profile is not already in use. If it is,
   prints `{"error":"profile in use"}` and exits with code `2` — it will not
   disturb whatever other automation is running.
2. Spawns Chrome 147 (system Chrome.app, *not* bundled Chromium) against
   `/Users/mike/.playwright-profiles/substack-jimmy` with CDP on port **9334**
   (publish.mjs uses 9333 so they can coexist).
3. Connects via Playwright `connectOverCDP`.
4. Loads `https://henryfinance.substack.com/publish/home` so the SPA bootstraps
   (read-only — no clicks, no draft access, no settings touched).
5. Calls `GET /api/v1/publish-dashboard/summary-v2?range=365` from inside the
   page (cookies reused from the profile).
6. Extracts `totalSubscribersEnd` and `paidSubscribersEnd`. Computes free as
   `total - paid`.
7. Prints a pretty JSON object to stdout *and* appends a single-line JSON
   record to `../data/sub-history.jsonl`.
8. Closes the browser and cleans up `SingletonLock` / `SingletonCookie` /
   `SingletonSocket` so the next run starts clean.

### Output schema

```json
{
  "timestamp": "2026-05-14T02:46:02.260Z",
  "total": 220,
  "free": 220,
  "paid": 0,
  "source": "stats-api",
  "sourceUrl": "https://henryfinance.substack.com/api/v1/publish-dashboard/summary-v2?range=365"
}
```

### Usage

```bash
# One-off run
node ~/projects/quiet-broke-index/scripts/sub-count.mjs

# With debug logging (prints the raw summary-v2 response to stderr)
SUB_COUNT_DEBUG=1 node ~/projects/quiet-broke-index/scripts/sub-count.mjs

# View history
cat ~/projects/quiet-broke-index/data/sub-history.jsonl

# Compute current delta vs. baseline (first line)
jq -s '
  (.[0]) as $first | (.[-1]) as $last |
  { from: $first.timestamp, to: $last.timestamp,
    total_delta: ($last.total - $first.total),
    free_delta:  ($last.free  - $first.free),
    paid_delta:  ($last.paid  - $first.paid) }
' ~/projects/quiet-broke-index/data/sub-history.jsonl
```

### Exit codes

- `0` — success
- `1` — error (Chrome failed to start, API request failed, auth missing, etc.)
- `2` — profile in use; another automation owns the Chrome session

### Endpoint notes

The underlying API was discovered by watching network traffic on
`/publish/home`. Two endpoints surface the count:

- `/api/v1/publish-dashboard/summary-v2?range=365` — used by this script.
  Returns `totalSubscribersEnd` and `paidSubscribersEnd` (integers). The
  `range` query param controls the window; only the `End` values represent
  "right now".
- `/api/v1/publish-dashboard/summary` — older shape, returns `totalEmail` and
  `appSubscribers` but no clean paid breakdown.
- `/api/v1/subscriber-stats` — per-row data; the `total_count` field on each
  row also reflects the publication total but the payload is much larger.

If the `summary-v2` endpoint ever changes shape, set `SUB_COUNT_DEBUG=1` and
re-inspect.

### Scheduling (manual)

To measure a 7-day delta, run the script once per day. Example launchd or
cron entry:

```
30 9 * * *  /usr/local/bin/node /Users/mike/projects/quiet-broke-index/scripts/sub-count.mjs >> /Users/mike/projects/quiet-broke-index/data/sub-count.log 2>&1
```

Do not schedule it for a time when other Substack automations are likely to
own the `substack-jimmy` profile (e.g., the engagement_actions pipeline).
The script exits cleanly with code `2` in that case, but you'll miss a
data point.

### Guardrails

- Read-only. Never posts, drafts, or modifies settings.
- Uses system Chrome 147, not bundled Chromium.
- Will not kill an in-use profile; it backs off instead.
