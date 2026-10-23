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
  if (!json.success) throw new Error(`Cloudflare: ${json.errors?.map((e) => e.message).join(", ") || `HTTP ${res.status}`}`);
  return json.result;
}

async function resend(key, method, route, body) {
  const res = await fetch(`https://api.resend.com${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend: ${json.message || `HTTP ${res.status}`}`);
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
  return { accounts: accounts.map(({ id, name }) => ({ id, name })), warnings };
}

const listZones = (token, accountId) =>
  cf(token, "GET", `/zones?account.id=${accountId}&per_page=50&status=active`).then((zones) => zones.map(({ id, name }) => ({ id, name })));

const checkResendKey = (key) => resend(key, "GET", "/domains");

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
    return { ...existing, hostname };
  }
  const widget = await cf(token, "POST", `/accounts/${accountId}/challenges/widgets`, body);
  return { sitekey: widget.sitekey, secret: widget.secret, hostname };
}

// Registers the domain with Resend and writes its DNS records into the
// Cloudflare zone. Resend scopes MX/SPF to "send.<domain>", so existing
// mailboxes on the domain (Google Workspace, Microsoft 365) are untouched.
async function ensureResendDomain(cfToken, zone, resendKey, log) {
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
  }).then((k) => k.token);

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

module.exports = { checkCloudflareToken, listZones, checkResendKey, workersDevHostname, ensureTurnstile, ensureResendDomain, createSendingKey, deployWorker };
