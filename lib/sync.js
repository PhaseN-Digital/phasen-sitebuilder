// GitHub sync (#137): a site's own git repo (lib/site-repo.js) pushed to and
// pulled from a GitHub repo over HTTPS with isomorphic-git, using the GitHub
// sign-in token (#60). Shared settings sync the same way, through a small repo
// of their own holding only shared.json.
//
// Only the `main` branch is synced. sync() never overwrites anything: when
// GitHub and this computer both have versions the other lacks, GitHub's is
// kept here as a branch (github-<date>) and the caller asks which to keep;
// resolve() then records that as a merge, so neither side's history is lost.
//
// The token is only ever sent to <login>/<owner>/<repo>.git (login is github.com,
// or the fake in tests); a remote pointing anywhere else counts as not connected.
// Secrets never leave the computer: lib/site-repo.js never stages them, and
// shared settings are an allowlist with no secret in it.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const git = require("isomorphic-git");
const http = require("isomorphic-git/http/node");
const repo = require("./site-repo");
const { client, SIGNED_OUT } = require("./github");
const { FIELDS } = require("./settings");

const BRANCH = "main";
const SPEC = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/;

// "owner/repo" (a trailing .git or github.com URL is fine) -> "owner/repo"; throws if it isn't one.
function parseSpec(spec) {
  const s = String(spec || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/(\.git)?\/?$/, "");
  if (!SPEC.test(s) || /\/\.\.?$/.test(s)) throw new Error(`"${spec}" isn't a GitHub repository. Use the form owner/name.`);
  return s;
}
const urlOf = (login, spec) => `${login}/${parseSpec(spec)}.git`;

// The repo dir syncs with ("owner/repo"), or null.
async function remote(dir, login) {
  const url = await git.getConfig({ fs, dir, path: "remote.origin.url" }).catch(() => null);
  if (!url?.startsWith(`${login}/`) || !url.endsWith(".git")) return null;
  try { return parseSpec(url.slice(login.length + 1)); } catch { return null; }
}
const connect = (dir, login, spec) => git.addRemote({ fs, dir, remote: "origin", url: urlOf(login, spec), force: true });
const disconnect = (dir) => git.deleteRemote({ fs, dir, remote: "origin" }).catch(() => {});

// Makes a new private repo for owner (the signed-in user, or an organisation they belong to). Returns "owner/repo".
async function createRepo({ api, token, user, owner, name, description }) {
  const spec = parseSpec(`${owner}/${name}`);
  const route = owner.toLowerCase() === String(user).toLowerCase() ? "/user/repos" : `/orgs/${encodeURIComponent(owner)}/repos`;
  const r = await client(api, token)("POST", route, { name: spec.split("/")[1], private: true, description }).catch((e) => {
    if (e.status === 422) throw new Error(`${spec} already exists on GitHub. Connect to it instead, or choose another name.`);
    if (e.status === 403 || e.status === 404) throw new Error(`GitHub didn't let you make a repository for ${owner}. Sign in again in Settings with private repositories allowed, or choose another owner.`);
    throw e;
  });
  return r.full_name;
}

const opts = (dir, login, spec, token) => ({ fs, http, dir, url: urlOf(login, spec), onAuth: () => ({ username: "x-access-token", password: token }) });
const head = (dir, ref = BRANCH) => git.resolveRef({ fs, dir, ref: `refs/heads/${ref}` }).catch(() => null);
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const reach = (p) => p.catch((e) => {
  // 401: GitHub rejected the token itself (revoked); 403: it can't reach this repo (#253).
  if (e.code === "HttpError" && e.data?.statusCode === 401) throw Object.assign(new Error(SIGNED_OUT), { status: 401 });
  if (e.code === "HttpError" && e.data?.statusCode === 403) throw new Error("GitHub didn't accept your sign-in for this repository. Sign in again in Settings with private repositories allowed.");
  if (e.code === "HttpError" && e.data?.statusCode === 404) throw new Error("Couldn't find this website's GitHub repository. It may have been deleted or renamed.");
  throw e;
});

// GitHub's main, fetched; null when the repo is still empty.
async function fetchTheirs(o) {
  const refs = await reach(git.listServerRefs({ http: o.http, url: o.url, onAuth: o.onAuth, prefix: `refs/heads/${BRANCH}` }));
  if (!refs.some((r) => r.ref === `refs/heads/${BRANCH}`)) return null;
  const { fetchHead } = await reach(git.fetch({ ...o, ref: BRANCH, singleBranch: true, tags: true }));
  return fetchHead;
}
const push = (o) => reach(git.push({ ...o, ref: BRANCH, remoteRef: BRANCH }));
// Moves main to oid and makes the files match it (everything is committed first, so nothing is lost).
async function checkout(dir, oid) {
  await git.writeRef({ fs, dir, ref: `refs/heads/${BRANCH}`, value: oid, force: true });
  await git.checkout({ fs, dir, ref: BRANCH, force: true });
}

// Commits pending changes, then brings dir and GitHub level. Returns { status } where status is
//   "up to date" | "pushed" | "pulled" (files changed: reload) | "conflict" (+ branch: GitHub's version, kept here).
const sync = (dir, { login, token, author }) => repo.queued(dir, async () => {
  const spec = await remote(dir, login);
  if (!spec) throw new Error("This isn't connected to GitHub.");
  const o = opts(dir, login, spec, token);
  await repo.commitNow(dir, null, author);
  const [ours, theirs] = [await head(dir), await fetchTheirs(o)];
  if (ours === theirs || (!theirs && !ours)) return { status: "up to date" };
  if (!theirs || (ours && (await git.isDescendent({ fs, dir, oid: ours, ancestor: theirs, depth: -1 })))) {
    await push(o);
    return { status: "pushed" };
  }
  if (!ours || (await git.isDescendent({ fs, dir, oid: theirs, ancestor: ours, depth: -1 }))) {
    await checkout(dir, theirs);
    return { status: "pulled" };
  }
  const taken = new Set(await git.listBranches({ fs, dir }));
  let branch = `github-${stamp()}`;
  for (let i = 2; taken.has(branch); i++) branch = `github-${stamp()}-${i}`;
  await git.branch({ fs, dir, ref: branch, object: theirs });
  return { status: "conflict", branch };
});

// After a conflict: keep "mine" or "theirs" (the branch's), as a merge of both, then push it.
const resolve = (dir, { login, token, author, branch, keep }) => repo.queued(dir, async () => {
  if (!["mine", "theirs"].includes(keep) || !/^github-[\d-]+$/.test(branch || "")) throw new Error("Bad choice");
  const spec = await remote(dir, login);
  if (!spec) throw new Error("This isn't connected to GitHub.");
  await repo.commitNow(dir, null, author);
  const ours = await head(dir), theirs = await head(dir, branch);
  if (!theirs) throw new Error("That conflict has already been sorted out.");
  const { commit: c } = await git.readCommit({ fs, dir, oid: keep === "mine" ? ours : theirs });
  const message = keep === "mine" ? "Kept this computer's version over GitHub's\n" : "Took GitHub's version over this computer's\n";
  const merged = await git.commit({ fs, dir, message, author, tree: c.tree, parent: [ours, theirs] });
  await checkout(dir, merged);
  await git.deleteBranch({ fs, dir, ref: branch });
  await push(opts(dir, login, spec, token));
  return { status: keep === "mine" ? "pushed" : "pulled" };
});

// Restores a site from GitHub into a new folder in root (named by freeDir). has(id): already here.
// Returns { id, dir }.
async function clone({ root, login, token, spec, freeDir, has }) {
  const tmp = path.join(root, `.clone-${crypto.randomBytes(4).toString("hex")}`); // dot folders are never scanned as sites
  try {
    await reach(git.clone({ ...opts(tmp, login, spec, token), ref: BRANCH, singleBranch: true }));
    const site = JSON.parse(await fs.promises.readFile(path.join(tmp, "site.json"), "utf8").catch(() => "null"));
    if (!site?.id) throw new Error(`${parseSpec(spec)} doesn't hold a PhaseN Site Builder website.`);
    if (has(site.id)) throw new Error(`${site.name || "That website"} is already in your sites folder.`);
    const dir = await freeDir(root, site.name);
    await fs.promises.rename(tmp, dir);
    return { id: site.id, dir };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

// Shared settings: only these, so nothing secret can ever be in them.
const shared = (s) => ({
  defaults: Object.fromEntries(FIELDS.filter((k) => s.defaults?.[k] != null).map((k) => [k, s.defaults[k]])),
  hidePublicThemes: Boolean(s.hidePublicThemes),
  themeSources: (s.themeSources || []).map(({ spec }) => ({ spec })),
});
// Applies shared settings to s (in place): their defaults win; theme sources are added, never removed (tokens stay local).
function applyShared(s, sh) {
  const clean = shared(sh || {});
  s.defaults = { ...s.defaults, ...clean.defaults };
  s.hidePublicThemes = clean.hidePublicThemes;
  const have = new Set((s.themeSources || []).map((x) => x.spec));
  s.themeSources = [...(s.themeSources || []), ...clean.themeSources.filter((x) => typeof x.spec === "string" && !have.has(x.spec))];
  return s;
}

// Syncs settings s through the repo at spec, kept locally in dir. The first sync on a
// computer takes GitHub's settings if it has any; later ones push changes or pull them.
// Returns sync()'s result plus shared: settings to applyShared() when GitHub's came in.
async function syncSettings(dir, { login, token, author, spec }, s) {
  const file = path.join(dir, "shared.json");
  const read = async () => JSON.parse(await fs.promises.readFile(file, "utf8"));
  const fresh = !(await repo.isRepo(dir)) || (await remote(dir, login)) !== parseSpec(spec);
  if (fresh) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await git.init({ fs, dir, defaultBranch: BRANCH });
    await connect(dir, login, spec);
    const r = await sync(dir, { login, token, author });
    if (r.status === "pulled") return { ...r, shared: await read() };
  }
  await fs.promises.writeFile(file, `${JSON.stringify(shared(s), null, 2)}\n`);
  const r = await sync(dir, { login, token, author });
  return { ...r, shared: r.status === "pulled" ? await read() : null };
}

module.exports = { parseSpec, remote, connect, disconnect, createRepo, sync, resolve, clone, shared, applyShared, syncSettings };
