// "A newer version is available" (#37). CI publishes latest.json with each
// release to the public releases repo (see .github/workflows/release-please.yml):
// { version, notes, downloads: { "<platform>-<arch>": url } }.
const LATEST_URL = "https://github.com/PhaseN-Digital/phasen-sitebuilder-releases/releases/latest/download/latest.json";

// Numeric x.y.z compare; a leading "v" and any pre-release suffix are ignored.
function isNewer(latest, current) {
  const parts = (v) => String(v).replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
  const a = parts(latest), b = parts(current);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The installer for this platform/arch, only if it's an https github.com URL.
// Windows on Arm runs the x64 installer.
function pickDownload(downloads, platform, arch) {
  const url = downloads?.[`${platform}-${arch}`] || (platform === "win32" ? downloads?.["win32-x64"] : undefined);
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "github.com" ? u.href : null;
  } catch {
    return null;
  }
}

module.exports = { LATEST_URL, isNewer, pickDownload };
