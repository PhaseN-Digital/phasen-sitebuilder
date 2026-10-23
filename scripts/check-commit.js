// Conventional Commits check, shared by the commit-msg hook (.githooks) and CI.
// release-please silently skips commits it can't parse, so a bad message can
// leave a change out of the changelog and version bump.
//   node scripts/check-commit.js <file>     check a commit message file (hook)
//   node scripts/check-commit.js --range A..B   check every commit in a range (CI)
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w ./-]+\))?!?: \S/;
const SKIP = /^(Merge |Revert "|fixup! |squash! )/;

const [flag, arg] = process.argv.slice(2);
const subjects = flag === "--range"
  ? execFileSync("git", ["log", "--no-merges", "--format=%h %s", arg], { encoding: "utf8" }).split("\n").filter(Boolean)
  : [fs.readFileSync(flag, "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#")) || ""];

const bad = subjects.filter((line) => {
  const subject = flag === "--range" ? line.slice(line.indexOf(" ") + 1) : line;
  return !SKIP.test(subject) && !PATTERN.test(subject);
});
if (bad.length) {
  console.error(`Not a Conventional Commit message:\n  ${bad.join("\n  ")}\n\nUse "type(optional scope): summary", e.g. "feat: add gallery captions" or "fix(publish): retry DNS".\nTypes: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Add "!" after the type for breaking changes.`);
  process.exit(1);
}
