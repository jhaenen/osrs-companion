import type {
  PlayerSyncData,
  QuestEntry,
  BankData,
  InventoryItem,
  ItemEntry,
  DiaryRegion,
  CombatAchievementData,
} from "./schema.js";
import { readSnapshot, writeSnapshot } from "./snapshotStore.js";
import { recordMetricChange, recordStateChange, type MetricSource } from "./historyStore.js";

// One choke point for every write to the canonical merged snapshot, called
// by both the plugin ingest endpoint and the WOM background poller. This is
// what makes the two inputs source-agnostic from here on out: callers pass
// in whatever they have, this figures out what actually changed and how it
// should be combined with what's already stored.

export interface MergeInput {
  source: MetricSource;
  username: string;
  timestamp: string;
  schemaVersion?: number;
  // Monotonic metrics, mergeable from either source via max().
  skills?: Record<string, { level: number; xp: number }>;
  bossKills?: Record<string, number>;
  // Plugin-only fields. WOM never touches these - none of them are on the
  // public hiscores. A plugin push always sends the full current state for
  // whichever categories it's syncing, so these are plain overwrites, not
  // merges; quests/diaries/CAs are additionally diffed against the
  // previous snapshot to produce history rows.
  player?: PlayerSyncData["player"];
  bank?: BankData;
  inventory?: InventoryItem[];
  equipment?: Record<string, ItemEntry>;
  quests?: QuestEntry[];
  achievementDiaries?: Record<string, DiaryRegion>;
  combatAchievements?: CombatAchievementData;
}

function mergeSkills(
  username: string,
  existing: Record<string, { level: number; xp: number }> | undefined,
  incoming: Record<string, { level: number; xp: number }>,
  source: MetricSource,
  timestamp: string
): Record<string, { level: number; xp: number }> {
  const merged = { ...(existing ?? {}) };
  for (const [skill, entry] of Object.entries(incoming)) {
    const prev = merged[skill];
    if (!prev || entry.xp > prev.xp) {
      if (prev && entry.xp > prev.xp) {
        recordMetricChange(username, `skill:${skill}`, prev.xp, entry.xp, source, timestamp);
      }
      merged[skill] = entry;
    }
  }
  return merged;
}

function mergeBossKills(
  username: string,
  existing: Record<string, number> | undefined,
  incoming: Record<string, number>,
  source: MetricSource,
  timestamp: string
): Record<string, number> {
  const merged = { ...(existing ?? {}) };
  for (const [boss, kc] of Object.entries(incoming)) {
    const prev = merged[boss];
    if (prev === undefined) {
      // First time this metric has ever appeared in the snapshot (true for
      // every boss/activity on a player's very first WOM poll, since the
      // plugin never populates bossKills at all). Treating "never recorded"
      // as a baseline of 0 would write a fake "0 -> kc" history row for
      // whatever the player's kill count already was BEFORE we ever started
      // watching - indistinguishable from a real increase, and duplicated
      // by a later backfill run correctly dating that same real history.
      // Mirrors mergeSkills' behavior above: seed silently, no row.
      merged[boss] = kc;
      continue;
    }
    if (kc > prev) {
      recordMetricChange(username, `kc:${boss}`, prev, kc, source, timestamp);
      merged[boss] = kc;
    }
  }
  return merged;
}

function diffQuests(username: string, existing: QuestEntry[] | undefined, incoming: QuestEntry[], timestamp: string): void {
  const prevByName = new Map((existing ?? []).map((q) => [q.name, q]));
  for (const quest of incoming) {
    const prev = prevByName.get(quest.name);
    if (!prev || prev.state !== quest.state) {
      recordStateChange(username, "quest", quest.displayName, prev?.state ?? "NOT_STARTED", quest.state, timestamp);
    }
  }
}

function diffDiaries(
  username: string,
  existing: Record<string, DiaryRegion> | undefined,
  incoming: Record<string, DiaryRegion>,
  timestamp: string
): void {
  const tiers: (keyof DiaryRegion)[] = ["easy", "medium", "hard", "elite"];
  for (const [region, diary] of Object.entries(incoming)) {
    const prev = existing?.[region];
    for (const tier of tiers) {
      const prevDone = prev?.[tier] ?? false;
      const newDone = diary[tier];
      if (prevDone !== newDone) {
        recordStateChange(
          username,
          "diary",
          `${region}:${tier}`,
          prevDone ? "complete" : "incomplete",
          newDone ? "complete" : "incomplete",
          timestamp
        );
      }
    }
  }
}

function diffCombatAchievements(
  username: string,
  existing: CombatAchievementData | undefined,
  incoming: CombatAchievementData,
  timestamp: string
): void {
  const tierFields: (keyof Pick<CombatAchievementData, "easyComplete" | "mediumComplete" | "hardComplete" | "eliteComplete">)[] = [
    "easyComplete",
    "mediumComplete",
    "hardComplete",
    "eliteComplete",
  ];
  for (const field of tierFields) {
    const prevDone = existing?.[field] ?? false;
    const newDone = incoming[field];
    if (prevDone !== newDone) {
      recordStateChange(
        username,
        "combat_achievement",
        `tier:${field.replace("Complete", "")}`,
        prevDone ? "complete" : "incomplete",
        newDone ? "complete" : "incomplete",
        timestamp
      );
    }
  }
  const prevTasks = new Set(existing?.completedTasks ?? []);
  for (const task of incoming.completedTasks) {
    if (!prevTasks.has(task)) {
      recordStateChange(username, "combat_achievement", task, "incomplete", "complete", timestamp);
    }
  }
}

export async function mergeAndStore(input: MergeInput): Promise<void> {
  const existing = await readSnapshot(input.username);
  // First-ever sync for this player has nothing to diff quests/diaries/CAs
  // against - their current state is a baseline, not a set of "changes",
  // so skip state-history diffing entirely on this call.
  const hasBaseline = existing !== null;

  const merged: PlayerSyncData = existing ?? {
    schemaVersion: input.schemaVersion ?? 1,
    lastUpdated: input.timestamp,
    player: input.player ?? { username: input.username, combatLevel: 0, world: 0 },
  };

  if (input.skills) {
    merged.skills = mergeSkills(input.username, merged.skills, input.skills, input.source, input.timestamp);
  }
  if (input.bossKills) {
    merged.bossKills = mergeBossKills(input.username, merged.bossKills, input.bossKills, input.source, input.timestamp);
  }

  // Everything below is plugin-only: WOM's hiscores don't expose any of it.
  if (input.source === "plugin") {
    if (input.player) merged.player = input.player;
    if (input.bank) merged.bank = input.bank;
    if (input.inventory) merged.inventory = input.inventory;
    if (input.equipment) merged.equipment = input.equipment;
    if (input.quests) {
      if (hasBaseline) diffQuests(input.username, merged.quests, input.quests, input.timestamp);
      merged.quests = input.quests;
    }
    if (input.achievementDiaries) {
      if (hasBaseline) diffDiaries(input.username, merged.achievementDiaries, input.achievementDiaries, input.timestamp);
      merged.achievementDiaries = input.achievementDiaries;
    }
    if (input.combatAchievements) {
      if (hasBaseline) diffCombatAchievements(input.username, merged.combatAchievements, input.combatAchievements, input.timestamp);
      merged.combatAchievements = input.combatAchievements;
    }
  }

  merged.lastUpdated = input.timestamp;
  await writeSnapshot(merged);
}
