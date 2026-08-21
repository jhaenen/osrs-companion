# osrs-companion

An MCP server for Old School RuneScape that gives AI assistants access to
wiki search, Grand Exchange prices, and your synced player data.

This is a fork of the original [osrs-companion](https://github.com/isaachansen/osrs-companion),
changed to run as a **remote HTTP server** with an authenticated ingest
endpoint, instead of a local stdio process reading files off the same
machine as the RuneLite client. Use this if your RuneLite client and your
MCP server/AI assistant don't run on the same machine. See
[runelite-osrs-companion](https://github.com/isaachansen/runelite-osrs-companion)
(and its fork) for the plugin side.

## Features

- **Wiki Search** — Search the OSRS Wiki for any article
- **Page Summaries** — Get introductory summaries of wiki pages
- **GE Prices** — Look up current Grand Exchange buy/sell prices
- **WikiSync Player Data** — Fetch player data via the WikiSync plugin
- **Synced Player Data** — Read detailed player data merged from the
  companion RuneLite plugin (bank, skills, quests, equipment, inventory,
  diaries, combat achievements) and Wise Old Man (skill xp, boss/activity
  kill counts), with a freshness indicator on every response
- **Progress History** — Query when skill xp, kill counts, quests, diaries,
  and combat achievements last changed, and project time-to-level from a
  recent xp rate

## Architecture

Four logical pieces, three of which live in this repo:

```
RuneLite plugin  --HTTPS + bearer token--\
                                           >-->  osrs-ingest  --shared volume-->  osrs-mcp  --HTTPS + OAuth-->  MCP client
Wise Old Man API  <--HTTPS (poll)--------/       (this repo)                     (this repo)
```

- **`osrs-ingest`** (`src/ingest.ts`) — a small Express service that accepts
  authenticated snapshot pushes from the plugin. This leg is
  machine-to-machine (one trusted plugin instance pushing its own data), so
  it's gated with a single long-lived bearer token rather than a full OAuth
  flow. It also runs the **Wise Old Man poll job** (`src/womPoller.ts`) on a
  timer, since it's the side of this deployment with write access to the
  shared snapshot volume.
- **`osrs-mcp`** (`src/index.ts`) — the MCP server. Reads whatever the merge
  logic below last wrote. Wiki search, summaries, prices, and the WikiSync
  `player` tool are unchanged outbound fetches to public APIs.

### Merging plugin + Wise Old Man data

The RuneLite plugin only reports data while the client is open on a desktop
machine, so it structurally can't see mobile-only play. Wise Old Man reads
the public hiscores, which do reflect mobile play, so it's polled
periodically (`WOM_POLL_INTERVAL_MS`, default 15 minutes) as a second input
into the same snapshot the plugin pushes to - not a separate data source the
AI needs to know about.

Every skill xp value and every boss/activity kill count is merged with
**`merged_value = max(plugin_value, wom_value)`**, never "whichever arrived
most recently" - both are monotonically non-decreasing in normal play, but
WOM's own snapshot timestamp reflects when it happened to check the
hiscores (which only refresh roughly hourly), not when the xp was actually
earned, so a "newer" WOM read can still carry a stale, lower value than what
the plugin already pushed minutes earlier. `get_my_stats` and every history
tool below return one number per metric with no indication of which source
it came from - `source` is recorded in the history tables purely for
debugging, never surfaced by the tools.

Wise Old Man can only ever contribute skill xp/levels and boss/activity kill
counts - bank, inventory, equipment, quests, achievement diaries, and combat
achievements aren't on the public hiscores at all, so the plugin remains the
sole source for all of that regardless of merging.

This is what replaces a separate Wise Old Man MCP connector: rather than an
AI client juggling two servers and deciding which one to ask, there's one
merged source of truth here.

## Running locally (stdio, for Claude Code / Claude Desktop on the same machine)

```bash
npm install
npm run build
npm start
```

Or without building:

```json
{
  "mcpServers": {
    "osrs-companion": {
      "command": "npx",
      "args": ["-y", "tsx", "src/index.ts"]
    }
  }
}
```

In this mode `get_my_*` tools read from `~/.runelite/osrs-companion/`
(override with the `SYNC_DIR` env var), same as upstream.

## Available Tools

### Wiki Tools

| Tool | Description |
|------|-------------|
| `search` | Search the OSRS Wiki for articles |
| `summary` | Get the intro summary of a wiki page |
| `price` | Look up Grand Exchange prices |
| `player` | Fetch player data via WikiSync |

### Player Sync Tools

| Tool | Description |
|------|-------------|
| `list_synced_players` | List players with synced data |
| `get_my_profile` | Full player summary |
| `get_my_bank` | Search bank contents, including Potion Storage (its own clearly-labeled section) |
| `get_my_stats` | Skill levels and XP |
| `get_my_quests` | Quest completion status |
| `get_my_equipment` | Currently equipped items |
| `get_my_inventory` | Current inventory |
| `get_my_diaries` | Achievement diary progress |
| `get_my_combat_achievements` | Combat achievement status |

Every player-sync tool's response includes a `Last Updated` line with how
long ago the snapshot landed (e.g. "2m ago") — treat the data as "recent",
not "live": there's an inherent gap between an in-game change and the
snapshot reaching the server.

### History Tools

Read from local storage only (a small SQLite database alongside the
snapshots) - never a live call to Wise Old Man. A row only exists there
because a genuine change was detected on a plugin push or WOM poll, so an
empty range returns a clean "no changes" message rather than an error.

| Tool | Description |
|------|-------------|
| `skill_xp_gained` | Xp (skill) or kill count (boss/activity) gained over a period |
| `skill_xp_timeline` | Time series of changes for a skill or boss/activity metric |
| `cooking_progress_since` | Projects time to a target Cooking level from a recent xp rate |
| `quest_history` | Quest state changes over a period |
| `diary_history` | Achievement diary tier completions over a period |
| `combat_achievement_history` | Combat achievement task/tier completions over a period |

`skill_xp_gained` and `skill_xp_timeline` accept either a skill name (e.g.
`COOKING`) or a Wise Old Man boss/activity metric name (e.g. `zulrah`,
`clue_scrolls_easy`) - both live in the same merged history, so the same
tools cover both.

## Deploying remotely (Docker + OAuth)

For a shared/remote server, `src/index.ts` switches from stdio to the SDK's
`StreamableHTTPServerTransport` (stateless — a fresh `McpServer` per
request, no session/auth logic in the app) whenever `MCP_TRANSPORT=http` is
set, listening on `PORT` (default `8080`) at `POST /mcp`. The Docker image
sets both by default.

OAuth 2.1 + PKCE (required by the MCP spec for remote servers, and by
clients like claude.ai) is handled by a sidecar,
[`mcp-oauth-proxy`](https://github.com/allardy/mcp-oauth-proxy), sitting in
front of the app container — see `docker-compose.yml`. It terminates the
OAuth flow against your OIDC provider and only forwards already-authorized
requests to `osrs-mcp:8080/mcp`.

### 1. Create the OAuth provider + application

If your OIDC provider (e.g. Authentik, Keycloak, Zitadel) doesn't support
open Dynamic Client Registration (which MCP clients expect), the proxy uses
one pre-created, static client instead:

1. **Provider**: OAuth2/OpenID provider, confidential client type.
   - Redirect URIs: the callback URL of the MCP client you'll actually use
     (e.g. claude.ai's connector callback). If you don't know it yet, try
     connecting once — your provider's logs will show the rejected
     `redirect_uri`, which you can then add. Only whitelist URLs you trust.
   - Scopes: `openid`, `profile`, `email` (add `offline_access` for refresh
     tokens).
   - Note the issuer URL for the application (it should end with `/`, and
     `<issuer>/.well-known/openid-configuration` must resolve).
2. **Application**: bind it to the provider above, and gate it behind
   whatever group/policy mechanism your provider offers (e.g. an
   `mcp-users` group), matching `ALLOW_GROUPS` below.
3. Copy the provider's Client ID / Secret into `.env` as `OAUTH_CLIENT_ID` /
   `OAUTH_CLIENT_SECRET`.

### 2. Configure and run

```bash
cp .env.example .env   # fill in INGEST_TOKEN, and OAuth values if using mcp-oauth-proxy
docker compose up -d --build
```

This starts:

- `osrs-ingest`, published on `INGEST_HOST_PORT` (default `8094`)
- `osrs-mcp`, internal only (reachable through the proxy below)
- `mcp-oauth-proxy`, published on `MCP_HOST_PORT` (default `8096`)

### 3. Wire up your reverse proxy

Point two vhosts at this host:

- One at `osrs-ingest`'s host port — this is what the RuneLite plugin's
  "Ingest URL" config points at (e.g. `https://your-ingest-domain.example/snapshot`).
- One at `mcp-oauth-proxy`'s host port — this is what MCP clients connect
  to (no additional forward-auth needed at the reverse-proxy layer, the
  sidecar proxy already handles auth). Set `MCP_PUBLIC_URL` in `.env` to
  this vhost's URL.

Both should sit behind TLS.

### 4. Connect an MCP client

Add your MCP vhost's URL (the proxy's root — it forwards internally to the
app's `/mcp` path) as a remote MCP server URL in your client. The client
should discover the OAuth metadata automatically (via
`/.well-known/oauth-authorization-server`) and walk you through login.

## Rotating the ingest token

1. Generate a new token: `openssl rand -hex 32`
2. Update `INGEST_TOKEN` in `.env` on the server and restart `osrs-ingest`
   (`docker compose up -d osrs-ingest`)
3. Update the "Ingest Token" field in the RuneLite plugin's config

The old token stops working the moment the server restarts with the new
one — there's no overlap window, so update the plugin config first if you
want to avoid a brief gap in syncing.

## How It Works

The MCP server runs via stdio (local) or Streamable HTTP (remote) transport,
selected by `MCP_TRANSPORT`. Wiki and price tools fetch from public OSRS
APIs. Player sync tools read the latest merged snapshot from `SYNC_DIR`
(default `~/.runelite/osrs-companion/` locally, or a shared volume in the
Docker deployment) - written by `osrs-ingest` on every plugin push, and by
the Wise Old Man poll job on its own timer (see "Merging plugin + Wise Old
Man data" above). History tools read a small SQLite database
(`history.db`) in the same directory, populated only when a merge actually
changes something.

No data is stored in the cloud beyond wherever you deploy this yourself
and whatever Wise Old Man already has via the public hiscores. No API key
is required for `WOM_API_KEY` — it only raises WOM's rate limit, which a
single-player poll every 15+ minutes doesn't come close to needing.

## Attribution

Wiki content returned by the `search` and `summary` tools is sourced from
the [Old School RuneScape Wiki](https://oldschool.runescape.wiki), which is
licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
All wiki tool responses include an attribution notice automatically.

Grand Exchange price data is provided by the
[OSRS Wiki Prices API](https://prices.runescape.wiki). Player data is
fetched via the [WikiSync API](https://sync.runescape.wiki), [Wise Old
Man](https://wiseoldman.net), or read from snapshots pushed by the
companion RuneLite plugin — none of which contain wiki article content.

## License

BSD 2-Clause "Simplified" License. See [LICENSE](LICENSE).
