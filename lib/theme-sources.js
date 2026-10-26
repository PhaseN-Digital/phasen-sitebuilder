// Theme sources (#58): GitHub repos of theme packages, the public
// PhaseN-Digital/phasen-sitebuilder-themes plus any the user adds. A source
// is downloaded as one tarball (a single API request, so the unauthenticated
// 60 an hour limit goes a long way), every theme in it is validated with
// lib/theme-validate.js, and the result is cached under userData. Choosing a
// theme copies it into the site folder (sites/<id>/theme), so builds never
// depend on the repo or the cache.
//
// A source is written `owner/repo`, optionally followed by a folder and/or a
// branch: `owner/repo/some/folder@branch`. Without a folder, themes are the
// subfolders of `themes/` if the repo has one, else of the repo root.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { validateTheme } = require("./theme-validate");

const PUBLIC_SOURCE = "PhaseN-Digital/phasen-sitebuilder-themes";
const GITHUB_API = "https://api.github.com";
const MAX_DOWNLOAD = 20e6;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/; // same as lib/theme-validate.js
const SOURCE_RE = /^([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)\/?(?:@([\w./-]+))?$/;

// { owner, repo, folder, branch, spec }, `spec` written the canonical way.
function parseSource(spec) {
  const m = SOURCE_RE.exec(String(spec).trim().replace(/^https:\/\/github\.com\//, ""));
  if (!m || [m[1], m[2]].some((p) => /^\.+$/.test(p)) || m[3].split("/").includes("..")) throw new Error('Write the repository as owner/repo, e.g. "acme/website-themes" (optionally owner/repo/folder@branch).');
  const [owner, repo, folder, branch] = [m[1], m[2], m[3].slice(1) || null, m[4] || null];
  return { owner, repo, folder, branch, spec: `${owner}/${repo}${folder ? `/${folder}` : ""}${branch ? `@${branch}` : ""}` };
}

// Folder name in the cache for a source.
const cacheKey = (spec) => crypto.createHash("sha256").update(spec).digest("hex").slice(0, 16);

// Entries of an uncompressed tar: [{ name, dir, data }]. Handles ustar
// prefixes and pax path records (GitHub uses both); links and the like are skipped.
function readTar(buf) {
  const out = [];
  let paxPath = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const head = buf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const str = (a, b) => head.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = str(156, 157) || "0";
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? null; continue; }
    if (type === "g") continue;
    const prefix = str(345, 500);
    const name = paxPath ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    paxPath = null;
    if (type === "0" || type === "5") out.push({ name, dir: type === "5", data });
  }
  return out;
}

async function githubError(res, spec, token) {
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = new Date(Number(res.headers.get("x-ratelimit-reset")) * 1000);
    return `GitHub's download limit is used up (60 an hour without a token). Try again after ${reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${token ? "" : ", or add an access token for this repository"}.`;
  }
  if (res.status === 401) return `GitHub didn't accept the access token for ${spec}. Check it hasn't expired.`;
  if (res.status === 404 || res.status === 403) return token
    ? `Couldn't find ${spec}. Check the name and branch, and that the token has Contents: Read-only access to it.`
    : `Couldn't find ${spec}. Check the name and branch. If it's a private repository, add an access token.`;
  return `GitHub returned an error for ${spec} (${res.status}).`;
}

// Downloads a source, validates its themes and replaces its cache folder
// (cacheRoot/<key>). The token, if any, is only ever sent to `api`; the
// download link GitHub redirects to carries its own short-lived access.
// Returns the cached listing (see readSource).
async function fetchSource(spec, { cacheRoot, token, api = GITHUB_API }) {
  const { owner, repo, folder, branch } = parseSource(spec);
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "PhaseN-Site-Builder", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ref = branch ? `/${branch.split("/").map(encodeURIComponent).join("/")}` : "";
  const get = (url, h) => fetch(url, { headers: h, redirect: "manual", signal: AbortSignal.timeout(60000) }).catch(() => {
    throw new Error("Couldn't reach GitHub. Check your internet connection.");
  });
  const url = `${api}/repos/${owner}/${repo}/tarball${ref}`;
  let res = await get(url, headers);
  // GitHub rejects an expired or revoked token even for a public repo (#251),
  // so retry without it: a repo that needs no token still downloads.
  if (res.status === 401 && token) {
    const { Authorization, ...anon } = headers;
    const retry = await get(url, anon);
    if (retry.status < 400) res = retry;
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    res = await get(new URL(res.headers.get("location"), api), { "User-Agent": headers["User-Agent"] });
  }
  if (!res.ok) throw new Error(await githubError(res, spec, token));
  if (Number(res.headers.get("content-length")) > MAX_DOWNLOAD) throw new Error(`${spec} is too large to download (over ${MAX_DOWNLOAD / 1e6} MB). Put the themes in a smaller repository.`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_DOWNLOAD) throw new Error(`${spec} is too large to download (over ${MAX_DOWNLOAD / 1e6} MB). Put the themes in a smaller repository.`);
  let entries;
  try {
    entries = readTar(zlib.gunzipSync(gz, { maxOutputLength: 5 * MAX_DOWNLOAD }));
  } catch {
    throw new Error(`Couldn't read the download of ${spec}.`);
  }

  // GitHub puts everything under one owner-repo-sha/ folder.
  const files = entries.map((e) => ({ ...e, name: e.name.split("/").slice(1).join("/") }));
  const root = folder ?? (files.some((f) => f.name.startsWith("themes/")) ? "themes" : "");
  const prefix = root ? `${root}/` : "";
  const dest = path.join(cacheRoot, cacheKey(spec));
  const tmp = `${dest}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  const themes = {};
  try {
    for (const f of files) {
      if (!f.name.startsWith(prefix)) continue;
      const [id, ...rest] = f.name.slice(prefix.length).replace(/\/$/, "").split("/");
      if (!id || !rest.length || id.startsWith(".")) continue; // the folder itself, a loose file, .github
      const t = (themes[id] ||= { errors: [] });
      const name = rest.join("/");
      if (!ID_RE.test(id)) t.errors[0] = `folder name "${id}" must be lowercase letters, digits and dashes`;
      // Single-level file names only reach the disk; validateTheme reports any it doesn't allow.
      else if (rest.length > 1 || f.dir || !/^[\w.-]{1,100}$/.test(name) || /^\.+$/.test(name)) t.errors.push(`unexpected entry ${name}`);
      else {
        await fs.mkdir(path.join(tmp, id), { recursive: true });
        await fs.writeFile(path.join(tmp, id, name), f.data);
      }
    }
    for (const [id, t] of Object.entries(themes)) {
      if (!ID_RE.test(id)) continue;
      t.errors.push(...validateTheme(path.join(tmp, id)));
      if (!t.errors.length) {
        const { label, about, font, colors, version } = JSON.parse(await fs.readFile(path.join(tmp, id, "theme.json"), "utf8"));
        const templates = (await fs.readdir(path.join(tmp, id))).some((f) => f.endsWith(".html")); // #200: labelled in the picker
        Object.assign(t, { label, about, font, colors, version: version || null, templates });
      }
    }
    if (!Object.keys(themes).length) throw new Error(`${spec} has no theme folders${root ? ` in ${root}/` : ""}.`);
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, "index.json"), JSON.stringify({ spec, fetchedAt: new Date().toISOString(), themes }, null, 2));
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(tmp, dest);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return readSource(spec, cacheRoot);
}

// The cached listing, or null if never downloaded: { spec, fetchedAt,
// themes: { <id>: { label, about, font, colors, version, preview, errors } } }
// with `preview` a data: URL (the editor can't load files directly).
async function readSource(spec, cacheRoot) {
  const dir = path.join(cacheRoot, cacheKey(spec));
  const index = await fs.readFile(path.join(dir, "index.json"), "utf8").then(JSON.parse, () => null);
  if (!index) return null;
  for (const [id, t] of Object.entries(index.themes)) {
    const png = !t.errors.length && (await fs.readFile(path.join(dir, id, "preview.png")).catch(() => null));
    t.preview = png ? `data:image/png;base64,${png.toString("base64")}` : null;
  }
  return index;
}

// Copies a cached, valid theme into siteDir/theme, replacing any previous one.
async function installTheme(spec, id, cacheRoot, siteDir) {
  const index = await readSource(spec, cacheRoot);
  const t = index?.themes[id];
  if (!t || t.errors.length || !ID_RE.test(id)) throw new Error(`The theme "${id}" isn't available from ${spec} any more.`);
  const dest = path.join(siteDir, "theme");
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(path.join(cacheRoot, cacheKey(spec), id), dest, { recursive: true });
}

module.exports = { PUBLIC_SOURCE, GITHUB_API, parseSource, readTar, fetchSource, readSource, installTheme, cacheKey };
