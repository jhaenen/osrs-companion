import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PlayerSyncData } from "./schema.js";

// Local file default is for stdio/dev mode (matches the original
// stock behavior). The HTTP deployment overrides this with SYNC_DIR
// pointed at a shared volume between the ingest and MCP containers.
const SYNC_DIR = process.env.SYNC_DIR ?? join(homedir(), ".runelite", "osrs-companion");

function filenameFor(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + ".json";
}

export async function writeSnapshot(data: PlayerSyncData): Promise<void> {
  await mkdir(SYNC_DIR, { recursive: true });
  const filepath = join(SYNC_DIR, filenameFor(data.player.username));
  await writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
}

export async function readSnapshot(username: string): Promise<PlayerSyncData | null> {
  const filepath = join(SYNC_DIR, filenameFor(username));
  try {
    const raw = await readFile(filepath, "utf-8");
    return JSON.parse(raw) as PlayerSyncData;
  } catch {
    return null;
  }
}

export async function listSyncedPlayers(): Promise<string[]> {
  try {
    const files = await readdir(SYNC_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export { SYNC_DIR };
