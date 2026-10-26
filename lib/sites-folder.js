// The sites folder (#136): <Documents>/PhaseN Sites by default, one sub-folder
// per site (named from the site's name, and renamed with it, #177), each a git repo, plus
// .phasen/ for the app's settings and encrypted secrets. Everything here is safe
// to interrupt: a copy is made and verified under a temporary name, renamed into
// place (the one step that makes it count), and only then is the original removed,
// so running it again finishes the job instead of copying twice.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const json = require("./json-store");
const secrets = require("./secrets");
const repo = require("./site-repo");

const ID_RE = /^[a-f0-9-]{36}$/;
const exists = (f) => fs.stat(f).then(() => true, () => false);

// id -> folder for every sub-folder that is a site repo (site.json + .git). First one wins on duplicates.
async function scan(root) {
  const found = new Map();
  const names = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
  for (const name of names) {
    const dir = path.join(root, name);
    if (!(await repo.isRepo(dir))) continue;
    const site = await json.read(path.join(dir, "site.json"), null);
    if (!ID_RE.test(site?.id || "")) continue;
    if (found.has(site.id)) console.error(`${dir} is a copy of ${found.get(site.id)} (same website id); ignoring it`);
    else found.set(site.id, dir);
  }
  return found;
}

function slugOf(name) {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "website";
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}-site` : slug; // reserved on Windows
}

// A new folder name in root from the site's name: "my-website", "my-website-2", …
async function freeDir(root, name) {
  const slug = slugOf(name);
  for (let i = 1; ; i++) {
    const dir = path.join(root, i === 1 ? slug : `${slug}-${i}`);
    if (!(await exists(dir))) return dir;
  }
}

// After a site is renamed (#177): its folder, renamed to match the new name if it
// doesn't already ("my-website" or "my-website-2" both match "My website"). One
// fs.rename in the same parent, so it's atomic: interrupted, the folder has either
// its old name or its new one, a whole repo (.git moves with it) that scan() finds.
// Throws if the folder can't be renamed (on Windows, a file in it is open); it keeps its name.
async function renameToMatch(dir, name) {
  const slug = slugOf(name), base = path.basename(dir);
  if (base === slug || new RegExp(`^${slug}-\\d+$`).test(base)) return dir;
  const to = await freeDir(path.dirname(dir), name);
  await fs.rename(dir, to);
  return to;
}

// Every file under dir, relative path -> sha256.
async function hashes(dir) {
  const out = new Map();
  for (const f of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const full = path.join(f.parentPath, f.name);
    out.set(path.relative(dir, full), crypto.createHash("sha256").update(await fs.readFile(full)).digest("hex"));
  }
  return out;
}
async function copyVerified(from, to) {
  await fs.rm(to, { recursive: true, force: true }); // a temp copy left by an interrupted run
  await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  const [a, b] = await Promise.all([hashes(from), hashes(to)]);
  if (a.size !== b.size || [...a].some(([f, h]) => b.get(f) !== h)) {
    await fs.rm(to, { recursive: true, force: true });
    throw new Error(`Copying ${from} to ${to} didn't produce an identical copy, so the original was kept.`);
  }
}

// Sites from before #136 (userData/sites/<id>, secrets sealed value by value with
// safeStorage) move into root as repos with their secrets in .secrets/secrets.enc.
// unsealLegacy(value) returns the secret, or null if it can't be read (then it's dropped).
// Returns how many sites it moved.
async function migrateLegacy({ legacyRoot, root, store, unsealLegacy, author, skip = () => false }) {
  let moved = 0;
  const ids = (await fs.readdir(legacyRoot).catch(() => [])).filter((id) => ID_RE.test(id) && !skip(id));
  if (!ids.length) return 0;
  await fs.mkdir(root, { recursive: true });
  const already = await scan(root);
  for (const id of ids) {
    const from = path.join(legacyRoot, id);
    const site = await json.read(path.join(from, "site.json"), null);
    if (!site) { console.error(`${from} has no readable site.json; left where it is`); continue; }
    if (!already.has(id)) { // otherwise an earlier run got as far as the rename
      const tmp = path.join(root, `.moving-${id}`);
      await copyVerified(from, tmp);
      for (const name of ["accounts.json", "publish.json"]) {
        const file = path.join(tmp, name);
        const value = await json.read(file, null);
        if (!value) continue;
        const { plain, secrets: sealed } = secrets.split(value);
        const opened = sealed.map(([p, v]) => [p, unsealLegacy(v)]).filter(([, v]) => v != null);
        for (const f of [file, `${file}.bak`]) await fs.rm(f, { force: true });
        await (name === "accounts.json" ? store.updateSite : store.updateState)(tmp, () => secrets.join(plain, opened));
      }
      await repo.ensure(tmp, author, "Moved into the PhaseN Sites folder");
      const to = await freeDir(root, site.name);
      await fs.rename(tmp, to);
      already.set(id, to);
    }
    await fs.rm(from, { recursive: true, force: true });
    moved++;
  }
  await fs.rmdir(legacyRoot).catch(() => {}); // only if empty (the Theme Builder's sample stays)
  return moved;
}

// userData/settings.json from before #136 -> .phasen/settings.json (+ secrets.enc).
async function migrateLegacySettings({ legacyFile, store, newFile, unsealLegacy }) {
  if (!(await exists(legacyFile))) return false;
  if (!(await exists(newFile))) {
    const { plain, secrets: sealed } = secrets.split(await json.read(legacyFile, {}));
    const opened = sealed.map(([p, v]) => [p, unsealLegacy(v)]).filter(([, v]) => v != null);
    await store.update(() => secrets.join(plain, opened));
  }
  for (const f of [legacyFile, `${legacyFile}.bak`]) await fs.rm(f, { force: true });
  return true;
}

// Moves every site (and .phasen) from one sites folder to another: all copied and
// verified first, then onSwitched() (main.js records the new folder), then the
// originals removed. Interrupted before the switch, the old folder is untouched.
async function moveAll(from, to, onSwitched) {
  await fs.mkdir(to, { recursive: true });
  const there = await scan(to);
  const sites = [...(await scan(from))].filter(([id]) => !there.has(id));
  for (const [id, dir] of sites) {
    const tmp = path.join(to, `.moving-${id}`);
    await copyVerified(dir, tmp);
    await fs.rename(tmp, await freeDir(to, path.basename(dir)));
  }
  const phasen = path.join(from, ".phasen");
  const movePhasen = (await exists(phasen)) && !(await exists(path.join(to, ".phasen")));
  if (movePhasen) {
    await copyVerified(phasen, path.join(to, ".phasen.moving"));
    await fs.rename(path.join(to, ".phasen.moving"), path.join(to, ".phasen"));
  }
  await onSwitched();
  for (const [, dir] of sites) await fs.rm(dir, { recursive: true, force: true });
  if (movePhasen) await fs.rm(phasen, { recursive: true, force: true });
  return sites.length;
}

module.exports = { ID_RE, scan, freeDir, renameToMatch, copyVerified, migrateLegacy, migrateLegacySettings, moveAll };
