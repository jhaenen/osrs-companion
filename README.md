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
- **Synced Player Data** — Read detailed player data pushed by the companion
  RuneLite plugin (bank, skills, quests, equipment, inventory, diaries,
  combat achievements), with a freshness indicator on every response

## Architecture

Three pieces, two of which live in this repo:

```
RuneLite plugin  --HTTPS + bearer token-->  osrs-ingest  --shared volume-->  osrs-mcp  --HTTPS + OAuth-->  MCP client
                                             (this repo)                     (this repo)
```

- **`osrs-ingest`** (`src/ingest.ts`) — a small Express service that accepts
  authenticated snapshot pushes from the plugin and stores the latest one
  per player. This leg is machine-to-machine (one trusted plugin instance
  pushing its own data), so it's gated with a single long-lived bearer
  token rather than a full OAuth flow.
- **`osrs-mcp`** (`src/index.ts`) — the MCP server. Reads whatever
  `osrs-ingest` last wrote. Wiki search, summaries, prices, and the
  WikiSync `player` tool are unchanged outbound fetches to public APIs.

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
| `get_my_bank` | Search bank contents |
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
APIs. Player sync tools read the latest snapshot written by `osrs-ingest`
from `SYNC_DIR` (default `~/.runelite/osrs-companion/` locally, or a shared
volume in the Docker deployment).

No data is stored in the cloud beyond wherever you deploy this yourself. No
API keys required for the wiki/price tools.

## Attribution

Wiki content returned by the `search` and `summary` tools is sourced from
the [Old School RuneScape Wiki](https://oldschool.runescape.wiki), which is
licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).
All wiki tool responses include an attribution notice automatically.

Grand Exchange price data is provided by the
[OSRS Wiki Prices API](https://prices.runescape.wiki). Player data is
fetched via the [WikiSync API](https://sync.runescape.wiki) or read from
snapshots pushed by the companion RuneLite plugin — neither contains wiki
article content.

## License

BSD 2-Clause "Simplified" License. See [LICENSE](LICENSE).
