// Help > Copy diagnostic report (#86): plain text a user can paste into a
// support email. Built from an allowlist of fields, so nothing personal or
// secret is in it unless it's added here on purpose. Free text (log lines,
// error messages) is scrubbed: every secret value found in the inputs, the
// importer's name/email, email addresses, long token-like strings and the
// home folder are replaced.
const { SECRET_KEYS } = require("./secrets");

// Every string under a secret key, anywhere in the inputs, plus declaredBy.
function sensitive(values) {
  const found = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k === "declaredBy" && v) [v.name, v.email].forEach((s) => typeof s === "string" && s.trim() && found.add(s.trim()));
      else if (SECRET_KEYS.has(k) && typeof v === "string" && v) found.add(v);
      else walk(v);
    }
  };
  walk(values);
  return [...found].sort((a, b) => b.length - a.length);
}

const scrubber = (secretValues, home) => (text) => {
  let s = String(text ?? "");
  for (const v of secretValues) s = s.split(v).join("[redacted]");
  if (home) s = s.split(home).join("~");
  return s
    .replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\bre_\w+/g, "[redacted]")
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, "[redacted]"); // tokens, keys; site ids (36) and paths survive
};

// app: { version, electron, chrome, node, platform, arch, osRelease, packaged, locale, dataDir }
// settings: the app settings (lib/settings.js store().load()), with secrets in them
// sites: [{ site, accounts, state }] from settingsFor()
// log: recent publish/import log lines; errors: [{ at, channel, message }]
function report({ app = {}, settings = {}, sites = [], log = [], errors = [], home = "" }) {
  const clean = scrubber(sensitive({ settings, sites }), home);
  const yes = (b) => (b ? "yes" : "no");
  const lines = [
    "PhaseN Site Builder diagnostic report",
    `Created: ${new Date().toISOString()}`,
    "",
    `App version: ${clean(app.version)}${app.packaged ? "" : " (development)"}`,
    `Electron ${clean(app.electron)}, Chrome ${clean(app.chrome)}, Node ${clean(app.node)}`,
    `OS: ${clean(app.platform)} ${clean(app.osRelease)} (${clean(app.arch)}), locale ${clean(app.locale)}`,
    `Data folder: ${clean(app.dataDir)}`,
    "",
    "Settings:",
    `  Cloudflare connected: ${yes(settings.cloudflare?.token)}${settings.cloudflare?.accounts ? ` (${settings.cloudflare.accounts.length} accounts)` : ""}`,
    `  Resend connected: ${yes(settings.resendKey)}`,
    `  GitHub connected: ${yes(settings.github?.token)}${settings.github?.expired ? " (expired)" : ""}`,
    `  Default form email set: ${yes(settings.defaults?.email)}`,
    `  Automatic update check: ${yes(settings.autoUpdate !== false)}`,
    `  Portable secrets: ${yes(app.portable)}${app.secretsProblem ? `, problem: ${clean(app.secretsProblem)}` : ""}`,
    "",
    `Sites (${sites.length}):`,
  ];
  for (const { site = {}, accounts = {}, state = {} } of sites) {
    const p = site.importProvenance;
    lines.push(`  ${clean(site.id)}: theme ${clean(site.theme || "?")}${site.themeSource ? " (source theme)" : ""}, ${site.pages?.length || 0} pages, ${site.forms?.length || 0} forms`
      + `, ${(site.pages || []).filter((pg) => pg.mirror).length} copied pages`);
    lines.push(`    imported: ${p ? `yes, verification ${clean(p.verification?.status || "unverified")}, app ${clean(p.appVersion || "?")}` : "no"}`
      + `; custom domain: ${yes(site.domain)}; own accounts: ${yes(accounts.cloudflare?.token || accounts.resendKey)}`
      + `; published: ${state.publishedAt ? clean(state.publishedAt) : "no"}`);
  }
  lines.push("", `Recent errors (${errors.length}):`, ...errors.map((e) => `  ${clean(e.at)} ${clean(e.channel)}: ${clean(e.message)}`));
  lines.push("", "Recent publish/import log:", ...log.map((l) => `  ${clean(l).replace(/\n+$/, "").replace(/\n/g, "\n  ")}`));
  return lines.join("\n") + "\n";
}

// Keeps the newest `max` entries.
const remember = (list, entry, max) => { list.push(entry); if (list.length > max) list.splice(0, list.length - max); };

module.exports = { report, remember, sensitive };
