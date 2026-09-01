import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSyncedPlayers, readSnapshot, SYNC_DIR } from "./snapshotStore.js";
import { getMetricGain, getMetricHistory, getStateHistory } from "./historyStore.js";
import { xpForLevel, formatDuration } from "./osrsXp.js";
import type { PlayerSyncData } from "./schema.js";
import { getDiaryTaskStatus, listDiaryRegions } from "./diaryTasks.js";

const EPOCH = new Date(0).toISOString();

// Resolves a user-supplied metric name to the internal history key. Skills
// are matched case-insensitively against synced skill names; anything else
// falls back to a boss/activity kill-count lookup (WOM's metric names are
// lowercase, e.g. "zulrah", "clue_scrolls_easy"). Deliberately source-
// agnostic - the caller can't tell and doesn't need to know whether a given
// metric's current value most recently moved via the plugin or WOM.
function resolveMetric(
  data: PlayerSyncData,
  metric: string
): { key: string; label: string; kind: "skill" | "kc"; current: number } | null {
  const upper = metric.toUpperCase();
  if (data.skills?.[upper]) {
    return { key: `skill:${upper}`, label: upper, kind: "skill", current: data.skills[upper].xp };
  }
  const lower = metric.toLowerCase();
  if (data.bossKills?.[lower] !== undefined) {
    return { key: `kc:${lower}`, label: lower, kind: "kc", current: data.bossKills[lower] };
  }
  return null;
}

function metricNotFoundMessage(username: string, metric: string, data: PlayerSyncData): string {
  const skills = Object.keys(data.skills ?? {}).join(", ") || "none synced";
  const bossKills = Object.keys(data.bossKills ?? {}).join(", ") || "none synced";
  return `Metric "${metric}" not found for "${username}".\nAvailable skills: ${skills}\nAvailable boss/activity metrics: ${bossKills}`;
}

// diary_task state_history rows store itemName as "REGION:tier:task text"
// (see diffDiaryTasks in merge.ts). Region and tier are both fixed,
// colon-free enums, but task text itself can contain colons - so this only
// ever splits on the first two, never a plain itemName.split(":").
function parseDiaryTaskItemName(itemName: string): { region: string; tier: string; task: string } {
  const firstColon = itemName.indexOf(":");
  const secondColon = itemName.indexOf(":", firstColon + 1);
  return {
    region: itemName.slice(0, firstColon),
    tier: itemName.slice(firstColon + 1, secondColon),
    task: itemName.slice(secondColon + 1),
  };
}

// ── progress_summary_since section builders ──────────────────────────────
// Shared by the combined tool below; each returns the lines for one section
// so `include` can select a subset without duplicating the per-category
// logic that used to live in skill_xp_gained_bulk / boss_kills_gained_bulk /
// diary_tiers_completed_since / collection_log_completed_since.

function buildSkillsSection(username: string, data: PlayerSyncData, sinceIso: string, untilIso: string): string[] {
  if (!data.skills) return ["## Skills", "No skill data synced."];
  // OVERALL is a derived sum of the other skills, not something trained in
  // its own right - reporting it here would double-count the total already
  // visible from summing the per-skill lines below.
  const skillNames = Object.keys(data.skills).filter((s) => s !== "OVERALL");
  const skillGains = skillNames.map((name) => ({
    name,
    gain: getMetricGain(username, `skill:${name}`, sinceIso, untilIso),
  }));
  const totalXpGained = skillGains.reduce((sum, s) => sum + s.gain, 0);
  const lines = [`## Skills — total xp gained: +${totalXpGained.toLocaleString()}`];
  for (const { name, gain } of skillGains) {
    lines.push(`  ${name}: +${gain.toLocaleString()} xp`);
  }
  return lines;
}

function buildBossesSection(username: string, data: PlayerSyncData, sinceIso: string, untilIso: string): string[] {
  if (!data.bossKills) return ["## Boss/Activity Kills", "No boss/activity kill count data synced."];
  const gains = Object.keys(data.bossKills).map((boss) => ({
    boss,
    gain: getMetricGain(username, `kc:${boss}`, sinceIso, untilIso),
  }));
  const metricsWithGains = gains.filter((g) => g.gain > 0).length;
  const lines = [`## Boss/Activity Kills — ${metricsWithGains} of ${gains.length} metrics with activity`];
  for (const { boss, gain } of gains) {
    lines.push(`  ${boss}: +${gain.toLocaleString()} kills`);
  }
  return lines;
}

function buildDiariesSection(username: string, data: PlayerSyncData, sinceIso: string, untilIso: string): string[] {
  if (!data.achievementDiaries) return ["## Achievement Diaries", "No diary data synced."];

  const tierRows = getStateHistory(username, "diary", sinceIso, untilIso);
  const completedByRegion = new Map<string, string[]>();
  for (const row of tierRows) {
    if (row.newState !== "complete") continue;
    const [region, tier] = row.itemName.split(":");
    if (!completedByRegion.has(region)) completedByRegion.set(region, []);
    completedByRegion.get(region)!.push(tier);
  }

  let totalTiersCompleted = 0;
  const lines = ["## Achievement Diaries"];
  for (const [region, diary] of Object.entries(data.achievementDiaries)) {
    const check = (v: boolean) => (v ? "Done" : "---");
    const status = `Easy=${check(diary.easy)} | Med=${check(diary.medium)} | Hard=${check(diary.hard)} | Elite=${check(diary.elite)}`;
    const completed = completedByRegion.get(region) ?? [];
    totalTiersCompleted += completed.length;
    const change = completed.length > 0 ? `completed ${completed.join(", ")}` : "no tier changes";
    lines.push(`  ${region}: ${change} (currently ${status})`);
  }
  lines.push(`Total tiers completed in this period: ${totalTiersCompleted}`);

  const taskRows = getStateHistory(username, "diary_task", sinceIso, untilIso).filter((r) => r.newState === "complete");
  lines.push("", `Individual tasks completed in this period: ${taskRows.length}`);
  if (taskRows.length > 0 && taskRows.length <= 100) {
    for (const row of taskRows) {
      const { region, tier, task } = parseDiaryTaskItemName(row.itemName);
      lines.push(`  ${row.timestamp}: [${region}:${tier}] ${task}`);
    }
  } else if (taskRows.length > 100) {
    lines.push("Too many tasks to list individually.");
  }

  return lines;
}

function buildCollectionLogSection(username: string, data: PlayerSyncData, sinceIso: string, untilIso: string): string[] {
  if (!data.collectionLog) return ["## Collection Log", "No collection log data synced."];

  const totalGain = getMetricGain(username, "clog:total", sinceIso, untilIso);
  const categoryGains = Object.entries(data.collectionLog.categories).map(([name, current]) => ({
    name,
    current,
    gain: getMetricGain(username, `clog:${name}`, sinceIso, untilIso),
  }));
  const itemRows = getStateHistory(username, "collection_log", sinceIso, untilIso).filter((r) => r.newState === "owned");

  const lines = [
    `## Collection Log — ${data.collectionLog.total.completed}/${data.collectionLog.total.possible} (+${totalGain} in this period)`,
  ];
  for (const { name, current, gain } of categoryGains) {
    lines.push(`  ${name}: ${current.completed}/${current.possible} (+${gain} in this period)`);
  }
  lines.push(
    "",
    `Items newly observed as obtained in this period: ${itemRows.length} (best-effort - the category counts above are authoritative; a short/empty item list means "nothing observed", not "nothing happened")`
  );
  if (itemRows.length > 0 && itemRows.length <= 100) {
    for (const row of itemRows) {
      lines.push(`  - ${row.itemName} (${row.timestamp})`);
    }
  } else if (itemRows.length > 100) {
    lines.push("Too many to list individually.");
  }

  return lines;
}

// ── Types ──────────────────────────────────────────────────────────────

interface WikiSearchItem {
  title: string;
  snippet: string;
  pageid: number;
}

interface WikiSearchResponse {
  query?: {
    search?: WikiSearchItem[];
  };
}

interface WikiPage {
  title: string;
  pageid: number;
  missing?: boolean;
  extract?: string;
}

interface WikiPageResponse {
  query?: {
    pages?: WikiPage[];
  };
}

// action=parse's error shape differs from action=query's - a missing page
// is a top-level `error.code === "missingtitle"`, not a `pages[].missing`
// flag like action=query returns.
interface WikiParseResponse {
  parse?: {
    title: string;
    pageid: number;
    text: string;
  };
  error?: {
    code: string;
    info: string;
  };
}

interface WikiItemMapping {
  [itemId: string]: string;
}

// Bucket is the OSRS Wiki's structured-data extension (replacing the
// hard-deprecated Semantic MediaWiki `action=ask`). A successful query
// returns `bucket`; a malformed one (unknown bucket/field name, bad syntax)
// still returns HTTP 200 with `error` set instead of failing the request -
// callers must check `error` explicitly rather than trusting an empty
// `bucket` array to mean "no results".
interface BucketQueryResponse {
  bucketQuery?: string;
  bucket?: Array<Record<string, unknown>>;
  error?: string;
}

interface PriceData {
  high?: number;
  highTime?: number;
  low?: number;
  lowTime?: number;
}

interface PriceResponse {
  data?: {
    [itemId: string]: PriceData;
  };
}

// ── Constants ──────────────────────────────────────────────────────────

const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";
const USER_AGENT = "osrs-companion/1.0 (Node.js; github.com/isaachansen/osrs-companion)";
const WIKI_ATTRIBUTION = "\n\n---\nContent from the [Old School RuneScape Wiki](https://oldschool.runescape.wiki), licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).";

// ── Wiki / Price Helpers ────────────────────────────────────────────────

function pageUrl(title: string): string {
  return `https://oldschool.runescape.wiki/w/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  minus: "−",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_NAMED_ENTITIES[name] ?? m);
}

function htmlFragmentToText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Removes every <span class="{className}">...</span> block, counting nested
// <span> depth rather than stopping at the first </span> - editsection spans
// ("[edit | edit source]") nest a bracket span inside, so a naive non-greedy
// regex only eats the opening bracket and leaks "edit | edit source]" as
// visible text once tags are stripped.
function stripBalancedSpan(html: string, className: string): string {
  const openMarker = `<span class="${className}">`;
  let result = "";
  let i = 0;
  while (i < html.length) {
    const openIdx = html.indexOf(openMarker, i);
    if (openIdx === -1) {
      result += html.slice(i);
      break;
    }
    result += html.slice(i, openIdx);
    const tagRe = /<span\b[^>]*>|<\/span>/gi;
    tagRe.lastIndex = openIdx;
    let depth = 0;
    let closeIdx = -1;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html))) {
      depth += m[0].toLowerCase().startsWith("<span") ? 1 : -1;
      if (depth === 0) {
        closeIdx = m.index + m[0].length;
        break;
      }
    }
    if (closeIdx === -1) {
      result += html.slice(openIdx);
      break;
    }
    i = closeIdx;
  }
  return result;
}

// A <sup class="reference"> footnote marker's visible label sits between two
// cite-bracket spans, e.g. <span class="cite-bracket">[</span>d 1<span
// class="cite-bracket">]</span> - decoded to the literal text "d 1" or "1",
// which is exactly the label used as the reference list's list-position key
// below (both entity and literal bracket forms are tolerated defensively).
const CITE_BRACKET_LABEL_RE =
  /<span class="cite-bracket">(?:\[|&#91;)<\/span>([\s\S]*?)<span class="cite-bracket">(?:\]|&#93;)<\/span>/;
const SUP_REFERENCE_RE = /<sup\b[^>]*class="[^"]*reference[^"]*"[^>]*>([\s\S]*?)<\/sup>/g;

// Wiki editors place a `{{Reflist|group=d}}`-style footnote list immediately
// after the single table it annotates, and each such call independently
// restarts its own numbering - so "d 1" under one table and "d 1" under
// another are unrelated notes, even though the labels collide (confirmed
// against Reward Cart, which has seven independent group="d" lists, one per
// drop table). Ungrouped <ref> citations, in contrast, collect into one
// running page-wide list. So: a *grouped* reflist's entries are scoped only
// to the single table immediately preceding it; an *ungrouped* reflist's
// entries are page-global fallbacks (used for citation-style refs, not
// per-item conditions - kept out of inline resolution, see convertWikiTable).
//
// Single left-to-right scan so "nearest preceding table" falls out of
// position order for free, without needing to special-case section
// boundaries: whichever table's placeholder was most recently emitted is
// still "current" when the next grouped reflist is found, and a new table
// simply replaces it.
function extractTablesAndFootnotes(html: string): {
  html: string;
  tables: string[];
  tableFootnotes: Array<Map<string, string>>;
  globalFootnotes: Map<string, string>;
  footnoteBlocks: string[];
} {
  const tables: string[] = [];
  const tableFootnotes: Array<Map<string, string>> = [];
  const globalFootnotes = new Map<string, string>();
  const footnoteBlocks: string[] = [];
  let currentTable = -1;
  let result = "";
  let i = 0;

  while (i < html.length) {
    const tableIdx = html.indexOf("<table", i);
    const olIdx = html.indexOf('<ol class="references"', i);
    const candidates = [tableIdx, olIdx].filter((x) => x !== -1);
    if (candidates.length === 0) {
      result += html.slice(i);
      break;
    }
    const nextIdx = Math.min(...candidates);
    result += html.slice(i, nextIdx);

    if (nextIdx === tableIdx) {
      const tagRe = /<table\b|<\/table>/gi;
      tagRe.lastIndex = nextIdx;
      let depth = 0;
      let closeIdx = -1;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(html))) {
        depth += m[0].toLowerCase().startsWith("<table") ? 1 : -1;
        if (depth === 0) {
          closeIdx = m.index + m[0].length;
          break;
        }
      }
      if (closeIdx === -1) {
        result += html.slice(nextIdx);
        break;
      }
      tables.push(html.slice(nextIdx, closeIdx));
      tableFootnotes.push(new Map());
      currentTable = tables.length - 1;
      result += ` TABLE${tables.length - 1} `;
      i = closeIdx;
    } else {
      const closeIdx = html.indexOf("</ol>", nextIdx);
      if (closeIdx === -1) {
        result += html.slice(nextIdx);
        break;
      }
      const olEnd = closeIdx + "</ol>".length;
      const olHtml = html.slice(nextIdx, olEnd);
      const groupMatch = /^<ol class="references"\s+data-mw-group="([^"]*)"/.exec(olHtml);
      const group = groupMatch ? groupMatch[1] : undefined;

      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      const lines: string[] = [];
      let n = 0;
      let liMatch: RegExpExecArray | null;
      while ((liMatch = liRe.exec(olHtml))) {
        n++;
        const textMatch = /<span class="reference-text">([\s\S]*?)<\/span>/.exec(liMatch[1]);
        const label = group ? `${group} ${n}` : String(n);
        const noteText = htmlFragmentToText(textMatch ? textMatch[1] : liMatch[1]);
        lines.push(`[${label}] ${noteText}`);
        if (group && currentTable !== -1) {
          tableFootnotes[currentTable].set(label, noteText);
        } else if (!group) {
          globalFootnotes.set(label, noteText);
        }
      }
      if (lines.length > 0) {
        footnoteBlocks.push(lines.join("\n"));
        result += ` FOOTNOTES${footnoteBlocks.length - 1} `;
      }
      i = olEnd;
    }
  }

  return { html: result, tables, tableFootnotes, globalFootnotes, footnoteBlocks };
}

// Renders a wikitable as pipe-delimited rows, one per line, preserving cell
// order. Any footnote marker resolvable against `footnotes` (grouped notes
// scoped to this table - see extractTablesAndFootnotes) is removed and its
// text inlined as "value — NOTE: ..." right in the cell, so reading the
// table doesn't require a second lookup to find and reattach the footnote.
// Markers that aren't in `footnotes` (ungrouped citation refs, or anything
// unresolvable) are left as literal "[label]" text via the generic
// tag-strip fallback, unchanged from before. Rows with no visible text in
// any cell (pure layout/spacer rows) are dropped.
function convertWikiTable(tableHtml: string, footnotes: Map<string, string>): string {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRe.exec(tableHtml))) {
    const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(trMatch[1]))) {
      const notes: string[] = [];
      const resolvedHtml = cellMatch[1].replace(SUP_REFERENCE_RE, (full, supInner: string) => {
        const labelMatch = CITE_BRACKET_LABEL_RE.exec(supInner);
        const label = labelMatch ? htmlFragmentToText(labelMatch[1]) : null;
        const note = label ? footnotes.get(label) : undefined;
        if (note === undefined) return full;
        notes.push(note);
        return "";
      });
      let cellText = htmlFragmentToText(resolvedHtml);
      if (notes.length > 0) cellText += ` — NOTE: ${notes.join(" ")}`;
      cells.push(cellText);
    }
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  }
  if (rows.length === 0) return "";
  return rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
}

// Finds the resolved text of any grouped footnote attached to itemName's own
// row, on any table on the page - used to populate dropsline's `conditions`
// field. Matches by wikilink href rather than visible text (robust to a
// row's link text differing slightly, e.g. capitalization) and only
// considers grouped footnotes, so a citation-style ungrouped ref never gets
// misreported as a drop condition.
function findItemConditions(html: string, itemName: string): string | null {
  const { tables, tableFootnotes } = extractTablesAndFootnotes(html);
  const slug = itemName.trim().replace(/ /g, "_").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hrefRe = new RegExp(`href="/w/${slug}(?:#[^"]*)?"`, "i");
  const notes: string[] = [];

  tables.forEach((tableHtml, tableIndex) => {
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRe.exec(tableHtml))) {
      if (!hrefRe.test(trMatch[1])) continue;
      SUP_REFERENCE_RE.lastIndex = 0;
      let supMatch: RegExpExecArray | null;
      while ((supMatch = SUP_REFERENCE_RE.exec(trMatch[1]))) {
        const labelMatch = CITE_BRACKET_LABEL_RE.exec(supMatch[1]);
        const label = labelMatch ? htmlFragmentToText(labelMatch[1]) : null;
        const note = label ? tableFootnotes[tableIndex].get(label) : undefined;
        if (note && !notes.includes(note)) notes.push(note);
      }
    }
  });

  return notes.length > 0 ? notes.join(" ") : null;
}

// Converts the OSRS Wiki's rendered page HTML (action=parse prop=text) to
// plain text, keeping tables (as pipe-delimited rows) and footnotes (as
// "[n] text" lines right where the wiki places them) instead of dropping
// them the way TextExtracts-based plain text does. That table/footnote
// content is exactly where chained-roll mechanics and conditional edge
// cases live on this wiki, so losing it silently produces confidently
// wrong answers about drop/reward mechanics.
function htmlPageToText(html: string): string {
  let work = html.replace(/<!--[\s\S]*?-->/g, "");
  work = stripBalancedSpan(work, "mw-editsection");

  const { html: withoutTables, tables, tableFootnotes, footnoteBlocks } = extractTablesAndFootnotes(work);
  // Only grouped footnotes (real conditions/mechanics) get inlined - merging
  // in the page-wide ungrouped citation list here would glue an unrelated
  // "video source" blurb onto the same NOTE as an actual gameplay condition.
  // Ungrouped markers are left as bare "[n]" text; the standalone footnote
  // block below (unchanged) still carries their text nearby.
  const convertedTables = tables.map((tableHtml, i) => convertWikiTable(tableHtml, tableFootnotes[i]));

  let text = withoutTables.replace(
    /<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level) - 1)} ${htmlFragmentToText(inner)}\n`
  );
  text = text.replace(/<\/p>/g, "\n\n").replace(/<br\s*\/?>/g, "\n");
  text = text.replace(/<li[^>]*>/g, "\n- ").replace(/<\/li>/g, "");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);

  text = text.replace(/ TABLE(\d+) /g, (_m, i: string) => {
    const converted = convertedTables[Number(i)];
    return converted ? `\n${converted}\n` : "";
  });
  text = text.replace(/ FOOTNOTES(\d+) /g, (_m, i: string) => `\n${footnoteBlocks[Number(i)]}\n`);

  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Serializes all oldschool.runescape.wiki requests (search/summary/bucket/
// parse alike) to roughly 1/second, per the wiki's request etiquette. A
// promise-chain queue rather than a fixed interval timer, so a burst of
// tool calls back-to-back naturally spaces itself out instead of racing.
let wikiRequestQueue: Promise<void> = Promise.resolve();
let lastWikiRequestAt = 0;
const WIKI_MIN_INTERVAL_MS = 1000;

function throttleWiki<T>(fn: () => Promise<T>): Promise<T> {
  const turn = wikiRequestQueue.then(async () => {
    const wait = lastWikiRequestAt + WIKI_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastWikiRequestAt = Date.now();
  });
  wikiRequestQueue = turn.catch(() => {});
  return turn.then(fn);
}

async function wikiFetch<T>(params: Record<string, string>): Promise<T> {
  return throttleWiki(async () => {
    const url = `${WIKI_API}?${new URLSearchParams({ format: "json", ...params })}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Wiki API returned ${res.status}`);
    return res.json() as Promise<T>;
  });
}

// Shared by wiki_parse_page and dropsline's `conditions` enrichment (both
// need a page's rendered HTML) so the action=parse fetch + its
// action=query-incompatible error shape are handled in exactly one place.
async function fetchPageHtml(title: string): Promise<{ html: string; title: string } | { error: string }> {
  const data = await wikiFetch<WikiParseResponse>({
    action: "parse",
    prop: "text",
    formatversion: "2",
    page: title,
  });

  if (data.error) {
    return { error: data.error.code === "missingtitle" ? `Page not found: "${title}"` : `Wiki error: ${data.error.info}` };
  }
  if (!data.parse?.text) {
    return { error: `No content available for "${title}"` };
  }
  return { html: data.parse.text, title: data.parse.title };
}

// Bucket/field names are always lowercase with underscores; rejecting
// anything else up front turns a silently-wrong query into a clear error
// before it ever reaches the wiki.
const BUCKET_NAME_RE = /^[a-z][a-z0-9_]*$/;

function escapeBucketString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function formatBucketValue(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${escapeBucketString(value)}'`;
}

// Builds a Bucket query string, e.g.
// bucket('infobox_item').select('item_id','examine').where('item_name','Raw lobster').limit(50).run()
// Multiple .where() calls are ANDed together (confirmed against the live API).
function buildBucketQuery(
  bucketName: string,
  select: string[],
  where: Array<[string, string | number]>,
  limit: number
): string {
  const selectArgs = select.map((f) => `'${f}'`).join(",");
  let query = `bucket('${bucketName}').select(${selectArgs})`;
  for (const [field, value] of where) {
    query += `.where('${field}',${formatBucketValue(value)})`;
  }
  return `${query}.limit(${limit}).run()`;
}

async function pricesFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${PRICES_API}/${path}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Prices API returned ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Item Mapping Cache ──────────────────────────────────────────────────

let itemMappingCache: WikiItemMapping | null = null;
let itemMappingExpiry = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getItemMapping(): Promise<WikiItemMapping> {
  if (itemMappingCache && Date.now() < itemMappingExpiry) {
    return itemMappingCache;
  }
  const data = await pricesFetch<WikiItemMapping>("mapping");
  const mapping: WikiItemMapping = {};
  if (Array.isArray(data)) {
    for (const item of data as Array<{ id: number; name: string }>) {
      mapping[String(item.id)] = item.name;
    }
  }
  itemMappingCache = mapping;
  itemMappingExpiry = Date.now() + CACHE_TTL;
  return mapping;
}

async function findItemId(name: string): Promise<string | null> {
  const mapping = await getItemMapping();
  const lower = name.toLowerCase();
  for (const [id, itemName] of Object.entries(mapping)) {
    if (itemName.toLowerCase() === lower) return id;
  }
  for (const [id, itemName] of Object.entries(mapping)) {
    if (itemName.toLowerCase().includes(lower)) return id;
  }
  return null;
}

function formatTimeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Synced snapshots come from a push over the network now rather than a
// same-machine file read, so callers should be told how stale the data
// might be rather than treating it as guaranteed-live.
function freshnessLine(lastUpdated: string): string {
  const then = new Date(lastUpdated).getTime();
  if (Number.isNaN(then)) {
    return `Last Updated: ${lastUpdated}`;
  }
  const diffSeconds = Math.floor((Date.now() - then) / 1000);
  const ago =
    diffSeconds < 5
      ? "just now"
      : diffSeconds < 60
        ? `${diffSeconds}s ago`
        : diffSeconds < 3600
          ? `${Math.floor(diffSeconds / 60)}m ago`
          : diffSeconds < 86400
            ? `${Math.floor(diffSeconds / 3600)}h ago`
            : `${Math.floor(diffSeconds / 86400)}d ago`;
  return `Last Updated: ${lastUpdated} (${ago})`;
}

// ── WikiSync Player Cache ───────────────────────────────────────────────

const playerDataCache: Record<string, { data: Record<string, unknown>; fetchedAt: number }> = {};

async function fetchWikiSyncPlayer(
  username: string,
  forceRefresh = false
): Promise<{ data: Record<string, unknown> | null; message?: string }> {
  const now = Date.now();
  const cache = playerDataCache[username];
  if (cache && !forceRefresh && now - cache.fetchedAt < 3600_000) {
    return { data: cache.data };
  }
  const url = `https://sync.runescape.wiki/runelite/player/${encodeURIComponent(username)}/STANDARD`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) {
      return { data: null, message: `WikiSync API returned ${resp.status}` };
    }
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data || Object.keys(data).length === 0) {
      return {
        data: null,
        message:
          "No player data found. Ensure the username is correct and you have the WikiSync plugin installed in RuneLite.",
      };
    }
    playerDataCache[username] = { data, fetchedAt: now };
    return { data };
  } catch (err) {
    return { data: null, message: `Error: ${err instanceof Error ? err.message : "Unknown error"}` };
  }
}

// ── MCP Server ──────────────────────────────────────────────────────────

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "osrs-mcp-companion",
    version: "1.0.0",
  });

  // ── Wiki Tools ──────────────────────────────────────────────────────

  server.tool(
    "search",
    "Search the Old School RuneScape Wiki for articles matching a query",
    {
      query: z.string().describe("Search query (e.g. 'dragon scimitar', 'Zulrah')"),
      limit: z.number().min(1).max(50).default(10).describe("Max results (1-50)"),
    },
    async ({ query, limit }) => {
      const data = await wikiFetch<WikiSearchResponse>({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: String(limit),
      });

      const results = data.query?.search ?? [];
      if (!results.length) {
        return { content: [{ type: "text", text: `No results found for "${query}"` }] };
      }

      const lines = results.map((item, i) => {
        const snippet = stripHtml(item.snippet);
        return `${i + 1}. **${item.title}**\n   ${snippet}\n   ${pageUrl(item.title)}`;
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} results:\n\n${lines.join("\n\n")}${WIKI_ATTRIBUTION}` }],
      };
    }
  );

  server.tool(
    "summary",
    "Get the introductory summary of an OSRS Wiki page",
    {
      title: z.string().describe("Exact page title (e.g. 'Abyssal whip', 'Farming')"),
    },
    async ({ title }) => {
      const data = await wikiFetch<WikiPageResponse>({
        action: "query",
        prop: "extracts",
        exintro: "1",
        explaintext: "1",
        formatversion: "2",
        titles: title,
      });

      const page = data.query?.pages?.[0];
      if (!page || page.missing) {
        return { content: [{ type: "text", text: `Page not found: "${title}"` }] };
      }

      const extract = page.extract?.trim();
      if (!extract) {
        return { content: [{ type: "text", text: `No summary available for "${page.title}"` }] };
      }

      return {
        content: [{ type: "text", text: `# ${page.title}\n\n${extract}\n\n${pageUrl(page.title)}${WIKI_ATTRIBUTION}` }],
      };
    }
  );

  server.tool(
    "wiki_query",
    "Query the OSRS Wiki's structured data (Bucket API) for precise facts: drop rates, monster combat stats, item stats/examine text, GE metadata, combat achievement tasks. " +
      "Prefer this over `summary` or `wiki_parse_page` whenever the fact in question is structured data, since prose parsing risks misreading. " +
      "Known buckets and a few of their fields (schemas aren't exhaustively documented - if a field name is rejected by the wiki, try common variants or fall back to wiki_parse_page): " +
      "infobox_item (item_name, item_id, examine, value, high_alchemy_value, weight, tradeable, buy_limit); " +
      "infobox_monster (name, combat_level, hitpoints, max_hit, attack_level, strength_level, defence_level, ranged_level, magic_level, slayer_level, slayer_category); " +
      "dropsline (page_name, item_name, drop_json - drop_json is a JSON string with Rarity, Drop Quantity, Dropped item, Dropped from, Rolls, etc, one row per drop); " +
      "exchange (id, name, value, high_alch, low_alch, limit); " +
      "combat_achievement (id, name, monster, task, tier, type). " +
      "Every bucket also accepts an implicit `page_name` filter (the wiki page a row came from), even though it isn't in the bucket's own field list - use `where: { page_name: 'X' }` to fetch every row tied to one page in a single call (e.g. an entire drop table) instead of one call per item_name. " +
      "dropsline responses always include page_name, item_name, and a `conditions` field regardless of what you selected: `conditions` is auto-resolved from the source page's own drop-table footnotes (a shared/chained roll, a \"redirect to a different item once you already have N\" rule, a tie-break order, etc) and is explicitly `null` when the wiki records no such condition for that row - treat a non-null `conditions` value as load-bearing, not a footnote to skip. Rarity alone is only trustworthy when conditions is null. Enrichment is capped at 5 distinct source pages per call (skipped rows still get `conditions: null`, which is then \"not checked\" rather than \"confirmed none\" - narrow with `where: { page_name: ... }` and re-run if that matters); for anything still unclear after that, wiki_parse_page on the source page has the full table.",
    {
      bucket: z.string().describe("Bucket name, e.g. 'infobox_item', 'infobox_monster', 'dropsline', 'exchange', 'combat_achievement'"),
      select: z.array(z.string()).min(1).describe("Fields to return, e.g. ['item_id', 'examine']"),
      where: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .describe("Equality filters as field -> value, e.g. { item_name: 'Raw lobster' }. Multiple entries are ANDed together."),
      limit: z.number().min(1).max(500).default(50).describe("Max rows to return (1-500)"),
    },
    async ({ bucket, select, where, limit }) => {
      const bucketName = bucket.trim().toLowerCase();
      if (!BUCKET_NAME_RE.test(bucketName)) {
        return {
          content: [{ type: "text", text: `Invalid bucket name: "${bucket}". Bucket names are lowercase with underscores, e.g. "infobox_item".` }],
        };
      }

      const fields = select.map((f) => f.trim().toLowerCase());
      const badField = fields.find((f) => !BUCKET_NAME_RE.test(f));
      if (badField) {
        return {
          content: [{ type: "text", text: `Invalid field name: "${badField}". Field names are lowercase with underscores.` }],
        };
      }

      const whereEntries = Object.entries(where ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v] as [string, string | number]);
      const badWhereField = whereEntries.find(([k]) => !BUCKET_NAME_RE.test(k));
      if (badWhereField) {
        return {
          content: [{ type: "text", text: `Invalid filter field name: "${badWhereField[0]}". Field names are lowercase with underscores.` }],
        };
      }

      const isDropsline = bucketName === "dropsline";
      // dropsline's `conditions` enrichment (below) needs to correlate each
      // row back to a spot on its source page, so page_name/item_name are
      // forced into the query regardless of what the caller selected.
      const queryFields = isDropsline ? Array.from(new Set([...fields, "page_name", "item_name"])) : fields;

      const query = buildBucketQuery(bucketName, queryFields, whereEntries, limit);
      const data = await wikiFetch<BucketQueryResponse>({ action: "bucket", query });

      if (data.error) {
        return {
          content: [{ type: "text", text: `Bucket query error: ${data.error}\n\nQuery: ${data.bucketQuery ?? query}` }],
        };
      }

      let rows = data.bucket ?? [];
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No rows found for bucket "${bucketName}" with the given fields/filters.\n\nQuery: ${query}` }],
        };
      }

      let dropslineCaveat = "";
      if (isDropsline) {
        // Bucket's flat Rarity can't itself represent a shared/chained roll
        // (see tool description) - the only real fix is reading the source
        // page's own footnotes, so fetch each distinct page (capped, since
        // a broad item_name-only query can span many monsters' pages) and
        // resolve a `conditions` field per row from them.
        const MAX_CONDITION_PAGES = 5;
        const distinctPages = Array.from(new Set(rows.map((r) => String(r.page_name ?? "")).filter((p) => p.length > 0)));
        const pagesToFetch = distinctPages.slice(0, MAX_CONDITION_PAGES);

        const pageHtmlByName = new Map<string, string>();
        for (const pageName of pagesToFetch) {
          const result = await fetchPageHtml(pageName);
          if (!("error" in result)) pageHtmlByName.set(pageName, result.html);
        }

        rows = rows.map((row) => {
          const pageHtml = pageHtmlByName.get(String(row.page_name ?? ""));
          const itemName = String(row.item_name ?? "");
          const conditions = pageHtml && itemName ? findItemConditions(pageHtml, itemName) : null;
          return { ...row, conditions };
        });

        const skippedPages = distinctPages.length - pagesToFetch.length;
        dropslineCaveat =
          skippedPages > 0
            ? `\n\nNote: results span ${distinctPages.length} source pages; conditions were only checked for the first ${MAX_CONDITION_PAGES} (\`conditions: null\` on rows from the other ${skippedPages} page(s) means "not checked", not "confirmed none"). Narrow with where: { page_name: ... } to cover a skipped page.`
            : "";
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${rows.length} row(s) from bucket "${bucketName}":\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`${dropslineCaveat}${WIKI_ATTRIBUTION}`,
          },
        ],
      };
    }
  );

  server.tool(
    "wiki_parse_page",
    "Get the full text of an OSRS Wiki page (every section, not just the intro `summary` gives), including tables (rendered as pipe-delimited rows) and footnotes (rendered as \"[n] note text\" lines directly after the table they annotate). " +
      "Use for quest guides, mechanics writeups, reward/drop-roll tables, and strategy content not covered by wiki_query's structured data. Footnotes are frequently where the non-obvious edge cases live (conditional redirects, tie-breaks, \"unless already have X\") - do not skip them when a table is present. " +
      "Prefer wiki_query instead whenever the fact in question is plain structured data (a single item's stats, a monster's combat level) with no shared/conditional mechanic involved.",
    {
      title: z.string().describe("Exact page title (e.g. 'Dragon Slayer I', 'Reward Cart')"),
    },
    async ({ title }) => {
      const result = await fetchPageHtml(title);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }] };
      }

      const text = htmlPageToText(result.html);
      if (!text) {
        return { content: [{ type: "text", text: `No content available for "${result.title}"` }] };
      }

      return {
        content: [{ type: "text", text: `# ${result.title}\n\n${text}\n\n${pageUrl(result.title)}${WIKI_ATTRIBUTION}` }],
      };
    }
  );

  server.tool(
    "price",
    "Look up the current Grand Exchange price for an item",
    {
      item: z.string().describe("Item name (e.g. 'Abyssal whip', 'Dragon bones')"),
    },
    async ({ item }) => {
      const itemId = await findItemId(item);
      if (!itemId) {
        return { content: [{ type: "text", text: `Item not found: "${item}". Try the exact in-game name.` }] };
      }

      const data = await pricesFetch<PriceResponse>(`latest?id=${itemId}`);
      const price = data.data?.[itemId];
      if (!price) {
        return { content: [{ type: "text", text: `No price data available for "${item}"` }] };
      }

      const mapping = await getItemMapping();
      const name = mapping[itemId] ?? item;

      const lines = [`# ${name} — Grand Exchange Price`];
      if (price.high != null) {
        const ago = price.highTime ? ` (${formatTimeAgo(price.highTime)})` : "";
        lines.push(`Buy (instant): ${price.high.toLocaleString()} gp${ago}`);
      }
      if (price.low != null) {
        const ago = price.lowTime ? ` (${formatTimeAgo(price.lowTime)})` : "";
        lines.push(`Sell (instant): ${price.low.toLocaleString()} gp${ago}`);
      }
      lines.push("", pageUrl(name));

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "player",
    "Fetch RuneLite player data via the WikiSync plugin (requires RuneLite client)",
    {
      username: z.string().describe("RuneLite username"),
      forceRefresh: z.boolean().default(false).describe("Force refresh cached data"),
    },
    async ({ username, forceRefresh }) => {
      if (!username.trim()) {
        return { content: [{ type: "text", text: "Please provide a RuneLite username." }] };
      }
      const { data, message } = await fetchWikiSyncPlayer(username, forceRefresh);
      if (!data) {
        return { content: [{ type: "text", text: message ?? "No player data found." }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `# ${username} — Player Data (via WikiSync)\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
          },
        ],
      };
    }
  );

  // ── Player Sync Tools (reads snapshots pushed by the plugin) ────────

  server.tool(
    "list_synced_players",
    "List all players that have synced data from RuneLite. Use this first to find available usernames.",
    {},
    async () => {
      const players = await listSyncedPlayers();
      if (players.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No synced players found. Make sure the OSRS MCP Companion RuneLite plugin is running and configured to push to this server, and that you've logged in.\n\nSnapshot directory: ${SYNC_DIR}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `Synced players: ${players.join(", ")}` }] };
    }
  );

  server.tool(
    "get_my_profile",
    "Get a full summary of synced player data including stats, quest count, bank size, and diary progress. Data is pushed from RuneLite via the companion plugin.",
    {
      username: z.string().describe("Player username"),
    },
    async ({ username }) => {
      const data = await readSnapshot(username);
      if (!data) {
        const players = await listSyncedPlayers();
        const hint = players.length > 0 ? ` Available players: ${players.join(", ")}` : "";
        return {
          content: [
            {
              type: "text",
              text: `No synced data found for "${username}".${hint}\n\nMake sure the OSRS MCP Companion RuneLite plugin is running and has pushed data.`,
            },
          ],
        };
      }

      const lines: string[] = [`# ${data.player.username} — Synced Profile`];
      lines.push(`Combat Level: ${data.player.combatLevel} | World: ${data.player.world}`);
      lines.push(freshnessLine(data.lastUpdated));

      if (data.skills) {
        const totalLevel =
          data.skills.OVERALL?.level ??
          Object.values(data.skills).reduce((sum, s) => sum + s.level, 0);
        lines.push(`\n## Skills — Total Level: ${totalLevel}`);
        for (const [skill, entry] of Object.entries(data.skills)) {
          if (skill === "OVERALL") continue;
          lines.push(`  ${skill}: ${entry.level} (${entry.xp.toLocaleString()} xp)`);
        }
      }

      if (data.quests) {
        const finished = data.quests.filter((q) => q.state === "FINISHED").length;
        const inProgress = data.quests.filter((q) => q.state === "IN_PROGRESS").length;
        const notStarted = data.quests.filter((q) => q.state === "NOT_STARTED").length;
        lines.push(
          `\n## Quests — ${finished} complete, ${inProgress} in progress, ${notStarted} not started`
        );
      }

      if (data.bank) {
        lines.push(
          `\n## Bank — ${data.bank.totalItems} unique items across ${data.bank.tabs.length} tabs`
        );
      }

      if (data.achievementDiaries) {
        lines.push("\n## Achievement Diaries");
        for (const [region, diary] of Object.entries(data.achievementDiaries)) {
          const tiers = [
            diary.easy ? "Easy" : null,
            diary.medium ? "Medium" : null,
            diary.hard ? "Hard" : null,
            diary.elite ? "Elite" : null,
          ].filter(Boolean);
          lines.push(
            `  ${region}: ${tiers.length > 0 ? tiers.join(", ") : "None complete"}`
          );
        }
      }

      if (data.combatAchievements) {
        const ca = data.combatAchievements;
        lines.push(`\n## Combat Achievements — ${ca.completedTasks.length} tasks complete`);
        lines.push(
          `  Easy: ${ca.easyComplete ? "Done" : "Incomplete"} | Medium: ${ca.mediumComplete ? "Done" : "Incomplete"} | Hard: ${ca.hardComplete ? "Done" : "Incomplete"} | Elite: ${ca.eliteComplete ? "Done" : "Incomplete"}`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_bank",
    "Search and browse the player's synced bank contents, including Potion Storage (shown as its own clearly-labeled section, never mixed into the numbered bank tabs since it's a separate storage location). Supports filtering by item name, bank tab, and minimum quantity.",
    {
      username: z.string().describe("Player username"),
      search: z.string().optional().describe("Search term to filter items by name (case-insensitive)"),
      tab: z.number().optional().describe("Bank tab number to filter (0-indexed). Does not affect Potion Storage, which has no tab of its own."),
      minQuantity: z.number().optional().describe("Only show items with at least this quantity"),
    },
    async ({ username, search, tab, minQuantity }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.bank?.tabs && !data.potionStorage) {
        return {
          content: [{ type: "text", text: `No bank data synced for "${username}". Open your bank in-game to sync.` }],
        };
      }

      // Defense in depth: a real bank entry should never have quantity <=
      // 0. The known cause (bank placeholders) is filtered at the plugin
      // source now, but this guards against any other stray zero/missing-
      // quantity row reaching here without one showing up as a phantom item.
      let allItems = (data.bank?.tabs ?? [])
        .flatMap((t) => t.items.map((item) => ({ ...item, tab: t.tabIndex })))
        .filter((item) => (item.quantity ?? 0) > 0);

      let potionItems = (data.potionStorage ?? []).filter((item) => (item.quantity ?? 0) > 0);

      if (search) {
        const term = search.toLowerCase();
        allItems = allItems.filter((item) => (item.name ?? "").toLowerCase().includes(term));
        potionItems = potionItems.filter((item) => (item.name ?? "").toLowerCase().includes(term));
      }
      if (tab !== undefined) {
        allItems = allItems.filter((item) => item.tab === tab);
      }
      if (minQuantity !== undefined) {
        allItems = allItems.filter((item) => item.quantity >= minQuantity);
        potionItems = potionItems.filter((item) => item.quantity >= minQuantity);
      }

      if (allItems.length === 0 && potionItems.length === 0) {
        return { content: [{ type: "text", text: `No matching items found in ${username}'s bank.` }] };
      }

      const lines: string[] = [
        `# ${username}'s Bank — ${allItems.length + potionItems.length} items found`,
        freshnessLine(data.lastUpdated),
      ];
      // Always show the quantity, even at exactly 1: this list is filtered
      // to quantity > 0 upstream, so an item with no quantity shown at all
      // reads as indistinguishable from a phantom/placeholder entry - which
      // is exactly the false alarm a hidden "x1" caused once already.
      for (const item of allItems) {
        lines.push(`  [Tab ${item.tab}] ${item.name} x${item.quantity.toLocaleString()} (ID: ${item.itemId})`);
      }
      if (potionItems.length > 0) {
        lines.push("", "## Potion Storage");
        for (const item of potionItems) {
          lines.push(`  ${item.name} x${item.quantity.toLocaleString()} (${item.doses.toLocaleString()} doses, ID: ${item.itemId})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_stats",
    "Get the player's synced skill levels and XP. Optionally filter to a specific skill.",
    {
      username: z.string().describe("Player username"),
      skill: z.string().optional().describe("Specific skill name (e.g. 'ATTACK', 'MINING'). Omit for all skills."),
    },
    async ({ username, skill }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.skills) {
        return { content: [{ type: "text", text: `No skill data synced for "${username}".` }] };
      }

      if (skill) {
        const key = skill.toUpperCase();
        const entry = data.skills[key];
        if (!entry) {
          return {
            content: [
              { type: "text", text: `Skill "${skill}" not found. Available: ${Object.keys(data.skills).join(", ")}` },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `# ${username} — ${key}\n${freshnessLine(data.lastUpdated)}\nLevel: ${entry.level}\nXP: ${entry.xp.toLocaleString()}`,
            },
          ],
        };
      }

      const lines: string[] = [`# ${username}'s Skills`, freshnessLine(data.lastUpdated)];
      for (const [name, entry] of Object.entries(data.skills)) {
        lines.push(`  ${name}: ${entry.level} (${entry.xp.toLocaleString()} xp)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_quests",
    "Get the player's synced quest completion status. Filter by state or search by name.",
    {
      username: z.string().describe("Player username"),
      state: z.enum(["NOT_STARTED", "IN_PROGRESS", "FINISHED"]).optional().describe("Filter by quest state"),
      search: z.string().optional().describe("Search term to filter quests by name"),
    },
    async ({ username, state, search }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.quests) {
        return { content: [{ type: "text", text: `No quest data synced for "${username}".` }] };
      }

      let quests = data.quests;
      if (state) {
        quests = quests.filter((q) => q.state === state);
      }
      if (search) {
        const term = search.toLowerCase();
        quests = quests.filter((q) => q.displayName.toLowerCase().includes(term));
      }

      if (quests.length === 0) {
        return { content: [{ type: "text", text: "No matching quests found." }] };
      }

      const lines: string[] = [`# ${username}'s Quests — ${quests.length} results`, freshnessLine(data.lastUpdated)];
      for (const q of quests) {
        const icon =
          q.state === "FINISHED"
            ? "[Done]"
            : q.state === "IN_PROGRESS"
              ? "[In Progress]"
              : "[Not Started]";
        lines.push(`  ${icon} ${q.displayName}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_equipment",
    "Get the player's currently equipped items (last synced state).",
    {
      username: z.string().describe("Player username"),
    },
    async ({ username }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.equipment) {
        return { content: [{ type: "text", text: `No equipment data synced for "${username}".` }] };
      }

      const lines: string[] = [`# ${username}'s Equipment`, freshnessLine(data.lastUpdated)];
      for (const [slot, item] of Object.entries(data.equipment)) {
        if (item.itemId === -1) {
          lines.push(`  ${slot}: (empty)`);
        } else {
          lines.push(`  ${slot}: ${item.name} (ID: ${item.itemId})`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_inventory",
    "Get the player's current inventory contents (last synced state).",
    {
      username: z.string().describe("Player username"),
    },
    async ({ username }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.inventory) {
        return { content: [{ type: "text", text: `No inventory data synced for "${username}".` }] };
      }

      const items = data.inventory.filter((i) => i.itemId !== -1);
      if (items.length === 0) {
        return { content: [{ type: "text", text: `${username}'s inventory is empty.` }] };
      }

      const lines: string[] = [`# ${username}'s Inventory — ${items.length} items`, freshnessLine(data.lastUpdated)];
      for (const item of items) {
        const qty = item.quantity > 1 ? ` x${item.quantity.toLocaleString()}` : "";
        lines.push(`  [Slot ${item.slot}] ${item.name}${qty}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_diaries",
    "Get the player's achievement diary completion status. Optionally filter by region.",
    {
      username: z.string().describe("Player username"),
      region: z.string().optional().describe("Specific diary region (e.g. 'ARDOUGNE', 'VARROCK')"),
    },
    async ({ username, region }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.achievementDiaries) {
        return { content: [{ type: "text", text: `No diary data synced for "${username}".` }] };
      }

      let diaries = Object.entries(data.achievementDiaries);
      if (region) {
        const key = region.toUpperCase();
        diaries = diaries.filter(([r]) => r.toUpperCase() === key);
        if (diaries.length === 0) {
          return {
            content: [
              { type: "text", text: `Region "${region}" not found. Available: ${Object.keys(data.achievementDiaries).join(", ")}` },
            ],
          };
        }
      }

      const lines: string[] = [`# ${username}'s Achievement Diaries`, freshnessLine(data.lastUpdated)];
      for (const [name, diary] of diaries) {
        const check = (v: boolean) => (v ? "Done" : "---");
        lines.push(
          `  ${name}: Easy=${check(diary.easy)} | Med=${check(diary.medium)} | Hard=${check(diary.hard)} | Elite=${check(diary.elite)}`
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_diary_tasks",
    "Get per-task Achievement Diary completion (task name + done/not-done), not just the tier-level summary get_my_diaries gives. " +
      "Defaults to each region's next incomplete tier; pass `tier` to see a specific tier, or `allTiers` to see everything.",
    {
      username: z.string().describe("Player username"),
      region: z.string().optional().describe("Specific diary region (e.g. 'ARDOUGNE', 'VARROCK'). Omit for all regions."),
      tier: z.enum(["easy", "medium", "hard", "elite"]).optional().describe("Specific tier. Omit to use the next incomplete tier."),
      allTiers: z.boolean().optional().describe("Show all 4 tiers instead of just the next incomplete one."),
    },
    async ({ username, region, tier, allTiers }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.achievementDiaries || !data.diaryTaskVarps) {
        return {
          content: [
            {
              type: "text",
              text: `No per-task diary data synced for "${username}" yet (needs a recent plugin sync with diary syncing enabled).`,
            },
          ],
        };
      }

      let regions = Object.keys(data.achievementDiaries);
      if (region) {
        const key = region.toUpperCase();
        regions = regions.filter((r) => r.toUpperCase() === key);
        if (regions.length === 0) {
          return {
            content: [
              { type: "text", text: `Region "${region}" not found. Available: ${listDiaryRegions().join(", ")}` },
            ],
          };
        }
      }

      const TIERS = ["easy", "medium", "hard", "elite"] as const;
      const lines: string[] = [`# ${username}'s Achievement Diary tasks`, freshnessLine(data.lastUpdated)];

      for (const r of regions) {
        const diary = data.achievementDiaries[r];
        let tiersToShow: (typeof TIERS)[number][];
        if (tier) {
          tiersToShow = [tier];
        } else if (allTiers) {
          tiersToShow = [...TIERS];
        } else {
          const nextIncomplete = TIERS.find((t) => !diary[t]);
          tiersToShow = nextIncomplete ? [nextIncomplete] : ["elite"]; // fully complete - show elite as the summary
        }

        lines.push(`\n## ${r}`);
        for (const t of tiersToShow) {
          const tasks = getDiaryTaskStatus(r, t, data.diaryTaskVarps, data.diaryTaskVarbits);
          if (!tasks) {
            lines.push(`  ${t}: no per-task data available for this region/tier`);
            continue;
          }
          const doneCount = tasks.filter((x) => x.done).length;
          lines.push(`  ${t[0].toUpperCase()}${t.slice(1)} (${doneCount}/${tasks.length} done)${diary[t] ? " - TIER COMPLETE" : ""}:`);
          for (const task of tasks) {
            lines.push(`    [${task.done ? "x" : " "}] ${task.name}`);
            // Requirements only for outstanding tasks - a done task's
            // requirements aren't useful for planning what's left to do,
            // and this tool exists specifically so callers don't have to
            // go look them up elsewhere for the tasks that still matter.
            if (!task.done) {
              for (const req of task.requirements) {
                lines.push(`        - ${req}`);
              }
            }
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_my_combat_achievements",
    "Get the player's combat achievement completion status. Optionally search by task name.",
    {
      username: z.string().describe("Player username"),
      search: z.string().optional().describe("Search term to filter by task name"),
    },
    async ({ username, search }) => {
      const data = await readSnapshot(username);
      if (!data) {
        return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      }
      if (!data.combatAchievements) {
        return {
          content: [{ type: "text", text: `No combat achievement data synced for "${username}".` }],
        };
      }

      const ca = data.combatAchievements;
      const lines: string[] = [`# ${username}'s Combat Achievements`, freshnessLine(data.lastUpdated)];
      lines.push(
        `Easy: ${ca.easyComplete ? "Complete" : "Incomplete"} | Medium: ${ca.mediumComplete ? "Complete" : "Incomplete"} | Hard: ${ca.hardComplete ? "Complete" : "Incomplete"} | Elite: ${ca.eliteComplete ? "Complete" : "Incomplete"}`
      );
      lines.push(`Completed tasks: ${ca.completedTasks.length}`);

      let tasks = ca.completedTasks;
      if (search) {
        const term = search.toLowerCase();
        tasks = tasks.filter((t) => t.toLowerCase().includes(term));
        lines.push(`\nMatching "${search}": ${tasks.length} tasks`);
      }

      if (tasks.length > 0 && tasks.length <= 100) {
        lines.push("");
        for (const task of tasks) {
          lines.push(`  [Done] ${task}`);
        }
      } else if (tasks.length > 100) {
        lines.push(
          `\nToo many tasks to display (${tasks.length}). Use the search parameter to filter.`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── History Tools (read from local storage only, no live WOM calls) ──

  server.tool(
    "skill_xp_gained",
    "Get xp (for a skill) or kill count (for a boss/activity) gained over a time period, computed from stored history. Works for any synced skill (e.g. 'MINING') or boss/activity metric (e.g. 'zulrah', 'clue_scrolls_easy') - the merged snapshot doesn't distinguish where the data came from.",
    {
      username: z.string().describe("Player username"),
      metric: z.string().describe("Skill name (e.g. 'COOKING') or boss/activity name (e.g. 'zulrah')"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure gain from. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 timestamp to measure gain until. Defaults to now."),
    },
    async ({ username, metric, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const resolved = resolveMetric(data, metric);
      if (!resolved) return { content: [{ type: "text", text: metricNotFoundMessage(username, metric, data) }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const gain = getMetricGain(username, resolved.key, sinceIso, untilIso);
      const unit = resolved.kind === "skill" ? "xp" : "kills";

      if (gain === 0) {
        return { content: [{ type: "text", text: `No change in ${resolved.label} between ${sinceIso} and ${untilIso}.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `# ${username} — ${resolved.label} gained\n${sinceIso} → ${untilIso}\n+${gain.toLocaleString()} ${unit}\nCurrent: ${resolved.current.toLocaleString()}`,
          },
        ],
      };
    }
  );

  const SUMMARY_SECTIONS = ["skills", "bosses", "diaries", "collection_log"] as const;

  server.tool(
    "progress_summary_since",
    "Get a combined progress summary over a time period in one call: skill xp gains, boss/activity kill gains, achievement diary tier + per-task completions, and collection log progress - all computed from stored history. Use this instead of calling the individual per-category history tools when answering a general 'how did I do' question. Pass `include` to narrow the response to just the section(s) a more specific question needs (e.g. `[\"skills\"]` for a skill-only question).",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure gains from. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 timestamp to measure gains until. Defaults to now."),
      include: z
        .array(z.enum(SUMMARY_SECTIONS))
        .optional()
        .describe("Sections to include: any of 'skills', 'bosses', 'diaries', 'collection_log'. Omit for all sections."),
    },
    async ({ username, since, until, include }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const sections = new Set(include && include.length > 0 ? include : SUMMARY_SECTIONS);

      const lines: string[] = [`# ${username} — Progress summary`, `${sinceIso} → ${untilIso}`, ""];
      if (sections.has("skills")) lines.push(...buildSkillsSection(username, data, sinceIso, untilIso), "");
      if (sections.has("bosses")) lines.push(...buildBossesSection(username, data, sinceIso, untilIso), "");
      if (sections.has("diaries")) lines.push(...buildDiariesSection(username, data, sinceIso, untilIso), "");
      if (sections.has("collection_log")) lines.push(...buildCollectionLogSection(username, data, sinceIso, untilIso), "");

      return { content: [{ type: "text", text: lines.join("\n").trimEnd() }] };
    }
  );

  server.tool(
    "skill_xp_timeline",
    "Get the time series of changes for a skill or boss/activity metric over a date range, computed from stored history (not a live WOM call).",
    {
      username: z.string().describe("Player username"),
      metric: z.string().describe("Skill name (e.g. 'COOKING') or boss/activity name (e.g. 'zulrah')"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to 30 days ago."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, metric, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const resolved = resolveMetric(data, metric);
      if (!resolved) return { content: [{ type: "text", text: metricNotFoundMessage(username, metric, data) }] };

      const sinceIso = since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const rows = getMetricHistory(username, resolved.key, sinceIso, untilIso);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No changes in ${resolved.label} between ${sinceIso} and ${untilIso}.` }] };
      }

      const lines = [`# ${username} — ${resolved.label} timeline`, `${sinceIso} → ${untilIso}`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.oldValue.toLocaleString()} → ${row.newValue.toLocaleString()} (+${(row.newValue - row.oldValue).toLocaleString()})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "cooking_progress_since",
    "Estimate time remaining until a target Cooking level (default 99), by projecting the xp/hour rate observed since a given time. Combines xp-gained history with a simple burn-rate calculation.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 timestamp to measure the xp rate from. Defaults to 7 days ago."),
      targetLevel: z.number().min(2).max(99).default(99).describe("Target Cooking level"),
    },
    async ({ username, since, targetLevel }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };

      const cooking = data.skills?.COOKING;
      if (!cooking) return { content: [{ type: "text", text: `No Cooking data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = new Date().toISOString();
      const gained = getMetricGain(username, "skill:COOKING", sinceIso, untilIso);
      const elapsedHours = (Date.parse(untilIso) - Date.parse(sinceIso)) / 3_600_000;

      if (gained <= 0 || elapsedHours <= 0) {
        return { content: [{ type: "text", text: `No Cooking xp gained since ${sinceIso} — can't estimate a rate.` }] };
      }

      const targetXp = xpForLevel(targetLevel);
      const xpRemaining = targetXp - cooking.xp;
      if (xpRemaining <= 0) {
        return {
          content: [
            { type: "text", text: `${username} has already reached level ${targetLevel} Cooking (current: level ${cooking.level}, ${cooking.xp.toLocaleString()} xp).` },
          ],
        };
      }

      const xpPerHour = gained / elapsedHours;
      const hoursRemaining = xpRemaining / xpPerHour;

      const lines = [
        `# ${username} — Cooking progress toward level ${targetLevel}`,
        `Current: level ${cooking.level} (${cooking.xp.toLocaleString()} xp)`,
        `Rate since ${sinceIso}: +${Math.round(xpPerHour).toLocaleString()} xp/hour (${gained.toLocaleString()} xp over ${elapsedHours.toFixed(1)}h)`,
        `Xp remaining to level ${targetLevel}: ${xpRemaining.toLocaleString()}`,
        `Estimated time at this rate: ${formatDuration(hoursRemaining)}`,
        "",
        "Projects the recent rate forward assuming similar play patterns continue.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "quest_history",
    "Get quest state changes (e.g. started, completed) for a player over a date range. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "quest", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No quest changes recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Quest history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "diary_history",
    "Get achievement diary tier completions for a player over a date range. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "diary", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No diary changes recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Achievement diary history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "diary_task_history",
    "Get per-task Achievement Diary completions for a player over a date range - which individual task flipped to complete, its region and tier, and when, rather than just the tier-level rollup diary_history gives. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      region: z.string().optional().describe("Filter to a specific diary region (e.g. 'VARROCK'). Omit for all regions."),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, region, since, until }) => {
      const rows = getStateHistory(username, "diary_task", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No per-task diary changes recorded for "${username}" in this range.` }] };
      }

      let parsed = rows.map((row) => ({ ...row, ...parseDiaryTaskItemName(row.itemName) }));
      if (region) {
        const key = region.toUpperCase();
        parsed = parsed.filter((r) => r.region.toUpperCase() === key);
        if (parsed.length === 0) {
          return {
            content: [
              { type: "text", text: `No per-task diary changes for region "${region}" in this range. Available: ${listDiaryRegions().join(", ")}` },
            ],
          };
        }
      }

      const lines = [`# ${username} — Achievement diary task history`, ""];
      for (const row of parsed) {
        lines.push(`  ${row.timestamp}: [${row.region}:${row.tier}] ${row.task} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "combat_achievements_completed_since",
    "Get combat achievement progress over a time range in one call - task completion count plus which tiers were newly finished, computed from stored history, alongside current tier status. Complements combat_achievement_history, which lists raw completion events without this summary/current-status framing.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to 7 days ago."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const data = await readSnapshot(username);
      if (!data) return { content: [{ type: "text", text: `No synced data found for "${username}".` }] };
      if (!data.combatAchievements) return { content: [{ type: "text", text: `No combat achievement data synced for "${username}".` }] };

      const sinceIso = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const untilIso = until ?? new Date().toISOString();
      const rows = getStateHistory(username, "combat_achievement", sinceIso, untilIso);

      // Tier-milestone rows (itemName "tier:easy" etc., see diffCombatAchievements
      // in merge.ts) are recorded alongside individual task rows - split them so
      // the task count/list doesn't double up with the tier summary below.
      const tierRowsInWindow = new Set(
        rows
          .filter((r) => r.itemName.startsWith("tier:") && r.newState === "complete")
          .map((r) => r.itemName.slice("tier:".length))
      );
      const taskRows = rows.filter((r) => !r.itemName.startsWith("tier:"));

      const ca = data.combatAchievements;
      const tierFields: [string, boolean][] = [
        ["easy", ca.easyComplete],
        ["medium", ca.mediumComplete],
        ["hard", ca.hardComplete],
        ["elite", ca.eliteComplete],
      ];

      const lines: string[] = [
        `# ${username} — Combat achievements since ${sinceIso}`,
        `${sinceIso} → ${untilIso}`,
        `Tasks completed in this period: ${taskRows.length}`,
        "",
        "## Tier status",
      ];
      for (const [tier, done] of tierFields) {
        const label = tier[0].toUpperCase() + tier.slice(1);
        const state = !done
          ? "not yet complete"
          : tierRowsInWindow.has(tier)
            ? "reached in this period"
            : "already complete before this period";
        lines.push(`  ${label}: ${state}`);
      }

      if (taskRows.length > 0 && taskRows.length <= 100) {
        lines.push("", "## Tasks completed");
        for (const row of taskRows) {
          lines.push(`  - ${row.itemName}`);
        }
      } else if (taskRows.length > 100) {
        lines.push("", `Too many tasks to list individually (${taskRows.length}).`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "combat_achievement_history",
    "Get combat achievement task/tier completions for a player over a date range. Defaults to all recorded history.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "combat_achievement", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No combat achievement changes recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Combat achievement history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "collection_log_history",
    "Get collection log item unlocks observed for a player over a date range. Defaults to all recorded history. Best-effort only - see collection_log_completed_since for the caveat on why this isn't a complete list of everything unlocked in the window.",
    {
      username: z.string().describe("Player username"),
      since: z.string().optional().describe("ISO 8601 start of the range. Defaults to all recorded history."),
      until: z.string().optional().describe("ISO 8601 end of the range. Defaults to now."),
    },
    async ({ username, since, until }) => {
      const rows = getStateHistory(username, "collection_log", since ?? EPOCH, until ?? new Date().toISOString());
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No collection log items recorded for "${username}" in this range.` }] };
      }
      const lines = [`# ${username} — Collection log history`, ""];
      for (const row of rows) {
        lines.push(`  ${row.timestamp}: ${row.itemName} — ${row.oldState} → ${row.newState}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}
