const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, dialog, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build, themes } = require("./lib/build");
const cf = require("./lib/publish");

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
    workerName: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site"}-${hex(2)}`,
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

  log("Preparing…\n");
  const hostname = site.domain ? site.domain.name : await cf.workersDevHostname(token, accountId, site.workerName);
  const turnstile = await cf.ensureTurnstile(token, accountId, site.name, hostname, state.turnstile && { ...state.turnstile, secret: unseal(state.turnstile.secret) });
  state.turnstile = { ...turnstile, secret: seal(turnstile.secret) };
  await writeState(id, state);

  const domainId = site.domain ? await cf.ensureResendDomain(token, site.domain, resendKey, log) : null;
  if (!state.sendingKey || state.sendingKeyDomain !== domainId) {
    state.sendingKey = seal(await cf.createSendingKey(resendKey, site.name, domainId));
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

  state.url = `https://${hostname}`;
  state.publishedAt = new Date().toISOString();
  await writeState(id, state);
  log(`\nDone! Your website is live at ${state.url}\n`);
  return state.url;
}

function publicSettings(s) {
  return {
    cloudflare: s.cloudflare && { accountId: s.cloudflare.accountId, accounts: s.cloudflare.accounts, warnings: s.cloudflare.warnings },
    resend: Boolean(s.resendKey),
    email: s.email || "",
  };
}

const handlers = {
  themes: () => require("./themes/themes.json"),

  "sites:list": async () => {
    const ids = await fs.readdir(data("sites")).catch(() => []);
    const sites = await Promise.all(ids.filter((i) => ID_RE.test(i)).map(readSite));
    return sites.filter(Boolean).map(({ id, name }) => ({ id, name }));
  },
  "sites:create": async (name, theme) => {
    const site = newSite(String(name).trim() || "My website", theme);
    await fs.mkdir(path.join(siteDir(site.id), "assets"), { recursive: true });
    await writeJson(path.join(siteDir(site.id), "site.json"), site);
    await queueBuild(() => build(site, siteDir(site.id), previewDir(site.id)));
    return site;
  },
  "sites:get": async (id) => ({ site: await readSite(id), url: (await readState(id)).url || null }),
  "sites:save": async (site) => {
    await writeJson(path.join(siteDir(site.id), "site.json"), site);
    return queueBuild(() => build(site, siteDir(site.id), previewDir(site.id))); // page id -> preview path
  },
  "sites:delete": async (id) => {
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
  open: (url) => /^https:\/\//.test(url) && shell.openExternal(url),
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, (event, ...args) => fn(...args, event));
}

app.whenReady().then(() => {
  protocol.handle("preview", async (request) => {
    const { host, pathname } = new URL(request.url);
    if (!ID_RE.test(host)) return new Response("Not found", { status: 404 });
    let p = decodeURIComponent(pathname);
    // Images come straight from the site folder so a fresh upload shows
    // before the next preview build finishes.
    const root = p.startsWith("/assets/") ? siteDir(host) : path.join(previewDir(host), "public");
    if (p.endsWith("/")) p += "index.html";
    else if (!path.extname(p)) p += ".html";
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).href).catch(() => net.fetch(pathToFileURL(path.join(previewDir(host), "public", "404.html")).href));
    // Every save rewrites these files, so the preview must never cache them.
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, headers });
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
