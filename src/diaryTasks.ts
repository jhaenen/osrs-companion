import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Plain fs read rather than `import ... with { type: "json" }` - this
// repo's tsconfig targets "module": "Node16", which predates TS's support
// for import attributes (see error TS2823 if you try). The build script
// copies src/data/*.json to dist/data/ so this resolves correctly from
// both `tsx src/...` (dev) and `node dist/...` (prod) - see package.json.
const dataPath = fileURLToPath(new URL("./data/achievementDiaryTasks.json", import.meta.url));
const diaryTaskData: unknown = JSON.parse(readFileSync(dataPath, "utf-8"));

// Per-task Achievement Diary decode logic. Bit offsets/var IDs come from a
// third-party LUT (see reference-osrs-diary-task-lut memory for provenance
// and the correctness caveats) merged with real task text scraped from the
// OSRS Wiki - src/data/achievementDiaryTasks.json. Deliberately does NOT
// use that LUT's "complete" field (found to be stale/inconsistent with the
// plugin's own already-correct tier-complete varbits) - tier completion
// should always come from PlayerSyncData.achievementDiaries instead.

type VarSpec =
  | { type: "player"; var_id: number; offset: number }
  | { type: "bits"; var_id: number; value: number };

interface TaskSpec extends Record<string, unknown> {
  name: string;
  type: "player" | "bits";
  var_id: number;
  offset?: number;
  value?: number;
}

interface TierSpec {
  complete: VarSpec;
  tasks: TaskSpec[];
}

type DiaryTaskData = Record<string, Record<string, TierSpec>>;

const DATA = diaryTaskData as DiaryTaskData;

// Plugin/achievementDiaries region keys -> this LUT's region keys. The
// plugin uses the same uppercase/underscore keys for both DIARY_VARBITS
// (tier-complete) and achievementDiaries, so this is the one place that
// needs to bridge the two naming conventions.
const REGION_KEY_TO_LUT_NAME: Record<string, string> = {
  ARDOUGNE: "Ardougne",
  DESERT: "Desert",
  FALADOR: "Falador",
  FREMENNIK: "Fremennik",
  KANDARIN: "Kandarin",
  KARAMJA: "Karamja",
  KOUREND_KEBOS: "Kourend & Kebos",
  LUMBRIDGE_DRAYNOR: "Lumbridge & Draynor",
  MORYTANIA: "Morytania",
  VARROCK: "Varrock",
  WESTERN_PROVINCES: "Western Provinces",
  WILDERNESS: "Wilderness",
};

const TIER_KEY_TO_LUT_NAME: Record<string, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  elite: "Elite",
};

function isBitSet(value: number | undefined, offset: number): boolean {
  if (value === undefined) return false;
  return ((value >> offset) & 1) === 1;
}

function resolveTask(
  spec: TaskSpec,
  varps: Record<string, number>,
  varbits: Record<string, number>,
  lutRegion: string,
  lutTier: string,
  taskIndex: number
): boolean {
  // Ported as-is from wikisync-api's AchievementDiaryTransformer: Desert
  // Medium's 11th task (0-indexed 10) has separate varbits for ironman vs
  // non-ironman, ORed together rather than a single spec.
  if (lutRegion === "Desert" && lutTier === "Medium" && taskIndex === 10) {
    return isBitSet(varps["1199"], 9) || isBitSet(varps["1198"], 22);
  }
  if (spec.type === "player") {
    return isBitSet(varps[String(spec.var_id)], spec.offset!);
  }
  // type === "bits": equality check against a varbit value (Karamja).
  return varbits[String(spec.var_id)] === spec.value;
}

export interface DiaryTaskStatus {
  index: number;
  name: string;
  done: boolean;
}

/**
 * Decode per-task completion for one region/tier from raw varp/varbit
 * values. `region`/`tier` use the plugin's keys (e.g. "VARROCK", "elite"),
 * matching PlayerSyncData.achievementDiaries.
 */
export function getDiaryTaskStatus(
  region: string,
  tier: string,
  varps: Record<string, number> | undefined,
  varbits: Record<string, number> | undefined
): DiaryTaskStatus[] | null {
  const lutRegion = REGION_KEY_TO_LUT_NAME[region.toUpperCase()];
  const lutTier = TIER_KEY_TO_LUT_NAME[tier.toLowerCase()];
  if (!lutRegion || !lutTier) return null;
  const tierSpec = DATA[lutRegion]?.[lutTier];
  if (!tierSpec) return null;

  const vp = varps ?? {};
  const vb = varbits ?? {};
  return tierSpec.tasks.map((task, index) => ({
    index,
    name: task.name,
    done: resolveTask(task, vp, vb, lutRegion, lutTier, index),
  }));
}

export function listDiaryRegions(): string[] {
  return Object.keys(REGION_KEY_TO_LUT_NAME);
}
