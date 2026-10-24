// Drives the real app for the regression suite: preloaded into Electron by
// test/regression.js (`electron -r test/drive.js .`), which passes the fake
// sites and output paths in SB_* environment variables. Every check lands in
// SB_RESULT as JSON; regression.js prints the summary.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { SB_USERDATA: UD, SB_DOCS, SB_PHASE, SB_RESULT, SB_SHOTS, SB_WP, SB_EL } = process.env;
app.setPath("userData", UD);
app.setPath("documents", SB_DOCS); // the sites folder is <Documents>/PhaseN Sites (#136)
const SITES = path.join(SB_DOCS, "PhaseN Sites");
const siteDirs = () => fs.readdirSync(SITES).filter((n) => !n.startsWith(".")).map((n) => path.join(SITES, n));
const S = (id) => siteDirs().find((d) => { try { return JSON.parse(fs.readFileSync(path.join(d, "site.json"), "utf8")).id === id; } catch { return false; } });
const git = require("isomorphic-git");
const PASSPHRASE = "regression passphrase";
// Linux CI has no keyring: an in-memory key keeps safeStorage working so accounts can be connected (#134).
app.whenReady().then(() => require("electron").safeStorage.setUsePlainTextEncryption(true));
const elHost = new URL(SB_EL).host;

const checks = [];
const result = { checks, sites: {} };
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(f, "utf8");

let driven = false;
app.on("browser-window-created", (_e, win) => {
  if (driven) return; // only the main window: the Theme Builder's hidden capture window must not run the steps too
  driven = true;
  win.webContents.on("console-message", (e) => { if (e.level === "error" && !/Content Security|OTS|font/.test(e.message)) console.log("[renderer]", e.message); });
  win.webContents.once("did-finish-load", async () => {
    const run = (js) => win.webContents.executeJavaScript(js);
    const frame = () => win.webContents.mainFrame.frames[0];
    // Times out: a call into a frame that's being replaced by a reload can otherwise never settle.
    const inFrame = (js) => Promise.race([frame().executeJavaScript(js), sleep(5000).then(() => { throw new Error("preview frame didn't answer"); })]);
    // Screenshots are diagnostics: capturePage can throw (UnknownVizError on CI runners, #87), so log and never fail a check.
    const shot = async (name) => {
      try { fs.writeFileSync(path.join(SB_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
      catch (e) { console.log(`screenshot ${name} skipped: ${e.message || e}`); }
    };
    // Polls fn until it returns something truthy; returns the last value either way.
    const waitFor = async (fn, ms = 15000) => {
      let v;
      for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
        try { if ((v = await fn())) return v; } catch {}
      }
      return v;
    };
    const saved = () => waitFor(() => run(`document.querySelector(".save-state")?.textContent === "All changes saved"`).then(async (ok) => ok && (await sleep(300), true)));
    const fieldInput = (label, tag = "input") => `[...document.querySelectorAll("label.field")].find((l) => l.firstChild.textContent === ${JSON.stringify(label)}).querySelector("${tag}")`;
    const clickButton = (text) => run(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);
    // Image uploads go through pickFiles; swap it for a generated PNG.
    const fakePick = (w, h, color) => run(`pickFiles = async (multiple, cb) => { const c = new OffscreenCanvas(${w}, ${h}); const g = c.getContext("2d"); g.fillStyle = "${color}"; g.fillRect(0, 0, ${w}, ${h}); cb([new File([await c.convertToBlob({ type: "image/png" })], "upload.png")]); }; 0`);
    // The ownership declaration before every import (#141): resolves to whether Import was disabled before the box was ticked.
    const declare = async () => {
      await waitFor(() => run(`Boolean(document.querySelector("dialog.declaration[open]"))`));
      const wasDisabled = await run(`document.querySelector('dialog.declaration button[value="ok"]').disabled`);
      await run(`{ const d = document.querySelector("dialog.declaration"); d.querySelector("input[type=checkbox]").click(); d.querySelector('button[value="ok"]').click(); } 0`);
      return wasDisabled;
    };
    const steps = SB_PHASE === "reinstall" ? { reinstall } : { updateBanner, createSite, richText, wordpressImport, elementorEditable, exactCopy, legacyDeclaration, pendingEdits, themeBuilder, settingsPage, themePublish, history, portableSecrets, closeWithPendingEdit };
    try {
      for (const [name, fn] of Object.entries(steps)) {
        try { await fn(); } catch (e) { check(`${name} finished without errors`, false, e.stack || String(e)); }
        await shot(name);
      }
    } finally {
      fs.writeFileSync(SB_RESULT, JSON.stringify(result, null, 2));
      app.quit();
    }

    // ---------- Settings (#134): app defaults and accounts, one site's overrides, publish with a stubbed Cloudflare/Resend ----------
    async function settingsPage() {
      const id = result.sites.created;
      // main.js calls these through the module object, so patching it here stubs every Cloudflare/Resend request.
      const cf = require("../lib/publish");
      const calls = { deploy: [], unpublish: [] };
      Object.assign(cf, {
        checkCloudflareToken: async (token) => ({ accounts: [{ id: `acct-${token}`, name: `Account ${token}` }], warnings: [] }),
        checkResendKey: async () => [],
        listZones: async () => [],
        workersDevHostname: async () => "regression.workers.dev",
        ensureTurnstile: async (token, accountId, name, hostname) => ({ sitekey: "1x00000000000000000000AA", secret: "1x0000000000000000000000000000000AA", hostname }),
        createSendingKey: async () => ({ id: "key-1", token: "re_sending" }),
        ensureD1: async (token, accountId, workerName) => ({ id: "db-1", name: `${workerName}-inbox` }),
        deployWorker: async (out, creds) => calls.deploy.push({ ...creds, forms: JSON.parse(read(path.join(out, "worker", "forms.json"))), privacy: read(path.join(out, "public", "privacy.html")) }),
        unpublish: async (token, resendKey, state) => (calls.unpublish.push({ token, resendKey }), { state: {}, failed: [] }),
      });
      const connect = (scope, placeholder, value) => run(`{ const i = document.querySelector(${JSON.stringify(`${scope} input[placeholder="${placeholder}"]`)}); i.value = ${JSON.stringify(value)}; i.nextSibling.click(); } 0`);
      const setField = (label, value, tag = "input") => run(`{ const i = ${fieldInput(label, tag)}; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("change")); } 0`);

      await run(`document.querySelector("#open-settings").click()`);
      check("settings: page opens", await waitFor(() => run(`Boolean(document.querySelector("#settings-page h1"))`)));
      await setField("Send form messages to", "app@example.com");
      await setField("Business or legal name", "App Default Ltd");
      await connect("#settings-page", "Paste your Cloudflare API token", "app");
      await waitFor(() => run(`settings.cloudflare?.accountId === "acct-app"`));
      await connect("#settings-page", "Paste your Resend API key", "re_app");
      await waitFor(() => run(`settings.resend`));
      await shot("settings");
      await run(`document.querySelector(".licences").scrollIntoView(); 0`);
      await sleep(300); await shot("settings-bottom");
      const saved1 = JSON.parse(read(path.join(SITES, ".phasen", "settings.json")));
      check("settings: defaults and accounts saved in the sites folder, secrets only in secrets.enc (#136)", saved1.defaults?.email === "app@example.com" && saved1.defaults.owner === "App Default Ltd" && saved1.cloudflare?.accountId === "acct-app" && !("token" in saved1.cloudflare) && !("resendKey" in saved1)
        && !read(path.join(SITES, ".phasen", "secrets.enc")).includes("re_app") && !fs.existsSync(path.join(UD, "settings.json")), saved1);
      check("settings: theme sources, updates, data and about sections", await run(`["Theme sources", "Check now", "Open data folder", "Find sites", "Turn on portable secrets", "Wrangler"].every((t) => document.querySelector("#settings-page").textContent.includes(t))`));

      await run(`document.querySelector('#site-list [data-id="${id}"]').click()`);
      await waitFor(() => run(`site?.id === ${JSON.stringify(id)} && Boolean(document.querySelector("#tab"))`));
      await run(`tab = "publish"; renderEditor(); 0`);
      const owner = `.overridable[data-key="owner"]`;
      const status = await waitFor(() => run(`document.querySelector('${owner} .default-value')?.textContent`));
      check("site: uses the app default", status === "Using app default (App Default Ltd)" && read(path.join(UD, "preview", id, "public", "privacy.html")).includes("run by App Default Ltd"), status);
      await run(`document.querySelector('${owner} button').click()`);
      await run(`{ const i = document.querySelector('${owner} input'); i.value = "Site Override Ltd"; i.dispatchEvent(new Event("input")); } 0`);
      await saved();
      check("site: override saved and previewed", JSON.parse(read(path.join(S(id), "site.json"))).overrides?.owner === "Site Override Ltd" && read(path.join(UD, "preview", id, "public", "privacy.html")).includes("run by Site Override Ltd"));
      check("site: app account shown", (await run(`document.querySelector(".account-status").textContent`)) === "Using app account (Account app).");
      await run(`[...document.querySelectorAll(".step")][0].querySelector("button:nth-child(2)").click()`);
      await connect(".step", "Paste your Cloudflare API token", "site");
      await waitFor(() => run(`siteAccounts.cloudflare?.accountId === "acct-site"`));
      check("site: own Cloudflare account stored sealed, apart from site.json", !read(path.join(S(id), "accounts.json")).includes('"site"') && !read(path.join(S(id), "site.json")).includes("acct-site"));
      await shot("publish-overrides");
      await run(`document.querySelector('.overridable[data-key=\"retention\"]').scrollIntoView(); 0`);
      await sleep(300); await shot("publish-privacy");

      await clickButton("Publish website");
      const log = await waitFor(() => run(`document.querySelector("pre.log").textContent.includes("Done!") || [...document.querySelectorAll(".error")].map((e) => e.textContent).find(Boolean)`), 30000);
      const d = calls.deploy[0];
      check("publish: uses the site's account and the resolved defaults", d?.token === "site" && d.accountId === "acct-site" && d.forms.contact.to === "app@example.com" && d.privacy.includes("run by Site Override Ltd") && d.privacy.includes("mailto:app@example.com"), d ? { token: d.token, accountId: d.accountId, to: d.forms.contact.to } : log);
      const state = JSON.parse(read(path.join(S(id), "publish.json")));
      check("publish: account recorded", state.accountId === "acct-site" && state.resendKeyHash);

      // Back to the app's account: offline must still go through the account the site is live on, never the app's.
      await clickButton("Reset to the app's account");
      await waitFor(() => run(`!siteAccounts.cloudflare`));
      await run(`window.confirm = () => true; 0`);
      await clickButton("Take website offline");
      const err = await waitFor(() => run(`[...document.querySelectorAll(".error")].map((e) => e.textContent).find(Boolean)`));
      check("unpublish: refuses another account than the one that published", /isn't connected any more/.test(err || "") && !calls.unpublish.length, err);
      await run(`[...document.querySelectorAll(".step")][0].querySelector("button:nth-child(2)").click()`);
      await connect(".step", "Paste your Cloudflare API token", "site");
      await waitFor(() => run(`siteAccounts.cloudflare?.accountId === "acct-site"`));
      await clickButton("Take website offline");
      await waitFor(() => calls.unpublish.length);
      check("unpublish: uses the account that published", calls.unpublish[0]?.token === "site" && calls.unpublish[0].resendKey === "re_app", calls.unpublish[0]);
    }

    // ---------- Theme Builder (#130): a theme from the created site's design, saved, then used by that site ----------
    async function themeBuilder() {
      const id = result.sites.created;
      await run(`document.querySelector("#open-themes").click()`);
      await waitFor(() => run(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Start")`));
      await run(`document.querySelector(".theme-list select").value = ${JSON.stringify(id)}; [...document.querySelectorAll("button")].find((b) => b.textContent === "Start").click()`);
      const start = await waitFor(() => run(`tbEdit && JSON.stringify(tbEdit)`)).then((j) => j && JSON.parse(j));
      check("theme builder: starts from a website's design", start?.label === "Regression Bikes theme" && start.font === "serif" && start.colors.background === "#faf7f2" && start.css.includes("flex-direction: column"), start);
      check("theme builder: sample preview", await waitFor(() => inFrame(`document.querySelector("h1")?.textContent.startsWith("Websites that work")`)), "no sample hero");
      await run(`{ const s = ${fieldInput("Header style", "select")}; s.value = "bar"; s.dispatchEvent(new Event("change")); }
        { const c = ${fieldInput("Text")}; c.value = "#eeeeee"; c.dispatchEvent(new Event("input")); } 0`);
      check("theme builder: contrast hint", await waitFor(() => run(`document.querySelector("#tb-warnings").textContent.includes("Text may be hard to read")`)));
      check("theme builder: preview restyled", await waitFor(() => inFrame(`getComputedStyle(document.querySelector(".site-header")).backgroundColor !== "rgba(0, 0, 0, 0)"`)), "header isn't a coloured bar");
      await run(`{ const c = ${fieldInput("Text")}; c.value = "#222222"; c.dispatchEvent(new Event("input")); } { const s = document.querySelector(".preview-bar select"); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event("change")); } 0`);
      check("theme builder: preview on one of the user's sites", await waitFor(() => inFrame(`document.querySelector("h1")?.textContent === "Edited headline"`)), "site content not shown");
      await shot("theme-builder");
      await clickButton("Save theme");
      const dir = path.join(UD, "themes-local", "regression-bikes-theme");
      const ok = await waitFor(() => fs.existsSync(path.join(dir, "theme.css")) && run(`document.querySelector(".save-state").textContent.startsWith("Saved")`));
      const { validateTheme } = require("../lib/theme-validate");
      check("theme builder: saved as a valid package", ok && validateTheme(dir).length === 0 && read(path.join(dir, "theme.css")).includes("var(--primary-text)"), ok && validateTheme(dir));
      const png = fs.existsSync(path.join(dir, "preview.png")) && fs.readFileSync(path.join(dir, "preview.png"));
      if (png) check("theme builder: preview.png is 640x400", png.readUInt32BE(16) === 640 && png.readUInt32BE(20) === 400);
      else console.log("preview.png not captured (capturePage unavailable here, #87)");
      await run(`document.querySelector('#site-list [data-id="${id}"]').click()`);
      await waitFor(() => run(`site?.id === ${JSON.stringify(id)} && Boolean(document.querySelector("#tab"))`));
      await run(`tab = "design"; renderEditor(); 0`);
      const btn = await waitFor(() => run(`[...document.querySelectorAll("button.theme")].some((b) => b.querySelector("strong").textContent === "Regression Bikes theme")`));
      check("theme builder: listed in the Design tab picker", btn);
      await run(`[...document.querySelectorAll("button.theme")].find((b) => b.querySelector("strong").textContent === "Regression Bikes theme").click()`);
      await waitFor(() => run(`site.themeSource === "local"`));
      await saved();
      const s = JSON.parse(read(path.join(S(id), "site.json")));
      check("theme builder: site uses the local theme", s.themeSource === "local" && s.theme === "regression-bikes-theme" && read(path.join(UD, "preview", id, "public", "styles.css")).includes("/* theme-builder "), { theme: s.theme, themeSource: s.themeSource });
      await shot("theme-builder-design");
    }

    // ---------- GitHub sign-in (device flow) and publishing the Theme Builder theme (#60), against the fake GitHub ----------
    // test/regression.js checks what reached the fake's repos and PRs.
    async function themePublish() {
      await run(`document.querySelectorAll("dialog[open]").forEach((d) => d.close()); 0`); // left open by an earlier step, it hides these screenshots
      await run(`document.querySelector("#open-settings").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("#settings-page h1"))`));
      await run(`[...document.querySelectorAll("label.field")].find((l) => l.textContent === "Also allow private repositories").querySelector("input").click(); 0`);
      await run(`[...document.querySelectorAll(".step")].find((s) => s.textContent.startsWith("GitHub")).scrollIntoView(); 0`);
      await shot("github-sign-in");
      await clickButton("Sign in with GitHub");
      const code = await waitFor(() => run(`document.querySelector(".device-code")?.textContent`), 5000);
      check("github: device code shown", code === "WDJB-MJHT", code);
      await shot("github-code");
      check("github: signed in", await waitFor(() => run(`settings.github?.login === "octo" && settings.github.privateRepos && document.querySelector("#settings-page").textContent.includes("Signed in as octo")`)));
      await shot("github-signed-in");
      const stored = JSON.parse(read(path.join(UD, "settings.json"))).github;
      check("github: token stored sealed", stored?.login === "octo" && stored.token && !JSON.stringify(stored).includes("github_pat_fake"), stored && Object.keys(stored));

      const inDialog = (js) => run(`{ const d = document.querySelector("dialog.publish-theme[open]"); d ? (${js}) : null }`);
      const status = () => inDialog(`d.querySelector("[role=status]").textContent + d.querySelector(".error").textContent`);
      await run(`document.querySelector("#open-themes").click()`);
      await waitFor(() => run(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Push to repo…")`));
      await clickButton("Push to repo…");
      const target = await waitFor(() => inDialog(`d.querySelector("input").value`));
      check("theme push: defaults to PhaseN's private themes repo", target === "PhaseN-Digital/phasen-themes-private", target);
      await shot("theme-push");
      await clickButton("Push");
      const pushed = await waitFor(() => status().then((t) => t.startsWith("Pushed") && t));
      check("theme push: done", Boolean(pushed), await status());
      await shot("theme-pushed");
      await inDialog(`d.close()`);
      await clickButton("Submit to public repo…");
      await waitFor(() => inDialog(`true`));
      await shot("theme-submit");
      await clickButton("Open pull request");
      const opened = await waitFor(() => status().then((t) => t.startsWith("Pull request opened") && t));
      check("theme submit: pull request opened", Boolean(opened), await status());
      await shot("theme-submitted");
      await inDialog(`d.close()`);
    }

    // ---------- an edit made just before leaving the editor is saved, not dropped (#143) ----------
    async function pendingEdits() {
      const { created, wordpress, mirror } = result.sites;
      const editButton = (text) => `{ const i = ${fieldInput("Button text")}; i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); }`;
      const leave = { "switching site": `openSite(${JSON.stringify(wordpress)})`, "opening Settings": "openSettings()", "opening Themes": "openThemes()",
        "opening Import": `document.querySelector("#import-wp").click()` };
      for (const [way, js] of Object.entries(leave)) {
        await run(`openSite(${JSON.stringify(created)})`);
        await run(`tab = "pages"; pageId = site.pages[0].id; renderEditor(); ${editButton(`Book now, then ${way}`)} ${js}`);
        await sleep(1000);
        await run(`openSite(${JSON.stringify(created)})`);
        const kept = await run(`site.pages[0].sections[0].buttonText`);
        check(`pending edit: kept when ${way}`, kept === `Book now, then ${way}`, kept);
      }
      // Rich text (Quill) goes through the same debounce.
      await run(`openSite(${JSON.stringify(wordpress)})`);
      await run(`tab = "pages"; pageId = site.pages[1].id; renderEditor(); 0`);
      await waitFor(() => run(`Boolean(document.querySelector(".rich-editor .ql-editor"))`));
      await run(`Quill.find(document.querySelector(".rich")).insertText(0, "Pending rich text. ", "user"); openSite(${JSON.stringify(created)})`);
      const rich = JSON.parse(read(path.join(S(wordpress), "site.json"))).pages[1].sections[0].html;
      check("pending edit: rich text kept when switching site", rich.includes("Pending rich text."), rich.slice(0, 80));
      // A copied page's edit is written by the time the next site has opened.
      if (mirror) {
        await run(`openSite(${JSON.stringify(mirror)})`);
        await run(`tab = "pages"; pageId = site.pages.find((p) => p.mirror === "/").id; renderEditor(); 0`);
        await waitFor(() => inFrame(`document.readyState === "complete" && Boolean(document.querySelector("h1[data-sb-edit]"))`));
        await inFrame(`{ const el = document.querySelector("h1"); el.click(); el.textContent = "Welcome to Acme Widgets!"; el.dispatchEvent(new FocusEvent("blur")); 0 }`);
        await waitFor(() => run(`document.querySelector(".save-state")?.textContent === "Saving…"`), 3000);
        await run(`openSite(${JSON.stringify(created)})`);
        check("pending edit: copied page edit written before the next site opens", read(path.join(S(mirror), "mirror", "index.html")).includes(">Welcome to Acme Widgets!</h1>"));
      }
    }

    // Last step: an edit, then the app quits straight away. regression.js checks it reached site.json (#143).
    // ---------- History (#136): edits committed, publish tagged, page-level changes, revert; no secrets or builds in the repo ----------
    async function history() {
      const id = result.sites.created, dir = S(id);
      await run(`document.querySelector("dialog[open]")?.close(); openSite(${JSON.stringify(id)})`);
      const versions = () => run(`cms.call("history:list", ${JSON.stringify(id)})`).then((r) => r.versions);
      const before = await versions();
      check("history: the publish is tagged live-…", before.some((v) => v.tags.some((t) => /^live-\d{8}-\d{4}$/.test(t)) && v.message === "Published the website"), before.map((v) => [v.message, v.tags]));
      await run(`tab = "pages"; pageId = site.pages[0].id; renderEditor(); { const i = ${fieldInput("Headline")}; i.value = "Headline from history"; i.dispatchEvent(new Event("input")); } 0`);
      await saved();
      await run(`tab = "history"; renderEditor(); 0`);
      const top = await waitFor(() => run(`document.querySelector("details.version summary b")?.textContent`));
      check("history: the edit shows as a readable version", top === "Edited page Home", top);
      await run(`document.querySelector("details.version").open = true; 0`);
      const lines = await waitFor(() => run(`[...document.querySelectorAll("details.version ul li")].map((l) => l.textContent).join("|")`));
      check("history: what changed, page by page", lines === "Edited page Home", lines);
      await shot("history");
      // Restore the version before the edit.
      await run(`window.confirm = () => true; [...document.querySelectorAll("details.version")][1].querySelector("button").click(); 0`);
      const restored = await waitFor(() => run(`site?.pages[0].sections[0].heading !== "Headline from history" && document.querySelector("details.version summary b")?.textContent`));
      check("history: restore adds a version and reloads the editor", /^Restored the version from/.test(restored || "") && JSON.parse(read(path.join(dir, "site.json"))).pages[0].sections[0].heading === "Edited headline", restored);
      check("history: restored content previewed", await waitFor(() => inFrame(`document.querySelector("h1")?.textContent === "Edited headline"`)));
      await shot("history-restored");
      // Nothing secret and no build output in any version.
      const leaks = [];
      for (const { oid } of await git.log({ fs, dir })) {
        for (const f of await git.listFiles({ fs, dir, ref: oid })) {
          if (/^(\.secrets\/|public\/|worker\/|wrangler\.toml)|secrets\.enc/.test(f)) leaks.push(`${oid.slice(0, 7)} ${f}`);
          const text = Buffer.from((await git.readBlob({ fs, dir, oid, filepath: f })).blob).toString();
          if (/re_sending|re_app|1x0000000000000000000000000000000AA|"token"|"secret"/.test(text)) leaks.push(`${oid.slice(0, 7)} ${f} (secret)`);
        }
      }
      check("history: no secrets and no preview/publish build in any commit", !leaks.length, leaks);
      const tracked = await git.listFiles({ fs, dir });
      check("history: publish state and accounts committed, their secrets kept in .secrets/", tracked.includes("publish.json") && tracked.includes("accounts.json") && fs.existsSync(path.join(dir, ".secrets", "secrets.enc")), tracked);
    }

    // ---------- Portable secrets (#136): on with a passphrase, from Settings › Data ----------
    async function portableSecrets() {
      await run(`document.querySelector("#open-settings").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("#data-status"))`));
      await run(`for (const p of ["Passphrase (at least 10 characters)", "Type it again"]) document.querySelector('#settings-page input[placeholder="' + p + '"]').value = ${JSON.stringify(PASSPHRASE)}; [...document.querySelectorAll("button")].find((b) => b.textContent === "Turn on portable secrets").click(); 0`);
      const on = await waitFor(() => run(`settings.portable?.on`));
      const envs = [path.join(SITES, ".phasen", "secrets.enc"), ...siteDirs().map((d) => path.join(d, ".secrets", "secrets.enc"))].filter((f) => fs.existsSync(f)).map((f) => JSON.parse(read(f)).mode);
      check("portable secrets: on, every secrets file re-encrypted with the passphrase", on && envs.length >= 2 && envs.every((m) => m === "portable"), envs);
      const holds = (d) => fs.readdirSync(d, { recursive: true }).some((f) => { try { return read(path.join(d, String(f))).includes(PASSPHRASE); } catch { return false; } });
      check("portable secrets: passphrase never stored", !holds(path.join(SITES, ".phasen")) && !holds(UD));
      check("portable secrets: still connected on this computer", await run(`cms.call("settings:get").then((s) => s.cloudflare?.accountId === "acct-app" && s.resend)`));
      await run(`document.querySelector("#data-status").scrollIntoView(); 0`);
      await sleep(300); await shot("settings-data");
    }

    // ---------- Reinstall / new computer (#136): fresh userData, same sites folder ----------
    async function reinstall() {
      const listed = await waitFor(() => run(`document.querySelectorAll("#site-list button").length >= 3 && [...document.querySelectorAll("#site-list button")].map((b) => b.textContent).join("|")`));
      check("reinstall: sites found in the sites folder", (listed || "").includes("Regression Bikes"), listed);
      const banner = await waitFor(() => run(`document.querySelector("#notice-banner")?.textContent`));
      check("reinstall: asks for the passphrase", /protected with a passphrase/.test(banner || ""), banner);
      await shot("reinstall-notice");
      check("reinstall: secrets locked until then, not crashed", await run(`cms.call("settings:get").then((s) => !s.cloudflare && !s.resend && s.portable.locked && s.defaults.email === "app@example.com")`));
      await run(`[...document.querySelectorAll("#notice-banner button")].find((b) => b.textContent === "Open Settings").click(); 0`);
      const pass = `document.querySelector('#settings-page input[placeholder="Your passphrase"]')`;
      await waitFor(() => run(`Boolean(${pass})`));
      await run(`${pass}.value = "wrong passphrase!"; [...document.querySelectorAll("button")].find((b) => b.textContent === "Unlock").click(); 0`);
      const wrong = await waitFor(() => run(`document.querySelector("#data-status.error")?.textContent`));
      check("reinstall: a wrong passphrase is refused", /isn't the one/.test(wrong || ""), wrong);
      await run(`${pass}.value = ${JSON.stringify(PASSPHRASE)}; [...document.querySelectorAll("button")].find((b) => b.textContent === "Unlock").click(); 0`);
      check("reinstall: unlocked with the passphrase", await waitFor(() => run(`settings.cloudflare?.accountId === "acct-app" && settings.resend && !settings.portable.locked && !settings.secretsProblem && !document.querySelector("#notice-banner")`)));
      await shot("reinstall-unlocked");
      const id = await run(`cms.call("sites:list").then((l) => l.find((s) => s.name === "Regression Bikes").id)`);
      const versions = await run(`cms.call("history:list", ${JSON.stringify(id)}).then((r) => r.versions)`);
      check("reinstall: the site's history came with it", versions.some((v) => v.tags.length) && versions.some((v) => /^Restored/.test(v.message)), versions.map((v) => v.message));
    }

    async function closeWithPendingEdit() {
      await run(`openSite(${JSON.stringify(result.sites.created)})`);
      await run(`tab = "pages"; pageId = site.pages[0].id; renderEditor(); { const i = ${fieldInput("Button text")}; i.value = "Book before closing"; i.dispatchEvent(new Event("input")); } 0`);
      result.closeEdit = { id: result.sites.created, buttonText: "Book before closing" };
    }

    // ---------- 3b. a site imported before #141 must declare ownership before it can be published again ----------
    async function legacyDeclaration() {
      const id = result.sites.mirror;
      if (!id) return;
      await run(`openSite(${JSON.stringify(result.sites.created)})`);
      const file = path.join(S(id), "site.json");
      const old = JSON.parse(read(file));
      delete old.importProvenance;
      fs.writeFileSync(file, JSON.stringify(old));
      await run(`openSite(${JSON.stringify(id)}); 0`);
      await waitFor(() => run(`Boolean(document.querySelector("dialog.declaration[open]"))`));
      check("legacy import: asked on open, and told why", /imported before Site Builder asked for an ownership declaration/.test(await run(`document.querySelector("dialog.declaration").textContent`)));
      await run(`document.querySelector('dialog.declaration button[value=""]').click(); tab = "publish"; renderEditor(); 0`);
      const notice = await waitFor(() => run(`[...document.querySelectorAll("#tab .warn")].map((w) => w.textContent).join(" | ")`));
      check("legacy import: Publish tab says why and offers the declaration", /imported before Site Builder asked/.test(notice || "") && await run(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Confirm ownership…")`), notice);
      const refused = await run(`cms.call("sites:publish", ${JSON.stringify(id)}).then(() => "published", (e) => e.message)`);
      check("legacy import: main process refuses to publish it", /ownership declaration/.test(refused), refused);
      const exportRefused = await run(`cms.call("sites:export", ${JSON.stringify(id)}).then(() => "exported", (e) => e.message)`);
      check("legacy import: main process refuses to export it (#145)", /ownership declaration/.test(exportRefused), exportRefused);
      await shot("legacy-declaration");
      await clickButton("Confirm ownership…");
      await waitFor(() => run(`Boolean(document.querySelector("dialog.declaration[open]"))`));
      await run(`{ const i = document.querySelector('dialog.declaration input[name="source"]'); i.value = ${JSON.stringify(SB_EL + "/about/")}; i.dispatchEvent(new Event("input")); } 0`);
      await declare();
      const p = await waitFor(() => JSON.parse(read(file)).importProvenance);
      check("legacy import: declaration recorded", p?.source === new URL(SB_EL).origin && !p.importedAt && p.declaredAt && p.declaredBy?.email === "jo.declarer@example.org", p);
      const after = await waitFor(() => run(`[...document.querySelectorAll("#tab .warn")].map((w) => w.textContent).join(" | ").includes("Imported from") && site.importProvenance?.source`));
      check("legacy import: Publish tab now describes the marker", after === new URL(SB_EL).origin, after);
    }

    // ---------- 0. update banner, from test/fakes.js's latest.json ----------
    async function updateBanner() {
      const text = await waitFor(() => run(`document.querySelector("#update-banner")?.textContent`));
      check("update check: banner shows the newer version", text?.includes("Version 99.0.0 is available") && text.includes("Download"), text);
      await shot("update-banner");
      await clickButton("Dismiss");
      check("update check: banner dismisses", !(await run(`Boolean(document.querySelector("#update-banner"))`)));
    }

    // ---------- 1. a site made in the app ----------
    async function createSite() {
      await run(`document.querySelector("#new-site input").value = "Regression Bikes"; document.querySelector("#new-site").requestSubmit()`);
      const id = await waitFor(() => run(`site?.name === "Regression Bikes" && site.id`));
      check("create site: editor opens", id, "no site after submitting the new-site form");
      result.sites.created = id;
      const siteDir = path.join(S(id)), pub = path.join(UD, "preview", id, "public");
      check("create site: preview renders", await waitFor(() => inFrame(`document.querySelector("h1")?.textContent === "Regression Bikes"`)), "preview iframe has no h1 with the site name");

      await run(`tab = "pages"; renderEditor(); { const i = ${fieldInput("Headline")}; i.value = "Edited headline"; i.dispatchEvent(new Event("input")); }`);
      await saved();
      check("edit: site.json saved", JSON.parse(read(path.join(siteDir, "site.json"))).pages[0].sections[0].heading === "Edited headline");
      check("edit: preview rebuilt", read(path.join(pub, "index.html")).includes("Edited headline"));
      check("edit: preview reloads", await waitFor(() => inFrame(`document.querySelector("h1")?.textContent === "Edited headline"`)), "preview still shows the old headline");

      await fakePick(2400, 1200, "#2a6");
      await run(`[...document.querySelectorAll("label.field, div.field")].find((l) => l.firstChild.textContent === "Background photo").querySelector("button").click()`);
      const src = await waitFor(() => run(`site.pages[0].sections[0].image?.src`));
      check("image upload: stored on the section", /^assets\/[a-f0-9]+\.webp$/.test(src || ""), src);
      if (src) {
        const file = path.join(siteDir, src);
        check("image upload: saved as webp", fs.existsSync(file) && fs.readFileSync(file).toString("latin1", 8, 12) === "WEBP");
        const size = await run(`new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => r("not served"); i.src = thumbUrl(${JSON.stringify(src)}); })`);
        check("image upload: resized to fit 1920", size === "1920x960", size);
        await saved();
        check("image upload: shown in the built page", read(path.join(pub, "index.html")).includes(src.replace(/^assets\//, "")));
        check("image upload: preview loads it", await waitFor(() => inFrame(`[...document.querySelectorAll("*")].some((e) => getComputedStyle(e).backgroundImage.includes(${JSON.stringify(path.basename(src))}))`)), "no element uses the uploaded image");
      }

      await run(`tab = "design"; renderEditor(); [...document.querySelectorAll("button.theme")].find((b) => b.querySelector("strong").textContent === "Elegant").click()`);
      await saved();
      const s = JSON.parse(read(path.join(siteDir, "site.json")));
      check("theme switch: saved", s.theme === "elegant" && s.font === "serif" && s.colors.background === "#faf7f2", { theme: s.theme, font: s.font, colors: s.colors });
      check("theme switch: preview CSS rebuilt", read(path.join(pub, "styles.css")).includes("#faf7f2"));
      check("theme switch: preview restyled", await waitFor(() => inFrame(`getComputedStyle(document.body).backgroundColor === "rgb(250, 247, 242)"`)), "preview background isn't Elegant's");
      await shot("designTab");
    }

    // ---------- 1b. rich text editor (Quill, #120) on the made-in-app site's home page ----------
    async function richText() {
      const id = result.sites.created;
      if (!id) return;
      const pub = path.join(UD, "preview", id, "public");
      await run(`tab = "pages"; pageId = site.pages[0].id; renderEditor(); [...document.querySelectorAll(".adders button")].find((b) => b.textContent === "+ Rich text").click(); 0`);
      await waitFor(() => run(`Boolean(document.querySelector(".rich-editor .ql-editor"))`));
      const q = `Quill.find(document.querySelector(".rich"))`;
      const select = (word) => run(`{ const q = ${q}; q.setSelection(q.getText().indexOf(${JSON.stringify(word)}), ${word.length}); 0 }`);
      const panelButton = (label) => run(`[...document.querySelectorAll(".rich-panel button")].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
      const panelInput = (value, sel = "input") => run(`{ const i = document.querySelector(".rich-panel ${sel}"); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("change")); 0 }`);
      const html = () => run(`site.pages[0].sections.at(-1).html`);

      await run(`{ const q = ${q}; q.setSelection(q.getLength() - 1); 0 }`);
      await win.webContents.insertText(" Regression rich text, typed.");
      check("rich text: typing", (await html()).includes("Regression rich text, typed."), await html());
      await select("rich");
      await run(`document.querySelector(".rich-editor .ql-bold").click()`);
      check("rich text: bold", (await html()).includes("<strong>rich</strong>"), await html());

      await select("text,");
      await run(`document.querySelector(".rich-editor .ql-link").click()`);
      await panelInput("javascript:alert(1)"); await panelButton("Apply link");
      const linkError = await run(`document.querySelector(".rich-panel .error").textContent`);
      await panelInput("https://example.com/rt"); await panelButton("Apply link");
      check("rich text: link validated, then applied", /Use a web address/.test(linkError) && (await html()).includes('<a href="https://example.com/rt">text,</a>') && !(await html()).includes("javascript:"), [linkError, await html()]);

      await fakePick(900, 600, "#c33");
      await run(`{ const q = ${q}; q.setSelection(q.getLength() - 1); document.querySelector(".rich-editor .ql-image").click(); 0 }`);
      await waitFor(() => run(`Boolean(document.querySelector(".rich-panel label.field input"))`));
      await panelInput("A red box", "label.field input");
      await panelInput("Our caption", "label.field:nth-of-type(2) input");
      check("rich text: image uploaded as an asset, with alt text and caption", /<figure><img src="assets\/[a-f0-9]+\.webp" alt="A red box"><figcaption>Our caption<\/figcaption><\/figure>/.test(await html()) && !(await html()).includes("data:"), await html());

      await run(`{ const q = ${q}; q.setSelection(q.getLength() - 1); document.querySelector(".rich-editor .ql-table").click(); 0 }`);
      await win.webContents.insertText("Cell A1");
      check("rich text: table", /<table><tbody><tr><td>Cell A1<\/td><td><\/td><td><\/td><\/tr>/.test(await html()), await html());

      await run(`{ const q = ${q}; q.setSelection(q.getLength() - 1); document.querySelector(".rich-editor .ql-video").click(); 0 }`);
      await panelInput("https://example.com/not-a-video"); await panelButton("Insert video");
      const videoError = await run(`document.querySelector(".rich-panel .error").textContent`);
      await panelInput("https://youtu.be/dQw4w9WgXcQ"); await panelButton("Insert video");
      check("rich text: video validated, stored as a youtube-nocookie placeholder", /YouTube or Vimeo/.test(videoError) && (await html()).includes('<div class="video-embed" data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></div>'), [videoError, await html()]);
      await run(`document.querySelector(".rich-editor .ql-undo").click()`);
      const undone = !(await html()).includes("video-embed");
      await run(`document.querySelector(".rich-editor .ql-redo").click()`);
      check("rich text: undo and redo", undone && (await html()).includes("video-embed"));

      // Paste from Google Docs / Word: basic formatting kept, styles, spans and data: images dropped.
      await run(`{ const q = ${q}; q.clipboard.dangerouslyPasteHTML(q.getLength() - 1, '<b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr" style="text-align:center"><span style="font-weight:700;color:#f00;font-family:Arial">Pasted bold</span></p></b><p class=MsoNormal><i>Word italic</i><o:p></o:p></p><img src="data:image/png;base64,iVBORw0KGgo=">', "user"); 0 }`);
      const pasted = await html();
      check("rich text: paste keeps basic formatting, strips junk", pasted.includes('<p class="align-center"><strong>Pasted bold</strong></p>') && pasted.includes("<em>Word italic</em>") && !/style=|span|data:|Mso|font/i.test(pasted), pasted);

      const sanitized = await run(`sanitizeHtml('<p class="align-center evil" style="color:red">c</p><a class="button x" href="javascript:alert(1)">b</a><a class="button" href="#page:abc">ok</a><s>s</s><div class="video-embed" data-src="https://evil.example/embed/x"></div><div class="video-embed" data-src="https://player.vimeo.com/video/123" onclick="x()">t</div><figure class="align-right"><img src="data:image/png;base64,x"></figure>')`);
      check("sanitizer: editor classes, video hosts and data: images", sanitized === '<p class="align-center">c</p><a class="button">b</a><a href="#page:abc" class="button">ok</a><s>s</s><div class="video-embed" data-src="https://player.vimeo.com/video/123"></div><figure class="align-right"></figure>', sanitized);

      await saved();
      const built = read(path.join(pub, "index.html"));
      check("rich text: built page shows it", built.includes("<strong>rich</strong>") && built.includes('<a href="https://example.com/rt">text,</a>') && /<img src="\/assets\/[a-f0-9]+\.webp" alt="A red box">/.test(built)
        && built.includes("<td>Cell A1</td>") && /<div class="video-embed"><iframe title="Video from YouTube" srcdoc="[^"]*youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?autoplay=1/.test(built) && !built.includes('data-src='), built.slice(built.indexOf('class="richtext"'), built.indexOf('class="richtext"') + 1500));
      check("rich text: preview shows the click-to-load video", await waitFor(() => inFrame(`Boolean(document.querySelector(".video-embed iframe")?.contentDocument?.querySelector("a")?.textContent.includes("Play video"))`)), "no play link in the preview");
      await run(`document.querySelector(".rich-editor").scrollIntoView(); 0`);
      await inFrame(`document.querySelector(".richtext").scrollIntoView(); 0`).catch(() => {});
      await shot("rich-text");
    }

    // ---------- 2. editable WordPress import ----------
    async function wordpressImport() {
      // The declaring user's name and email (#141): recorded in site.json, never published.
      fs.writeFileSync(path.join(SITES, ".phasen", "settings.json"), JSON.stringify({ name: "Jo Declarer", email: "jo.declarer@example.org" }));
      await run(`document.querySelector("#import-wp").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("form.import"))`));
      check("import: renamed for any website", await run(`document.querySelector("#import-wp").textContent === "Import a website…" && document.querySelector(".import h1").textContent === "Import a website"`));
      const before = siteDirs().length;
      const refused = await run(`Promise.all([cms.call("wp:mirror", ${JSON.stringify(SB_EL)}), cms.call("wp:fetch", ${JSON.stringify(SB_WP)}, "", "", { confirmed: false })].map((p) => p.then(() => "imported", (e) => e.message)))`);
      check("declaration: main process refuses imports without one", refused.every((m) => /Confirm that you own this website/.test(m)) && siteDirs().length === before, refused);
      await run(`{ const f = document.querySelector("form.import"); f.url.value = ${JSON.stringify(SB_WP)}; f.querySelector('[value="editable"]').checked = true; f.requestSubmit() }`);
      await waitFor(() => run(`Boolean(document.querySelector("dialog.declaration[open]"))`));
      const modal = await run(`document.querySelector("dialog.declaration").textContent`);
      check("declaration: warning, checkbox and marker notice shown", /copyright, trademarks and database rights/.test(modal) && modal.includes("I confirm I own this website, or have the owner's written permission to copy and republish it")
        && /phasen-provenance\.json/.test(modal) && /name and email are never published/.test(modal) && /phasen-verify-[a-f0-9]{24}\.txt/.test(modal), modal);
      check("declaration: Import disabled until the box is ticked", await run(`document.querySelector('dialog.declaration button[value="ok"]').disabled`));
      await shot("declaration");
      await run(`document.querySelector('dialog.declaration button[value=""]').click(); 0`);
      await sleep(500);
      check("declaration: cancelling doesn't import", !(await run(`Boolean(document.querySelector("dialog.declaration"))`)) && !(await run(`document.querySelector(".log").textContent`)) && siteDirs().length === before);
      await run(`{ const f = document.querySelector("form.import"); f.querySelector('[value="auto"]').checked = true; f.username.value = "u"; f.password.value = "p"; f.requestSubmit() }`);
      await declare();
      const err = await waitFor(() => run(`document.querySelector(".import .error").textContent`));
      check("wordpress: credentials over http refused", /https/i.test(err || ""), err);

      await run(`{ const f = document.querySelector("form.import"); f.username.value = ""; f.password.value = ""; f.querySelector('[value="editable"]').checked = true; f.querySelector("button").disabled = false; f.requestSubmit() }`);
      await declare();
      const id = await waitFor(() => run(`site?.name === "Bob’s Bikes" && site.id`), 30000);
      check("wordpress: import opens the site", id, await run(`document.querySelector(".import .error")?.textContent || document.querySelector(".log")?.textContent`).catch(() => ""));
      if (!id) return;
      result.sites.wordpress = id;
      await saved();
      const s = JSON.parse(read(path.join(S(id), "site.json")));
      check("wordpress: tagline", s.description === "Fixing bikes since 1999", s.description);
      const p = s.importProvenance || {};
      check("declaration: provenance recorded (editable import)", p.source === new URL(SB_WP).origin && p.importedAt && p.appVersion === require("../package.json").version
        && p.declaredBy?.name === "Jo Declarer" && p.declaredBy.email === "jo.declarer@example.org" && /I confirm I own/.test(p.statement), p);
      check("verification: file on the source site, with the dialog's token", p.verification?.status === "verified" && p.verification.method === "verification-file", p.verification);
      check("wordpress: global styles mapped", s.theme === "elegant" && s.font === "serif" && JSON.stringify(s.colors) === JSON.stringify({ background: "#fdf6e3", text: "#222222", primary: "#cc3300", accent: "#0a7d4b" }), { theme: s.theme, colors: s.colors });
      check("wordpress: logo copied", /^assets\/[a-f0-9]+\.webp$/.test(s.logo?.src || ""), s.logo);
      check("wordpress: front page first", JSON.stringify(s.pages.map((p) => p.title)) === JSON.stringify(["Welcome", "About & Team", "Contact"]), s.pages.map((p) => p.title));
      const about = s.pages[1].sections[0].html, contact = s.pages[2];
      check("wordpress: hostile HTML removed", !/<script|<iframe|onclick|onerror|style=|javascript:|alert/i.test(about) && (about.match(/class="[^"]*"/g) || []).join() === 'class="gallery-grid"', about);
      check("wordpress: formatting kept", about.includes("We <strong>fix</strong> bikes.") && about.includes("<h1>Big</h1>"), about);
      check("wordpress: internal links rewired", about.includes(`href="#page:${contact.id}"`), about);
      check("wordpress: other links point at the old site", about.includes(`href="${SB_WP}/blog/post-1/"`), about);
      check("wordpress: images downloaded, missing ones dropped", (about.match(/<img /g) || []).length === 1 && /<img src="assets\/[a-f0-9]+\.webp" alt="Shop">/.test(about) && !about.includes("missing.png"), about);
      check("wordpress: form replaced with ours", contact.sections.some((x) => x.type === "form" && x.formId === "contact") && !contact.sections[0].html.includes("<form"), contact.sections);
      const built = read(path.join(UD, "preview", id, "public", "about", "index.html"));
      check("wordpress: built page at its old address", built.includes("We <strong>fix</strong> bikes.") && !/<script>alert|evil\(\)|javascript:alert/.test(built));

      // Imported rich text loads into the editor and saves back without losing anything.
      await run(`tab = "pages"; pageId = site.pages[1].id; renderEditor(); 0`);
      await waitFor(() => run(`Boolean(document.querySelector(".rich-editor .ql-editor"))`));
      await run(`{ const q = Quill.find(document.querySelector(".rich")); q.insertText(0, "x", "user"); q.deleteText(0, 1, "user"); 0 }`);
      await saved();
      const resaved = JSON.parse(read(path.join(S(id), "site.json"))).pages[1].sections[0].html;
      const textOf = (h) => h.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
      check("wordpress: rich text survives a round trip through the editor", textOf(resaved) === textOf(about) && resaved.includes("We <strong>fix</strong> bikes.") && resaved.includes("<h1>Big</h1>")
        && resaved.includes(`href="#page:${contact.id}"`) && /<figure class="gallery-grid"><figure><img src="assets\/[a-f0-9]+\.webp" alt="Shop"><\/figure><\/figure>/.test(resaved), [about, resaved]);
    }

    // ---------- 2b. editable import of an Elementor site: kit colours/font, site-logo widget ----------
    async function elementorEditable() {
      await run(`document.querySelector("#import-wp").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("form.import"))`));
      await run(`{ const f = document.querySelector("form.import"); f.url.value = ${JSON.stringify(SB_EL)}; f.querySelector('[value="editable"]').checked = true; f.requestSubmit() }`);
      await declare();
      const id = await waitFor(() => run(`site?.name === "Acme Ltd" && !site.mirror && site.id`), 30000);
      check("elementor editable: import opens the site", id, await run(`document.querySelector(".import .error")?.textContent || document.querySelector(".log")?.textContent`).catch(() => ""));
      if (!id) return;
      await saved();
      const s = JSON.parse(read(path.join(S(id), "site.json")));
      check("elementor editable: kit styles mapped", s.theme === "elegant" && s.font === "serif" && JSON.stringify(s.colors) === JSON.stringify({ background: "#fff6ee", text: "#241b2f", primary: "#ee5c44", accent: "#7c6bff" }), { theme: s.theme, font: s.font, colors: s.colors });
      check("elementor editable: header logo copied", /^assets\/[a-f0-9]+\.webp$/.test(s.logo?.src || ""), s.logo);
    }

    // ---------- 3. exact copy of an Elementor site ----------
    async function exactCopy() {
      await run(`document.querySelector("#import-wp").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("form.import"))`));
      await run(`{ const f = document.querySelector("form.import"); f.url.value = ${JSON.stringify(SB_EL)}; f.requestSubmit() }`); // "auto" picks exact for Elementor
      await declare();
      const id = await waitFor(() => run(`site?.mirror && site.id`), 60000);
      check("exact copy: import opens the site", id, await run(`document.querySelector(".import .error")?.textContent || document.querySelector(".log")?.textContent`).catch(() => ""));
      if (!id) return;
      result.sites.mirror = id;
      const M = path.join(S(id), "mirror");
      const s = JSON.parse(read(path.join(S(id), "site.json")));
      check("declaration: provenance recorded (exact copy), unverified", s.importProvenance?.source === new URL(SB_EL).origin && s.importProvenance.verification?.status === "unverified" && s.importProvenance.declaredBy?.name === "Jo Declarer", s.importProvenance);
      const previewed = await Promise.all(["/", "/about/", "/nope/"].map((p) => require("electron").net.fetch(`preview://${id}${p}`).then((r) => r.text())));
      check("exact copy: in-app preview shows the provenance marker (#145)", previewed.every((h) => h.includes(`<meta name="phasen:imported-from" content="${new URL(SB_EL).origin}">`) && (h.match(/name="generator"/g) || []).length === 1)
        && !read(path.join(M, "index.html")).includes("phasen:"), previewed.map((h) => h.slice(0, 300)));
      check("exact copy: pages", JSON.stringify(s.pages.map((p) => p.mirror).sort()) === JSON.stringify(["/", "/about/", "/contact-us/"]), s.pages.map((p) => p.mirror));

      const files = [];
      (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : files.push(path.join(d, f.name)); })(M);
      const leftovers = files.filter((f) => /\.(html|css|js|json|txt)$|_redirects$/.test(f) && read(f).includes(elHost)).map((f) => path.relative(M, f));
      check("exact copy: no leftover origin URLs", !leftovers.length, leftovers);
      for (const f of ["wp-content/uploads/2024/01/bg.png", "wp-content/uploads/elementor/css/extra.css", "wp-content/themes/hello/fonts/acme.woff2", "wp-content/plugins/elementor/assets/js/frontend.min.js", "404.html"])
        check(`exact copy: copied ${f}`, fs.existsSync(path.join(M, f)));
      check("exact copy: redirect kept", /^\/contact\/ \/contact-us\/ 301$/m.test(read(path.join(M, "_redirects"))));

      const home = read(path.join(M, "index.html"));
      const form = s.forms[0];
      check("exact copy: form detected", s.forms.length === 1 && form.mirrored && JSON.stringify(form.fields.map((f) => [f.id, f.type, f.required])) === JSON.stringify([["form_fields[name]", "text", true], ["form_fields[email]", "email", true], ["form_fields[message]", "textarea", false], ["form_fields[services][]", "choice", false], ["form_fields[other]", "text", false]]), s.forms);
      check("exact copy: form re-wired", form && home.includes(`data-form="${form.id}"`) && !home.includes("admin-ajax") && home.includes("cf-turnstile") && home.includes('name="website"') && home.includes("/form.js"));
      check("exact copy: hidden branch loses only its required attribute", home.includes('placeholder="Other, not required">'));
      check("exact copy: search form left alone", /<form role="search"(?![^>]*data-form)/.test(home));

      // Copy vs structure tagging.
      const keyOf = (re) => home.match(re)?.[1];
      const h1 = keyOf(/<h1[^>]*data-sb-edit="([^"]+)"/), footer = keyOf(/<p class="elementor-heading-title" data-sb-edit="([^"]+)"/);
      const menuKeys = [...home.matchAll(/<li class="menu-item" data-sb-edit="([^"]+)"><a href="\/about\/">/g)].map((m) => m[1]);
      check("tagging: page heading is page content", h1?.startsWith("p-"), h1);
      check("tagging: footer is site structure", footer?.startsWith("s-"), footer);
      check("tagging: both menus share one site-wide key", menuKeys.length === 2 && menuKeys[0] === menuKeys[1] && menuKeys[0].startsWith("s-"), menuKeys);
      check("tagging: text widget is one block", /class="elementor-widget-container" data-sb-edit="p-[^"]+"><p>We make/.test(home));
      check("tagging: layout untagged", !/<(section|div) class="elementor-(section|container|column)[^"]*"[^>]*data-sb-edit/.test(home));
      check("tagging: same key on every page", ["about/index.html", "contact-us/index.html"].every((f) => read(path.join(M, f)).includes(`data-sb-edit="${footer}"`)));

      // Preview: our submit handler wins over Elementor's. The editor opens on site.pages[0], which is
      // whichever page the crawl finished first (not always the one with the form), so load the home
      // page explicitly and wait for that load (by its ?t=) to have run /form.js, which comes after the form.
      const since = Date.now();
      await run(`pageId = site.pages.find((p) => p.mirror === "/").id; refreshPreview(); 0`);
      await waitFor(() => inFrame(`+new URLSearchParams(location.search).get("t") >= ${since} && typeof onTurnstileLoad === "function" && Boolean(document.querySelector(".elementor-form"))`));
      await inFrame(`document.querySelector("#form-field-name").value = "A"; document.querySelector('[name="form_fields[email]"]').value = "a@b.co"; document.querySelector(".elementor-form").requestSubmit()`).catch(() => {});
      const status = await waitFor(() => inFrame(`document.querySelector(".form-status").textContent`), 3000);
      check("exact copy: preview form doesn't post to WordPress", /once your website is published/.test(status || "") && !(await inFrame("window.__elementorPosted || false")), status);

      // Editing: page edit, site-wide edit, image, undo, revert.
      await run(`tab = "pages"; pageId = site.pages.find((p) => p.mirror === "/").id; renderEditor(); window.confirm = () => true; 0`);
      await waitFor(() => inFrame(`document.readyState === "complete" && [...document.styleSheets].some((s) => s.ownerNode.textContent?.includes("data-sb-edit"))`));
      const edit = async (selector, text) => inFrame(`{ const el = document.querySelector(${JSON.stringify(selector)}); el.click(); el.textContent = ${JSON.stringify(text)}; el.closest("[data-sb-edit]").dispatchEvent(new FocusEvent("blur")); 0 }`);
      const settle = () => run(`copyEdits.then(() => 0)`);
      const all = ["index.html", "about/index.html", "contact-us/index.html", "404.html"];
      const grab = () => Object.fromEntries(all.map((f) => [f, read(path.join(M, f))]));

      await edit("h1", "Welcome to Acme Widgets");
      await waitFor(() => read(path.join(M, "index.html")).includes("Welcome to Acme Widgets"), 5000); await settle();
      let now = grab();
      check("page edit: saved on this page", now["index.html"].includes(">Welcome to Acme Widgets</h1>"));
      check("page edit: original kept for revert", fs.existsSync(path.join(S(id), "mirror-original", "index.html")));

      await edit(".elementor-location-footer p", "Call us on 0800 000 111");
      await waitFor(() => all.every((f) => read(path.join(M, f)).includes("0800 000 111")), 5000); await settle();
      now = grab();
      check("site-wide edit: applied to every page", all.every((f) => now[f].includes("Call us on 0800 000 111")), all.filter((f) => !now[f].includes("0800 000 111")));
      check("site-wide edit: page edit stays on its page", !now["about/index.html"].includes("Acme Widgets"));

      await inFrame(`document.querySelector(".elementor-widget-image img").click()`);
      await waitFor(() => run(`Boolean(selectedCopyImage)`));
      await fakePick(120, 80, "#0a0");
      await clickButton("Replace image…");
      const img = await waitFor(() => read(path.join(M, "index.html")).match(/<img src="(\/assets\/[a-f0-9]+\.webp)"[^>]*alt="Hero"/)?.[1], 8000); await settle();
      check("copy image: replaced and srcset dropped", img && fs.existsSync(path.join(S(id), img)) && !/alt="Hero"[^>]*srcset|srcset[^>]*alt="Hero"/.test(read(path.join(M, "index.html"))), img);

      await clickButton("Undo last change"); await settle(); // the image
      await clickButton("Undo last change"); await settle(); // the footer
      now = grab();
      check("undo: site-wide edit undone everywhere", all.every((f) => now[f].includes("Call us on 01234 567890") && !now[f].includes("0800")), all.filter((f) => !now[f].includes("01234 567890")));
      check("undo: earlier page edit survives", now["index.html"].includes("Welcome to Acme Widgets"));

      await clickButton("Revert this page to the original"); await settle();
      const original = read(path.join(S(id), "mirror-original", "index.html"));
      check("revert: page back to the import", read(path.join(M, "index.html")) === original && original.includes(">Welcome to Acme</h1>"));
      check("revert: save state", (await run(`document.querySelector(".save-state").textContent`)) === "Page reverted");
      await clickButton("Undo last change"); await settle();
      check("undo: revert can be undone", read(path.join(M, "index.html")).includes("Welcome to Acme Widgets"));

      // Link target of a site-wide menu item (both menus, every page); regression.js checks the built site.
      // Find and click in one poll: a separate click call can land on a frame the undo reload is replacing and hang.
      const clickAbout = () => waitFor(() => inFrame(`{ const a = document.querySelector('li[data-sb-edit^="s-"] a[href="/about/"]'); if (a) { a.click(); document.activeElement.dispatchEvent(new FocusEvent("blur")); } Boolean(a) }`));
      const aboutLinks = (html) => (html.match(/<a href="([^"]*)">About<\/a>/g) || []).join(" ");
      await clickAbout();
      const shown = await waitFor(() => run(`document.querySelector(".copy-link input")?.value`), 5000);
      check("copy link: panel shows the current target", shown === "/about/", shown);
      const setLink = (v) => run(`{ const i = document.querySelector(".copy-link input"); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("change")); 0 }`);
      const beforeBad = grab();
      for (const bad of ["javascript:alert(1)", "/not-a-page/", "ftp://x.example/"]) { await setLink(bad); await settle(); }
      check("copy link: invalid targets refused", /Use a web address/.test(await run(`document.querySelector(".copy-link .error")?.textContent`)) && JSON.stringify(grab()) === JSON.stringify(beforeBad));
      await setLink("/contact-us/"); await settle();
      now = grab();
      check("copy link: site-wide change on every page", all.every((f) => aboutLinks(now[f]) === '<a href="/contact-us/">About</a> <a href="/contact-us/">About</a>'), all.map((f) => aboutLinks(now[f])));
      check("copy link: preview updated", await waitFor(() => inFrame(`document.querySelectorAll('a[href="/about/"]').length === 0`), 3000));
      await clickButton("Undo last change"); await settle();
      now = grab();
      check("copy link: undone everywhere", all.every((f) => aboutLinks(now[f]) === '<a href="/about/">About</a> <a href="/about/">About</a>'), all.map((f) => aboutLinks(now[f])));
      await clickAbout();
      await waitFor(() => run(`Boolean(document.querySelector(".copy-link input"))`), 5000);
      await shot("copy-link");
      await setLink("https://example.com/about-acme"); await settle();
      check("copy link: external address saved", all.every((f) => read(path.join(M, f)).includes('<a href="https://example.com/about-acme">About</a>')));
      // Linked image (the header logo, site-wide): same link panel from the image panel.
      await waitFor(() => inFrame(`{ const i = document.querySelector(".elementor-location-header a > img"); if (i) i.click(); Boolean(i) }`));
      const logoShown = await waitFor(() => run(`selectedCopyImage && document.querySelector(".copy-link input")?.value`), 5000);
      check("copy image link: panel shows the logo's target", logoShown === "/", logoShown);
      await setLink("/contact-us/"); await settle(); await shot("copy-image-link");
      check("copy image link: saved on every page", all.every((f) => /<a href="\/contact-us\/"><img [^>]*alt="Acme"/.test(read(path.join(M, f)))));
    }
  });
});
