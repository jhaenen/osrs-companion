# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repo. This is a
running list of hard-won gotchas from actually building and operating this
service — not a restatement of what's already in the code comments or
README, only things worth knowing *before* you touch related code.

## This repo alone is not "deployed"

The running instance lives on a separate host, reached over SSH, running via
Docker Compose. A local commit — even pushed to `origin/remote-sync` — has
no effect until that host does `git pull --ff-only` and
`docker compose up -d --build`. If you're fixing a live bug, the fix isn't
done until you've redeployed there and re-verified.

**Always verify through the actual MCP tools, not just by reading code or
querying the SQLite file directly.** Multiple bugs this project hit only
became obvious once exercised through the real tool call path - e.g. a
"quantity: 0" hypothesis for a bank bug turned out to be quantity 1 with a
distinct item ID once actually checked; a merge-logic double-count bug was
only visible by calling `skill_xp_gained` for real, not by eyeballing rows.
The pattern that worked repeatedly: spin up `buildServer()` from
`mcpServer.ts` with the MCP SDK's `Client` + `InMemoryTransport.createLinkedPair()`,
call the tool for real, read the actual text response. Cheap, and it catches
things raw data inspection won't.

## node:sqlite (`src/historyStore.ts`) has two easy ways to hurt a live writer

1. **Set `PRAGMA busy_timeout` immediately after opening the connection,
   before any statement that can take a lock** (schema creation included).
   `node:sqlite`'s `DatabaseSync` defaults `busy_timeout` to 0 - any other
   connection to the same file holding a lock at that moment fails
   immediately with `SQLITE_BUSY`/`ERR_SQLITE_ERROR` instead of waiting.
   Opening a connection and setting this pragma are both lock-free
   operations; schema creation isn't. Order matters.
2. **Batch a large write into one transaction** (`runInTransaction` in
   `historyStore.ts`), not one autocommit statement per row. Each
   autocommit INSERT is its own fsync + lock acquire/release; thousands of
   them back-to-back is measured in *minutes* on real disk, which is a long
   window to starve a concurrently-running live writer. Wrapped in a single
   transaction, the same batch drops to milliseconds.

Both of the above were discovered by watching the WOM backfill script
(`src/scripts/womBackfill.ts`) genuinely starve the live ingest process's
writes in production - not hypothetical. If you add another script or job
that touches `history.db`, assume it can run concurrently with the live
poller/ingest process and needs both of these.

## Extending the merge logic (`src/merge.ts`) with a new monotonic metric

`mergeSkills` only writes a history row when a *previous* value existed
(`if (prev && entry.xp > prev.xp)`) - a metric's first-ever appearance in
the snapshot seeds silently. `mergeBossKills` originally defaulted a
missing previous value to `0` and wrote a row unconditionally on increase,
which meant *every* boss/activity metric's first-ever WOM sighting produced
a fake "0 → kc" row - indistinguishable from a real increase, and later
duplicated once a historical backfill correctly dated that same real event
(cost: 23 rows had to be manually identified and deleted from production).

**If you add another field merged via max(), mirror `mergeSkills`': no
history row on first sighting, full stop.** There is no real "previous
value" to diff against the first time a metric shows up, only a baseline.

The same rule applies outside the max()-metric family too: `diffDiaryTasks`
(per-task achievement diary completion, decoded from raw varp/varbit bits
via `getDiaryTaskStatus`) skips diffing entirely when there's no prior
`diaryTaskVarps`/`diaryTaskVarbits` to compare against - not just on a
player's very first sync overall, but also the first sync *after* per-task
diary syncing gets enabled for an existing player. Otherwise a veteran
player's already-completed tasks would all record as "just now" on the
first sync that starts sending the bits.

## Wise Old Man API facts worth not re-deriving

- `GET /players/:username/snapshots` returns a player's **entire** history
  with no implicit time window when `period`/`startDate`/`endDate` are all
  omitted - confirmed against WOM's actual server source, not assumed.
  Paginate via `limit` (max 200, enforced server-side) and `offset`.
  Ordered newest-first.
- Unauthenticated rate limit is 20 req/60s (100/60s with `WOM_API_KEY`).
- The force-update endpoint (`POST /players/:username`) has a per-player
  cooldown (~60s) - failures there should be treated as best-effort, never
  block the read that follows.
- WOM's `overall` skill entry is deliberately excluded from merging
  (`extractMergeableMetricsFromData` in `womClient.ts`) - it's a derived
  sum, and the plugin already owns computing its own `OVERALL` entry.

## Tool output: never hide a quantity, even at exactly 1

Bank/inventory-style tool responses (`get_my_bank`, etc.) are filtered to
`quantity > 0` upstream. Given that invariant, hiding the quantity for
`quantity === 1` (a previous "don't show x1" convention, meant to mirror
how the game itself doesn't overlay a count on single-item stacks) makes a
real held item textually indistinguishable from a phantom/placeholder
entry - and it caused exactly that false-alarm bug report once already.
Always print the quantity explicitly in list-style tool output.
