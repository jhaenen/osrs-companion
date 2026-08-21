// Plain HTTP client for Wise Old Man's public REST API. Deliberately not a
// client of the WOM MCP server - that MCP is just a thin wrapper over this
// same public API, so calling it from here would be pointless indirection.
// Docs: https://docs.wiseoldman.net/

const WOM_API_BASE = process.env.WOM_API_BASE ?? "https://api.wiseoldman.net/v2";
const WOM_API_KEY = process.env.WOM_API_KEY; // optional, raises WOM's rate limit
const USER_AGENT = "osrs-companion/1.0 (+https://github.com/isaachansen/osrs-companion)";

interface WomSkillSnapshot {
  metric: string;
  experience: number;
  rank: number;
  level: number;
}

interface WomBossSnapshot {
  metric: string;
  kills: number;
  rank: number;
}

interface WomActivitySnapshot {
  metric: string;
  score: number;
  rank: number;
}

interface WomSnapshotData {
  skills: Record<string, WomSkillSnapshot>;
  bosses: Record<string, WomBossSnapshot>;
  activities: Record<string, WomActivitySnapshot>;
}

interface WomPlayerResponse {
  username: string;
  displayName: string;
  latestSnapshot?: {
    data: WomSnapshotData;
  };
}

async function womFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (WOM_API_KEY) headers["x-api-key"] = WOM_API_KEY;
  const res = await fetch(`${WOM_API_BASE}${path}`, { ...init, headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`WOM API ${path} returned ${res.status}: ${await res.text().catch(() => "")}`);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

/**
 * Ask WOM to re-check the hiscores for this player before we read their
 * snapshot. Best-effort: WOM cools this endpoint down per player (normally
 * ~60s), which our poll interval comfortably clears, but a transient
 * failure here shouldn't stop the poll from reading whatever WOM already
 * has cached.
 */
export async function forceUpdatePlayer(username: string): Promise<void> {
  try {
    await womFetch(`/players/${encodeURIComponent(username)}`, { method: "POST" });
  } catch (err) {
    console.error(`WOM force-update failed for ${username}:`, err instanceof Error ? err.message : err);
  }
}

export async function fetchPlayerSnapshot(username: string): Promise<WomPlayerResponse | null> {
  return womFetch<WomPlayerResponse>(`/players/${encodeURIComponent(username)}`);
}

export interface WomMergeableMetrics {
  skills: Record<string, { level: number; xp: number }>;
  bossKills: Record<string, number>;
}

/**
 * Flattens a WOM player response down to just the metrics we're allowed to
 * merge (see project scope notes: skill xp/levels and boss/activity kill
 * counts only - never bank/inventory/equipment/quests/diaries/CAs, none of
 * which are on the hiscores). WOM reports -1 for unranked metrics; those
 * are dropped rather than merged in as a real 0.
 */
export function extractMergeableMetrics(resp: WomPlayerResponse): WomMergeableMetrics {
  const data = resp.latestSnapshot?.data;
  const skills: Record<string, { level: number; xp: number }> = {};
  const bossKills: Record<string, number> = {};
  if (!data) return { skills, bossKills };

  for (const [key, entry] of Object.entries(data.skills ?? {})) {
    if (key === "overall") continue;
    if (entry.experience < 0) continue;
    skills[key.toUpperCase()] = { level: entry.level, xp: entry.experience };
  }
  for (const [key, entry] of Object.entries(data.bosses ?? {})) {
    if (entry.kills >= 0) bossKills[key] = entry.kills;
  }
  for (const [key, entry] of Object.entries(data.activities ?? {})) {
    if (entry.score >= 0) bossKills[key] = entry.score;
  }
  return { skills, bossKills };
}
