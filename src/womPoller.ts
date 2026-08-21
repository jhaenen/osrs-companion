import { fetchPlayerSnapshot, forceUpdatePlayer, extractMergeableMetrics } from "./womClient.js";
import { mergeAndStore } from "./merge.js";
import { listSyncedPlayers } from "./snapshotStore.js";

// Background job: periodically pulls WOM's public hiscores for every
// currently-synced player and merges the result into the same canonical
// snapshot the plugin pushes to. This is what catches mobile-only play the
// desktop plugin structurally can't see. Runs inside the ingest process
// since that's the side of this deployment that already holds write access
// to the shared snapshot volume - no separate service needed for it.
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const POLL_INTERVAL_MS = Number(process.env.WOM_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);

async function pollPlayer(username: string): Promise<void> {
  await forceUpdatePlayer(username);
  const resp = await fetchPlayerSnapshot(username);
  if (!resp) {
    console.error(`WOM poll: no player found for "${username}" (not tracked by WOM yet?)`);
    return;
  }
  const { skills, bossKills } = extractMergeableMetrics(resp);
  if (Object.keys(skills).length === 0 && Object.keys(bossKills).length === 0) {
    return;
  }
  await mergeAndStore({
    source: "wom",
    username,
    timestamp: new Date().toISOString(),
    skills,
    bossKills,
  });
}

async function pollAll(): Promise<void> {
  // listSyncedPlayers() returns filesystem-safe names (lowercase, spaces
  // already turned into "_" by snapshotStore's filenameFor) rather than the
  // exact RSN. WOM's player-lookup endpoint is documented as tolerant of
  // case and underscore-for-space substitution, so this is passed through
  // as-is; if a given RSN ever fails to resolve on WOM's side, that's the
  // first thing to check.
  const usernames = await listSyncedPlayers();
  for (const username of usernames) {
    try {
      await pollPlayer(username);
    } catch (err) {
      console.error(`WOM poll failed for ${username}:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startWomPoller(): void {
  console.log(`WOM poller starting - polling every ${Math.round(POLL_INTERVAL_MS / 60000)}m`);
  pollAll().catch((err) => console.error("Initial WOM poll failed:", err));
  setInterval(() => {
    pollAll().catch((err) => console.error("WOM poll failed:", err));
  }, POLL_INTERVAL_MS);
}
