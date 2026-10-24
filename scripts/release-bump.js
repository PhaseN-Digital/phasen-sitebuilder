// Release gate (#47, #97) helpers for release-please.yml: only "patch"
// release PRs merge automatically, and only onto the main they were tested on.
//   node scripts/release-bump.js <old> <new>   prints patch, minor or major
//   node scripts/release-bump.js stale         prints why merging now is unsafe
//     (nothing if it's safe), from START_MAIN, MAIN, BASE, TESTED, PR_HEAD and
//     CONTAINS_MAIN in the environment.
//   node scripts/release-bump.js gate          prints why this run should gate
//     the open release PR (nothing if it shouldn't), from EVENT, REF,
//     PRS_CREATED and LABELS (comma-separated) in the environment.
// Anything that isn't a plain x.y.z upgrade counts as major, so it waits for
// the maintainer rather than slipping through.
function bump(from, to) {
  const [a, b] = [from, to].map((v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())?.slice(1).map(Number));
  if (!a || !b || a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return b[2] > a[2] ? "patch" : "major";
}

// A squash merge only ships what regression tested if main hasn't moved since
// the run started (#97: a feat landed 11s before the merge and shipped in a
// patch), the PR is based on that main, and its head is the tested commit.
function staleReason({ startMain, main, base, tested, head, containsMain }) {
  if (!startMain || !main || !tested) return "the gate is missing the main or tested sha";
  if (main !== startMain) return `main moved from ${startMain} to ${main} during this run`;
  if (base !== main) return `the PR's base ${base} isn't current main ${main}`;
  if (head !== tested) return `the PR head moved from the tested ${tested} to ${head}`;
  if (containsMain !== "true") return `the tested head ${tested} isn't based on main ${main}`;
  return "";
}

// #111: a refusal that only means "too early" (main or the head moved) adds
// the `regate` label, so the next run of any kind picks the PR up again even
// if nothing new is pushed; a manual dispatch on main gates it regardless.
function gateReason({ event, ref, prsCreated, labels = [] }) {
  if (prsCreated === "true") return "release-please updated it in this run";
  if (event === "workflow_dispatch" && ref === "refs/heads/main") return "manual dispatch on main";
  if (labels.includes("regate")) return "an earlier gate left it to be re-gated";
  return "";
}

if (require.main === module) {
  const e = process.env;
  const cmd = process.argv[2];
  console.log(cmd === "stale"
    ? staleReason({ startMain: e.START_MAIN, main: e.MAIN, base: e.BASE, tested: e.TESTED, head: e.PR_HEAD, containsMain: e.CONTAINS_MAIN })
    : cmd === "gate"
      ? gateReason({ event: e.EVENT, ref: e.REF, prsCreated: e.PRS_CREATED, labels: (e.LABELS || "").split(",") })
      : bump(process.argv[2], process.argv[3]));
}
module.exports = { bump, staleReason, gateReason };
