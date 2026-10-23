// Classifies a release-please version bump for the release gate (#47) in
// release-please.yml: only "patch" release PRs merge automatically.
//   node scripts/release-bump.js <old> <new>   prints patch, minor or major
// Anything that isn't a plain x.y.z upgrade counts as major, so it waits for
// the maintainer rather than slipping through.
function bump(from, to) {
  const [a, b] = [from, to].map((v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())?.slice(1).map(Number));
  if (!a || !b || a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return b[2] > a[2] ? "patch" : "major";
}

if (require.main === module) console.log(bump(process.argv[2], process.argv[3]));
module.exports = { bump };
