const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, dialog, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build, pruneAssets, themes, fonts } = require("./lib/build");
const cf = require("./lib/publish");
const wp = require("./lib/wordpress");
const { mirrorSite } = require("./lib/mirror");
const update = require("./lib/update");
const themeSources = require("./lib/theme-sources");
const { loadTheme } = require("./lib/themes");

// The regression suite points this at a fake latest.json; never honoured in a packaged build.
const UPDATE_URL = (!app.isPackaged && process.env.SITEBUILDER_UPDATE_URL) || update.LATEST_URL;
// Same for the fake GitHub API (theme sources, #58).
const GITHUB_API = (!app.isPackaged && process.env.SITEBUILDER_GITHUB_API) || themeSources.GITHUB_API;

// preview://<site-id>/... serves the last preview build so the editor can
// show the real generated site in an iframe, no local web server needed.
protocol.registerSchemesAsPrivileged([{ scheme: "preview", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const ID_RE = /^[a-f0-9-]{36}$/;
const data = (...p) => path.join(app.getPath("userData"), ...p);
const siteDir = (id) => {
  if (!ID_RE.test(id)) throw new Error("Bad site id");
  return data("sites", id);
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

const readJson = (file, fallback) => fs.readFile(file, "utf8").then(JSON.parse, () => fallback);
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));
const seal = (v) => safeStorage.encryptString(v).toString("base64");
const unseal = (v) => (v ? safeStorage.decryptString(Buffer.from(v, "base64")) : "");
const hex = (n) => crypto.randomBytes(n).toString("hex");

const loadSettings = () => readJson(data("settings.json"), {});
const saveSettings = (s) => writeJson(data("settings.json"), s);
const readSite = (id) => readJson(path.join(siteDir(id), "site.json"), null);
// Per-site deploy state (Turnstile keys, Resend sending key). Kept apart from
// site.json so secrets never end up in a build or export.
const readState = (id) => readJson(path.join(siteDir(id), "publish.json"), {});
const writeState = (id, s) => writeJson(path.join(siteDir(id), "publish.json"), s);

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

async function publish(id, log) {
  const settings = await loadSettings();
  if (!settings.cloudflare) throw new Error("Connect your Cloudflare account first.");
  if (!settings.resendKey) throw new Error("Connect your Resend account first (it sends your form emails).");
  const site = await readSite(id);
  const missingTo = site.forms.find((f) => !f.to && !settings.email);
  if (missingTo) throw new Error(`Set where "${missingTo.name}" form messages should go (Forms tab or account settings).`);

  const token = unseal(settings.cloudflare.token);
  const { accountId } = settings.cloudflare;
  const resendKey = unseal(settings.resendKey);
  const state = await readState(id);
  // Recorded up front so "Take offline" (#71) can undo even a half-finished publish.
  Object.assign(state, { accountId, worker: site.workerName }, site.domain && { www: { id: site.domain.id, name: site.domain.name } });

  log("Preparing…\n");
  const hostname = site.domain ? site.domain.name : await cf.workersDevHostname(token, accountId, site.workerName);
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

  const options = {
    workerName: site.workerName,
    hostname,
    sitekey: turnstile.sitekey,
    fromAddress: site.domain ? `website@${site.domain.name}` : "onboarding@resend.dev",
    defaultTo: settings.email,
  };
  await build(site, siteDir(id), publishDir(id), options);
  log("Uploading website…\n");
  await cf.deployWorker(publishDir(id), { token, accountId }, { TURNSTILE_SECRET_KEY: turnstile.secret, RESEND_API_KEY: unseal(state.sendingKey) }, log);

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
  const settings = await loadSettings();
  if (!settings.cloudflare) throw new Error("Connect your Cloudflare account first, so the website can be removed from it.");
  const site = await readSite(id);
  const state = await readState(id);
  if (state.url) { // published before publish.json recorded these
    state.worker ??= site.workerName;
    if (site.domain) state.www ??= { id: site.domain.id, name: site.domain.name };
  }
  state.accountId ??= settings.cloudflare.accountId;
  log("Taking the website offline…\n");
  const { state: left, failed } = await cf.unpublish(unseal(settings.cloudflare.token), unseal(settings.resendKey), state, log);
  await writeState(id, left);
  if (failed.length) throw new Error(`Couldn't remove ${failed.join(", ")}. See the log, then try again.`);
  log("\nDone. The website is offline.\n");
}
const canUnpublish = (s) => Boolean(s.url || s.worker || s.www || s.turnstile || s.sendingKeyId);

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
const fetchSource = (source) => themeSources.fetchSource(source.spec, { cacheRoot: themeCache(), token: unseal(source.token), api: GITHUB_API });
// Downloads only sources that have never been downloaded; "Refresh" and "Update theme" fetch again.
async function listSources() {
  return Promise.all(sourcesOf(await loadSettings()).map(async (source) => {
    const info = { spec: source.spec, public: Boolean(source.public), hidden: Boolean(source.hidden), hasToken: Boolean(source.token) };
    if (source.hidden) return info;
    try {
      return { ...info, ...((await themeSources.readSource(source.spec, themeCache())) || (await fetchSource(source))) };
    } catch (e) {
      return { ...info, error: e.message };
    }
  }));
}
// Copies a theme into the site folder; returns the theme (font registered) and the font list.
async function useTheme(id, spec, themeId) {
  await themeSources.installTheme(spec, themeId, themeCache(), siteDir(id));
  return { theme: loadTheme(path.join(siteDir(id), "theme"), themeId), fonts };
}

function publicSettings(s) {
  return {
    cloudflare: s.cloudflare && { accountId: s.cloudflare.accountId, accounts: s.cloudflare.accounts, warnings: s.cloudflare.warnings },
    resend: Boolean(s.resendKey),
    email: s.email || "",
  };
}

const handlers = {
  themes: () => ({ themes, fonts }),
  "themes:sources": listSources,
  "themes:add": async (spec, token) => {
    spec = themeSources.parseSource(spec).spec;
    const s = await loadSettings();
    if (sourcesOf(s).some((x) => x.spec === spec)) throw new Error(`${spec} is already in your theme sources.`);
    const source = { spec, ...(String(token || "").trim() && { token: seal(String(token).trim()) }) };
    await fetchSource(source); // throws with GitHub's reason, so a wrong name or token is never saved
    const latest = await loadSettings();
    latest.themeSources = [...(latest.themeSources || []), source];
    await saveSettings(latest);
    return listSources();
  },
  "themes:remove": async (spec) => {
    const s = await loadSettings();
    s.themeSources = (s.themeSources || []).filter((x) => x.spec !== spec);
    await saveSettings(s);
    await fs.rm(path.join(themeCache(), themeSources.cacheKey(spec)), { recursive: true, force: true });
    return listSources();
  },
  "themes:hide-public": async (hidden) => {
    const s = await loadSettings();
    s.hidePublicThemes = Boolean(hidden);
    await saveSettings(s);
    return listSources();
  },
  "themes:refresh": async (spec) => {
    await fetchSource(await findSource(spec));
    return listSources();
  },
  "themes:use": (id, spec, themeId) => useTheme(id, spec, themeId),
  // Fetches the source again and replaces the site's copy; colours and font are left alone.
  "themes:update": async (id, spec, themeId) => {
    await fetchSource(await findSource(spec));
    return useTheme(id, spec, themeId);
  },

  "sites:list": async () => {
    const ids = await fs.readdir(data("sites")).catch(() => []);
    const sites = await Promise.all(ids.filter((i) => ID_RE.test(i)).map(readSite));
    return sites.filter(Boolean).map(({ id, name }) => ({ id, name }));
  },
  "sites:create": async (name, theme) => {
    const site = newSite(String(name).trim() || "My website", theme);
    await fs.mkdir(path.join(siteDir(site.id), "assets"), { recursive: true });
    await writeJson(path.join(siteDir(site.id), "site.json"), site);
    await queueBuild(() => build(site, siteDir(site.id), previewDir(site.id), { preview: true }));
    return site;
  },
  "sites:get": async (id) => {
    const state = await readState(id);
    return { site: await readSite(id), url: state.url || null, canUnpublish: canUnpublish(state) };
  },
  "sites:save": async (site) => {
    await writeJson(path.join(siteDir(site.id), "site.json"), site);
    const defaultTo = (await loadSettings()).email; // the privacy page's contact address
    return queueBuild(() => build(site, siteDir(site.id), previewDir(site.id), { preview: true, defaultTo })); // page id -> preview path
  },
  "sites:delete": async (id, offline, event) => {
    if (offline) await unpublish(id, (line) => event.sender.send("publish-log", line)); // throws before anything local is deleted
    for (const dir of [siteDir(id), previewDir(id), publishDir(id)]) await fs.rm(dir, { recursive: true, force: true });
  },
  "sites:export": async (id) => {
    const site = await readSite(id);
    const { canceled, filePaths } = await dialog.showOpenDialog({ title: "Choose where to save the website package", properties: ["openDirectory", "createDirectory"] });
    if (canceled) return null;
    const out = path.join(filePaths[0], site.workerName);
    await fs.mkdir(out); // throws if it exists, so we never overwrite a user's folder
    const state = await readState(id);
    await build(site, siteDir(id), out, { workerName: site.workerName, hostname: site.domain?.name, sitekey: state.turnstile?.sitekey, fromAddress: site.domain ? `website@${site.domain.name}` : undefined, defaultTo: (await loadSettings()).email });
    shell.showItemInFolder(out);
    return out;
  },
  "sites:publish": (id, event) => publish(id, (line) => event.sender.send("publish-log", line)),
  "sites:unpublish": (id, event) => unpublish(id, (line) => event.sender.send("publish-log", line)),

  "images:save": async (id, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 20e6) throw new Error("Image too large.");
    const file = `assets/${hex(6)}.webp`;
    await fs.mkdir(path.join(siteDir(id), "assets"), { recursive: true });
    await fs.writeFile(path.join(siteDir(id), file), bytes);
    return file;
  },

  "settings:get": async () => publicSettings(await loadSettings()),
  "settings:cloudflare": async (token) => {
    token = String(token).trim();
    const { accounts, warnings } = await cf.checkCloudflareToken(token);
    const s = await loadSettings();
    s.cloudflare = { token: seal(token), accountId: accounts[0].id, accounts, warnings };
    await saveSettings(s);
    return publicSettings(s);
  },
  "settings:account": async (accountId) => {
    const s = await loadSettings();
    if (!s.cloudflare?.accounts.some((a) => a.id === accountId)) throw new Error("Unknown account.");
    s.cloudflare.accountId = accountId;
    await saveSettings(s);
    return publicSettings(s);
  },
  "settings:resend": async (key) => {
    key = String(key).trim();
    await cf.checkResendKey(key);
    const s = await loadSettings();
    s.resendKey = seal(key);
    await saveSettings(s);
    return publicSettings(s);
  },
  "settings:email": async (email) => {
    const s = await loadSettings();
    s.email = String(email).trim();
    await saveSettings(s);
    return publicSettings(s);
  },
  "settings:disconnect": async (which) => {
    const s = await loadSettings();
    delete s[which === "cloudflare" ? "cloudflare" : "resendKey"];
    await saveSettings(s);
    return publicSettings(s);
  },
  zones: async () => {
    const { cloudflare } = await loadSettings();
    return cloudflare ? cf.listZones(unseal(cloudflare.token), cloudflare.accountId) : [];
  },
  "wp:fetch": (url, username, password) => wp.fetchWordPress(url, username, password),
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
  // Exact-copy import: see lib/mirror.js.
  "wp:mirror": async (url, event) => {
    const site = newSite("Imported website", "clean");
    const dir = siteDir(site.id);
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    try {
      const result = await mirrorSite(url, path.join(dir, "mirror"), (line) => event.sender.send("import-log", line));
      site.name = result.name || new URL(/^https?:/i.test(url) ? url : `https://${url}`).host;
      site.workerName = workerNameFor(site.name);
      site.pages = result.pages.map((p) => ({ id: hex(4), title: p.title, mirror: p.path, file: p.file, sections: [] }));
      site.forms = result.forms.map((f) => ({ id: f.id, name: f.name, to: "", success: "Thanks, your message has been sent.", fields: f.fields, mirrored: true, shownOn: f.pages }));
      site.mirror = { formFiles: result.formFiles };
      await writeJson(path.join(dir, "site.json"), site);
      await queueBuild(() => build(site, dir, previewDir(site.id), { preview: true }));
      return site.id;
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  },
  // Fetches latest.json at most once a day; the result is kept in settings so
  // a restart the same day still shows the banner. Offline or any error: no
  // banner, and the next call tries again.
  "update:check": async () => {
    let { updateCheck } = await loadSettings();
    if (!updateCheck || Date.now() - updateCheck.at > 24 * 3600e3) {
      try {
        const res = await net.fetch(UPDATE_URL, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return null;
        const latest = await res.json();
        updateCheck = { at: Date.now(), version: String(latest.version), url: update.pickDownload(latest.downloads, process.platform, process.arch) };
      } catch {
        return null;
      }
      const s = await loadSettings(); // re-read: settings may have changed during the fetch
      s.updateCheck = updateCheck;
      await saveSettings(s);
    }
    return updateCheck.url && update.isNewer(updateCheck.version, app.getVersion()) ? { version: updateCheck.version, url: updateCheck.url } : null;
  },
  open: (url) => /^https:\/\//.test(url) && shell.openExternal(url),
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, (event, ...args) => fn(...args, event));
}

app.whenReady().then(() => {
  // Replaced/removed images (#14); see pruneAssets for why only at startup.
  handlers["sites:list"]().then((sites) => Promise.all(sites.map(async ({ id }) => pruneAssets(await readSite(id), siteDir(id)))))
    .catch((e) => console.error("Couldn't remove unused images:", e));
  protocol.handle("preview", async (request) => {
    const { host, pathname } = new URL(request.url);
    if (!ID_RE.test(host)) return new Response("Not found", { status: 404 });
    const p = decodeURIComponent(pathname);
    if (p === "/__sb-edit.js") {
      return new Response(await fs.readFile(path.join(__dirname, "app", "copy-edit-frame.js")), { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } });
    }
    // Uploaded images come straight from the site folder so a fresh upload
    // shows before the next preview build finishes; exact-copy pages are
    // served from the site folder too rather than copied on every save.
    const roots = p.startsWith("/assets/") ? [siteDir(host)] : [path.join(siteDir(host), "mirror"), path.join(previewDir(host), "public")];
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
    // Copied pages open in edit mode on the Pages tab (app/copied.js).
    if (found && new URL(request.url).searchParams.has("sb-edit") && found.endsWith(".html") && found.startsWith(path.join(siteDir(host), "mirror") + path.sep)) {
      const html = (await fs.readFile(found, "utf8")).replace(/<\/body>|$/i, (m) => `<script src="/__sb-edit.js"></script>${m}`);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const res = await net.fetch(pathToFileURL(file).href);
    // Every save rewrites these files, so the preview must never cache them.
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: found ? 200 : 404, headers });
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: "PhaseN Site Builder",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.removeMenu();
  // Links clicked in the preview open in the user's real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "app", "index.html"));
});

app.on("window-all-closed", () => app.quit());
