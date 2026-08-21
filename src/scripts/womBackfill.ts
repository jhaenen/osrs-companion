#!/usr/bin/env node
// One-time historical backfill: pulls a player's FULL snapshot history from
// Wise Old Man (going back to whenever WOM started tracking them, well
// before this project's own merge job existed) and reconstructs
// metric_history rows for whatever predates live tracking.
//
// This is a standalone script, not a service - it is never imported by
// ingest.ts, womPoller.ts, or mcpServer.ts, and does not run on a timer.
// It touches metric_history only (INSERT, never UPDATE/DELETE) and never
// touches the live snapshot store (snapshotStore.ts / merge.ts are not
// imported here at all) or state_history (no quest/diary/CA data exists on
// WOM's hiscores to backfill from).
//
// Usage:
//   node dist/scripts/womBackfill.js <username>              (dry run - report only)
//   node dist/scripts/womBackfill.js <username> --commit      (write for real)
//   node dist/scripts/womBackfill.js <username> --commit --allow-rerun
//     (bypass the "wom_backfill rows already exist" guard - only for a
//     deliberate, understood re-run; can create duplicate rows)

import {
  fetchPlayerSnapshots,
  extractMergeableMetricsFromData,
  WOM_SNAPSHOTS_PAGE_SIZE_MAX,
  type WomSnapshotListItem,
} from "../womClient.js";
import { getEarliestMetricTimestamp, countRowsBySource, recordMetricChange } from "../historyStore.js";

const SOURCE = "wom_backfill" as const;

// Comfortably under WOM's unauthenticated rate limit (20 requests/60s per
// their docs - 100/60s with an API key, which this script also honors via
// WOM_API_KEY if set, but stays conservative regardless since this only
// needs to run once and correctness matters far more than speed here).
const REQUEST_INTERVAL_MS = 3500;

interface Args {
  username: string;
  commit: boolean;
  allowRerun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const username = argv.find((a) => !a.startsWith("--"));
  if (!username) {
    console.error("Usage: womBackfill.js <username> [--commit] [--allow-rerun]");
    process.exit(1);
  }
  return { username, commit: flags.has("--commit"), allowRerun: flags.has("--allow-rerun") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFullSnapshotHistory(username: string): Promise<WomSnapshotListItem[]> {
  const all: WomSnapshotListItem[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPlayerSnapshots(username, { limit: WOM_SNAPSHOTS_PAGE_SIZE_MAX, offset });
    if (!page || page.length === 0) break;
    all.push(...page);
    console.log(`  fetched ${page.length} snapshots at offset ${offset} (total so far: ${all.length})`);
    if (page.length < WOM_SNAPSHOTS_PAGE_SIZE_MAX) break;
    offset += WOM_SNAPSHOTS_PAGE_SIZE_MAX;
    await sleep(REQUEST_INTERVAL_MS);
  }
  return all;
}

interface MetricPoint {
  timestamp: string;
  value: number;
}

interface MetricSummary {
  metric: string;
  pulled: number;
  written: number;
  skippedNoChange: number;
  skippedDecrease: number;
  skippedAtOrAfterCutoff: number;
  cutoff: string | null;
  earliestWritten: string | null;
  latestWritten: string | null;
}

async function main(): Promise<void> {
  const { username, commit, allowRerun } = parseArgs();
  const normalizedUsername = username.toLowerCase();

  console.log(`Wise Old Man historical backfill for "${username}"`);
  console.log(`Mode: ${commit ? "COMMIT (will write rows)" : "DRY RUN (report only, no writes)"}`);

  if (!allowRerun) {
    const existing = countRowsBySource(normalizedUsername, SOURCE);
    if (existing > 0) {
      console.error(
        `\nRefusing to run: ${existing} row(s) with source="${SOURCE}" already exist for "${username}".`
      );
      console.error(
        "This script is meant to run once. Re-running without care risks duplicate rows on top of a prior backfill."
      );
      console.error("If you're certain you want to proceed anyway, re-run with --allow-rerun.");
      process.exit(1);
    }
  }

  console.log("\nFetching full snapshot history from Wise Old Man (this may take a while for a long history)...");
  const snapshots = await fetchFullSnapshotHistory(username);

  if (snapshots.length === 0) {
    console.log('No snapshots found for this player on WOM. Nothing to backfill.');
    return;
  }

  snapshots.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  console.log(
    `\nPulled ${snapshots.length} total snapshots, spanning ${snapshots[0].createdAt} -> ${snapshots[snapshots.length - 1].createdAt}`
  );

  // Build one chronological (timestamp, value) series per metric, across
  // every pulled snapshot - same key scheme as the live merge job:
  // "skill:<NAME>" and "kc:<name>".
  const seriesByMetric = new Map<string, MetricPoint[]>();
  for (const snap of snapshots) {
    const { skills, bossKills } = extractMergeableMetricsFromData(snap.data);
    for (const [skill, entry] of Object.entries(skills)) {
      const key = `skill:${skill}`;
      if (!seriesByMetric.has(key)) seriesByMetric.set(key, []);
      seriesByMetric.get(key)!.push({ timestamp: snap.createdAt, value: entry.xp });
    }
    for (const [boss, kc] of Object.entries(bossKills)) {
      const key = `kc:${boss}`;
      if (!seriesByMetric.has(key)) seriesByMetric.set(key, []);
      seriesByMetric.get(key)!.push({ timestamp: snap.createdAt, value: kc });
    }
  }

  const summaries: MetricSummary[] = [];

  for (const [metric, points] of [...seriesByMetric.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Cutoff = earliest timestamp already recorded for this metric from ANY
    // source (plugin push or live wom poll). Only snapshot pairs whose
    // later point falls strictly before this get backfilled - once WOM's
    // own history reaches the point live tracking already covers, stop for
    // this metric and don't touch that range at all.
    const cutoff = getEarliestMetricTimestamp(normalizedUsername, metric);

    const summary: MetricSummary = {
      metric,
      pulled: points.length,
      written: 0,
      skippedNoChange: 0,
      skippedDecrease: 0,
      skippedAtOrAfterCutoff: 0,
      cutoff,
      earliestWritten: null,
      latestWritten: null,
    };

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      if (cutoff !== null && curr.timestamp >= cutoff) {
        summary.skippedAtOrAfterCutoff++;
        continue;
      }
      if (curr.value === prev.value) {
        summary.skippedNoChange++;
        continue;
      }
      if (curr.value < prev.value) {
        // Not expected in normal play (xp/kc are monotonic), but hiscores
        // data can be noisy - skip rather than write a value going backwards.
        summary.skippedDecrease++;
        continue;
      }

      if (commit) {
        recordMetricChange(normalizedUsername, metric, prev.value, curr.value, SOURCE, curr.timestamp);
      }
      summary.written++;
      summary.earliestWritten ??= curr.timestamp;
      summary.latestWritten = curr.timestamp;
    }

    summaries.push(summary);
  }

  console.log("\n=== Backfill summary ===");
  for (const s of summaries) {
    console.log(`\n${s.metric}`);
    console.log(`  snapshots pulled: ${s.pulled}`);
    console.log(`  live-tracking cutoff: ${s.cutoff ?? "(none - no existing history for this metric yet)"}`);
    console.log(`  rows ${commit ? "written" : "that would be written"}: ${s.written}`);
    console.log(`  skipped, no change between consecutive snapshots: ${s.skippedNoChange}`);
    console.log(`  skipped, at/after live-tracking cutoff: ${s.skippedAtOrAfterCutoff}`);
    if (s.skippedDecrease > 0) {
      console.log(`  skipped, value decreased (unexpected, not written): ${s.skippedDecrease}`);
    }
    if (s.written > 0) {
      console.log(`  now covers: ${s.earliestWritten} -> ${s.latestWritten}`);
    }
  }

  const totalWritten = summaries.reduce((sum, s) => sum + s.written, 0);
  const totalPulled = summaries.reduce((sum, s) => sum + s.pulled, 0);
  console.log(`\nTotals: ${totalPulled} metric-snapshots pulled across ${summaries.length} metrics.`);
  console.log(`${commit ? "Wrote" : "Would write"} ${totalWritten} history row(s).`);

  if (!commit) {
    console.log("\nThis was a DRY RUN - no rows were written. Re-run with --commit to apply.");
  }
}

main().catch((err) => {
  console.error("\nBackfill failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
