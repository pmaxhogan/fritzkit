// stack-template: scripts/check-ascii@2 0efd0b6fe664
// Fails when any tracked text file contains a non-ASCII byte (long dashes, smart quotes).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let bad = 0;
for (const f of files) {
  if (/\.(png|jpg|jpeg|gif|webp|ico|jar|keystore|zip|fzpz|fzz|pdf)$/i.test(f)) continue;
  // Vendored upstream code (Fritzing's fzp checker) keeps its bytes; see tools/fzp-checker/vendor/UPSTREAM.md.
  if (f.startsWith("tools/fzp-checker/vendor/")) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/[\u0080-\uffff]/.test(line)) {
      bad++;
      console.log(`${f}:${i + 1}: non-ASCII: ${line.trim().slice(0, 100)}`);
    }
  });
}
if (bad) {
  console.log(`${bad} non-ASCII line(s)`);
  process.exit(1);
}
console.log(`ascii ok (${files.length} files)`);
