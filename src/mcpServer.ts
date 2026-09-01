import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSyncedPlayers, readSnapshot, SYNC_DIR } from "./snapshotStore.js";
import { getMetricGain, getMetricHistory, getStateHistory } from "./historyStore.js";
import { xpForLevel, formatDuration } from "./osrsXp.js";
import type { PlayerSyncData } from "./schema.js";
import { getDiaryTaskStatus, listDiaryRegions } from "./diaryTasks.js";

const EPOCH = new Date(0).toISOString();

// Resolves a user-supplied metric name to the internal history key. Skills
// are matched case-insensitively against synced skill names; anything else
// falls back to a boss/activity kill-count lookup (WOM's metric names are
// lowercase, e.g. "zulrah", "clue_scrolls_easy"). Deliberately source-
// agnostic - the caller can't tell and doesn't need to know whether a given
// metric's current value most recently moved via the plugin or WOM.
function resolveMetric(
  data: PlayerSyncData,
  metric: string
): { key: string; label: string; kind: "skill" | "kc"; current: number } | null {
  const upper = metric.toUpperCase();
  if (data.skills?.[upper]) {
    return { key: `skill:${upper}`, label: upper, kind: "skill", current: data.skills[upper].xp };
  }
  const lower = metric.toLowerCase();
  if (data.bossKills?.[lower] !== undefined) {
    return { key: `kc:${lower}`, label: lower, kind: "kc", current: data.bossKills[lower] };
  }
  return null;
}

function metricNotFoundMessage(username: string, metric: string, data: PlayerSyncData): string {
  const skills = Object.keys(data.skills ?? {}).join(", ") || "none synced";
  const bossKills = Object.keys(data.bossKills ?? {}).join(", ") || "none synced";
  return `Metric "${metric}" not found for "${username}".\nAvailable skills: ${skills}\nAvailable boss/activity metrics: ${bossKills}`;
}

// ── Types ──────────────────────────────────────────────────────────────

interface WikiSearchItem {
  title: string;
  snippet: string;
  pageid: number;
}

interface WikiSearchResponse {
  query?: {
    search?: WikiSearchItem[];
  };
}

interface WikiPage {
  title: string;
  pageid: number;
  missing?: boolean;
  extract?: string;
}

interface WikiPageResponse {
  query?: {
    pages?: WikiPage[];
  };
}

interface WikiItemMapping {
  [itemId: string]: string;
}

interface PriceData {
  high?: number;
  highTime?: number;
  low?: number;
  lowTime?: number;
}

interface PriceResponse {
  data?: {
    [itemId: string]: PriceData;
  };
}

// ── Constants ──────────────────────────────────────────────────────────

const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";
const USER_AGENT = "osrs-companion/1.0 (Node.js; github.com/isaachansen/osrs-companion)";
const WIKI_ATTRIBUTION = "\n\n---\nContent from the [Old School RuneScape Wiki](https://oldschool.runescape.wiki), licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).";

// ── Wiki / Price Helpers ────────────────────────────────────────────────

function pageUrl(title: string): string {
  return `https://oldschool.runescape.wiki/w/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

async function wikiFetch<T>(params: Record<string, string>): Promise<T> {
  const url = `${WIKI_API}?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Wiki API returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function pricesFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${PRICES_API}/${path}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Prices API returned ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Item Mapping Cache ──────────────────────────────────────────────────

let itemMappingCache: WikiItemMapping | null = null;
let itemMappingExpiry = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getItemMapping(): Promise<WikiItemMapping> {
  if (itemMappingCache && Date.now() < itemMappingExpiry) {
    return itemMappingCache;
  }
  const data = await pricesFetch<WikiItemMapping>("mapping");
  const mapping: WikiItemMapping = {};
  if (Array.isArray(data)) {
    for (const item of data as Array<{ id: number; name: string }>) {
      mapping[String(item.id)] = item.name;
    }
  }
  itemMappingCache = mapping;
  itemMappingExpiry = Date.now() + CACHE_TTL;
  return mapping;
}

async function findItemId(name: string): Promise<string | null> {
  const mapping = await getItemMapping();
  const lower = name.toLowerCase();
  for (const [id, itemName] of Object.entries(mapping)) {
    if (itemName.toLowerCase() === lower) return id;
  }
  for (const [id, itemName] of Object.entries(mapping)) {
    if (itemName.toLowerCase().includes(lower)) return id;
  }
  return null;
}

function formatTimeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Synced snapshots come from a push over the network now rather than a
// same-machine file read, so callers should be told how stale the data
// might be rather than treating it as guaranteed-live.
function freshnessLine(lastUpdated: string): string {
  const then = new Date(lastUpdated).getTime();
  if (Number.isNaN(then)) {
    return `Last Updated: ${lastUpdated}`;
  }
  const diffSeconds = Math.floor((Date.now() - then) / 1000);
  const ago =
    diffSeconds < 5
      ? "just now"
      : diffSeconds < 60
        ? `${diffSeconds}s ago`
        : diffSeconds < 3600
          ? `${Math.floor(diffSeconds / 60)}m ago`
          : diffSeconds < 86400
            ? `${Math.floor(diffSeconds / 3600)}h ago`
            : `${Math.floor(diffSeconds / 86400)}d ago`;
  return `Last Updated: ${lastUpdated} (${ago})`;
}

// ── WikiSync Player Cache ───────────────────────────────────────────────

const playerDataCache: Record<string, { data: Record<string, unknown>; fetchedAt: number }> = {};

async function fetchWikiSyncPlayer(
  username: string,
  forceRefresh = false
): Promise<{ data: Record<string, unknown> | null; message?: string }> {
  const now = Date.now();
  const cache = playerDataCache[username];
  if (cache && !forceRefresh && now - cache.fetchedAt < 3600_000) {
    return { data: cache.data };
  }
  const url = `https://sync.runescape.wiki/runelite/player/${encodeURIComponent(username)}/STANDARD`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) {
      return { data: null, message: `WikiSync API returned ${resp.status}` };
    }
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data || Object.keys(data).length === 0) {
      return {
        data: null,
        message:
          "No player data found. Ensure the username is correct and you have the WikiSync plugin installed in RuneLite.",
      };
    }
    playerDataCache[username] = { data, fetchedAt: now };
    return { data };
  } catch (err) {
    return { data: null, message: `Error: ${err instanceof Error ? err.message : "Unknown error"}` };
  }
}

// ── MCP Server ──────────────────────────────────────────────────────────

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "osrs-mcp-companion",
    version: "1.0.0",
  });

  // ── Wiki Tools ──────────────────────────────────────────────────────

  server.tool(
    "search",
    "Search the Old School RuneScape Wiki for articles matching a query",
    {
      query: z.string().describe("Search query (e.g. 'dragon scimitar', 'Zulrah')"),
      limit: z.number().min(1).max(50).default(10).describe("Max results (1-50)"),
    },
    async ({ query, limit }) => {
      const data = await wikiFetch<WikiSearchResponse>({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: String(limit),
      });

      const results = data.query?.search ?? [];
      if (!results.length) {
        return { content: [{ type: "text", text: `No results found for "${query}"` }] };
      }

      const lines = results.map((item, i) => {
        const snippet = stripHtml(item.snippet);
        return `${i + 1}. **${item.title}**\n   ${snippet}\n   ${pageUrl(item.title)}`;
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} results:\n\n${lines.join("\n\n")}${WIKI_ATTRIBUTION}` }],
      };
    }
  );

  server.tool(
    "summary",
    "Get the introductory summary of an OSRS Wiki page",
    {
      title: z.string().describe("Exact page title (e.g. 'Abyssal whip', 'Farming')"),
    },
    async ({ title }) => {
      const data = await wikiFetch<WikiPageResponse>({
        action: "query",
        prop: "extracts",
        exintro: "1",
        explaintext: "1",
        formatversion: "2",
        titles: title,
      });

      const page = data.query?.pages?.[0];
      if (!page || page.missing) {
        return { content: [{ type: "text", text: `Page not found: "${title}"` }] };
      }

      const extract = page.extract?.trim();
      if (!extract) {
        return { content: [{ type: "text", text: `No summary available for "${page.title}"` }] };
      }

      return {
        content: [{ type: "text", text: `# ${page.title}\n\n${extract}\n\n${pageUrl(page.title)}${WIKI_ATTRIBUTION}` }],
      };
    }
  );

  server.tool(
    "price",
    "Look up the current Grand Exchange price for an item",
    {
      item: z.string().describe("Item name (e.g. 'Abyssal whip', 'Dragon bones')"),
    },
    async ({ item }) => {
      const itemId = await findItemId(item);
      if (!itemId) {
        return { content: [{ type: "text", text: `Item not found: "${item}". Try the exact in-game name.` }] };
      }

      const data = await pricesFetch<PriceResponse>(`latest?id=${itemId}`);
      const price = data.data?.[itemId];
      if (!price) {
        return { content: [{ type: "text", text: `No price data available for "${item}"` }] };
      }

      const mapping = await getItemMapping();
      const name = mapping[itemId] ?? item;

      const lines = [`# ${name} — Grand Exchange Price`];
      if (price.high != null) {
        const ago = price.highTime ? ` (${formatTimeAgo(price.highTime)})` : "";
        lines.push(`Buy (instant): ${price.high.toLocaleString()} gp${ago}`);
      }
      if (price.low != null) {
        const ago = price.lowTime ? ` (${formatTimeAgo(price.lowTime)})` : "";
        lines.push(`Sell (instant): ${price.low.toLocaleString()} gp${ago}`);
      }
      lines.push("", pageUrl(name));

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "player",
    "Fetch RuneLite player data via the WikiSync plugin (requires RuneLite client)",
    {
      username: z.string().describe("RuneLite username"),
      forceRefresh: z.boolean().default(false).describe("Force refresh cached data"),
    },
    async ({ username, forceRefresh }) => {
      if (!username.trim()) {
        return { content: [{ type: "text", text: "Please provide a RuneLite username." }] };
      }
      const { data, message } = await fetchWikiSyncPlayer(username, forceRefresh);
      if (!data) {
        return { content: [{ type: "text", text: message ?? "No player data found." }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `# ${username} — Player Data (via WikiSync)\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
          },
        ],
      };
    }
  );

  // ── Player Sync Tools (reads snapshots pushed by the plugin) ────────

  server.tool(
    "list_synced_players",
    "List all players that have synced data from RuneLite. Use this first to find available usernames.",
    {},
    async () => {
      const players = await listSyncedPlayers();
      if (players.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No synced players found. Make sure the OSRS MCP Companion RuneLite plugin is running and configured to push to this server, and that you've logged in.\n\nSnapshot directory: ${SYNC_DIR}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `Synced players: ${players.join(", ")}` }] };
    }
  );

  server.tool(
    "get_my_profile",
    "Get a full summary of synced player data including stats, quest count, bank size, and diary progress. Data is pushed from RuneLite via the companion plugin.",
    {
      username: z.string().describe("Player username"),
    },
    async ({ username }) => {
      const data = await readSnapshot(username);
      if (!data) {
        const players = await listSyncedPlayers();
        const hint = players.length > 0 ? ` Available players: ${players.join(", ")}` : "";
        return {
          content: [
            {
              type: "text",
              text: `No synced data found for "${username}".${hint}\n\nMake sure the OSRS MCP Companion RuneLite plugin is running and has pushed data.`,
            },
          ],
        };
      }

      const lines: string[] = [`# ${data.player.username} — Synced Profile`];
      lines.push(`Combat Level: ${data.player.combatLevel} | World: ${data.player.world}`);
      lines.push(freshnessLine(data.lastUpdated));

      if (data.skills) {
        const totalLevel =
          data.skills.OVERALL?.level ??
          Object.values(data.skills).reduce((sum, s) => sum + s.level, 0);
        lines.push(`\n## Skills — Total Level: ${totalLevel}`);
        for (const [skill, entry] of Object.entries(data.skills)) {
          if (skill === "OVERALL") continue;
          lines.push(`  ${skill}: ${entry.level} (${entry.xp.toLocaleString()} xp)`);
        }
      }

      if (data.quests) {
        const finished = data.quests.filter((q) => q.state === "FINISHED").length;
        const inProgress = data.quests.filter((q) => q.state === "IN_PROGRESS").length;
        const notStarted = data.quests.filter((q) => q.state === "NOT_STARTED").length;
        lines.push(
          `\n## Quests — ${finished} complete, ${inProgress} in progress, ${notStarted} not started`
        );
      }

      if (data.bank) {
        lines.push(
          `\n## Bank — ${data.bank.totalItems} unique items across ${data.bank.tabs.length} tabs`
        );
      }

      if (data.achievementDiaries) {
        lines.push("\n## Achievement Diaries");
        for (const [region, diary] of Object.entries(data.achievementDiaries)) {
          const tiers = [
            diary.easy ? "Easy" : null,
            diary.medium ? "Medium" : null,
            diary.hard ? "Hard" : null,
            diary.elite ? "Elite" : null,
          ].filter(Boolean);
          lines.push(
            `  ${region}: ${tiers.length > 0 ? tiers.join(", ") : "None complete"}`
          );
        }
      }

      if (data.combatAchievements) {
        const ca = data.combatAchievements;
        lines.push(`\n## Combat Achievements — ${ca.completedTasks.length} tasks complete`);
        lines.push(
          `  Easy: ${ca.easyComplete ? "Done" : "Incomplete"} | Medium: ${ca.mediumComplete ? "Done" : "Incomplete"} | Hard: ${ca.hardComplete ? "Done" : "Incomplete"} | Elite: ${ca.eliteComplete ? "Done" : "Incomplete"}`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_bank",
    "Search and browse the player's synced bank contents, including Potion Storage (shown as its own clearly-labeled section, never mixed into the numbered bank tabs since it's a separate storage location). Supports filtering by item name, bank tab, and minimum quantity.",
    {
      username: z.string().describe("Player username"),
      search: z.string().optional().describe("Search term to filter items by name (case-insensitive)"),
      tab: z.number().optional().describe("Bank tab number to filter (0-indexed). Does not affect Potion Storage, which has no tab of its own."),
      minQuantity: z.number().optional().describe("Only show items with at least this quantity"),
    },
    async ({ username, search, tab, minQuantity }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.bank?.tabs && !data.potionStorage) {
        return {
          content: [{ type: "text", text: `No bank data synced for "${username}". Open your bank in-game to sync.` }],
        };
      }

      // Defense in depth: a real bank entry should never have quantity <=
      // 0. The known cause (bank placeholders) is filtered at the plugin
      // source now, but this guards against any other stray zero/missing-
      // quantity row reaching here without one showing up as a phantom item.
      let allItems = (data.bank?.tabs ?? [])
        .flatMap((t) => t.items.map((item) => ({ ...item, tab: t.tabIndex })))
        .filter((item) => (item.quantity ?? 0) > 0);

      let potionItems = (data.potionStorage ?? []).filter((item) => (item.quantity ?? 0) > 0);

      if (search) {
        const term = search.toLowerCase();
        allItems = allItems.filter((item) => (item.name ?? "").toLowerCase().includes(term));
        potionItems = potionItems.filter((item) => (item.name ?? "").toLowerCase().includes(term));
      }
      if (tab !== undefined) {
        allItems = allItems.filter((item) => item.tab === tab);
      }
      if (minQuantity !== undefined) {
        allItems = allItems.filter((item) => item.quantity >= minQuantity);
        potionItems = potionItems.filter((item) => item.quantity >= minQuantity);
      }

      if (allItems.length === 0 && potionItems.length === 0) {
        return { content: [{ type: "text", text: `No matching items found in ${username}'s bank.` }] };
      }

      const lines: string[] = [
        `# ${username}'s Bank — ${allItems.length + potionItems.length} items found`,
        freshnessLine(data.lastUpdated),
      ];
      // Always show the quantity, even at exactly 1: this list is filtered
      // to quantity > 0 upstream, so an item with no quantity shown at all
      // reads as indistinguishable from a phantom/placeholder entry - which
      // is exactly the false alarm a hidden "x1" caused once already.
      for (const item of allItems) {
        lines.push(`  [Tab ${item.tab}] ${item.name} x${item.quantity.toLocaleString()} (ID: ${item.itemId})`);
      }
      if (potionItems.length > 0) {
        lines.push("", "## Potion Storage");
        for (const item of potionItems) {
          lines.push(`  ${item.name} x${item.quantity.toLocaleString()} (${item.doses.toLocaleString()} doses, ID: ${item.itemId})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_stats",
    "Get the player's synced skill levels and XP. Optionally filter to a specific skill.",
    {
      username: z.string().describe("Player username"),
      skill: z.string().optional().describe("Specific skill name (e.g. 'ATTACK', 'MINING'). Omit for all skills."),
    },
    async ({ username, skill }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.skills) {
        return { content: [{ type: "text", text: `No skill data synced for "${username}".` }] };
      }

      if (skill) {
        const key = skill.toUpperCase();
        const entry = data.skills[key];
        if (!entry) {
          return {
            content: [
              { type: "text", text: `Skill "${skill}" not found. Available: ${Object.keys(data.skills).join(", ")}` },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `# ${username} — ${key}\n${freshnessLine(data.lastUpdated)}\nLevel: ${entry.level}\nXP: ${entry.xp.toLocaleString()}`,
            },
          ],
        };
      }

      const lines: string[] = [`# ${username}'s Skills`, freshnessLine(data.lastUpdated)];
      for (const [name, entry] of Object.entries(data.skills)) {
        lines.push(`  ${name}: ${entry.level} (${entry.xp.toLocaleString()} xp)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_quests",
    "Get the player's synced quest completion status. Filter by state or search by name.",
    {
      username: z.string().describe("Player username"),
      state: z.enum(["NOT_STARTED", "IN_PROGRESS", "FINISHED"]).optional().describe("Filter by quest state"),
      search: z.string().optional().describe("Search term to filter quests by name"),
    },
    async ({ username, state, search }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.quests) {
        return { content: [{ type: "text", text: `No quest data synced for "${username}".` }] };
      }

      let quests = data.quests;
      if (state) {
        quests = quests.filter((q) => q.state === state);
      }
      if (search) {
        const term = search.toLowerCase();
        quests = quests.filter((q) => q.displayName.toLowerCase().includes(term));
      }

      if (quests.length === 0) {
        return { content: [{ type: "text", text: "No matching quests found." }] };
      }

      const lines: string[] = [`# ${username}'s Quests — ${quests.length} results`, freshnessLine(data.lastUpdated)];
      for (const q of quests) {
        const icon =
          q.state === "FINISHED"
            ? "[Done]"
            : q.state === "IN_PROGRESS"
              ? "[In Progress]"
              : "[Not Started]";
        lines.push(`  ${icon} ${q.displayName}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_equipment",
    "Get the player's currently equipped items (last synced state).",
    {
      username: z.string().describe("Player username"),
    },
    async ({ username }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.equipment) {
        return { content: [{ type: "text", text: `No equipment data synced for "${username}".` }] };
      }

      const lines: string[] = [`# ${username}'s Equipment`, freshnessLine(data.lastUpdated)];
      for (const [slot, item] of Object.entries(data.equipment)) {
        if (item.itemId === -1) {
          lines.push(`  ${slot}: (empty)`);
        } else {
          lines.push(`  ${slot}: ${item.name} (ID: ${item.itemId})`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_inventory",
    "Get the player's current inventory contents (last synced state).",
    {
      username: z.string().describe("Player username"),
    },
    async ({ username }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.inventory) {
        return { content: [{ type: "text", text: `No inventory data synced for "${username}".` }] };
      }

      const items = data.inventory.filter((i) => i.itemId !== -1);
      if (items.length === 0) {
        return { content: [{ type: "text", text: `${username}'s inventory is empty.` }] };
      }

      const lines: string[] = [`# ${username}'s Inventory — ${items.length} items`, freshnessLine(data.lastUpdated)];
      for (const item of items) {
        const qty = item.quantity > 1 ? ` x${item.quantity.toLocaleString()}` : "";
        lines.push(`  [Slot ${item.slot}] ${item.name}${qty}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_diaries",
    "Get the player's achievement diary completion status. Optionally filter by region.",
    {
      username: z.string().describe("Player username"),
      region: z.string().optional().describe("Specific diary region (e.g. 'ARDOUGNE', 'VARROCK')"),
    },
    async ({ username, region }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.achievementDiaries) {
        return { content: [{ type: "text", text: `No diary data synced for "${username}".` }] };
      }

      let diaries = Object.entries(data.achievementDiaries);
      if (region) {
        const key = region.toUpperCase();
        diaries = diaries.filter(([r]) => r.toUpperCase() === key);
        if (diaries.length === 0) {
          return {
            content: [
              { type: "text", text: `Region "${region}" not found. Available: ${Object.keys(data.achievementDiaries).join(", ")}` },
            ],
          };
        }
      }

      const lines: string[] = [`# ${username}'s Achievement Diaries`, freshnessLine(data.lastUpdated)];
      for (const [name, diary] of diaries) {
        const check = (v: boolean) => (v ? "Done" : "---");
        lines.push(
          `  ${name}: Easy=${check(diary.easy)} | Med=${check(diary.medium)} | Hard=${check(diary.hard)} | Elite=${check(diary.elite)}`
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_diary_tasks",
    "Get per-task Achievement Diary completion (task name + done/not-done), not just the tier-level summary get_my_diaries gives. " +
      "Defaults to each region's next incomplete tier; pass `tier` to see a specific tier, or `allTiers` to see everything.",
    {
      username: z.string().describe("Player username"),
      region: z.string().optional().describe("Specific diary region (e.g. 'ARDOUGNE', 'VARROCK'). Omit for all regions."),
      tier: z.enum(["easy", "medium", "hard", "elite"]).optional().describe("Specific tier. Omit to use the next incomplete tier."),
      allTiers: z.boolean().optional().describe("Show all 4 tiers instead of just the next incomplete one."),
    },
    async ({ username, region, tier, allTiers }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.achievementDiaries || !data.diaryTaskVarps) {
        return {
          content: [
            {
              type: "text",
              text: `No per-task diary data synced for "${username}" yet (needs a recent plugin sync with diary syncing enabled).`,
            },
          ],
        };
      }

      let regions = Object.keys(data.achievementDiaries);
      if (region) {
        const key = region.toUpperCase();
        regions = regions.filter((r) => r.toUpperCase() === key);
        if (regions.length === 0) {
          return {
            content: [
              { type: "text", text: `Region "${region}" not found. Available: ${listDiaryRegions().join(", ")}` },
            ],
          };
        }
      }

      const TIERS = ["easy", "medium", "hard", "elite"] as const;
      const lines: string[] = [`# ${username}'s Achievement Diary tasks`, freshnessLine(data.lastUpdated)];

      for (const r of regions) {
        const diary = data.achievementDiaries[r];
        let tiersToShow: (typeof TIERS)[number][];
        if (tier) {
          tiersToShow = [tier];
        } else if (allTiers) {
          tiersToShow = [...TIERS];
        } else {
          const nextIncomplete = TIERS.find((t) => !diary[t]);
          tiersToShow = nextIncomplete ? [nextIncomplete] : ["elite"]; // fully complete - show elite as the summary
        }

        lines.push(`\n## ${r}`);
        for (const t of tiersToShow) {
          const tasks = getDiaryTaskStatus(r, t, data.diaryTaskVarps, data.diaryTaskVarbits);
          if (!tasks) {
            lines.push(`  ${t}: no per-task data available for this region/tier`);
            continue;
          }
          const doneCount = tasks.filter((x) => x.done).length;
          lines.push(`  ${t[0].toUpperCase()}${t.slice(1)} (${doneCount}/${tasks.length} done)${diary[t] ? " - TIER COMPLETE" : ""}:`);
          for (const task of tasks) {
            lines.push(`    [${task.done ? "x" : " "}] ${task.name}`);
            // Requirements only for outstanding tasks - a done task's
            // requirements aren't useful for planning what's left to do,
            // and this tool exists specifically so callers don't have to
            // go look them up elsewhere for the tasks that still matter.
            if (!task.done) {
              for (const req of task.requirements) {
                lines.push(`        - ${req}`);
              }
            }
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_combat_achievements",
    "Get the player's combat achievement completion status. Optionally search by task name.",
    {
      username: z.string().describe("Player username"),
      search: z.string().optional().describe("Search term to filter by task name"),
    },
    async ({ username, search }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.combatAchievements) {
        return {
          content: [{ type: "text", text: `No combat achievement data synced for "${username}".` }],
        };
      }

      const ca = data.combatAchievements;
      const lines: string[] = [`# ${username}'s Combat Achievements`, freshnessLine(data.lastUpdated)];
      lines.push(
        `Easy: ${ca.easyComplete ? "Complete" : "Incomplete"} | Medium: ${ca.mediumComplete ? "Complete" : "Incomplete"} | Hard: ${ca.hardComplete ? "Complete" : "Incomplete"} | Elite: ${ca.eliteComplete ? "Complete" : "Incomplete"}`
      );
      lines.push(`Completed tasks: ${ca.completedTasks.length}`);

      let tasks = ca.completedTasks;
      if (search) {
        const term = search.toLowerCase();
        tasks = tasks.filter((t) => t.toLowerCase().includes(term));
        lines.push(`\nMatching "${search}": ${tasks.length} tasks`);
      }

      if (tasks.length > 0 && tasks.length <= 100) {
        lines.push("");
        for (const task of tasks) {
          lines.push(`  [Done] ${task}`);
        }
      } else if (tasks.length > 100) {
        lines.push(
          `\nToo many tasks to display (${tasks.length}). Use the search parameter to filter.`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── History Tools (read from local storage only, no live WOM calls) ──

  server.tool(
    "skill_xp_gained",
    "Get xp (for a skill) or kill count (for a boss/activity) gained over a time period, computed from stored history. Works for any synced skill (e.g. 'MINING') or boss/activity metric (e.g. 'zulrah', 'clue_scrolls_easy') - the merged snapshot doesn't distinguish where the data came from.",
    {
      username: z.string().describe("Player username"),
      metric: z.string().describe("Skill name (e.g. 'COOKING') or boss/activity name (e.g. 'zulrah')"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure gain from. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 timestamp to measure gain until. Defaults to now."),
    },
    async ({ username, metric, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const resolved = resolveMetric(data, metric);
      if (!resolved) return { content: [{ type: "text", text: metricNotFoundMessage(username, metric, data) }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const gain = getMetricGain(username, resolved.key, sinceIso, untilIso);
      const unit = resolved.kind === "skill" ? "xp" : "kills";

      if (gain === 0) {
        return { content: [{ type: "text", text: `No change in ${resolved.label} between ${sinceIso} and ${untilIso}.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `# ${username} — ${resolved.label} gained\n${sinceIso} → ${untilIso}\n+${gain.toLocaleString()} ${unit}\nCurrent: ${resolved.current.toLocaleString()}`,
          },
        ],
      };
    }
  );

  server.tool(
    "skill_xp_gained_bulk",
    "Get xp gained over a time period for every synced skill in one call, computed from stored history - use this instead of calling skill_xp_gained per skill when answering 'what did I train' style questions. Skills with zero change are included explicitly so 'no change' doesn't require a separate call to confirm. Optionally also include kill-count gains for a supplied list of boss/activity metrics (e.g. 'zulrah').",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure gain from. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 timestamp to measure gain until. Defaults to now."),
      metrics: z.array(z.string()).optional().describe("Additional boss/activity metric names (e.g. 'zulrah', 'clue_scrolls_easy') to include alongside all skills."),
    },
    async ({ username, since, until, metrics }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      if (!data.skills) return { content: [{ type: "text", text: `No skill data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();

      // OVERALL is a derived sum of the other skills, not something trained
      // in its own right - reporting it alongside them would just double-
      // count the total already visible from summing the per-skill lines.
      const skillNames = Object.keys(data.skills).filter((s) => s !== "OVERALL");
      const skillGains = skillNames.map((name) => ({
        name,
        gain: getMetricGain(username, `skill:${name}`, sinceIso, untilIso),
      }));
      const totalXpGained = skillGains.reduce((sum, s) => sum + s.gain, 0);

      const seenKeys = new Set(skillGains.map((s) => `skill:${s.name}`));
      const activityGains: { label: string; gain: number }[] = [];
      const unknownMetrics: string[] = [];
      for (const metric of metrics ?? []) {
        const resolved = resolveMetric(data, metric);
        if (!resolved) {
          unknownMetrics.push(metric);
          continue;
        }
        if (seenKeys.has(resolved.key)) continue; // already covered by the full skill sweep
        seenKeys.add(resolved.key);
        activityGains.push({
          label: resolved.label,
          gain: getMetricGain(username, resolved.key, sinceIso, untilIso),
        });
      }

      const lines: string[] = [
        `# ${username} — Gains since ${sinceIso}`,
        `${sinceIso} → ${untilIso}`,
        `Total xp gained: +${totalXpGained.toLocaleString()}`,
        "",
        "## Skills",
      ];
      for (const { name, gain } of skillGains) {
        lines.push(`  ${name}: +${gain.toLocaleString()} xp`);
      }
      if (activityGains.length > 0) {
        lines.push("", "## Boss/Activity Metrics");
        for (const { label, gain } of activityGains) {
          lines.push(`  ${label}: +${gain.toLocaleString()} kills`);
        }
      }
      if (unknownMetrics.length > 0) {
        lines.push("", `Unknown metrics (skipped): ${unknownMetrics.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "boss_kills_gained_bulk",
    "Get kill count gained over a time period for every synced boss/activity metric in one call, computed from stored history - use this instead of calling skill_xp_gained per boss when answering 'what did I kill' style questions. Metrics with zero change are included explicitly so 'no change' doesn't require a separate call to confirm.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure gain from. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 timestamp to measure gain until. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      if (!data.bossKills) return { content: [{ type: "text", text: `No boss/activity kill count data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();

      const gains = Object.keys(data.bossKills).map((boss) => ({
        boss,
        gain: getMetricGain(username, `kc:${boss}`, sinceIso, untilIso),
      }));
      const metricsWithGains = gains.filter((g) => g.gain > 0).length;

      const lines: string[] = [
        `# ${username} — Kill counts gained since ${sinceIso}`,
        `${sinceIso} → ${untilIso}`,
        `Metrics with activity: ${metricsWithGains} of ${gains.length}`,
        "",
      ];
      for (const { boss, gain } of gains) {
        lines.push(`  ${boss}: +${gain.toLocaleString()} kills`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "skill_xp_timeline",
    "Get the time series of changes for a skill or boss/activity metric over a date range, computed from stored history (not a live WOM call).",
    {
      username: z.string().describe("Player username"),
      metric: z.string().describe("Skill name (e.g. 'COOKING') or boss/activity name (e.g. 'zulrah')"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to 30 days ago."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, metric, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const resolved = resolveMetric(data, metric);
      if (!resolved) return { content: [{ type: "text", text: metricNotFoundMessage(username, metric, data) }] };

      const sinceIso = since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const rows = getMetricHistory(username, resolved.key, sinceIso, untilIso);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No changes in ${resolved.label} between ${sinceIso} and ${untilIso}.` }] };
      }

      const lines = [`# ${username} — ${resolved.label} timeline`, `${sinceIso} → ${untilIso}`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.oldValue.toLocaleString()} → ${row.newValue.toLocaleString()} (+${(row.newValue - row.oldValue).toLocaleString()})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "cooking_progress_since",
    "Estimate time remaining until a target Cooking level (default 99), by projecting the xp/hour rate observed since a given time. Combines xp-gained history with a simple burn-rate calculation.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure the xp rate from. Defaults to 7 days ago."),
      targetLevel: z.number().min(2).max(99).default(99).describe("Target Cooking level"),
    },
    async ({ username, since, targetLevel }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const cooking = data.skills?.COOKING;
      if (!cooking) return { content: [{ type: "text", text: `No Cooking data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = new Date().toISOString();
      const gained = getMetricGain(username, "skill:COOKING", sinceIso, untilIso);
      const elapsedHours = (Date.parse(untilIso) - Date.parse(sinceIso)) / 3_600_000;

      if (gained <= 0 || elapsedHours <= 0) {
        return { content: [{ type: "text", text: `No Cooking xp gained since ${sinceIso} — can't estimate a rate.` }] };
      }

      const targetXp = xpForLevel(targetLevel);
      const xpRemaining = targetXp - cooking.xp;
      if (xpRemaining <= 0) {
        return {
          content: [
            { type: "text", text: `${username} has already reached level ${targetLevel} Cooking (current: level ${cooking.level}, ${cooking.xp.toLocaleString()} xp).` },
          ],
        };
      }

      const xpPerHour = gained / elapsedHours;
      const hoursRemaining = xpRemaining / xpPerHour;

      const lines = [
        `# ${username} — Cooking progress toward level ${targetLevel}`,
        `Current: level ${cooking.level} (${cooking.xp.toLocaleString()} xp)`,
        `Rate since ${sinceIso}: +${Math.round(xpPerHour).toLocaleString()} xp/hour (${gained.toLocaleString()} xp over ${elapsedHours.toFixed(1)}h)`,
        `Xp remaining to level ${targetLevel}: ${xpRemaining.toLocaleString()}`,
        `Estimated time at this rate: ${formatDuration(hoursRemaining)}`,
        "",
        "Projects the recent rate forward assuming similar play patterns continue.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "quest_history",
    "Get quest state changes (e.g. started, completed) for a player over a date range. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "quest", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No quest changes recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Quest history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "diary_tiers_completed_since",
    "Get Achievement Diary tier completions for every synced region in one call, over a time range - regions with no change in the period are reported explicitly rather than omitted, alongside their current tier status. Complements diary_history, which lists raw completion events without the per-region 'nothing changed here' or current-status context.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      if (!data.achievementDiaries) return { content: [{ type: "text", text: `No diary data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const rows = getStateHistory(username, "diary", sinceIso, untilIso);

      // itemName is "REGION:tier" (see diffDiaries in merge.ts).
      const completedByRegion = new Map<string, string[]>();
      for (const row of rows) {
        if (row.newState !== "complete") continue;
        const [region, tier] = row.itemName.split(":");
        if (!completedByRegion.has(region)) completedByRegion.set(region, []);
        completedByRegion.get(region)!.push(tier);
      }

      let totalCompleted = 0;
      const lines: string[] = [`# ${username} — Diary tiers completed since ${sinceIso}`, `${sinceIso} → ${untilIso}`, ""];
      for (const [region, diary] of Object.entries(data.achievementDiaries)) {
        const check = (v: boolean) => (v ? "Done" : "---");
        const status = `Easy=${check(diary.easy)} | Med=${check(diary.medium)} | Hard=${check(diary.hard)} | Elite=${check(diary.elite)}`;
        const completed = completedByRegion.get(region) ?? [];
        totalCompleted += completed.length;
        const change = completed.length > 0 ? `completed ${completed.join(", ")}` : "no tier changes";
        lines.push(`  ${region}: ${change} (currently ${status})`);
      }
      lines.push("", `Total tiers completed in this period: ${totalCompleted}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "diary_history",
    "Get achievement diary tier completions for a player over a date range. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "diary", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No diary changes recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Achievement diary history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "combat_achievements_completed_since",
    "Get combat achievement progress over a time range in one call - task completion count plus which tiers were newly finished, computed from stored history, alongside current tier status. Complements combat_achievement_history, which lists raw completion events without this summary/current-status framing.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      if (!data.combatAchievements) return { content: [{ type: "text", text: `No combat achievement data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const rows = getStateHistory(username, "combat_achievement", sinceIso, untilIso);

      // Tier-milestone rows (itemName "tier:easy" etc., see diffCombatAchievements
      // in merge.ts) are recorded alongside individual task rows - split them so
      // the task count/list doesn't double up with the tier summary below.
      const tierRowsInWindow = new Set(
        rows
          .filter((r) => r.itemName.startsWith("tier:") && r.newState === "complete")
          .map((r) => r.itemName.slice("tier:".length))
      );
      const taskRows = rows.filter((r) => !r.itemName.startsWith("tier:"));

      const ca = data.combatAchievements;
      const tierFields: [string, boolean][] = [
        ["easy", ca.easyComplete],
        ["medium", ca.mediumComplete],
        ["hard", ca.hardComplete],
        ["elite", ca.eliteComplete],
      ];

      const lines: string[] = [
        `# ${username} — Combat achievements since ${sinceIso}`,
        `${sinceIso} → ${untilIso}`,
        `Tasks completed in this period: ${taskRows.length}`,
        "",
        "## Tier status",
      ];
      for (const [tier, done] of tierFields) {
        const label = tier[0].toUpperCase() + tier.slice(1);
        const state = !done
          ? "not yet complete"
          : tierRowsInWindow.has(tier)
            ? "reached in this period"
            : "already complete before this period";
        lines.push(`  ${label}: ${state}`);
      }

      if (taskRows.length > 0 && taskRows.length <= 100) {
        lines.push("", "## Tasks completed");
        for (const row of taskRows) {
          lines.push(`  - ${row.itemName}`);
        }
      } else if (taskRows.length > 100) {
        lines.push("", `Too many tasks to list individually (${taskRows.length}).`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "combat_achievement_history",
    "Get combat achievement task/tier completions for a player over a date range. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "combat_achievement", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No combat achievement changes recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Combat achievement history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}
