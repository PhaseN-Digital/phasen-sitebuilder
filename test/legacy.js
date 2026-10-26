// Upgrade from a pre-#136 install (#218), preloaded by test/regression.js:
// `electron -r test/legacy.js .` on a copy of test/fixtures/legacy-0.7.0, the
// userData v0.7.0 left after publishing an apex site (made by v0.7.0 itself,
// under this harness: secrets sealed one by one with safeStorage, whose
// plain-text mode on Linux uses Chromium's fixed key, so they open here too).
// The fixture's secrets are fakes: Cloudflare token "cf_token", Resend key
// "re_full", sending key "re_send_1", Turnstile's test secret.
// Cloudflare and Resend are faked at fetch level, so lib/publish.js's own logic
// runs; only the wrangler upload is stubbed, recording the secrets it would send.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { SB_USERDATA: UD, SB_DOCS, SB_RESULT, SB_LEGACY_OUT: OUT } = process.env;
app.setPath("userData", UD);
app.setPath("documents", SB_DOCS);
app.whenReady().then(() => safeStorage.setUsePlainTextEncryption(true));

const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

// The fake accepts only the keys it issued, like Resend.
const VALID_KEY = /^re_(full|send_\d+)$/;
let keyCount = 1, issueGarbage = false; // the fixture already holds re_send_1
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const auth = (opts.headers?.Authorization || "").replace("Bearer ", "");
  const ok = (result) => Response.json({ success: true, result });
  if (u.host === "api.resend.com") {
    calls.push(`resend ${opts.method} ${u.pathname}`);
    if (!VALID_KEY.test(auth)) return Response.json({ message: "API key is invalid" }, { status: 401 });
    if (u.pathname === "/domains" && opts.method === "GET") return Response.json({ data: [{ id: "dom-1", name: "example.com" }] });
    if (u.pathname.startsWith("/domains")) return Response.json({ id: "dom-1", name: "example.com", status: "verified", records: [] });
    if (u.pathname === "/api-keys") return Response.json({ id: `key-${++keyCount}`, token: issueGarbage ? "djEwnot-a-key" : `re_send_${keyCount}` });
    return Response.json({});
  }
  if (u.host === "api.cloudflare.com") {
    const r = u.pathname.replace("/client/v4", "");
    calls.push(`cf ${opts.method} ${r}`);
    if (/rotate_secret$/.test(r)) return ok({ secret: "0x4AAAAAAArotated" });
    if (/\/query$/.test(r)) return ok([{ results: [] }]);
    return ok([]);
  }
  return realFetch(url, opts);
};
const cf = require("../lib/publish");
const deploys = [];
let failDeploy = false;
cf.deployWorker = async (out, creds, secrets) => {
  if (failDeploy) { calls.push("deploy failed"); throw new Error("upload failed"); }
  deploys.push(secrets);
  calls.push("deploy");
  fs.cpSync(out, path.join(OUT, `publish-${deploys.length}`), { recursive: true });
};

app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", async () => {
    const run = (js) => win.webContents.executeJavaScript(js);
    const publish = (id) => run(`cms.call("sites:publish", ${JSON.stringify(id)}).then(() => "ok", (e) => e.message)`);
    const result = { checks };
    try {
      const SITES = path.join(SB_DOCS, "PhaseN Sites");
      const [site] = await run(`cms.call("sites:list")`);
      const dir = path.join(SITES, fs.readdirSync(SITES).find((n) => !n.startsWith(".")));
      const sealed = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "legacy-0.7.0", "sites", site.id, "publish.json"), "utf8")).sendingKey;
      check("legacy upgrade: site moved, no sealed value left in publish.json", !fs.readFileSync(path.join(dir, "publish.json"), "utf8").includes("djEw"));

      // 1. Republish after the upgrade: the real keys go up, the existing sending key is reused.
      const r1 = await publish(site.id);
      const [d1] = deploys;
      check("legacy upgrade: republish uploads the real Resend sending key (#218)", r1 === "ok" && d1?.RESEND_API_KEY === "re_send_1", { r1, key: d1?.RESEND_API_KEY?.slice(0, 8) });
      check("legacy upgrade: republish uploads the real Turnstile secret", d1?.TURNSTILE_SECRET_KEY === TURNSTILE_TEST_SECRET);
      check("legacy upgrade: sending key reused, not re-created", !calls.includes("resend POST /api-keys"), calls);
      const forms = JSON.parse(fs.readFileSync(path.join(OUT, "publish-1", "worker", "forms.json"), "utf8"));
      const toml = fs.readFileSync(path.join(OUT, "publish-1", "wrangler.toml"), "utf8");
      check("legacy upgrade: recipient from the app defaults, from-address on the apex", forms.contact?.to === "owner@example.com" && toml.includes('FROM_ADDRESS = "website@example.com"'), { to: forms.contact?.to });
      result.publishDir = path.join(OUT, "publish-1");
      result.key = d1?.RESEND_API_KEY;
      result.sealed = sealed;

      // 2. A site left broken (old ciphertext in its secrets): republishing repairs it.
      const keyring = { safe: { encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) }, portable: false, key: null };
      const store = require("../lib/settings").store(path.join(SITES, ".phasen"), keyring);
      await store.updateState(dir, (s) => { s.sendingKey = sealed; s.turnstile.secret = sealed; });
      calls.length = 0;
      const r2 = await publish(site.id);
      const d2 = deploys[1];
      check("broken site: republish re-creates the sending key and rotates the Turnstile secret", r2 === "ok" && /^re_send_\d+$/.test(d2?.RESEND_API_KEY) && d2.RESEND_API_KEY !== "re_send_1" && d2.TURNSTILE_SECRET_KEY === "0x4AAAAAAArotated", { r2, d2 });
      const state = await store.loadState(dir);
      check("broken site: the replaced sending key is deleted at Resend after the deploy (#176)", calls.indexOf("resend DELETE /api-keys/key-1") > calls.indexOf("deploy"), calls);
      check("broken site: the new keys are stored", state.sendingKey === d2?.RESEND_API_KEY && state.turnstile.secret === "0x4AAAAAAArotated");

      // 3. The guard: a key that isn't a Resend key is never uploaded.
      await store.updateState(dir, (s) => { delete s.sendingKey; });
      issueGarbage = true;
      calls.length = 0;
      const r3 = await publish(site.id);
      check("guard: refuses to deploy with an invalid key", /form keys aren't valid/.test(r3) && deploys.length === 2, r3);
      check("guard: the live sending key isn't deleted when the deploy is refused (#176)", !calls.some((c) => c.startsWith("resend DELETE")), calls);

      // 4. A deploy that fails after the key was replaced keeps the old ids for later (#276).
      issueGarbage = false;
      await store.updateState(dir, (s) => { delete s.sendingKey; });
      failDeploy = true;
      calls.length = 0;
      const r4 = await publish(site.id);
      const s4 = await store.loadState(dir);
      check("failed deploy: publish reports it, nothing deleted at Resend (#276)", /upload failed/.test(r4) && !calls.some((c) => c.startsWith("resend DELETE")), { r4, calls });
      check("failed deploy: the replaced key ids wait in publish.json, no key values (#276)",
        JSON.stringify(s4.oldSendingKeyIds) === JSON.stringify(["key-2", "key-3"]) && s4.sendingKeyId === "key-4" && !fs.readFileSync(path.join(dir, "publish.json"), "utf8").includes("re_send"), s4.oldSendingKeyIds);

      // 5. The next successful publish deletes them and reuses the live key.
      failDeploy = false;
      calls.length = 0;
      const r5 = await publish(site.id);
      const s5 = await store.loadState(dir);
      const after = calls.slice(calls.indexOf("deploy"));
      check("next publish: deletes the saved old keys after the deploy, not the live one (#276)",
        r5 === "ok" && after.includes("resend DELETE /api-keys/key-2") && after.includes("resend DELETE /api-keys/key-3") && !calls.includes("resend DELETE /api-keys/key-4") && !calls.includes("resend POST /api-keys"), calls);
      check("next publish: the pending list is cleared (#276)", !("oldSendingKeyIds" in s5) && deploys.at(-1)?.RESEND_API_KEY === "re_send_4", s5.oldSendingKeyIds);
    } catch (e) {
      check("legacy run finished without errors", false, String(e.stack || e));
    }
    fs.writeFileSync(SB_RESULT, JSON.stringify(result));
    app.exit(0);
  });
});
