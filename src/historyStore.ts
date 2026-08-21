import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SYNC_DIR } from "./snapshotStore.js";

// Same directory the plugin/WOM snapshots already live in - one shared
// volume, no separate "history data" location. Low write volume by design:
// a row is only ever written on a genuine state transition (see merge.ts),
// never on every poll/push, so a single SQLite file is plenty here.
const DB_PATH = process.env.HISTORY_DB_PATH ?? join(SYNC_DIR, "history.db");

// The Docker deployment mounts the shared volume read-only into osrs-mcp
// (only osrs-ingest, which also runs the WOM poller, needs write access).
// Set on that container. Everywhere else (local stdio dev, osrs-ingest)
// this is false and the DB is opened read-write, creating the schema on
// first use.
const READONLY = process.env.HISTORY_DB_READONLY === "true";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS metric_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    metric TEXT NOT NULL,
    old_value INTEGER NOT NULL,
    new_value INTEGER NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_metric_history_lookup
    ON metric_history (username, metric, timestamp);

  CREATE TABLE IF NOT EXISTS state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    category TEXT NOT NULL,
    item_name TEXT NOT NULL,
    old_state TEXT NOT NULL,
    new_state TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_state_history_lookup
    ON state_history (username, category, timestamp);
`;

// Retention: keep everything (see project decision log). Rows are tiny and
// only ever written on a genuine change, so this stays small indefinitely.
// If a cap or rollup is wanted later, add a DELETE on the two tables above
// keyed off `timestamp` - the schema needs no migration for that.

export type MetricSource = "plugin" | "wom";

export interface MetricHistoryRow {
  timestamp: string;
  metric: string;
  oldValue: number;
  newValue: number;
  source: MetricSource;
}

export interface StateHistoryRow {
  timestamp: string;
  category: string;
  itemName: string;
  oldState: string;
  newState: string;
}

// Lazily opened, cached only on success. In read-only mode (osrs-mcp) the
// DB file may not exist yet if the ingest side hasn't written anything -
// that's not an error, callers just see empty history until it does. We
// deliberately don't cache a "missing" result, since the file can appear
// at any time without this process restarting.
let db: DatabaseSync | null = null;

function getDb(): DatabaseSync | null {
  if (db) return db;
  try {
    if (READONLY) {
      if (!existsSync(DB_PATH)) return null;
      db = new DatabaseSync(DB_PATH, { readOnly: true });
    } else {
      mkdirSync(SYNC_DIR, { recursive: true });
      db = new DatabaseSync(DB_PATH);
      db.exec(SCHEMA_SQL);
    }
  } catch (err) {
    console.error("Failed to open history DB:", err instanceof Error ? err.message : err);
    return null;
  }
  return db;
}

const insertStatements = new WeakMap<DatabaseSync, { metric: StatementSync; state: StatementSync }>();
const selectStatements = new WeakMap<DatabaseSync, { metric: StatementSync; state: StatementSync }>();

function getInsertStatements(handle: DatabaseSync) {
  let stmts = insertStatements.get(handle);
  if (!stmts) {
    stmts = {
      metric: handle.prepare(
        `INSERT INTO metric_history (username, timestamp, metric, old_value, new_value, source)
         VALUES (?, ?, ?, ?, ?, ?)`
      ),
      state: handle.prepare(
        `INSERT INTO state_history (username, timestamp, category, item_name, old_state, new_state)
         VALUES (?, ?, ?, ?, ?, ?)`
      ),
    };
    insertStatements.set(handle, stmts);
  }
  return stmts;
}

function getSelectStatements(handle: DatabaseSync) {
  let stmts = selectStatements.get(handle);
  if (!stmts) {
    stmts = {
      metric: handle.prepare(
        `SELECT timestamp, metric, old_value AS oldValue, new_value AS newValue, source
         FROM metric_history
         WHERE username = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`
      ),
      state: handle.prepare(
        `SELECT timestamp, category, item_name AS itemName, old_state AS oldState, new_state AS newState
         FROM state_history
         WHERE username = ? AND category = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`
      ),
    };
    selectStatements.set(handle, stmts);
  }
  return stmts;
}

export function recordMetricChange(
  username: string,
  metric: string,
  oldValue: number,
  newValue: number,
  source: MetricSource,
  timestamp: string
): void {
  const handle = getDb();
  if (!handle) {
    console.error(`Dropped metric history row for ${username}/${metric}: history DB unavailable`);
    return;
  }
  getInsertStatements(handle).metric.run(username.toLowerCase(), timestamp, metric, oldValue, newValue, source);
}

export function recordStateChange(
  username: string,
  category: string,
  itemName: string,
  oldState: string,
  newState: string,
  timestamp: string
): void {
  const handle = getDb();
  if (!handle) {
    console.error(`Dropped state history row for ${username}/${category}/${itemName}: history DB unavailable`);
    return;
  }
  getInsertStatements(handle).state.run(username.toLowerCase(), timestamp, category, itemName, oldState, newState);
}

export function getMetricHistory(username: string, metric: string, since: string, until: string): MetricHistoryRow[] {
  const handle = getDb();
  if (!handle) return [];
  return getSelectStatements(handle).metric.all(username.toLowerCase(), metric, since, until) as unknown as MetricHistoryRow[];
}

/**
 * Net change over the window, computed as the sum of recorded deltas
 * (new_value - old_value) for rows in range. Safe because metric_history
 * rows are only ever written on an increase and the old_value/new_value
 * chain is contiguous within a single merged snapshot, so summing deltas
 * equals (value at end of window) - (value at start of window) without
 * needing to know the absolute value just before the window began.
 */
export function getMetricGain(username: string, metric: string, since: string, until: string): number {
  const rows = getMetricHistory(username, metric, since, until);
  return rows.reduce((sum, r) => sum + (r.newValue - r.oldValue), 0);
}

export function getStateHistory(username: string, category: string, since: string, until: string): StateHistoryRow[] {
  const handle = getDb();
  if (!handle) return [];
  return getSelectStatements(handle).state.all(username.toLowerCase(), category, since, until) as unknown as StateHistoryRow[];
}

export { DB_PATH };
