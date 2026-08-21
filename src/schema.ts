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
  inventory: z.array(inventoryItemSchema).optional(),
  equipment: z.record(itemEntrySchema).optional(),
  quests: z.array(questEntrySchema).optional(),
  achievementDiaries: z.record(diaryRegionSchema).optional(),
  combatAchievements: combatAchievementDataSchema.optional(),
});

export type PlayerSyncData = z.infer<typeof playerSyncDataSchema>;
export type ItemEntry = z.infer<typeof itemEntrySchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type BankData = z.infer<typeof bankDataSchema>;
export type QuestEntry = z.infer<typeof questEntrySchema>;
export type DiaryRegion = z.infer<typeof diaryRegionSchema>;
export type CombatAchievementData = z.infer<typeof combatAchievementDataSchema>;
