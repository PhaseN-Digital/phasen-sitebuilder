// Drives the real app for the regression suite: preloaded into Electron by
// test/regression.js (`electron -r test/drive.js .`), which passes the fake
// sites and output paths in SB_* environment variables. Every check lands in
// SB_RESULT as JSON; regression.js prints the summary.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { SB_USERDATA: UD, SB_RESULT, SB_SHOTS, SB_WP, SB_EL } = process.env;
app.setPath("userData", UD);
const elHost = new URL(SB_EL).host;

const checks = [];
const result = { checks, sites: {} };
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(f, "utf8");

app.on("browser-window-created", (_e, win) => {
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
    const steps = { updateBanner, createSite, wordpressImport, elementorEditable, exactCopy };
    try {
      for (const [name, fn] of Object.entries(steps)) {
        try { await fn(); } catch (e) { check(`${name} finished without errors`, false, e.stack || String(e)); }
        await shot(name);
      }
    } finally {
      fs.writeFileSync(SB_RESULT, JSON.stringify(result, null, 2));
      app.quit();
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
      const siteDir = path.join(UD, "sites", id), pub = path.join(UD, "preview", id, "public");
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

    // ---------- 2. editable WordPress import ----------
    async function wordpressImport() {
      await run(`document.querySelector("#import-wp").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("form.import"))`));
      await run(`{ const f = document.querySelector("form.import"); f.url.value = ${JSON.stringify(SB_WP)}; f.username.value = "u"; f.password.value = "p"; f.requestSubmit() }`);
      const err = await waitFor(() => run(`document.querySelector(".import .error").textContent`));
      check("wordpress: credentials over http refused", /https/i.test(err || ""), err);

      await run(`{ const f = document.querySelector("form.import"); f.username.value = ""; f.password.value = ""; f.querySelector('[value="editable"]').checked = true; f.querySelector("button").disabled = false; f.requestSubmit() }`);
      const id = await waitFor(() => run(`site?.name === "Bob’s Bikes" && site.id`), 30000);
      check("wordpress: import opens the site", id, await run(`document.querySelector(".import .error")?.textContent || document.querySelector(".log")?.textContent`).catch(() => ""));
      if (!id) return;
      result.sites.wordpress = id;
      await saved();
      const s = JSON.parse(read(path.join(UD, "sites", id, "site.json")));
      check("wordpress: tagline", s.description === "Fixing bikes since 1999", s.description);
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
    }

    // ---------- 2b. editable import of an Elementor site: kit colours/font, site-logo widget ----------
    async function elementorEditable() {
      await run(`document.querySelector("#import-wp").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("form.import"))`));
      await run(`{ const f = document.querySelector("form.import"); f.url.value = ${JSON.stringify(SB_EL)}; f.querySelector('[value="editable"]').checked = true; f.requestSubmit() }`);
      const id = await waitFor(() => run(`site?.name === "Acme Ltd" && !site.mirror && site.id`), 30000);
      check("elementor editable: import opens the site", id, await run(`document.querySelector(".import .error")?.textContent || document.querySelector(".log")?.textContent`).catch(() => ""));
      if (!id) return;
      await saved();
      const s = JSON.parse(read(path.join(UD, "sites", id, "site.json")));
      check("elementor editable: kit styles mapped", s.theme === "elegant" && s.font === "serif" && JSON.stringify(s.colors) === JSON.stringify({ background: "#fff6ee", text: "#241b2f", primary: "#ee5c44", accent: "#7c6bff" }), { theme: s.theme, font: s.font, colors: s.colors });
      check("elementor editable: header logo copied", /^assets\/[a-f0-9]+\.webp$/.test(s.logo?.src || ""), s.logo);
    }

    // ---------- 3. exact copy of an Elementor site ----------
    async function exactCopy() {
      await run(`document.querySelector("#import-wp").click()`);
      await waitFor(() => run(`Boolean(document.querySelector("form.import"))`));
      await run(`{ const f = document.querySelector("form.import"); f.url.value = ${JSON.stringify(SB_EL)}; f.requestSubmit() }`); // "auto" picks exact for Elementor
      const id = await waitFor(() => run(`site?.mirror && site.id`), 60000);
      check("exact copy: import opens the site", id, await run(`document.querySelector(".import .error")?.textContent || document.querySelector(".log")?.textContent`).catch(() => ""));
      if (!id) return;
      result.sites.mirror = id;
      const M = path.join(UD, "sites", id, "mirror");
      const s = JSON.parse(read(path.join(UD, "sites", id, "site.json")));
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
      check("page edit: original kept for revert", fs.existsSync(path.join(UD, "sites", id, "mirror-original", "index.html")));

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
      check("copy image: replaced and srcset dropped", img && fs.existsSync(path.join(UD, "sites", id, img)) && !/alt="Hero"[^>]*srcset|srcset[^>]*alt="Hero"/.test(read(path.join(M, "index.html"))), img);

      await clickButton("Undo last change"); await settle(); // the image
      await clickButton("Undo last change"); await settle(); // the footer
      now = grab();
      check("undo: site-wide edit undone everywhere", all.every((f) => now[f].includes("Call us on 01234 567890") && !now[f].includes("0800")), all.filter((f) => !now[f].includes("01234 567890")));
      check("undo: earlier page edit survives", now["index.html"].includes("Welcome to Acme Widgets"));

      await clickButton("Revert this page to the original"); await settle();
      const original = read(path.join(UD, "sites", id, "mirror-original", "index.html"));
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
    }
  });
});
