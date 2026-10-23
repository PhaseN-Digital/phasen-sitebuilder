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
const { startWordPress, startElementor } = require("./fakes");

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

async function driveApp(wp, el) {
  const result = path.join(OUT, "drive.json"), shots = path.join(OUT, "screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const args = ["--no-sandbox", "-r", path.join(__dirname, "drive.js"), "."];
  const headless = process.platform === "linux" && !process.env.DISPLAY;
  const env = { ...process.env, SB_USERDATA: path.join(OUT, "userdata"), SB_RESULT: result, SB_SHOTS: shots, SB_WP: wp.url, SB_EL: el.url };
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
  await build(site, siteDir, dir, { workerName: site.workerName, sitekey: "REAL_SITEKEY", defaultTo: "owner@example.com" });
  fs.writeFileSync(path.join(dir, ".dev.vars"), `TURNSTILE_SECRET_KEY=${TURNSTILE_TEST_SECRET}\n`);
  const port = await freePort();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" };
  delete env.RESEND_API_KEY;
  const child = start(ELECTRON, ["--require", path.join(ROOT, "lib", "wrangler-argv-fix.js"), WRANGLER, "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: dir, env, log: path.join(OUT, `wrangler-${name}.log`) });
  const base = `http://127.0.0.1:${port}`;
  for (const end = Date.now() + 60000; Date.now() < end && child.exitCode === null; await sleep(300)) {
    if (await fetch(base + "/", { redirect: "manual" }).then(() => true, () => false)) return { site, dir, base, child };
  }
  await child.stop();
  throw new Error(`wrangler dev didn't start for ${name}:\n${child.output.slice(-2000)}`);
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

async function workerChecks(sites) {
  if (sites.created) {
    const s = await serve("created", sites.created, { analyticsId: "G-REGRESSION1" });
    try {
      const home = await get(s.base, "/");
      check("worker (made in app): home page", home.status === 200 && home.text.includes("Edited headline") && home.text.includes("/styles.css"), home.status);
      const img = home.text.match(/\/assets\/[a-f0-9]+\.webp/)?.[0];
      check("worker (made in app): uploaded image served", img && (await get(s.base, img)).status === 200, img);
      const contact = await get(s.base, "/contact");
      check("worker (made in app): contact page with form", contact.status === 200 && contact.text.includes('data-form="contact"') && contact.text.includes('data-sitekey="REAL_SITEKEY"'), contact.status);
      check("worker (made in app): cookie banner, no gtag before consent", home.text.includes('id="cookie-banner"') && !home.text.includes("googletagmanager")
        && (await get(s.base, "/consent.js")).text.includes("googletagmanager"));
      check("worker (made in app): privacy page", (await get(s.base, "/privacy")).text.includes("owner@example.com"));
      const missing = await get(s.base, "/no-such-page");
      check("worker (made in app): custom 404", missing.status === 404 && missing.text.includes("Page not found"), missing.status);
      check("worker (made in app): unknown form", (await post(s.base, "/api/forms/nope", {})).status === 404);
      check("worker (made in app): GET on a form", (await get(s.base, "/api/forms/contact")).status === 405);
      const fields = s.site.forms[0].fields;
      const valid = Object.fromEntries(fields.map((f) => [f.id, f.type === "email" ? "jo@example.com" : `Regression ${f.id} value`]));
      await formChecks("worker (made in app) form", s, "contact", valid);
    } finally { await s.child.stop(); }
  }
  if (sites.mirror) {
    const s = await serve("mirror", sites.mirror);
    try {
      const home = await get(s.base, "/");
      const form = s.site.forms[0];
      check("worker (exact copy): home page", home.status === 200 && home.text.includes(`data-form="${form.id}"`), home.status);
      check("worker (exact copy): editor tags and placeholders gone", !/data-sb-edit|__TURNSTILE_SITEKEY__|__FORM_SUCCESS__/.test(home.text) && home.text.includes('data-sitekey="REAL_SITEKEY"'));
      const about = await get(s.base, "/about/");
      check("worker (exact copy): copied page", about.status === 200);
      check("worker (exact copy): edited menu link on every page", [home, about].every((r) => (r.text.match(/<a href="https:\/\/example\.com\/about-acme">About<\/a>/g) || []).length === 2));
      check("worker (exact copy): copied CSS", (await get(s.base, "/wp-content/uploads/elementor/css/post-5.css")).status === 200);
      const redirect = await get(s.base, "/contact/");
      check("worker (exact copy): old address redirects", redirect.status === 301 && /\/contact-us\/$/.test(redirect.location || ""), redirect);
      const missing = await get(s.base, "/no-such-page/");
      check("worker (exact copy): copied 404 page", missing.status === 404 && missing.text.includes("Oops, nothing here"), missing.status);
      await formChecks("worker (exact copy) form", s, form.id, { "form_fields[name]": "Regression Name", "form_fields[email]": "jo@example.com", "form_fields[message]": "Regression message body" });
    } finally { await s.child.stop(); }
  }
}

(async () => {
  const started = Date.now();
  console.log(`Regression run, output in ${OUT}`);
  const wp = await startWordPress(), el = await startElementor();
  try {
    const sites = await driveApp(wp, el);
    check("exact copy: never fetched feeds or admin pages", !el.forbidden.length, el.forbidden);
    await workerChecks(sites);
  } catch (e) {
    check("suite finished without errors", false, e.stack || String(e));
  } finally {
    await wp.close(); await el.close();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s.`);
  if (failed.length) console.log(`Failed:\n${failed.map((c) => `  - ${c.name}`).join("\n")}\nLogs and screenshots: ${OUT}`);
  process.exit(failed.length || !checks.length ? 1 : 0);
})();
