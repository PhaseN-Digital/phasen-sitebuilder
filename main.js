const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, dialog, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build, pruneAssets, stampHtml, themes, fonts, inboxDays } = require("./lib/build");
const cf = require("./lib/publish");
const wp = require("./lib/wordpress");
const { mirrorSite, verifyOwnership } = require("./lib/mirror");
const update = require("./lib/update");
const themeSources = require("./lib/theme-sources");
const { loadTheme } = require("./lib/themes");
const builder = require("./lib/theme-builder");
const config = require("./lib/settings");
const { migrateLayouts } = require("./lib/layouts");
const json = require("./lib/json-store");
const github = require("./lib/github");
const secrets = require("./lib/secrets");
const repo = require("./lib/site-repo");
const folder = require("./lib/sites-folder");

// The regression suite points this at a fake latest.json; never honoured in a packaged build.
const UPDATE_URL = (!app.isPackaged && process.env.SITEBUILDER_UPDATE_URL) || update.LATEST_URL;
// Same for the fake GitHub API (theme sources, #58).
const GITHUB_API = (!app.isPackaged && process.env.SITEBUILDER_GITHUB_API) || themeSources.GITHUB_API;
const GITHUB_LOGIN = (!app.isPackaged && process.env.SITEBUILDER_GITHUB_API) || github.LOGIN; // the fake serves both
const GITHUB_CLIENT_ID = github.clientId({ packaged: app.isPackaged });

// preview://<site-id>/... serves the last preview build so the editor can
// show the real generated site in an iframe, no local web server needed.
protocol.registerSchemesAsPrivileged([{ scheme: "preview", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const ID_RE = /^[a-f0-9-]{36}$/;
const data = (...p) => path.join(app.getPath("userData"), ...p);
// Sites live in the user's sites folder (#136, lib/sites-folder.js), found by
// scanning it: id -> folder. userData keeps only machine-local things (location.json,
// preview/publish builds, caches).
let SITES = null;
const sites = new Map();
const siteDir = (id) => {
  if (!ID_RE.test(id)) throw new Error("Bad site id");
  if (id === SAMPLE_ID) return data("sites", id); // the Theme Builder's pseudo-site, never in the sites folder
  const dir = sites.get(id);
  if (!dir) throw new Error("That website isn't in your sites folder any more. Use Find sites in Settings › Data.");
  return dir;
};
const previewDir = (id) => data("preview", id);
// A copied page's HTML file (exact-copy import), for app/copied.js to edit.
// "mirror-original" holds each page's HTML as it was before its first edit.
const mirrorFile = (id, file, dir = "mirror") => {
  const root = path.join(siteDir(id), dir);
  const target = path.join(root, String(file));
  if (!target.startsWith(root + path.sep) || !target.endsWith(".html")) throw new Error("Bad file");
  return target;
};
const publishDir = (id) => data("publish", id);

// Secrets are plain values in memory; config.store() splits them out into an
// encrypted secrets.enc on every write (lib/secrets.js, #136). seal/unseal only
// mark which values are secrets.
const seal = (v) => v;
const unseal = (v) => v || "";
// A value still in the pre-#136 sealed format: safeStorage output ("v10"/"v11" + ciphertext) in base64.
const looksSealed = (v) => /^djE[wx][A-Za-z0-9+/]{16,}={0,2}$/.test(v || "");
const validSecrets = (s) => /^re_\w+$/.test(s.RESEND_API_KEY || "") && Boolean(s.TURNSTILE_SECRET_KEY) && !looksSealed(s.TURNSTILE_SECRET_KEY);
const hex = (n) => crypto.randomBytes(n).toString("hex");

// App-wide settings. Site operations go through settingsFor() instead (#134).
// Both are set up by openSitesFolder(), before any handler runs.
let keyring, settingsStore;
const loadSettings = () => settingsStore.load();
const updateSettings = (change) => settingsStore.update(change); // read-modify-write under one queue (#147)
const readSite = (id) => json.read(path.join(siteDir(id), "site.json"), null).then(config.migrateSite).then(migrateLayouts).then((site) => site && { ...site, domain: cf.siteDomain(site.domain) }); // pre-#135 domains migrated
// Everything a site operation needs: the site's overrides, else the app's settings.
// `published` is the accounts the site was last published with (lib/settings.js publishedWith).
async function settingsFor(id, site) {
  const [s, accounts, state] = await Promise.all([loadSettings(), settingsStore.loadSite(siteDir(id)), readState(id)]);
  return { ...config.resolve(s, site || (await readSite(id)), accounts), published: config.publishedWith(s, accounts, state, unseal), accounts, state };
}
// Every build (preview, import, export, publish) goes through here so it sees the resolved settings.
const buildSite = (site, outDir, options = {}) => settingsFor(site.id, site).then((r) => build(r.site, siteDir(site.id), outDir, { defaultTo: r.email, ...options }));
const previewBuild = (site) => queueBuild(() => buildSite(site, previewDir(site.id), { preview: true }));
// Per-site deploy state (Turnstile keys, Resend sending key). Kept apart from
// site.json so secrets never end up in a build or export.
const readState = (id) => settingsStore.loadState(siteDir(id));
const writeState = (id, s) => settingsStore.updateState(siteDir(id), () => s);

// The sites folder (#136): location.json in userData says where it is
// (default <Documents>/PhaseN Sites) and remembers the portable-secrets key on
// this machine. Opening it migrates pre-#136 data out of userData, then scans it.
const location = () => json.read(data("location.json"), {});
const portableFile = () => path.join(SITES, ".phasen", "portable.json");
const safe = { encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) };
let notice = null; // shown once by the renderer (notice:get)
async function openSitesFolder() {
  const loc = await location();
  SITES = path.resolve(loc.sitesFolder || path.join(app.getPath("documents"), "PhaseN Sites"));
  await fs.mkdir(path.join(SITES, ".phasen"), { recursive: true });
  const portable = await json.read(portableFile(), null);
  let key = null;
  if (portable && loc.portableKey?.salt === portable.salt) {
    try { key = Buffer.from(safeStorage.decryptString(Buffer.from(loc.portableKey.sealed, "base64")), "base64"); } catch {}
  }
  keyring = { safe, portable: Boolean(portable), key, config: portable };
  settingsStore = config.store(path.join(SITES, ".phasen"), keyring);
  try {
    // Before #136, every secret was sealed on its own with safeStorage (base64).
    let lost = false;
    // A "decrypted" value with control or replacement characters is garbage (#218): dropped like an unreadable one.
    const unsealLegacy = (v) => {
      try {
        const plain = safeStorage.decryptString(Buffer.from(v, "base64"));
        if (plain && !/[\x00-\x1f\x7f\ufffd]/.test(plain)) return plain;
      } catch {}
      lost = true;
      return null;
    };
    await folder.migrateLegacySettings({ legacyFile: data("settings.json"), newFile: path.join(SITES, ".phasen", "settings.json"), store: settingsStore, unsealLegacy });
    const moved = await folder.migrateLegacy({ legacyRoot: data("sites"), root: SITES, store: settingsStore, unsealLegacy, author: await author(), skip: (id) => id === SAMPLE_ID });
    if (moved) notice = `${moved === 1 ? "Your website has" : `Your ${moved} websites have`} moved to ${SITES}. Each one now keeps a history of its changes (History tab). You can choose another folder in Settings › Data.`;
    if (lost) notice = `${notice || ""} Some saved passwords or keys couldn't be read on this computer: reconnect your accounts in Settings (and any a website uses on its own), then publish your websites again.`.trim();
  } catch (e) {
    console.error("Couldn't move websites into the sites folder:", e);
    notice = `Some websites couldn't be moved into ${SITES} (${e.message}). They're still in ${data("sites")}; the move is tried again next time the app starts.`;
  }
  return findSites();
}
async function findSites() {
  const found = await folder.scan(SITES);
  sites.clear();
  for (const [id, dir] of found) sites.set(id, dir);
  return sites.size;
}
// Only the running copy (#149) migrates or opens the folder; a second launch just quits.
const ready = app.whenReady().then(() => firstInstance && openSitesFolder());

// Site history (#136, lib/site-repo.js): edits are committed after a pause in
// editing, when another site opens, before publishing and on quit; every publish
// is tagged. The author is the app's user (Settings defaults).
const HISTORY_PAUSE = 15000;
const pendingCommits = new Map();
async function author() {
  const s = await loadSettings().catch(() => ({}));
  return { name: s.name || s.defaults?.owner || "PhaseN Site Builder", email: s.defaults?.email || "sitebuilder@localhost" };
}
function autosave(id) {
  clearTimeout(pendingCommits.get(id));
  pendingCommits.set(id, setTimeout(() => saveHistory(id), HISTORY_PAUSE));
}
async function saveHistory(id, message) {
  clearTimeout(pendingCommits.get(id));
  pendingCommits.delete(id);
  let oid = null;
  try {
    oid = await whileBusy(async () => repo.commit(siteDir(id), message, await author()));
  } catch (e) {
    console.error(`Couldn't save the history of ${id}:`, e);
  }
  await renameFolder(id);
  return oid;
}
// A renamed site's folder follows its name (#177), once its edits are committed and
// nothing else is running: every IPC call and commit counts as busy, so a publish,
// a folder move or a flush is never left holding the old path, and IPC calls and
// previews wait for a rename in progress. Only after a commit (a pause in editing,
// or quitting), so typing a name doesn't rename the folder letter by letter.
// ponytail: one app-wide busy count, per-site counts if renames ever wait too long.
let busy = 0, renaming = null;
async function whileBusy(fn) {
  busy++;
  try { return await fn(); } finally { busy--; }
}
async function renameFolder(id) {
  const name = sites.has(id) && (await readSite(id).catch(() => null))?.name;
  if (!name || busy || renaming) return;
  renaming = folder.renameToMatch(sites.get(id), name)
    .then((dir) => sites.set(id, dir), (e) => console.error(`Couldn't rename the folder of ${id}; it keeps its name:`, e))
    .finally(() => { renaming = null; });
  await renaming;
}
const saveAllHistory = async () => { // one at a time, so each can rename its folder (#177)
  for (const id of [...pendingCommits.keys()]) await saveHistory(id);
};
const pad = (n) => String(n).padStart(2, "0");
const liveTag = (d = new Date()) => `live-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
// Channels that change files in a site folder (their first argument is the site, or its id).
const EDITS = new Set(["sites:save", "images:save", "mirror:write", "mirror:keep-original", "themes:use", "themes:update", "import:declare", "settings:cloudflare", "settings:account", "settings:resend", "settings:disconnect"]);

// Portable secrets (#136): turning them on or off re-encrypts every secrets.enc.
// The config (salt + check) is written before the files and removed after them,
// so a crash in between never leaves a file nothing can open.
const secretFiles = () => settingsStore.secretFiles([...sites.values()]);
// Reads every secrets file, so secrets.problems() is current, and returns what the renderer may see.
async function checkSecrets() {
  await Promise.all([...sites.values()].flatMap((d) => [settingsStore.loadSite(d), settingsStore.loadState(d)]));
  return publicSettings(await loadSettings());
}
const rememberKey = (key) => json.update(data("location.json"), (l) => {
  if (key) l.portableKey = { salt: keyring.config.salt, sealed: safeStorage.encryptString(key.toString("base64")).toString("base64") };
  else delete l.portableKey;
});

// ponytail: one global build queue, per-site queues if builds ever get slow.
let buildQueue = Promise.resolve();
const queueBuild = (fn) => (buildQueue = buildQueue.then(fn, fn));

const workerNameFor = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site"}-${hex(2)}`;

function newSite(name, theme) {
  const t = themes[theme] || themes.clean;
  const home = { id: hex(4), title: "Home", sections: [] };
  const contact = { id: hex(4), title: "Contact", sections: [] };
  home.sections.push(
    { id: hex(4), type: "hero", heading: name, text: "A short sentence about what you do and who you do it for.", image: null, buttonText: "Get in touch", buttonPage: contact.id },
    { id: hex(4), type: "text", heading: "About us", text: "Tell visitors who you are, what makes you different, and why they should choose you.", image: null, imageLeft: false }
  );
  contact.sections.push({ id: hex(4), type: "form", heading: "Get in touch", text: "Send us a message and we'll get back to you.", formId: "contact", buttonText: "Send message" });
  return {
    id: crypto.randomUUID(),
    name,
    description: "",
    theme: themes[theme] ? theme : "clean",
    colors: { ...t.colors },
    font: t.font,
    logo: null,
    domain: null,
    workerName: workerNameFor(name),
    pages: [home, contact],
    forms: [
      {
        id: "contact",
        name: "Contact",
        to: "",
        success: "Thanks! Your message has been sent, we'll be in touch soon.",
        fields: [
          { id: "name", label: "Your name", type: "text", required: true },
          { id: "email", label: "Email address", type: "email", required: true },
          { id: "message", label: "Message", type: "textarea", required: true },
        ],
      },
    ],
  };
}

// Import provenance (#141). Every import needs the user's ownership declaration,
// refused here too so a UI bug can't skip it; verification is attempted and
// recorded, never required. declaredBy stays in site.json: lib/build.js only
// publishes the source, date, app version and verification result.
const isImported = (site) => Boolean(site.importProvenance || site.mirror || site.pages.some((p) => p.path));
// Publish and "Save as package…" both refuse a site imported before #141 until
// it has a declaration, so the marker always goes out with it (#145).
function requireProvenance(site) {
  if (site && isImported(site) && !site.importProvenance) {
    throw new Error("This website was imported before Site Builder asked for an ownership declaration. Confirm that you own it on the Publish tab before publishing or exporting it again.");
  }
}
// Origins wp:fetch logged in to with an application password this session, so
// "Decide for me" falling back to an exact copy keeps that verification (#145).
// ponytail: in memory only; a restart between fetch and copy loses it (it's one click apart).
const wpAuthenticatedOrigins = new Set();
function requireDeclaration(declaration) {
  if (declaration?.confirmed !== true) throw new Error("Confirm that you own this website, or have the owner's written permission to copy and republish it, before importing it.");
}
async function importProvenance(url, declaration, { wpAuthenticated = false, imported = true } = {}) {
  requireDeclaration(declaration);
  const raw = String(url || "").trim();
  let source;
  try { source = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin; } catch { throw new Error("Enter the address of the website it was copied from."); }
  if (wpAuthenticated) wpAuthenticatedOrigins.add(source);
  const settings = await loadSettings();
  const zones = settings.cloudflare ? await cf.listZones(unseal(settings.cloudflare.token), settings.cloudflare.accountId).catch(() => []) : [];
  const now = new Date().toISOString();
  return {
    source,
    ...(imported && { importedAt: now }),
    declaredAt: now,
    appVersion: app.getVersion(),
    declaredBy: { name: settings.name || "", email: settings.defaults?.email || "" }, // the app default form email (#134)
    statement: String(declaration.statement || "").slice(0, 500),
    verification: await verifyOwnership(source, { zones, wpAuthenticated: wpAuthenticatedOrigins.has(source), token: String(declaration.token || "") }),
  };
}

async function publish(id, log) {
  const site = await readSite(id);
  requireProvenance(site);
  const settings = await settingsFor(id, site);
  if (!settings.cloudflare) throw new Error("Connect your Cloudflare account first (Settings).");
  if (!settings.resendKey) throw new Error("Connect your Resend account first (Settings). It sends your form emails.");
  const missingTo = site.forms.find((f) => !f.to && !settings.email);
  if (missingTo) throw new Error(`Set where "${missingTo.name}" form messages should go (Forms tab, Publish tab or Settings).`);

  const token = unseal(settings.cloudflare.token);
  const { accountId } = settings.cloudflare;
  const resendKey = unseal(settings.resendKey);
  const { state } = settings;
  // Turnstile, D1 and the Worker all belong to the account it's live on, so moving needs a take-offline first.
  if (state.accountId && state.accountId !== accountId && canUnpublish(state)) {
    throw new Error("This website is live on a different Cloudflare account. Take it offline first (or switch back to that account), then publish again.");
  }
  state.resendKeyHash = config.keyHash(resendKey);
  // Recorded up front so "Take offline" (#71) can undo even a half-finished publish.
  const labelError = site.domain && cf.labelError(site.domain.label, site.domain.zoneName);
  if (labelError) throw new Error(`Web address: ${labelError}`);
  const www = site.domain && !site.domain.label && { id: site.domain.zoneId, name: site.domain.zoneName }; // the www redirect is apex-only (#135)
  Object.assign(state, { accountId, worker: site.workerName }, www && { www });

  log("Preparing…\n");
  if (site.domain) for (const w of await cf.hostnameWarnings(token, accountId, site.domain, site.workerName)) log(`Warning: ${w}\n`);
  const hostname = site.domain ? cf.domainHostname(site.domain) : await cf.workersDevHostname(token, accountId, site.workerName);
  // A secret that isn't a real one (still sealed the pre-#136 way, or empty) is never uploaded (#218):
  // the Turnstile secret is rotated and the sending key re-created instead.
  if (state.turnstile?.secret && looksSealed(state.turnstile.secret)) {
    log("This site's Turnstile secret couldn't be read, so it's being replaced.\n");
    delete state.turnstile.secret;
  }
  if (state.sendingKey && !/^re_\w+$/.test(state.sendingKey)) {
    log("This site's Resend sending key couldn't be read, so a new one is being made.\n");
    delete state.sendingKey;
  }
  const turnstile = await cf.ensureTurnstile(token, accountId, site.name, hostname, state.turnstile && { ...state.turnstile, secret: unseal(state.turnstile.secret) });
  state.turnstile = { ...turnstile, secret: seal(turnstile.secret) };
  await writeState(id, state);

  const domainId = site.domain ? await cf.ensureResendDomain(token, site.domain, resendKey, log) : null;
  if (!state.sendingKey || state.sendingKeyDomain !== domainId) {
    const key = await cf.createSendingKey(resendKey, site.name, domainId);
    state.sendingKey = seal(key.token);
    state.sendingKeyId = key.id;
    state.sendingKeyDomain = domainId;
    await writeState(id, state);
  }

  // The form inbox (#75). Older tokens lack D1 permission: publish without it rather than fail.
  try {
    state.d1 = await cf.ensureD1(token, accountId, site.workerName, state.d1);
    await writeState(id, state);
  } catch (e) {
    log(`Couldn't set up the form inbox (${e.message}). Form messages will only be emailed. Add Account · D1 · Edit to your Cloudflare token and publish again.\n`);
  }

  const options = {
    workerName: site.workerName,
    hostname,
    sitekey: turnstile.sitekey,
    fromAddress: site.domain ? `website@${site.domain.zoneName}` : "onboarding@resend.dev",
    d1: state.d1,
  };
  await buildSite(site, publishDir(id), options);
  log("Uploading website…\n");
  const secrets = { TURNSTILE_SECRET_KEY: turnstile.secret, RESEND_API_KEY: unseal(state.sendingKey) };
  if (!validSecrets(secrets)) throw new Error("The website's form keys aren't valid, so it wasn't published (its forms couldn't send email). Reconnect Resend and Cloudflare in Settings, then publish again.");
  await cf.deployWorker(publishDir(id), { token, accountId }, secrets, log);

  // The site is already live by now, so a missing token permission only costs the www redirect.
  if (site.domain) await cf.ensureWwwRedirect(token, site.domain, log).catch((e) =>
    log(`Couldn't set up the www redirect (${e.message}). Add Zone · Single Redirect · Edit to your Cloudflare token and publish again.\n`));

  state.url = `https://${hostname}`;
  state.publishedAt = new Date().toISOString();
  await writeState(id, state);
  log(`\nDone! Your website is live at ${state.url}\n`);
  return state.url;
}

// Undoes publish() (#71). Throws if anything couldn't be removed; publish.json
// keeps just those parts, so trying again only retries them.
async function unpublish(id, log) {
  const site = await readSite(id);
  const { published, state } = await settingsFor(id, site);
  if (!published.cloudflare) throw new Error(state.accountId
    ? "This website is on a Cloudflare account that isn't connected any more. Connect it again (Settings, or this site's Publish tab) so the website can be removed from it."
    : "Connect your Cloudflare account first (Settings), so the website can be removed from it.");
  if (state.url) { // published before publish.json recorded these
    state.worker ??= site.workerName;
    if (site.domain && !site.domain.label) state.www ??= { id: site.domain.zoneId, name: site.domain.zoneName };
  }
  state.accountId ??= published.cloudflare.accountId;
  log("Taking the website offline…\n");
  const { state: left, failed } = await cf.unpublish(unseal(published.cloudflare.token), unseal(published.resendKey), state, log);
  await writeState(id, left);
  if (failed.length) throw new Error(`Couldn't remove ${failed.join(", ")}. See the log, then try again.`);
  log("\nDone. The website is offline.\n");
}
const canUnpublish = (s) => Boolean(s.url || s.worker || s.www || s.turnstile || s.sendingKeyId || s.d1);

// Form inbox (#75): read straight from the site's D1 database with the user's
// token, so no public endpoint ever serves messages. Returns null when the
// site has no inbox yet. Listing also applies the retention period, so old
// messages go even if nobody sends a new one.
async function inbox(id) {
  const { published, state, site } = await settingsFor(id);
  if (!state.d1) return null;
  if (!published.cloudflare) throw new Error("This website's Cloudflare account isn't connected. Connect it in Settings (or this site's Publish tab).");
  const token = unseal(published.cloudflare.token), { accountId } = published.cloudflare;
  return { site, query: (sql, params) => cf.d1Query(token, accountId, state.d1.id, sql, params) };
}
// ponytail: loads every message at once; page it if an inbox ever holds thousands.
async function listMessages(id) {
  const box = await inbox(id);
  if (!box) return null;
  await box.query("DELETE FROM messages WHERE created_at < datetime('now', ?)", [`-${inboxDays(box.site)} days`]);
  return box.query("SELECT id, form, fields, created_at, email_status FROM messages ORDER BY id DESC");
}

// Theme sources (#58): the public repo (hideable via settings.hidePublicThemes)
// plus settings.themeSources, [{ spec, token? (sealed) }]. Tokens never leave
// the main process. Returns [{ spec, public, hidden, hasToken, error?, ...cached listing }].
const themeCache = () => data("theme-cache");
const sourcesOf = (s) => [{ spec: themeSources.PUBLIC_SOURCE, public: true, hidden: Boolean(s.hidePublicThemes) }, ...(s.themeSources || [])];
const findSource = async (spec) => {
  const source = sourcesOf(await loadSettings()).find((x) => x.spec === spec);
  if (!source) throw new Error(`${spec} isn't one of your theme sources.`);
  return source;
};
// A source without its own token uses the GitHub sign-in (#60), if any.
const fetchSource = async (source) => themeSources.fetchSource(source.spec, { cacheRoot: themeCache(), token: unseal(source.token) || unseal((await loadSettings()).github?.token), api: GITHUB_API });
// Downloads only sources that have never been downloaded; "Refresh" and "Update theme" fetch again.
async function listSources() {
  const local = { spec: LOCAL, local: true, themes: await builder.listLocal(localThemes()) };
  return Promise.all(sourcesOf(await loadSettings()).map(async (source) => {
    const info = { spec: source.spec, public: Boolean(source.public), hidden: Boolean(source.hidden), hasToken: Boolean(source.token) };
    if (source.hidden) return info;
    try {
      return { ...info, ...((await themeSources.readSource(source.spec, themeCache())) || (await fetchSource(source))) };
    } catch (e) {
      return { ...info, error: e.message };
    }
  })).then((list) => [...list, local]);
}
// Copies a theme into the site folder; returns the theme (font registered) and the font list.
async function useTheme(id, spec, themeId) {
  if (spec === LOCAL) await builder.installLocal(localThemes(), themeId, siteDir(id));
  else await themeSources.installTheme(spec, themeId, themeCache(), siteDir(id));
  return { theme: loadTheme(path.join(siteDir(id), "theme"), themeId), fonts };
}

// What the renderer may see of a set of accounts (the app's or a site's own): never the secrets.
const publicAccounts = (a) => ({
  cloudflare: a.cloudflare?.token ? { accountId: a.cloudflare.accountId, accounts: a.cloudflare.accounts, warnings: a.cloudflare.warnings } : null,
  resend: Boolean(a.resendKey),
});
const publicSettings = (s) => ({
  ...publicAccounts(s), defaults: s.defaults, autoUpdate: s.autoUpdate !== false,
  github: s.github?.token ? { login: s.github.login, privateRepos: s.github.privateRepos } : null, githubConfigured: Boolean(GITHUB_CLIENT_ID),
  version: app.getVersion(), releasesUrl: update.LATEST_URL.replace("/download/latest.json", ""), dataDir: data(),
  sitesFolder: SITES, portable: { on: keyring.portable, locked: keyring.portable && !keyring.key }, secretsProblem: secrets.problems()[0] || null,
});
// Account changes apply to the app's accounts, or to one site's own when siteId is given (#134).
async function editAccounts(siteId, change) {
  if (typeof siteId === "string") return publicAccounts(await settingsStore.updateSite(siteDir(siteId), change));
  return publicSettings(await updateSettings(change));
}

// Theme Builder (#130): local themes in userData/themes-local, listed in the
// Design tab as the "local" source. The live preview builds sample content (or
// one of the user's sites) as a pseudo-site whose folder is never listed (no site.json).
const LOCAL = "local";
const localThemes = () => data("themes-local");
const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
let sampleAssetsFrom;
async function previewTheme(controls, siteId) {
  const dir = siteDir(SAMPLE_ID);
  const real = siteId && (await readSite(siteId));
  const sample = builder.sampleSite(controls);
  const onSite = real?.pages.some((p) => !p.mirror);
  const { theme, themeSource, colors, font } = sample;
  const site = onSite ? { ...real, theme, themeSource, colors, font, pages: real.pages.filter((p) => !p.mirror) } : sample;
  return queueBuild(async () => {
    const errors = await builder.writeTheme(path.join(dir, "theme"), controls);
    const from = onSite ? siteId : "sample";
    if (sampleAssetsFrom !== from) {
      await fs.rm(path.join(dir, "assets"), { recursive: true, force: true });
      if (onSite) await fs.cp(path.join(siteDir(siteId), "assets"), path.join(dir, "assets"), { recursive: true }).catch(() => {});
      else await builder.sampleAssets(path.join(dir, "assets"));
      sampleAssetsFrom = from;
    }
    if (!errors.length) await build(site, dir, previewDir(SAMPLE_ID), { preview: true });
    return { id: SAMPLE_ID, errors, warnings: builder.warnings(controls) };
  });
}
// preview.png: the sample preview at 1280x800 in a hidden window, downscaled to 640x400.
async function capturePreview() {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`preview://${SAMPLE_ID}/`);
    await win.webContents.insertCSS("::-webkit-scrollbar { display: none; }");
    await new Promise((r) => setTimeout(r, 500)); // images and fonts
    return (await win.webContents.capturePage()).resize({ width: 640, height: 400, quality: "best" }).toPNG();
  } finally {
    win.destroy();
  }
}

// GitHub sign-in (device flow) and publishing Theme Builder themes (#60). The
// token is app-wide (settings.github, sealed) and never reaches the renderer.
let deviceFlow = null;
async function githubToken() {
  const s = await loadSettings();
  if (!s.github) throw new Error("Sign in with GitHub in Settings first.");
  return unseal(s.github.token);
}
const publishable = (id) => {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Bad theme id");
  return github.themeFiles(path.join(localThemes(), id)); // validated; only theme.json/theme.css/preview.png
};

const handlers = {
  themes: () => ({ themes, fonts }),
  "builder:list": () => builder.listLocal(localThemes()),
  "builder:new": () => builder.clean({}),
  "builder:preview": (controls, siteId) => previewTheme(controls, siteId),
  // Selectors come from the preview's frame script: classes and tag names only.
  "builder:css-rule": (css, selectors) => {
    if (typeof css !== "string" || !Array.isArray(selectors) || !selectors.length || !selectors.every((s) => typeof s === "string" && /^[\w.\- >]{1,200}$/.test(s))) throw new Error("Bad selector");
    return builder.cssRule(css, { selectors });
  },
  "builder:save": async (controls) => {
    const { errors } = await previewTheme(controls);
    if (errors.length) return { errors };
    const png = await capturePreview().catch((e) => (console.error("Couldn't capture the theme preview:", e), null));
    await fs.mkdir(localThemes(), { recursive: true });
    return builder.saveLocal(localThemes(), controls, png);
  },
  "builder:delete": (id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Bad theme id");
    return fs.rm(path.join(localThemes(), id), { recursive: true, force: true });
  },
  "builder:from-site": async (id) => builder.fromSite(await readSite(id), siteDir(id), themes),
  "themes:sources": listSources,
  "themes:add": async (spec, token) => {
    spec = themeSources.parseSource(spec).spec;
    const s = await loadSettings();
    if (sourcesOf(s).some((x) => x.spec === spec)) throw new Error(`${spec} is already in your theme sources.`);
    const source = { spec, ...(String(token || "").trim() && { token: seal(String(token).trim()) }) };
    await fetchSource(source); // throws with GitHub's reason, so a wrong name or token is never saved
    await updateSettings((latest) => {
      if (!sourcesOf(latest).some((x) => x.spec === spec)) latest.themeSources = [...(latest.themeSources || []), source];
    });
    return listSources();
  },
  "themes:remove": async (spec) => {
    await updateSettings((s) => { s.themeSources = (s.themeSources || []).filter((x) => x.spec !== spec); });
    await fs.rm(path.join(themeCache(), themeSources.cacheKey(spec)), { recursive: true, force: true });
    return listSources();
  },
  "themes:hide-public": async (hidden) => {
    await updateSettings((s) => { s.hidePublicThemes = Boolean(hidden); });
    return listSources();
  },
  "themes:refresh": async (spec) => {
    await fetchSource(await findSource(spec));
    return listSources();
  },
  "themes:use": (id, spec, themeId) => useTheme(id, spec, themeId),
  // Fetches the source again and replaces the site's copy; colours and font are left alone.
  "themes:update": async (id, spec, themeId) => {
    if (spec !== LOCAL) await fetchSource(await findSource(spec));
    return useTheme(id, spec, themeId);
  },

  "sites:list": async () => {
    const list = await Promise.all([...sites.keys()].map(readSite));
    return list.filter(Boolean).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  },
  "sites:create": async (name, theme) => {
    const site = newSite(String(name).trim() || "My website", theme);
    const dir = await folder.freeDir(SITES, site.name);
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    sites.set(site.id, dir);
    await json.write(path.join(dir, "site.json"), site);
    await repo.ensure(dir, await author(), "Created the website");
    await previewBuild(site);
    return site;
  },
  "sites:get": async (id) => {
    await saveAllHistory(); // switching sites ends a batch of edits
    const state = await readState(id);
    return { site: await readSite(id), url: state.url || null, canUnpublish: canUnpublish(state), accounts: publicAccounts(await settingsStore.loadSite(siteDir(id))) };
  },
  "sites:save": async (site) => {
    await json.write(path.join(siteDir(site.id), "site.json"), site);
    return previewBuild(site); // page id -> preview path
  },
  "sites:delete": async (id, offline, event) => {
    if (offline) await unpublish(id, (line) => event.sender.send("publish-log", line)); // throws before anything local is deleted
    clearTimeout(pendingCommits.get(id));
    pendingCommits.delete(id);
    for (const dir of [siteDir(id), previewDir(id), publishDir(id)]) await fs.rm(dir, { recursive: true, force: true });
    sites.delete(id);
  },
  "sites:export": async (id) => {
    const site = await readSite(id);
    requireProvenance(site);
    const { canceled, filePaths } = await dialog.showOpenDialog({ title: "Choose where to save the website package", properties: ["openDirectory", "createDirectory"] });
    if (canceled) return null;
    const out = path.join(filePaths[0], site.workerName);
    await fs.mkdir(out); // throws if it exists, so we never overwrite a user's folder
    const state = await readState(id);
    await buildSite(site, out, { workerName: site.workerName, hostname: cf.domainHostname(site.domain), sitekey: state.turnstile?.sitekey, fromAddress: site.domain ? `website@${site.domain.zoneName}` : undefined, d1: state.d1 });
    shell.showItemInFolder(out);
    return out;
  },
  "sites:publish": async (id, event) => {
    await saveHistory(id);
    const url = await publish(id, (line) => event.sender.send("publish-log", line));
    await saveHistory(id, "Published the website");
    await repo.tag(siteDir(id), liveTag()).catch((e) => console.error("Couldn't tag the published version:", e));
    return url;
  },
  "sites:unpublish": async (id, event) => {
    await saveHistory(id);
    await unpublish(id, (line) => event.sender.send("publish-log", line));
    await saveHistory(id, "Took the website offline");
  },

  // History (#136): the site's versions, what each changed, and going back to one (as a new version).
  "history:list": async (id) => {
    await saveHistory(id);
    return { versions: await repo.log(siteDir(id)), large: await repo.largeFiles(siteDir(id)) };
  },
  "history:changes": (id, oid) => {
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("Bad version");
    return repo.changes(siteDir(id), oid);
  },
  "history:revert": async (id, oid) => {
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("Bad version");
    clearTimeout(pendingCommits.get(id));
    pendingCommits.delete(id);
    await repo.revert(siteDir(id), oid, await author());
    await previewBuild(await readSite(id));
  },

  // Settings › Data (#136): the sites folder and portable secrets.
  "data:open-sites": () => shell.openPath(SITES),
  "data:find-sites": async () => {
    await saveAllHistory();
    return findSites();
  },
  "data:choose-folder": async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ title: "Choose your sites folder", defaultPath: SITES, properties: ["openDirectory", "createDirectory"] });
    if (canceled) return null;
    return { path: filePaths[0], sites: (await folder.scan(filePaths[0])).size, current: sites.size };
  },
  // Points the app at a folder; with move, takes the current sites (and settings) there first.
  "data:set-folder": async (to, move) => {
    to = path.resolve(String(to));
    if (to !== SITES) {
      if (to.startsWith(SITES + path.sep)) throw new Error("Choose a folder that isn't inside your current sites folder.");
      await saveAllHistory();
      const record = () => json.update(data("location.json"), (l) => { l.sitesFolder = to; });
      if (move) await folder.moveAll(SITES, to, record);
      else await record();
      await openSitesFolder();
    }
    return checkSecrets();
  },
  "secrets:portable-on": async (passphrase) => {
    passphrase = String(passphrase || "");
    if (keyring.portable) throw new Error("Portable secrets are already on.");
    if (passphrase.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
    const { key, config: cfg } = await secrets.makePortable(passphrase);
    const before = { ...keyring };
    await json.write(portableFile(), cfg);
    Object.assign(keyring, { portable: true, key, config: cfg });
    await rememberKey(key);
    await secrets.reencrypt(secretFiles(), before, keyring);
    return checkSecrets();
  },
  "secrets:portable-off": async () => {
    if (!keyring.portable) return checkSecrets();
    if (!keyring.key) throw new Error("Unlock your secrets with the passphrase first, or choose Forget saved secrets.");
    await secrets.reencrypt(secretFiles(), keyring, { safe, portable: false, key: null });
    await fs.rm(portableFile(), { force: true });
    await rememberKey(null);
    Object.assign(keyring, { portable: false, key: null, config: null });
    return checkSecrets();
  },
  "secrets:unlock": async (passphrase) => {
    keyring.key = await secrets.unlock(keyring.config, String(passphrase || ""));
    await rememberKey(keyring.key);
    return checkSecrets();
  },
  // Passphrase forgotten: the secrets files are kept aside (never deleted) and everything starts again.
  "secrets:forget": async () => {
    const stamp = Date.now();
    for (const f of secretFiles()) await fs.rename(f, `${f}.unreadable-${stamp}`).catch(() => {});
    await fs.rm(portableFile(), { force: true });
    await rememberKey(null);
    Object.assign(keyring, { portable: false, key: null, config: null });
    return checkSecrets();
  },
  // One-time notices for the renderer: websites moved, secrets that need re-entering or unlocking.
  "notice:get": async () => {
    await checkSecrets();
    const moved = notice;
    notice = null;
    return { moved, secrets: secrets.problems()[0] || null, locked: keyring.portable && !keyring.key };
  },

  "inbox:list": listMessages,
  "inbox:delete": async (id, messageId) => {
    const box = await inbox(id);
    if (box) await box.query("DELETE FROM messages WHERE id = ?", [Number(messageId)]);
  },
  "inbox:export": async (id) => {
    const rows = await listMessages(id);
    if (!rows) return null;
    const site = await readSite(id);
    const { canceled, filePath } = await dialog.showSaveDialog({ title: "Save form messages", defaultPath: `${site.workerName}-messages.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (canceled) return null;
    await fs.writeFile(filePath, "\ufeff" + cf.messagesCsv(rows, Object.fromEntries(site.forms.map((f) => [f.id, f.name])))); // BOM so Excel reads UTF-8
    return filePath;
  },

  "images:save": async (id, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 20e6) throw new Error("Image too large.");
    const file = `assets/${hex(6)}.webp`;
    await fs.mkdir(path.join(siteDir(id), "assets"), { recursive: true });
    await fs.writeFile(path.join(siteDir(id), file), bytes);
    return file;
  },

  "settings:get": async () => publicSettings(await loadSettings()),
  // These take an optional site id last: given one, they change that site's own accounts.
  "settings:cloudflare": async (token, siteId) => {
    token = String(token).trim();
    const { accounts, warnings } = await cf.checkCloudflareToken(token);
    return editAccounts(siteId, (a) => { a.cloudflare = { token: seal(token), accountId: accounts[0].id, accounts, warnings }; });
  },
  "settings:account": (accountId, siteId) => editAccounts(siteId, (a) => {
    if (!a.cloudflare?.accounts.some((x) => x.id === accountId)) throw new Error("Unknown account.");
    a.cloudflare.accountId = accountId;
  }),
  "settings:resend": async (key, siteId) => {
    key = String(key).trim();
    await cf.checkResendKey(key);
    return editAccounts(siteId, (a) => { a.resendKey = seal(key); });
  },
  "settings:disconnect": (which, siteId) => editAccounts(siteId, (a) => { delete a[{ cloudflare: "cloudflare", github: "github" }[which] || "resendKey"]; }),
  "github:start": async (privateRepos) => {
    if (!GITHUB_CLIENT_ID) throw new Error("GitHub sign-in isn't configured in this copy of the app.");
    const flow = await github.startDeviceFlow({ clientId: GITHUB_CLIENT_ID, scope: privateRepos ? "public_repo repo" : "public_repo", login: GITHUB_LOGIN });
    deviceFlow = { ...flow, privateRepos: Boolean(privateRepos) };
    return { userCode: flow.userCode, verificationUri: flow.verificationUri };
  },
  // Waits for the user to approve the code on GitHub, then stores the token.
  "github:finish": async () => {
    const flow = deviceFlow;
    if (!flow) throw new Error("Sign-in cancelled.");
    try {
      const { token } = await github.pollDeviceFlow({ ...flow, clientId: GITHUB_CLIENT_ID, login: GITHUB_LOGIN, cancelled: () => deviceFlow !== flow });
      const { login } = await github.user(GITHUB_API, token);
      return publicSettings(await updateSettings((s) => { s.github = { token: seal(token), login, privateRepos: flow.privateRepos }; }));
    } finally {
      if (deviceFlow === flow) deviceFlow = null;
    }
  },
  "github:cancel": () => { deviceFlow = null; },
  // The last repo pushed to, else PhaseN's private themes repo if the user can write to it.
  "github:push-target": async () => {
    const s = await loadSettings();
    if (!s.github) return "";
    return s.github.pushRepo || ((await github.canPush(GITHUB_API, unseal(s.github.token), github.PRIVATE_DEFAULT)) ? github.PRIVATE_DEFAULT : "");
  },
  "github:push": async (id, target) => {
    const token = await githubToken();
    const { files, json: theme } = await publishable(id);
    const r = await github.pushTheme({ api: GITHUB_API, token, target, id, files, version: theme.version || "1.0.0" });
    await updateSettings((s) => { if (s.github) s.github.pushRepo = themeSources.parseSource(target).spec; });
    return r;
  },
  "github:submit": async (id) => {
    const token = await githubToken();
    const { files, json: theme } = await publishable(id);
    return github.submitTheme({ api: GITHUB_API, token, id, files, label: theme.label, about: theme.about, version: theme.version || "1.0.0" });
  },
  "settings:default": async (key, value) => {
    if (!config.FIELDS.includes(key)) throw new Error("Unknown setting.");
    return publicSettings(await updateSettings((s) => { s.defaults[key] = key === "inboxDays" ? Math.max(1, Math.round(Number(value)) || 90) : String(value).trim(); }));
  },
  "settings:auto-update": async (on) => {
    return publicSettings(await updateSettings((s) => { s.autoUpdate = Boolean(on); }));
  },
  "settings:open-data": () => shell.openPath(data()),
  zones: async (siteId) => {
    const { cloudflare } = await settingsFor(siteId);
    return cloudflare ? cf.listZones(unseal(cloudflare.token), cloudflare.accountId) : [];
  },
  "domain:check": async (id, domain) => {
    const site = await readSite(id);
    const { cloudflare } = site ? await settingsFor(id, site) : {}; // the site's resolved account (#134)
    return cloudflare && site ? cf.hostnameWarnings(unseal(cloudflare.token), cloudflare.accountId, cf.siteDomain(domain), site.workerName) : [];
  },
  "wp:fetch": async (url, username, password, declaration) => {
    requireDeclaration(declaration);
    const result = await wp.fetchWordPress(url, username, password);
    return { ...result, provenance: await importProvenance(url, declaration, { wpAuthenticated: result.authenticated }) };
  },
  // Declaration for a site imported before #141; it has to be given before the site can be published again.
  "import:declare": async (id, url, declaration) => {
    requireDeclaration(declaration);
    const site = await readSite(id);
    if (!site || !isImported(site)) throw new Error("Only imported websites need an ownership declaration.");
    site.importProvenance = await importProvenance(url, declaration, { imported: false });
    await json.write(path.join(siteDir(id), "site.json"), site);
    return site.importProvenance;
  },
  "wp:image": (url) => wp.downloadImage(url),
  "mirror:read": (id, file) => fs.readFile(mirrorFile(id, file), "utf8"),
  "mirror:write": (id, file, html) => fs.writeFile(mirrorFile(id, file), String(html)),
  // Kept once, before a page's first edit, for "Revert this page to the original".
  "mirror:keep-original": async (id, file) => {
    const original = mirrorFile(id, file, "mirror-original");
    await fs.mkdir(path.dirname(original), { recursive: true });
    await fs.copyFile(mirrorFile(id, file), original, fs.constants.COPYFILE_EXCL).catch((e) => { if (e.code !== "EEXIST") throw e; });
  },
  "mirror:original": (id, file) => fs.readFile(mirrorFile(id, file, "mirror-original"), "utf8"),
  // An exact copy turned editable (#161): its copied pages would otherwise still be served and published.
  "mirror:discard": async (id) => {
    if ((await readSite(id))?.mirror) throw new Error("This website is still an exact copy.");
    for (const dir of ["mirror", "mirror-original"]) await fs.rm(path.join(siteDir(id), dir), { recursive: true, force: true });
  },
  // Exact-copy import: see lib/mirror.js.
  "wp:mirror": async (url, declaration, event) => {
    requireDeclaration(declaration);
    const site = newSite("Imported website", "clean");
    const dir = await folder.freeDir(SITES, String(url).replace(/^https?:\/\//i, "").replace(/^www\./i, ""));
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    sites.set(site.id, dir);
    try {
      const result = await mirrorSite(url, path.join(dir, "mirror"), (line) => event.sender.send("import-log", line));
      site.name = result.name || new URL(/^https?:/i.test(url) ? url : `https://${url}`).host;
      site.workerName = workerNameFor(site.name);
      site.pages = result.pages.map((p) => ({ id: hex(4), title: p.title, mirror: p.path, file: p.file, sections: [] }));
      site.forms = result.forms.map((f) => ({ id: f.id, name: f.name, to: "", success: "Thanks, your message has been sent.", fields: f.fields, mirrored: true, shownOn: f.pages }));
      site.mirror = { formFiles: result.formFiles };
      site.importProvenance = await importProvenance(url, declaration);
      await json.write(path.join(dir, "site.json"), site);
      await repo.ensure(dir, await author(), `Imported from ${site.importProvenance.source} (exact copy)`);
      await previewBuild(site);
      return site.id;
    } catch (e) {
      sites.delete(site.id);
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  },
  // Fetches latest.json at most once a day; the result is kept in settings so
  // a restart the same day still shows the banner. Offline or any error: null
  // (no banner), and the next call tries again. Settings › Updates passes
  // force (Check now): always fetches, and throws instead of returning null.
  // With auto-check off, only forced checks run.
  "update:check": async (force) => {
    force = force === true;
    let { updateCheck, autoUpdate } = await loadSettings();
    if (!force && autoUpdate === false) return null;
    if (force || !updateCheck || Date.now() - updateCheck.at > 24 * 3600e3) {
      try {
        const res = await net.fetch(UPDATE_URL, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const latest = await res.json();
        updateCheck = { at: Date.now(), version: String(latest.version), url: update.pickDownload(latest.downloads, process.platform, process.arch) };
      } catch (e) {
        if (force) throw new Error(`Couldn't check for updates (${e.message}). Check your internet connection and try again.`);
        return null;
      }
      await updateSettings((s) => { s.updateCheck = updateCheck; });
    }
    return { version: updateCheck.version, url: updateCheck.url, newer: Boolean(updateCheck.url && update.isNewer(updateCheck.version, app.getVersion())) };
  },
  open: (url) => /^https:\/\//.test(url) && shell.openExternal(url),
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (event, ...args) => {
    await ready;
    while (renaming) await renaming; // no await when idle, so nothing slips in between this and busy++
    const result = await whileBusy(() => fn(...args, event));
    if (EDITS.has(channel)) {
      const id = channel === "sites:save" ? args[0]?.id : channel.startsWith("settings:") ? args.at(-1) : args[0];
      if (typeof id === "string" && sites.has(id)) autosave(id);
    }
    return result;
  });
}

// One running copy per userData (#149): lib/json-store.js queues writes per
// process, so two copies could each overwrite the other's changes. A second
// launch quits and brings the existing window to the front instead.
const firstInstance = app.requestSingleInstanceLock();
let mainWindow;
if (!firstInstance) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!firstInstance) return;
  // Replaced/removed images (#14); see pruneAssets for why only at startup.
  ready.then(() => handlers["sites:list"]()).then((sites) => Promise.all(sites.map(async ({ id }) => pruneAssets(await readSite(id), siteDir(id)))))
    .catch((e) => console.error("Couldn't remove unused images:", e));
  protocol.handle("preview", async (request) => {
    await ready;
    while (renaming) await renaming;
    const { host, pathname } = new URL(request.url);
    if (!ID_RE.test(host) || (host !== SAMPLE_ID && !sites.has(host))) return new Response("Not found", { status: 404 });
    const p = path.posix.normalize(decodeURIComponent(pathname)); // so "/assets/..%2F" can't reach the site folder
    const frameScript = { "/__sb-edit.js": "copy-edit-frame.js", "/__sb-pick.js": "content-pick-frame.js", "/__sb-theme.js": "theme-builder-frame.js" }[p];
    if (frameScript) {
      return new Response(await fs.readFile(path.join(__dirname, "app", frameScript)), { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } });
    }
    // Uploaded images come straight from the site folder so a fresh upload
    // shows before the next preview build finishes; exact-copy pages are
    // served from the site folder too rather than copied on every save.
    // A copied site's own /assets/ files sit in mirror/ (#163).
    const mirror = path.join(siteDir(host), "mirror");
    const roots = p.startsWith("/assets/") ? [siteDir(host), mirror] : [mirror, path.join(previewDir(host), "public")];
    const names = p.endsWith("/") ? [`${p}index.html`] : path.extname(p) ? [p] : [`${p}.html`, `${p}/index.html`];
    const find = async (candidates) => {
      for (const name of candidates) for (const root of roots) {
        const file = path.join(root, path.normalize(name));
        if (file.startsWith(root + path.sep) && (await fs.stat(file).catch(() => null))?.isFile()) return file;
      }
    };
    const found = await find(names);
    const file = found || (await find(["/404.html"]));
    if (!file) return new Response("Not found", { status: 404 });
    // Copied pages get the provenance marker the published copy will have (#145),
    // and open in edit mode on the Pages tab (app/copied.js). The editor reads
    // and writes the file itself (mirror:read/write), so neither ends up in it.
    if (file.endsWith(".html") && file.startsWith(mirror + path.sep)) {
      let html = stampHtml(await fs.readFile(file, "utf8"), (await readSite(host).catch(() => null))?.importProvenance);
      const params = new URL(request.url).searchParams;
      if (found && params.has("sb-edit")) html = html.replace(/<\/body>|$/i, (m) => `<script src="/__sb-edit.js"></script>${m}`);
      // The editable import's review step (#161): only our script runs, so the page shows exactly the HTML being imported.
      const nonce = found && params.has("sb-pick") && hex(16);
      if (nonce) html = html.replace(/<\/body>|$/i, (m) => `<script nonce="${nonce}" src="/__sb-pick.js"></script>${m}`);
      return new Response(html, { status: found ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...(nonce && { "Content-Security-Policy": `script-src 'nonce-${nonce}'; object-src 'none'` }) } });
    }
    // The Theme Builder's preview gets its right-click menu script (#156).
    if (file.endsWith(".html") && host === SAMPLE_ID && new URL(request.url).searchParams.has("sb-theme")) {
      const html = (await fs.readFile(file, "utf8")).replace(/<\/body>|$/i, (m) => `<script src="/__sb-theme.js"></script>${m}`);
      return new Response(html, { status: found ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const res = await net.fetch(pathToFileURL(file).href);
    // Every save rewrites these files, so the preview must never cache them.
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: found ? 200 : 404, headers });
  });

  const win = mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: "PhaseN Site Builder",
    icon: path.join(__dirname, "build", "icon.png"), // Linux/dev window icon; packaged mac/win use build.icon
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.removeMenu();
  // Links clicked in the preview open in the user's real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Closing (or quitting) first writes an edit still waiting for the editor's
  // autosave (app.js flushSave, #143); a stuck renderer can't hold it open past 5s.
  let flushed = false;
  win.on("close", (e) => {
    if (flushed) return;
    e.preventDefault();
    flushed = true;
    Promise.race([win.webContents.executeJavaScript("flushSave()"), new Promise((r) => setTimeout(r, 5000))])
      .catch(() => {}).finally(() => win.close());
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
});

app.on("window-all-closed", () => saveAllHistory().finally(() => app.quit())); // the last batch of edits goes into the history
