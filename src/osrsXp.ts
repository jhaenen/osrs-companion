// Standard OSRS skill xp table (levels 1-99). Used to project "xp remaining
// until level N" for the burn-rate style tools - not sourced from any API,
// this formula is a long-documented Jagex constant.
const LEVEL_XP: number[] = [0];
for (let level = 1; level < 99; level++) {
  let points = 0;
  for (let n = 1; n <= level; n++) {
    points += Math.floor(n + 300 * Math.pow(2, n / 7));
  }
  LEVEL_XP.push(Math.floor(points / 4));
}

export function xpForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(99, Math.floor(level)));
  return LEVEL_XP[clamped - 1];
}

export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const remHours = Math.round(hours % 24);
  return `${days}d ${remHours}h`;
}
