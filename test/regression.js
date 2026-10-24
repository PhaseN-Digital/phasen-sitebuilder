// End-to-end regression suite: `npm run test:regression`. Starts the fake
// WordPress sites (test/fakes.js), drives the real app headlessly through
// test/drive.js, then builds the sites it made and runs them under the
// bundled wrangler (`wrangler dev` on Electron's Node), exactly as publishing
// would, short of deploying. No accounts needed; the only outside request is
// the Worker's Turnstile check, against Cloudflare's published test secret.
// On Linux without a display it runs Electron under xvfb-run.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { build } = require("../lib/build");
const { startWordPress, startElementor, startUpdates, startGitHub } = require("./fakes");
const themeSources = require("../lib/theme-sources");

const ROOT = path.join(__dirname, "..");
const ELECTRON = require("electron"); // the binary's path, when required from Node
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "wrangler-dist", "cli.js");
const OUT = process.env.SB_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "sb-regression-"));
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA"; // always passes
const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// Runs a child in its own process group, so killing it takes its children too (workerd).
function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], ...opts });
  child.output = "";
  const log = opts.log && fs.createWriteStream(opts.log);
  for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { child.output += d; log?.write(d); opts.echo && process.stdout.write(d); });
  child.done = new Promise((r) => child.on("close", r));
  child.stop = () => { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch {} return child.done; };
  return child;
}

async function driveApp(wp, el, updates, gh) {
  const result = path.join(OUT, "drive.json"), shots = path.join(OUT, "screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const args = ["--no-sandbox", "-r", path.join(__dirname, "drive.js"), "."];
  const headless = process.platform === "linux" && !process.env.DISPLAY;
  const env = { ...process.env, SB_USERDATA: path.join(OUT, "userdata"), SB_RESULT: result, SB_SHOTS: shots, SB_WP: wp.url, SB_EL: el.url, SITEBUILDER_UPDATE_URL: updates.latestUrl, SITEBUILDER_GITHUB_API: gh.url };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = headless ? start("xvfb-run", ["-a", ELECTRON, ...args], { env, echo: true }) : start(ELECTRON, args, { env, echo: true });
  const timer = setTimeout(() => { console.log("App run timed out after 3 minutes"); app.stop(); }, 180000);
  await app.done;
  clearTimeout(timer);
  if (!fs.existsSync(result)) { check("app run produced results", false, "see the log above"); return {}; }
  const { checks: appChecks, sites } = JSON.parse(fs.readFileSync(result, "utf8"));
  checks.push(...appChecks); // already printed by drive.js
  return sites;
}

// Builds a site the way publishing does and serves it with `wrangler dev`.
async function serve(name, siteId, extra = {}) {
  const siteDir = path.join(OUT, "userdata", "sites", siteId);
  const site = { ...JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")), ...extra };
  const dir = path.join(OUT, "built", name);
  await build(site, siteDir, dir, { workerName: site.workerName, hostname: "regression.workers.dev", sitekey: "REAL_SITEKEY", defaultTo: "owner@example.com", d1: { id: "00000000-0000-0000-0000-000000000000", name: "regression-inbox" } });
  fs.writeFileSync(path.join(dir, ".dev.vars"), `TURNSTILE_SECRET_KEY=${TURNSTILE_TEST_SECRET}\n`);
  const port = await freePort();
  const env = wranglerEnv();
  const child = start(ELECTRON, ["--require", path.join(ROOT, "lib", "wrangler-argv-fix.js"), WRANGLER, "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: dir, env, log: path.join(OUT, `wrangler-${name}.log`) });
  const base = `http://127.0.0.1:${port}`;
  for (const end = Date.now() + 60000; Date.now() < end && child.exitCode === null; await sleep(300)) {
    if (await fetch(base + "/", { redirect: "manual" }).then(() => true, () => false)) return { site, dir, base, child };
  }
  await child.stop();
  throw new Error(`wrangler dev didn't start for ${name}:\n${child.output.slice(-2000)}`);
}

function wranglerEnv() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" };
  delete env.RESEND_API_KEY;
  return env;
}

// Runs SQL against the built site's local D1 (the form inbox, #75), the same database `wrangler dev` uses.
async function d1(dir, sql) {
  const child = start(ELECTRON, ["--require", path.join(ROOT, "lib", "wrangler-argv-fix.js"), WRANGLER, "d1", "execute", "regression-inbox", "--local", "--json", "--command", sql], { cwd: dir, env: wranglerEnv() });
  await child.done;
  try { return JSON.parse(child.output.slice(child.output.indexOf("["))).flatMap((r) => r.results); } catch { return { error: child.output.slice(-1500) }; }
}

async function inboxChecks(label, s) {
  const rows = await d1(s.dir, "SELECT form, fields, email_status FROM messages");
  check(`${label}: valid message stored in the inbox, honeypot and token never stored`, rows.length === 1 && rows[0].email_status === "not sent (no email key)"
    && rows[0].fields.includes("jo@example.com") && !/spam|DUMMY/.test(rows[0].fields), rows);
  await d1(s.dir, "INSERT INTO messages (form, fields, created_at) VALUES ('old', '[]', datetime('now', '-91 days'))");
  const fields = JSON.parse(rows[0].fields);
  const body = Object.fromEntries(s.site.forms.find((f) => f.id === rows[0].form).fields.map((f) => [f.id, fields.find((x) => x.label === f.label)?.value || ""]));
  const r = await post(s.base, `/api/forms/${rows[0].form}`, { ...body, "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" });
  const after = await d1(s.dir, "SELECT form FROM messages");
  check(`${label}: messages past the retention period deleted on the next write`, r.json?.ok === true && after.length === 2 && !after.some((m) => m.form === "old"), after);
}

const get = (base, p) => fetch(base + p, { redirect: "manual" }).then(async (r) => ({ status: r.status, location: r.headers.get("location"), text: await r.text() }));
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

async function formChecks(label, { base, child }, formId, valid) {
  const api = `/api/forms/${formId}`;
  const sent = () => (child.output.match(/RESEND_API_KEY not set, would have sent/g) || []).length;
  const ok = (r) => r.status === 200 && r.json?.ok === true;
  check(`${label}: honeypot gets a silent success`, ok(await post(base, api, { ...valid, website: "spam" })) && sent() === 0);
  const firstField = Object.keys(valid)[0];
  let r = await post(base, api, { ...valid, [firstField]: "", "cf-turnstile-response": "x" });
  check(`${label}: required field enforced`, r.status === 400 && /Please fill in/.test(r.json?.error), r);
  const email = Object.keys(valid).find((k) => /email/.test(k));
  r = await post(base, api, { ...valid, [email]: "not-an-email", "cf-turnstile-response": "x" });
  check(`${label}: email validated`, r.status === 400 && /doesn't look right/.test(r.json?.error), r);
  r = await post(base, api, valid);
  check(`${label}: captcha required`, r.status === 400 && /captcha/.test(r.json?.error), r);
  r = await post(base, api, "{nope");
  check(`${label}: bad JSON rejected`, r.status === 400, r);
  r = await post(base, api, { ...valid, "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" });
  await sleep(500);
  check(`${label}: valid message accepted (Turnstile test secret)`, ok(r), r);
  check(`${label}: message logged instead of sent without RESEND_API_KEY`, sent() === 1 && Object.values(valid).every((v) => child.output.includes(v)), child.output.slice(-1500));
}

// A theme from a theme source (#58): downloaded from the fake GitHub API,
// copied into the site folder and built from there, with the cache gone.
async function sourceTheme(siteId) {
  const gh = await startGitHub();
  const cacheRoot = path.join(OUT, "theme-cache");
  try {
    const listing = await themeSources.fetchSource(themeSources.PUBLIC_SOURCE, { cacheRoot, api: gh.url });
    check("theme source: public repo listed and validated", listing.themes.retro?.errors.length === 0 && listing.themes.broken?.errors.length > 0, listing.themes);
    const priv = await themeSources.fetchSource(gh.privateSpec, { cacheRoot, api: gh.url, token: gh.token });
    check("theme source: private repo with a token, token never sent off the API host", priv.themes.night?.errors.length === 0
      && gh.requests.every(([host, , auth]) => host === gh.host || !auth), gh.requests);
    await themeSources.installTheme(themeSources.PUBLIC_SOURCE, "retro", cacheRoot, path.join(OUT, "userdata", "sites", siteId));
  } finally {
    await gh.close();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
  return { theme: "retro", themeSource: themeSources.PUBLIC_SOURCE, font: "theme-retro" };
}

// Publishing to a subdomain (#135) against a stubbed Cloudflare/Resend API:
// the publish steps main.js runs, then the build checked with wrangler's own dry run.
async function subdomainChecks(siteId) {
  const pub = require("../lib/publish");
  const siteDir = path.join(OUT, "userdata", "sites", siteId), dir = path.join(OUT, "built", "subdomain");
  const site = { ...JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")), domain: { id: "zone1", name: "example.com" } };
  const domain = pub.siteDomain(site.domain);
  domain.label = "shop";
  const hostname = pub.domainHostname(domain), calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, { method, body }) => {
    url = url.replace(/^https:\/\/api\.(cloudflare\.com\/client\/v4|resend\.com)/, "");
    calls.push({ method, url, body: body && JSON.parse(body) });
    const result = url.includes("/workers/domains") ? [] : url.includes("/dns_records") ? [{ type: "CNAME" }] : url.includes("/challenges/widgets") ? { sitekey: "sk", secret: "sec" } : {};
    const json = url === "/domains" && method === "GET" ? { data: [] } : url === "/domains" ? { id: "rd1", name: "example.com", records: [], status: "verified" } : { success: true, result };
    return { status: 200, ok: true, json: async () => json };
  };
  let warnings;
  try {
    warnings = await pub.hostnameWarnings("t", "acct", domain, site.workerName);
    await pub.ensureTurnstile("t", "acct", site.name, hostname);
    await pub.ensureResendDomain("t", domain, "rk", () => {});
    await pub.ensureWwwRedirect("t", domain, () => {});
  } finally { globalThis.fetch = realFetch; }
  check("subdomain publish: hostname and validation", hostname === "shop.example.com" && !pub.labelError(domain.label, domain.zoneName) && pub.labelError("Shop!", "example.com"));
  check("subdomain publish: warned about existing DNS records", warnings.length === 1 && warnings[0].includes("shop.example.com already has DNS records"), warnings);
  check("subdomain publish: Turnstile widget on the full hostname", calls.some((c) => c.url === "/accounts/acct/challenges/widgets" && c.body.domains[0] === "shop.example.com"), calls);
  check("subdomain publish: Resend sends from the zone apex", calls.some((c) => c.url === "/domains" && c.method === "POST" && c.body.name === "example.com"), calls);
  check("subdomain publish: no www redirect", !calls.some((c) => /rulesets|www\./.test(c.url)), calls);
  await build(site, siteDir, dir, { workerName: site.workerName, hostname, sitekey: "sk", fromAddress: `website@${domain.zoneName}`, defaultTo: "owner@example.com" });
  const toml = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8"), read = (f) => fs.readFileSync(path.join(dir, "public", f), "utf8");
  check("subdomain publish: wrangler.toml Custom Domain on the full hostname", toml.includes('pattern = "shop.example.com"\ncustom_domain = true') && toml.includes("workers_dev = false"), toml);
  check("subdomain publish: canonical, sitemap and robots on the full hostname", read("index.html").includes('<link rel="canonical" href="https://shop.example.com/">')
    && read("sitemap.xml").includes("<loc>https://shop.example.com/</loc>") && read("robots.txt").includes("Sitemap: https://shop.example.com/sitemap.xml"));
  const dry = start(ELECTRON, ["--require", path.join(ROOT, "lib", "wrangler-argv-fix.js"), WRANGLER, "deploy", "--dry-run", "--outdir", path.join(OUT, "subdomain-dry-run")], { cwd: dir, env: wranglerEnv() });
  check("subdomain publish: wrangler accepts the config (deploy --dry-run)", (await dry.done) === 0, dry.output.slice(-1500));
}

async function workerChecks(sites) {
  if (sites.created) {
    // Built with the Theme Builder's theme the app chose for it (#130), before serve() swaps in a source theme.
    const siteDir = path.join(OUT, "userdata", "sites", sites.created), localOut = path.join(OUT, "built", "local-theme");
    await build(JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")), siteDir, localOut, { workerName: "local-theme" });
    check("build (made in app): with a Theme Builder theme", fs.readFileSync(path.join(localOut, "public", "styles.css"), "utf8").includes("/* theme-builder "));
    const s = await serve("created", sites.created, { analyticsId: "G-REGRESSION1", ...(await sourceTheme(sites.created)) });
    try {
      const home = await get(s.base, "/");
      check("worker (made in app): home page", home.status === 200 && home.text.includes("Edited headline") && home.text.includes("/styles.css"), home.status);
      const img = home.text.match(/\/assets\/[a-f0-9]+\.webp/)?.[0];
      const css = (await get(s.base, "/styles.css")).text;
      check("worker (made in app): theme from a theme source", css.includes("retro-theme-css") && css.includes('--font: "Courier New"'), css.slice(0, 300));
      check("worker (made in app): uploaded image served", img && (await get(s.base, img)).status === 200, img);
      const figure = home.text.match(/<figure><img src="(\/assets\/[a-f0-9]+\.webp)" alt="A red box">/)?.[1];
      check("worker (made in app): rich text with its image, table and click-to-load video (#120)", figure && (await get(s.base, figure)).status === 200 && home.text.includes("<td>Cell A1</td>")
        && home.text.includes('<div class="video-embed"><iframe title="Video from YouTube" srcdoc=') && !home.text.includes("<iframe src="), figure);
      const contact = await get(s.base, "/contact");
      check("worker (made in app): contact page with form", contact.status === 200 && contact.text.includes('data-form="contact"') && contact.text.includes('data-sitekey="REAL_SITEKEY"'), contact.status);
      check("worker (made in app): cookie banner, no gtag before consent", home.text.includes('id="cookie-banner"') && !home.text.includes("googletagmanager")
        && (await get(s.base, "/consent.js")).text.includes("googletagmanager"));
      check("worker (made in app): privacy page", (await get(s.base, "/privacy")).text.includes("owner@example.com"));
      const sitemap = (await get(s.base, "/sitemap.xml")).text, robots = (await get(s.base, "/robots.txt")).text;
      check("worker (made in app): sitemap, robots.txt and canonical (#74)", sitemap.includes("<loc>https://regression.workers.dev/contact</loc>") && !sitemap.includes("privacy")
        && robots.includes("Sitemap: https://regression.workers.dev/sitemap.xml") && home.text.includes('<link rel="canonical" href="https://regression.workers.dev/">'), sitemap);
      const missing = await get(s.base, "/no-such-page");
      check("worker (made in app): custom 404", missing.status === 404 && missing.text.includes("Page not found"), missing.status);
      check("worker (made in app): unknown form", (await post(s.base, "/api/forms/nope", {})).status === 404);
      check("worker (made in app): GET on a form", (await get(s.base, "/api/forms/contact")).status === 405);
      const fields = s.site.forms[0].fields;
      const valid = Object.fromEntries(fields.map((f) => [f.id, f.type === "email" ? "jo@example.com" : `Regression ${f.id} value`]));
      await formChecks("worker (made in app) form", s, "contact", valid);
      await inboxChecks("worker (made in app) inbox", s);
    } finally { await s.child.stop(); }
  }
  if (sites.wordpress) {
    const s = await serve("wordpress", sites.wordpress);
    try {
      const about = await get(s.base, "/about/"), contact = await get(s.base, "/contact/");
      check("worker (editable import): pages keep their WordPress addresses", about.status === 200 && about.text.includes("We <strong>fix</strong> bikes.")
        && contact.status === 200 && contact.text.includes('data-form="contact"'), [about.status, contact.status]);
      const cart = await get(s.base, "/cart/");
      check("worker (editable import): WordPress-only pages skipped", cart.status === 404 && !s.site.pages.some((p) => ["Members", "Cart"].includes(p.title)), cart.status);
    } finally { await s.child.stop(); }
  }
  if (sites.mirror) {
    const s = await serve("mirror", sites.mirror);
    try {
      const home = await get(s.base, "/");
      const form = s.site.forms[0];
      check("worker (exact copy): home page", home.status === 200 && home.text.includes(`data-form="${form.id}"`), home.status);
      check("worker (exact copy): editor tags and placeholders gone", !/data-sb-edit|__TURNSTILE_SITEKEY__|__FORM_SUCCESS__/.test(home.text) && home.text.includes('data-sitekey="REAL_SITEKEY"'));
      check("worker (exact copy): old site's tracking and Google Fonts hosts gone", !/googletagmanager|facebook\.com\/tr|fonts\.googleapis/.test(home.text));
      const about = await get(s.base, "/about/");
      check("worker (exact copy): copied page", about.status === 200);
      const copySitemap = (await get(s.base, "/sitemap.xml")).text;
      check("worker (exact copy): original sitemap, copied pages only (#74, #115)", copySitemap.includes("<loc>https://regression.workers.dev/about/</loc>") && !copySitemap.includes("old-post"), copySitemap);
      check("worker (exact copy): canonical/og:url on the published hostname (#115)", about.text.includes('<link rel="canonical" href="https://regression.workers.dev/">') && about.text.includes('content="https://regression.workers.dev/about/"'));
      check("worker (exact copy): edited menu link on every page", [home, about].every((r) => (r.text.match(/<a href="https:\/\/example\.com\/about-acme">About<\/a>/g) || []).length === 2));
      check("worker (exact copy): edited logo link", [home, about].every((r) => /<a href="\/contact-us\/"><img [^>]*alt="Acme"/.test(r.text)));
      check("worker (exact copy): copied CSS", (await get(s.base, "/wp-content/uploads/elementor/css/post-5.css")).status === 200);
      const redirect = await get(s.base, "/contact/");
      check("worker (exact copy): old address redirects", redirect.status === 301 && /\/contact-us\/$/.test(redirect.location || ""), redirect);
      const missing = await get(s.base, "/no-such-page/");
      check("worker (exact copy): copied 404 page", missing.status === 404 && missing.text.includes("Oops, nothing here"), missing.status);
      await formChecks("worker (exact copy) form", s, form.id, { "form_fields[name]": "Regression Name", "form_fields[email]": "jo@example.com", "form_fields[message]": "Regression message body" });
      check("worker (exact copy): cart and comment forms not re-wired", s.site.forms.length === 1 && !about.text.includes("data-form="), s.site.forms.map((f) => f.name));
      const r = await post(s.base, `/api/forms/${form.id}`, { "form_fields[name]": "Ticker", "form_fields[email]": "jo@example.com", "form_fields[services][]": ["Design", "Build"], "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" });
      await sleep(500);
      check("worker (exact copy): checkbox group sent whole, hidden branch not required", r.json?.ok === true && s.child.output.includes("Services: Design, Build"), r);
    } finally { await s.child.stop(); }
  }
}

(async () => {
  const started = Date.now();
  console.log(`Regression run, output in ${OUT}`);
  const wp = await startWordPress(), el = await startElementor(), updates = await startUpdates(), gh = await startGitHub();
  try {
    const sites = await driveApp(wp, el, updates, gh);
    check("exact copy: never fetched feeds or admin pages", !el.forbidden.length, el.forbidden);
    await workerChecks(sites);
    if (sites.created) await subdomainChecks(sites.created);
  } catch (e) {
    check("suite finished without errors", false, e.stack || String(e));
  } finally {
    await wp.close(); await el.close(); await updates.close(); await gh.close();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s.`);
  if (failed.length) console.log(`Failed:\n${failed.map((c) => `  - ${c.name}`).join("\n")}\nLogs and screenshots: ${OUT}`);
  process.exit(failed.length || !checks.length ? 1 : 0);
})();
