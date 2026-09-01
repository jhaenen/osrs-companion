import { z } from "zod";

// Mirrors the Java model in the companion RuneLite plugin
// (model/PlayerSyncData.java). Keep in sync with that file.

export const skillEntrySchema = z.object({
  level: z.number(),
  xp: z.number(),
});

export const itemEntrySchema = z.object({
  itemId: z.number(),
  // Empty equipment/inventory slots have name = null in Java, which Gson
  // omits entirely from the JSON rather than serializing null.
  name: z.string().optional(),
  quantity: z.number(),
});

export const inventoryItemSchema = itemEntrySchema.extend({
  slot: z.number(),
});

export const bankTabSchema = z.object({
  tabIndex: z.number(),
  items: z.array(itemEntrySchema),
});

export const bankDataSchema = z.object({
  totalItems: z.number(),
  tabs: z.array(bankTabSchema),
});

export const potionStorageEntrySchema = z.object({
  itemId: z.number(),
  name: z.string().optional(),
  // Whole potions at the currently-configured withdraw dose tier - matches
  // what the in-game Potion Storage interface itself shows.
  quantity: z.number(),
  // Total individual doses stored, independent of the withdraw dose tier.
  doses: z.number(),
  doseTier: z.number(),
});

export const questEntrySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  state: z.enum(["NOT_STARTED", "IN_PROGRESS", "FINISHED"]),
});

export const diaryRegionSchema = z.object({
  easy: z.boolean(),
  medium: z.boolean(),
  hard: z.boolean(),
  elite: z.boolean(),
});

export const combatAchievementDataSchema = z.object({
  easyComplete: z.boolean(),
  mediumComplete: z.boolean(),
  hardComplete: z.boolean(),
  eliteComplete: z.boolean(),
  completedTasks: z.array(z.string()),
});

export const collectionLogCategoryCountSchema = z.object({
  completed: z.number(),
  possible: z.number(),
});

// No bulk "every unlocked item ever" API exists in the client (see the
// plugin's PlayerSyncData.CollectionLogData javadoc) - total/categories are
// cheap, always-in-sync varp-derived counts, while obtainedItems is a
// best-effort, ever-growing set of item names actually observed unlocked,
// from two passive sources: the "New item added to your collection log"
// chat message (only while the client is running and listening), and a
// clientscript that only fires when an external full collection-log
// export action (e.g. weirdgloop/WikiSync's own "sync" button) happens to
// run while the plugin is also listening - this plugin cannot trigger that
// itself. Never treat obtainedItems as exhaustive.
export const collectionLogDataSchema = z.object({
  total: collectionLogCategoryCountSchema,
  categories: z.record(collectionLogCategoryCountSchema),
  obtainedItems: z.array(z.string()),
});

// Per-category fields are optional: the plugin omits any category a user
// has toggled off in its config, and Gson skips null fields on write.
export const playerSyncDataSchema = z.object({
  schemaVersion: z.number(),
  lastUpdated: z.string(),
  player: z.object({
    username: z.string().min(1),
    combatLevel: z.number(),
    world: z.number(),
  }),
  skills: z.record(skillEntrySchema).optional(),
  // Boss/activity kill counts. Unlike every other field here, this one does
  // NOT mirror the plugin's Java model - the plugin doesn't track kill
  // counts at all. It's populated solely by the Wise Old Man merge job
  // (see merge.ts), keyed by WOM's lowercase metric name (e.g. "zulrah",
  // "clue_scrolls_easy"). Present here so it lives in the same merged
  // snapshot as everything else, per the single-source-of-truth design.
  bossKills: z.record(z.number()).optional(),
  bank: bankDataSchema.optional(),
  // Potion Storage is a separate bank feature - own field rather than
  // folded into bank.tabs so callers can always tell regular bank items
  // and stored potions apart without guessing at a tab index convention.
  potionStorage: z.array(potionStorageEntrySchema).optional(),
  inventory: z.array(inventoryItemSchema).optional(),
  equipment: z.record(itemEntrySchema).optional(),
  quests: z.array(questEntrySchema).optional(),
  achievementDiaries: z.record(diaryRegionSchema).optional(),
  // Raw per-task achievement diary bits, keyed by varplayer/varbit ID
  // (as strings, since JSON object keys always are). Decoded against
  // src/data/achievementDiaryTasks.json in diaryTasks.ts, not stored
  // decoded - see PlayerDataCollector.DIARY_TASK_VARPS/DIARY_TASK_VARBITS
  // in the plugin for what's actually sent.
  diaryTaskVarps: z.record(z.number()).optional(),
  diaryTaskVarbits: z.record(z.number()).optional(),
  combatAchievements: combatAchievementDataSchema.optional(),
  collectionLog: collectionLogDataSchema.optional(),
});

export type PlayerSyncData = z.infer<typeof playerSyncDataSchema>;
export type ItemEntry = z.infer<typeof itemEntrySchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type BankData = z.infer<typeof bankDataSchema>;
export type PotionStorageEntry = z.infer<typeof potionStorageEntrySchema>;
export type QuestEntry = z.infer<typeof questEntrySchema>;
export type DiaryRegion = z.infer<typeof diaryRegionSchema>;
export type CombatAchievementData = z.infer<typeof combatAchievementDataSchema>;
export type CollectionLogCategoryCount = z.infer<typeof collectionLogCategoryCountSchema>;
export type CollectionLogData = z.infer<typeof collectionLogDataSchema>;
