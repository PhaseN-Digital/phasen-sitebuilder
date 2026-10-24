// Everything that talks to Cloudflare or Resend. Deploys go through the
// bundled wrangler, run on Electron's own Node (ELECTRON_RUN_AS_NODE), so
// users never install Node or wrangler themselves.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const WRANGLER = path.join(__dirname, "..", "node_modules", "wrangler", "wrangler-dist", "cli.js");
const ARGV_FIX = path.join(__dirname, "wrangler-argv-fix.js");

async function cf(token, method, route, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw Object.assign(new Error(`Cloudflare: ${json.errors?.map((e) => e.message).join(", ") || `HTTP ${res.status}`}`), { status: res.status });
  return json.result;
}

async function resend(key, method, route, body) {
  const res = await fetch(`https://api.resend.com${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Resend: ${json.message || `HTTP ${res.status}`}`), { status: res.status });
  return json;
}

// Returns accounts the token can see, plus warnings about missing permissions.
async function checkCloudflareToken(token) {
  const accounts = await cf(token, "GET", "/accounts");
  if (!accounts.length) throw new Error("This token can't see any Cloudflare accounts.");
  const warnings = [];
  await cf(token, "GET", `/accounts/${accounts[0].id}/challenges/widgets`).catch(() =>
    warnings.push("The token is missing the Turnstile permission, so forms won't work. Add Account › Turnstile › Edit.")
  );
  await cf(token, "GET", `/accounts/${accounts[0].id}/workers/scripts`).catch(() =>
    warnings.push("The token is missing the Workers permission. Use the \"Edit Cloudflare Workers\" template.")
  );
  await cf(token, "GET", `/accounts/${accounts[0].id}/d1/database?per_page=1`).catch(() =>
    warnings.push("The token is missing the D1 permission, so form messages won't be kept in the Inbox. Add Account › D1 › Edit.")
  );
  return { accounts: accounts.map(({ id, name }) => ({ id, name })), warnings };
}

const listZones = (token, accountId) =>
  cf(token, "GET", `/zones?account.id=${accountId}&per_page=50&status=active`).then((zones) => zones.map(({ id, name }) => ({ id, name })));

const checkResendKey = (key) => resend(key, "GET", "/domains");

// A site's domain (#135): { zoneId, zoneName, label }, label "" for the zone's
// apex. Sites saved before #135 have the zone as { id, name }.
const siteDomain = (d) => d && (d.zoneId ? { label: "", ...d } : { zoneId: d.id, zoneName: d.name, label: "" });
const domainHostname = (d) => d && (d.label ? `${d.label}.${d.zoneName}` : d.zoneName);
// The subdomain part: DNS labels (letters, digits, hyphens, not at either end, 63 max), dots between them.
function labelError(label, zoneName = "") {
  if (!label) return null;
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/.test(label)) return "Use lowercase letters, numbers and hyphens (not at the start or end), with dots between parts, each part at most 63 characters.";
  if (label.length + zoneName.length + 1 > 253) return "That address is too long.";
  return null;
}

// Warnings (never blockers) about a hostname someone else may be using: DNS
// records there, or a Worker other than this site's attached to it. Records of
// this site's own Custom Domain don't count. Lookups the token can't make are skipped.
async function hostnameWarnings(token, accountId, domain, workerName) {
  const hostname = domainHostname(domain), warnings = [];
  const attached = await cf(token, "GET", `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`).catch(() => []);
  const other = attached.find((d) => d.hostname === hostname && d.service !== workerName);
  if (other) warnings.push(`${hostname} is already used by another Cloudflare Worker (${other.service}). Publishing may take it over from that Worker, or fail.`);
  else if (!attached.some((d) => d.hostname === hostname)) {
    const records = await cf(token, "GET", `/zones/${domain.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`).catch(() => []);
    if (records.length) warnings.push(`${hostname} already has DNS records (${[...new Set(records.map((r) => r.type))].join(", ")}). Publishing may fail or replace what's there; remove them in Cloudflare first if they aren't needed.`);
  }
  return warnings;
}

async function workersDevHostname(token, accountId, workerName) {
  let sub = await cf(token, "GET", `/accounts/${accountId}/workers/subdomain`).catch(() => null);
  if (!sub?.subdomain) {
    // New accounts have no workers.dev subdomain yet; claim a random one.
    sub = await cf(token, "PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain: `sites-${crypto.randomBytes(4).toString("hex")}` });
  }
  return `${workerName}.${sub.subdomain}.workers.dev`;
}

// One Turnstile widget per site; its allowed hostname follows the site's domain.
async function ensureTurnstile(token, accountId, siteName, hostname, existing) {
  const body = { name: `${siteName} website`.slice(0, 254), domains: [hostname], mode: "managed" };
  if (existing?.sitekey) {
    if (existing.hostname !== hostname) await cf(token, "PUT", `/accounts/${accountId}/challenges/widgets/${existing.sitekey}`, body);
    // Its secret couldn't be decrypted (another computer, #136): get a new one for the same widget.
    if (!existing.secret) return { ...existing, hostname, secret: (await cf(token, "POST", `/accounts/${accountId}/challenges/widgets/${existing.sitekey}/rotate_secret`, { invalidate_immediately: true })).secret };
    return { ...existing, hostname };
  }
  const widget = await cf(token, "POST", `/accounts/${accountId}/challenges/widgets`, body);
  return { sitekey: widget.sitekey, secret: widget.secret, hostname };
}

// The form inbox (#75): one D1 database per site, bound to the Worker as DB.
// Only the app reads it, through the D1 API with the user's token; the Worker
// creates the same table on first write (runtime/worker.js SCHEMA).
const D1_SCHEMA = "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, form TEXT NOT NULL, fields TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), email_status TEXT NOT NULL DEFAULT 'pending')";
const d1Query = (token, accountId, dbId, sql, params = []) =>
  cf(token, "POST", `/accounts/${accountId}/d1/database/${dbId}/query`, { sql, params }).then((r) => r[0]?.results || []);

async function ensureD1(token, accountId, workerName, existing) {
  const name = `${workerName}-inbox`;
  let id = existing?.name === name && existing.id;
  if (!id) {
    const found = (await cf(token, "GET", `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`)).find((d) => d.name === name);
    id = found?.uuid || (await cf(token, "POST", `/accounts/${accountId}/d1/database`, { name })).uuid;
  }
  await d1Query(token, accountId, id, D1_SCHEMA);
  return { id, name };
}

// Inbox rows ({ id, form, fields: JSON [{ label, value }], created_at, email_status }) as CSV, one column per question label.
function messagesCsv(rows, formNames = {}) {
  const parsed = rows.map((r) => ({ ...r, fields: JSON.parse(r.fields) }));
  const labels = [...new Set(parsed.flatMap((r) => r.fields.map((f) => f.label)))];
  // Visitors wrote these: a leading = + - @ would run as a spreadsheet formula, so it's quoted with '.
  const cell = (v) => (v = String(v ?? "").replace(/^[=+\-@\t\r]/, "'$&"), /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [["Received (UTC)", "Form", "Email", ...labels], ...parsed.map((r) =>
    [r.created_at, formNames[r.form] || r.form, r.email_status, ...labels.map((l) => r.fields.find((f) => f.label === l)?.value)])]
    .map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

// Registers the zone apex with Resend (a subdomain site still sends from it, #135) and writes its DNS records into the
// Cloudflare zone. Resend scopes MX/SPF to "send.<domain>", so existing
// mailboxes on the domain (Google Workspace, Microsoft 365) are untouched.
async function ensureResendDomain(cfToken, site, resendKey, log) {
  const zone = { id: site.zoneId, name: site.zoneName };
  const { data } = await resend(resendKey, "GET", "/domains");
  let domain = data.find((d) => d.name === zone.name);
  domain = domain ? await resend(resendKey, "GET", `/domains/${domain.id}`) : await resend(resendKey, "POST", "/domains", { name: zone.name });

  for (const r of domain.records || []) {
    const name = r.name && r.name !== "@" ? `${r.name}.${zone.name}` : zone.name;
    const existing = await cf(cfToken, "GET", `/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(name)}`);
    if (existing.some((e) => e.content.replace(/"/g, "") === r.value)) continue;
    log(`Adding ${r.type} record for ${name}\n`);
    await cf(cfToken, "POST", `/zones/${zone.id}/dns_records`, {
      type: r.type, name, content: r.value, ttl: 1, ...(r.priority != null && { priority: r.priority }),
    });
  }
  if (domain.status !== "verified") {
    await resend(resendKey, "POST", `/domains/${domain.id}/verify`).catch(() => {});
    log(`Email domain ${zone.name} is being verified by Resend. Forms can take a few minutes to start sending.\n`);
  }
  return domain.id;
}

const createSendingKey = (resendKey, siteName, domainId) =>
  resend(resendKey, "POST", "/api-keys", {
    name: `${siteName} website`.slice(0, 50),
    permission: "sending_access",
    ...(domainId && { domain_id: domainId }),
  }).then(({ id, token }) => ({ id, token }));

// Same shape as phasen.digital's terraform/: a proxied www CNAME plus a 301
// Single Redirect rule to the apex. Never touches a zone's existing www record
// or redirect rules; it logs and skips instead. Apex sites only (#135).
const REDIRECT_PHASE = "http_request_dynamic_redirect";
const WWW_RULE_REF = "sitebuilder_www_to_apex";
const WWW_COMMENT = "PhaseN Site Builder: redirects to the apex";
async function ensureWwwRedirect(token, domain, log) {
  if (domain.label) return;
  const zone = { id: domain.zoneId, name: domain.zoneName };
  const www = `www.${zone.name}`;
  const records = await cf(token, "GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(www)}`);
  if (!records.length) {
    log(`Adding www record for ${www}\n`);
    await cf(token, "POST", `/zones/${zone.id}/dns_records`, {
      type: "CNAME", name: www, content: zone.name, ttl: 1, proxied: true, comment: WWW_COMMENT,
    });
  } else if (!records.some((r) => r.type === "CNAME" && r.content === zone.name && r.proxied)) {
    log(`${www} already has a DNS record, so the www redirect may not work. Left it alone.\n`);
  }

  // No entrypoint ruleset yet is a 404, which cf() throws on.
  const ruleset = await cf(token, "GET", `/zones/${zone.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`).catch(() => null);
  if (ruleset?.rules?.some((r) => r.ref === WWW_RULE_REF)) return;
  if (ruleset?.rules?.length) return log("This domain already has redirect rules in Cloudflare, so the www redirect wasn't added. Left them alone.\n");
  log(`Redirecting ${www} to ${zone.name}\n`);
  await cf(token, "PUT", `/zones/${zone.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, {
    name: "www to apex redirect", kind: "zone", phase: REDIRECT_PHASE,
    rules: [{
      ref: WWW_RULE_REF,
      description: `Redirect ${www} to ${zone.name}`,
      expression: `(http.host eq ${JSON.stringify(www)})`,
      action: "redirect",
      action_parameters: { from_value: {
        status_code: 301, preserve_query_string: true,
        target_url: { expression: `concat(${JSON.stringify(`https://${zone.name}`)}, http.request.uri.path)` },
      } },
    }],
  });
}

// Undoes publishing (#71), using the per-site publish.json state. Every step is
// best-effort and logged; one failing doesn't stop the rest. Returns the state
// minus what was removed (or was already gone), plus the labels that failed,
// so a retry only redoes those. The www record and rule are matched by the
// comment and ref publishing gives them, so a user's own are never touched.
async function unpublish(token, resendKey, state, log) {
  const s = { ...state }, failed = [];
  const attempt = async (label, fn) => {
    try { await fn(); log(`Removed ${label}.\n`); return true; }
    catch (e) {
      if (e.status === 404) { log(`Already gone: ${label}.\n`); return true; }
      log(`Couldn't remove ${label}: ${e.message}\n`); failed.push(label); return false;
    }
  };
  const acct = `/accounts/${s.accountId}`;
  // Deleting the Worker drops its Custom Domains too; removing them first just makes sure.
  if (s.worker && await attempt(`the website (Worker ${s.worker})`, async () => {
    for (const d of await cf(token, "GET", `${acct}/workers/domains?service=${encodeURIComponent(s.worker)}`)) await cf(token, "DELETE", `${acct}/workers/domains/${d.id}`);
    await cf(token, "DELETE", `${acct}/workers/scripts/${encodeURIComponent(s.worker)}?force=true`);
  })) { delete s.worker; delete s.url; delete s.publishedAt; }

  if (s.www && await attempt(`the www redirect for ${s.www.name}`, async () => {
    const www = `www.${s.www.name}`;
    for (const r of await cf(token, "GET", `/zones/${s.www.id}/dns_records?name=${encodeURIComponent(www)}`)) {
      if (r.comment === WWW_COMMENT) await cf(token, "DELETE", `/zones/${s.www.id}/dns_records/${r.id}`);
    }
    const ruleset = await cf(token, "GET", `/zones/${s.www.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`).catch((e) => { if (e.status !== 404) throw e; });
    const rule = ruleset?.rules?.find((r) => r.ref === WWW_RULE_REF);
    if (rule) await cf(token, "DELETE", `/zones/${s.www.id}/rulesets/${ruleset.id}/rules/${rule.id}`);
  })) delete s.www;

  if (s.d1 && await attempt("the form inbox and its messages (D1 database)", () =>
    cf(token, "DELETE", `${acct}/d1/database/${s.d1.id}`))) delete s.d1;

  if (s.turnstile && await attempt("the form spam check (Turnstile widget)", () =>
    cf(token, "DELETE", `${acct}/challenges/widgets/${s.turnstile.sitekey}`))) delete s.turnstile;

  if (s.sendingKeyId && await attempt("the form email key (Resend)", () => resend(resendKey, "DELETE", `/api-keys/${s.sendingKeyId}`))) {
    delete s.sendingKeyId; delete s.sendingKey; delete s.sendingKeyDomain;
  } else if (s.sendingKey && !s.sendingKeyId) {
    log("This site's Resend sending key was made by an older version, so it can't be found automatically. Delete it at resend.com/api-keys if you like.\n");
  }
  return { state: s, failed };
}

function wrangler(args, cwd, env, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", ARGV_FIX, WRANGLER, ...args], {
      cwd,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    const onData = (d) => { output += d; log(String(d)); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`Publishing failed (wrangler exit code ${code}). See the log above.`))));
  });
}

async function deployWorker(outDir, { token, accountId }, secrets, log) {
  const env = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
  await wrangler(["deploy"], outDir, env, log);
  // Secrets go in after the first deploy because `secret bulk` needs the
  // Worker to exist. The file lives outside the build folder so an export
  // can never pick it up.
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "sitebuilder-")), "secrets.json");
  try {
    await fs.writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    log("Uploading form secrets…\n");
    await wrangler(["secret", "bulk", file], outDir, env, () => {}); // don't echo secret names/values into the log
  } finally {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }
}

module.exports = { checkCloudflareToken, listZones, checkResendKey, siteDomain, domainHostname, labelError, hostnameWarnings, workersDevHostname, ensureTurnstile, ensureResendDomain, createSendingKey, ensureWwwRedirect, ensureD1, d1Query, messagesCsv, deployWorker, unpublish };
