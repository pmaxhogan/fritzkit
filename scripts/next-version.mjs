#!/usr/bin/env node
/**
 * Prints the next release version: one patch above the latest published
 * version when it shares the floor's major.minor, otherwise the floor itself
 * (package.json holds major.minor.0 and is never committed back by CI).
 *
 * Usage: node scripts/next-version.mjs <latestPublished> <floor>
 */
export function nextVersion(latest, floor) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) throw new Error(`not a version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [lM, lm, lp] = parse(latest);
  const [fM, fm, fp] = parse(floor);
  if (lM === fM && lm === fm && lp + 1 > fp) return `${fM}.${fm}.${lp + 1}`;
  if (lM > fM || (lM === fM && lm > fm)) {
    throw new Error(`published ${latest} is ahead of the floor ${floor}; bump package.json`);
  }
  return `${fM}.${fm}.${fp}`;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("next-version.mjs")
) {
  const [latest = "0.0.0", floor] = process.argv.slice(2);
  if (!floor) {
    console.error("usage: next-version.mjs <latest> <floor>");
    process.exit(2);
  }
  console.log(nextVersion(latest, floor));
}
