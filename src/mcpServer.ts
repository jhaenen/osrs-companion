import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSyncedPlayers, readSnapshot, SYNC_DIR } from "./snapshotStore.js";

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
    "Search and browse the player's synced bank contents. Supports filtering by item name, bank tab, and minimum quantity.",
    {
      username: z.string().describe("Player username"),
      search: z.string().optional().describe("Search term to filter items by name (case-insensitive)"),
      tab: z.number().optional().describe("Bank tab number to filter (0-indexed)"),
      minQuantity: z.number().optional().describe("Only show items with at least this quantity"),
    },
    async ({ username, search, tab, minQuantity }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.bank?.tabs) {
        return {
          content: [{ type: "text", text: `No bank data synced for "${username}". Open your bank in-game to sync.` }],
        };
      }

      let allItems = data.bank.tabs.flatMap((t) =>
        t.items.map((item) => ({ ...item, tab: t.tabIndex }))
      );

      if (search) {
        const term = search.toLowerCase();
        allItems = allItems.filter((item) => (item.name ?? "").toLowerCase().includes(term));
      }
      if (tab !== undefined) {
        allItems = allItems.filter((item) => item.tab === tab);
      }
      if (minQuantity !== undefined) {
        allItems = allItems.filter((item) => item.quantity >= minQuantity);
      }

      if (allItems.length === 0) {
        return { content: [{ type: "text", text: `No matching items found in ${username}'s bank.` }] };
      }

      const lines: string[] = [`# ${username}'s Bank — ${allItems.length} items found`, freshnessLine(data.lastUpdated)];
      for (const item of allItems) {
        const qty = item.quantity > 1 ? ` x${item.quantity.toLocaleString()}` : "";
        lines.push(`  [Tab ${item.tab}] ${item.name}${qty} (ID: ${item.itemId})`);
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

  return server;
}
