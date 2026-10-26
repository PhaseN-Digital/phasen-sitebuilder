// GitHub sign-in and theme publishing (#60). Sign-in is GitHub's OAuth device
// flow: the app shows a short code, the user approves it on github.com, and the
// app polls for the token. No client secret (a desktop app can't keep one), so
// only the OAuth App's public client ID, which release-please.yml's build job
// writes into lib/github-config.json (local dev: the env var of the same name).
//
// Publishing sends only a Theme Builder theme's theme.json, theme.css,
// preview.png and HTML templates (#200), validated first with lib/theme-validate.js, as one commit made
// through the git data API (blobs, tree, commit, ref):
//   pushTheme    to themes/<id>/ in a repo the user can write to
//   submitTheme  to a branch of the user's fork of the public themes repo, then a PR
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateTheme } = require("./theme-validate");
const { parseSource, PUBLIC_SOURCE } = require("./theme-sources");

const LOGIN = "https://github.com";
const PRIVATE_DEFAULT = "PhaseN-Digital/phasen-themes-private";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (ref) => ref.split("/").map(encodeURIComponent).join("/");

// The OAuth App's client ID, or "" when this copy wasn't built with one.
function clientId({ env = process.env, packaged = false, dir = __dirname } = {}) {
  if (!packaged && env.SITEBUILDER_GITHUB_CLIENT_ID) return env.SITEBUILDER_GITHUB_CLIENT_ID.trim();
  try {
    return String(JSON.parse(require("node:fs").readFileSync(path.join(dir, "github-config.json"), "utf8")).clientId || "").trim();
  } catch {
    return "";
  }
}

const reach = (p) => p.catch(() => { throw new Error("Couldn't reach GitHub. Check your internet connection."); });

// github.com's device flow endpoints take form posts and answer JSON.
async function loginPost(login, route, params) {
  const res = await reach(fetch(`${login}${route}`, { method: "POST", headers: { Accept: "application/json", "User-Agent": "PhaseN-Site-Builder" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000) }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) throw new Error(`GitHub sign-in failed (${res.status}).`);
  return data;
}

// { deviceCode, userCode, verificationUri, interval, expiresIn }
async function startDeviceFlow({ clientId, scope, login = LOGIN }) {
  const r = await loginPost(login, "/login/device/code", { client_id: clientId, scope });
  if (!r.device_code) throw new Error(r.error === "device_flow_disabled" ? "GitHub sign-in isn't enabled for this app's GitHub OAuth App." : `GitHub sign-in failed (${r.error_description || r.error || "no code"}).`);
  return { deviceCode: r.device_code, userCode: r.user_code, verificationUri: r.verification_uri, interval: Number(r.interval ?? 5), expiresIn: Number(r.expires_in || 900) };
}

// Polls until the user approves (returns the token) or the code expires,
// they deny it, or cancelled() turns true (throws).
async function pollDeviceFlow({ clientId, deviceCode, interval, expiresIn, login = LOGIN, cancelled = () => false, wait = sleep }) {
  for (const end = Date.now() + expiresIn * 1000; ; ) {
    await wait(interval * 1000);
    if (cancelled()) throw new Error("Sign-in cancelled.");
    const r = await loginPost(login, "/login/oauth/access_token", { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (r.access_token) return { token: r.access_token, scope: r.scope || "" };
    if (r.error === "slow_down") interval = Number(r.interval) || interval + 5;
    else if (r.error === "access_denied") throw new Error("The sign-in was declined on GitHub.");
    else if (r.error === "expired_token" || Date.now() > end) throw new Error("The sign-in code expired. Click Sign in with GitHub to get a new one.");
    else if (r.error !== "authorization_pending") throw new Error(`GitHub sign-in failed (${r.error_description || r.error || "no token"}).`);
  }
}

// A 401 means GitHub no longer accepts the token: the user revoked the app or
// it went unused for a year. OAuth App user tokens (this app's client ID is an
// OAuth App's, "Ov23…") don't expire otherwise and come without a refresh
// token, so the only fix is signing in again (#253).
const SIGNED_OUT = "You've been signed out of GitHub (your sign-in expired or was revoked). Sign in to GitHub again in Settings.";

// A REST client for one token. Errors carry GitHub's status.
const client = (api, token) => async (method, route, body) => {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "PhaseN-Site-Builder", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await reach(fetch(`${api}${route}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) }));
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const e = new Error(res.status === 401 ? SIGNED_OUT : `GitHub returned an error (${res.status}${data?.message ? `: ${data.message}` : ""}).`);
  e.status = res.status;
  throw e;
};

const user = (api, token) => client(api, token)("GET", "/user");

// Whether the token can write to repo (owner/repo); false if it can't see it.
// Throws only when GitHub rejects the token itself (401).
const canPush = (api, token, repo) => client(api, token)("GET", `/repos/${repo}`).then((r) => Boolean(r.permissions?.push), (e) => { if (e.status === 401) throw e; return false; });

// A theme folder's publishable files, { name: Buffer }; throws if it isn't valid.
async function themeFiles(dir) {
  const errors = validateTheme(dir);
  if (errors.length) throw new Error(`This theme can't be published: ${errors.join("; ")}`);
  const files = {};
  // Valid, so every file in it is one lib/theme-validate.js allows.
  for (const name of await fs.readdir(dir)) files[name] = await fs.readFile(path.join(dir, name));
  return { files, json: JSON.parse(files["theme.json"]) };
}

// One commit on top of branch's head putting files into folder/. Returns its sha.
// ponytail: files missing locally (an old preview.png) stay in the repo; delete entries if that matters.
async function commitFiles(call, repo, branch, folder, files, message) {
  const head = (await call("GET", `/repos/${repo}/git/ref/heads/${enc(branch)}`)).object.sha;
  const base = (await call("GET", `/repos/${repo}/git/commits/${head}`)).tree.sha;
  const tree = await Promise.all(Object.entries(files).map(async ([name, buf]) => ({
    path: `${folder}/${name}`, mode: "100644", type: "blob",
    sha: (await call("POST", `/repos/${repo}/git/blobs`, { content: buf.toString("base64"), encoding: "base64" })).sha,
  })));
  const t = await call("POST", `/repos/${repo}/git/trees`, { base_tree: base, tree });
  return (await call("POST", `/repos/${repo}/git/commits`, { message, tree: t.sha, parents: [head] })).sha;
}

// Commits the theme to <folder or themes>/<id>/ in target (owner/repo[/folder][@branch]).
async function pushTheme({ api, token, target, id, files, version }) {
  const call = client(api, token);
  const { owner, repo, folder, branch } = parseSource(target);
  const full = `${owner}/${repo}`;
  const info = await call("GET", `/repos/${full}`).catch((e) => {
    throw e.status === 404 ? new Error(`Couldn't find ${full}. Check the name. If it's private, sign in again in Settings with private repositories allowed.`) : e;
  });
  if (!info.permissions?.push) throw new Error(`You can't write to ${full}. Choose a repository you can push to, or ask its owner for access.`);
  const b = branch || info.default_branch;
  const dir = `${folder || "themes"}/${id}`;
  const sha = await commitFiles(call, full, b, dir, files, `Publish theme ${id} ${version}`);
  await call("PATCH", `/repos/${full}/git/refs/heads/${enc(b)}`, { sha });
  return { url: `https://github.com/${full}/tree/${enc(b)}/${dir}` };
}

// Forks the public themes repo (GitHub reuses an existing fork), commits the
// theme on a new branch of the fork and opens a PR. Returns { url } of the PR.
async function submitTheme({ api, token, id, files, label, about, version, wait = sleep }) {
  const call = client(api, token);
  const up = await call("GET", `/repos/${PUBLIC_SOURCE}`);
  const base = up.default_branch;
  const fork = await call("POST", `/repos/${PUBLIC_SOURCE}/forks`, { default_branch_only: true });
  for (let i = 0; ; i++) { // a new fork takes a few seconds to appear
    const ok = await call("GET", `/repos/${fork.full_name}/git/ref/heads/${enc(base)}`).then(() => true, (e) => { if (![404, 409].includes(e.status)) throw e; return false; });
    if (ok) break;
    if (i >= 20) throw new Error("GitHub is still making your copy of the themes repository. Try again in a minute.");
    await wait(3000);
  }
  await call("POST", `/repos/${fork.full_name}/merge-upstream`, { branch: base }).catch(() => {}); // a fork that's diverged keeps its history
  const branch = `theme-${id}-${version.replace(/\./g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const sha = await commitFiles(call, fork.full_name, base, `themes/${id}`, files, `Add theme ${id} ${version}`);
  await call("POST", `/repos/${fork.full_name}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  const pr = await call("POST", `/repos/${PUBLIC_SOURCE}/pulls`, {
    title: `Add theme: ${label}`, head: `${fork.owner.login}:${branch}`, base, maintainer_can_modify: true,
    body: `${about}\n\nTheme \`${id}\`, version ${version}, made with the PhaseN Site Builder's Theme Builder.`,
  });
  return { url: pr.html_url };
}

module.exports = { LOGIN, SIGNED_OUT, PRIVATE_DEFAULT, client, clientId, startDeviceFlow, pollDeviceFlow, user, canPush, themeFiles, pushTheme, submitTheme };
