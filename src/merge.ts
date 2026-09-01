import type {
  PlayerSyncData,
  QuestEntry,
  BankData,
  PotionStorageEntry,
  InventoryItem,
  ItemEntry,
  DiaryRegion,
  CombatAchievementData,
  CollectionLogData,
  CollectionLogCategoryCount,
} from "./schema.js";
import { readSnapshot, writeSnapshot } from "./snapshotStore.js";
import { recordMetricChange, recordStateChange, type MetricSource } from "./historyStore.js";
import { getDiaryTaskStatus, listDiaryRegions } from "./diaryTasks.js";

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
  potionStorage?: PotionStorageEntry[];
  inventory?: InventoryItem[];
  equipment?: Record<string, ItemEntry>;
  quests?: QuestEntry[];
  achievementDiaries?: Record<string, DiaryRegion>;
  // Raw per-task diary bits - plain overwrite, no diffing/history (the
  // decoded booleans are derived at read time in diaryTasks.ts, not
  // stored decoded, so there's nothing meaningful to diff here yet).
  diaryTaskVarps?: Record<string, number>;
  diaryTaskVarbits?: Record<string, number>;
  combatAchievements?: CombatAchievementData;
  collectionLog?: CollectionLogData;
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

// Per-task diary completion, decoded from the raw varp/varbit bag on both
// sides via the same getDiaryTaskStatus() the read-path tools use - there's
// no separately-stored decoded form to diff otherwise (see the
// diaryTaskVarps/diaryTaskVarbits comment on MergeInput). itemName is
// "REGION:tier:task text" - region and tier are both fixed, colon-free
// enums, but task text itself can contain colons (e.g. "Note: ..."), so
// only ever parse this back with a two-colon split, never a plain
// itemName.split(":").
const DIARY_TIERS = ["easy", "medium", "hard", "elite"] as const;

function diffDiaryTasks(
  username: string,
  existingVarps: Record<string, number> | undefined,
  existingVarbits: Record<string, number> | undefined,
  incomingVarps: Record<string, number> | undefined,
  incomingVarbits: Record<string, number> | undefined,
  timestamp: string
): void {
  for (const region of listDiaryRegions()) {
    for (const tier of DIARY_TIERS) {
      const prevTasks = getDiaryTaskStatus(region, tier, existingVarps, existingVarbits);
      const newTasks = getDiaryTaskStatus(region, tier, incomingVarps, incomingVarbits);
      if (!prevTasks || !newTasks) continue;
      for (const task of newTasks) {
        const prevDone = prevTasks[task.index]?.done ?? false;
        if (prevDone === task.done) continue;
        recordStateChange(
          username,
          "diary_task",
          `${region}:${tier}:${task.name}`,
          prevDone ? "complete" : "incomplete",
          task.done ? "complete" : "incomplete",
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

// Collection log completion counts are monotonic numbers exactly like
// bossKills' kill counts (varp-derived, always the current total, never a
// delta) - merged the same way: max() per key, with a metric_history row
// only once a *previous* value exists. A veteran player's very first sync
// already has a large existing completed count; treating "never recorded"
// as a baseline of 0 would write a fake "0 -> N" row, the exact mistake
// mergeBossKills' comment warns about. `possible` isn't part of that
// monotonic story (it only grows when Jagex adds log content) so it's just
// always taken from the latest snapshot, independent of the completed-count
// gate below.
function mergeCollectionLogCount(
  username: string,
  metricKey: string,
  prev: CollectionLogCategoryCount | undefined,
  incoming: CollectionLogCategoryCount,
  source: MetricSource,
  timestamp: string
): CollectionLogCategoryCount {
  if (!prev) {
    return incoming;
  }
  if (incoming.completed > prev.completed) {
    recordMetricChange(username, metricKey, prev.completed, incoming.completed, source, timestamp);
  }
  return { completed: Math.max(prev.completed, incoming.completed), possible: incoming.possible };
}

function mergeCollectionLogCounts(
  username: string,
  existing: CollectionLogData | undefined,
  incoming: CollectionLogData,
  source: MetricSource,
  timestamp: string
): { total: CollectionLogCategoryCount; categories: Record<string, CollectionLogCategoryCount> } {
  const total = mergeCollectionLogCount(username, "clog:total", existing?.total, incoming.total, source, timestamp);
  const categories: Record<string, CollectionLogCategoryCount> = { ...(existing?.categories ?? {}) };
  for (const [category, count] of Object.entries(incoming.categories)) {
    categories[category] = mergeCollectionLogCount(
      username,
      `clog:${category}`,
      existing?.categories?.[category],
      count,
      source,
      timestamp
    );
  }
  return { total, categories };
}

// obtainedItems is a flat, best-effort set (see schema.ts's comment) - the
// plugin's local copy resets on client/plugin restart, so incoming can be a
// *subset* of what's already known. Diffing/recording only fires for names
// genuinely new to the stored set; the caller unions rather than overwrites
// so a restart never forgets a previously-observed item.
function diffCollectionLogItems(username: string, existingItems: string[] | undefined, incomingItems: string[], timestamp: string): void {
  const prev = new Set(existingItems ?? []);
  for (const item of incomingItems) {
    if (!prev.has(item)) {
      recordStateChange(username, "collection_log", item, "not_owned", "owned", timestamp);
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
    if (input.potionStorage) merged.potionStorage = input.potionStorage;
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
    if (input.diaryTaskVarps || input.diaryTaskVarbits) {
      // A veteran player's very first sync with per-task diary data has no
      // prior varps/varbits to diff against - diffing that against "no
      // data" (all bits unset) would record every already-done task as
      // newly completed just now. Mirrors mergeSkills'/mergeBossKills'
      // "seed silently, no row on first sighting" rule.
      if (hasBaseline && (merged.diaryTaskVarps || merged.diaryTaskVarbits)) {
        diffDiaryTasks(
          input.username,
          merged.diaryTaskVarps,
          merged.diaryTaskVarbits,
          input.diaryTaskVarps ?? merged.diaryTaskVarps,
          input.diaryTaskVarbits ?? merged.diaryTaskVarbits,
          input.timestamp
        );
      }
      if (input.diaryTaskVarps) merged.diaryTaskVarps = input.diaryTaskVarps;
      if (input.diaryTaskVarbits) merged.diaryTaskVarbits = input.diaryTaskVarbits;
    }
    if (input.combatAchievements) {
      if (hasBaseline) diffCombatAchievements(input.username, merged.combatAchievements, input.combatAchievements, input.timestamp);
      merged.combatAchievements = input.combatAchievements;
    }
    if (input.collectionLog) {
      const { total, categories } = mergeCollectionLogCounts(
        input.username,
        merged.collectionLog,
        input.collectionLog,
        input.source,
        input.timestamp
      );
      const existingItems = merged.collectionLog?.obtainedItems ?? [];
      if (hasBaseline) diffCollectionLogItems(input.username, existingItems, input.collectionLog.obtainedItems, input.timestamp);
      merged.collectionLog = {
        total,
        categories,
        obtainedItems: Array.from(new Set([...existingItems, ...input.collectionLog.obtainedItems])),
      };
    }
  }

  merged.lastUpdated = input.timestamp;
  await writeSnapshot(merged);
}
