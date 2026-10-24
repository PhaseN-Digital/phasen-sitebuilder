// App settings and per-site overrides (#134). Everything a site operation
// needs (build, publish, unpublish, inbox, import) comes from resolve() or
// publishedWith(), never from settings.json directly. Secrets stay sealed
// (safeStorage, base64) here; main.js unseals them.
//
// Storage lives behind store() so #136 can move it (documents folder,
// portable secrets) without touching callers:
//   userData/settings.json          app settings, { defaults, cloudflare, resendKey, ... }
//   sites/<id>/accounts.json        the site's own accounts, { cloudflare?, resendKey? }
//   site.json `overrides`           the site's non-secret overrides
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Overridable values. A key present in site.overrides (even "") overrides the
// app default; reset deletes it. build() still reads them from the site
// object, so resolve() hands it a copy with the resolved values filled in.
const FIELDS = ["email", "owner", "retention", "inboxDays", "analyticsId"];

const readJson = (file, fallback) => fs.readFile(file, "utf8").then(JSON.parse, () => fallback);
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));

// Settings from before #134 kept the form email at the top level.
function migrateSettings(s) {
  s.defaults ||= {};
  if ("email" in s) {
    s.defaults.email ??= s.email;
    delete s.email;
  }
  return s;
}

// Sites from before #134 kept these on the site itself, where blank meant
// "use the built-in wording", which is what an absent override means now.
function migrateSite(site) {
  if (!site || site.overrides) return site;
  const legacy = { owner: site.privacy?.owner, retention: site.privacy?.retention, inboxDays: site.inboxDays, analyticsId: site.analyticsId };
  site.overrides = Object.fromEntries(Object.entries(legacy).filter(([, v]) => v != null && String(v).trim() !== ""));
  delete site.inboxDays;
  delete site.analyticsId;
  if (site.privacy) { delete site.privacy.owner; delete site.privacy.retention; }
  return site;
}

const store = (root) => ({
  load: () => readJson(path.join(root, "settings.json"), {}).then(migrateSettings),
  save: (s) => writeJson(path.join(root, "settings.json"), s),
  loadSite: (siteDir) => readJson(path.join(siteDir, "accounts.json"), {}),
  saveSite: (siteDir, accounts) => writeJson(path.join(siteDir, "accounts.json"), accounts),
});

// The settings that apply to one site: its overrides, else the app's.
function resolve(app, site, accounts = {}) {
  const overrides = site.overrides || {};
  const values = Object.fromEntries(FIELDS.map((k) => [k, k in overrides ? overrides[k] : app.defaults?.[k]]));
  return {
    ...values,
    cloudflare: accounts.cloudflare || app.cloudflare || null,
    resendKey: accounts.resendKey || app.resendKey || "",
    site: { ...site, analyticsId: values.analyticsId, inboxDays: values.inboxDays, privacy: { ...site.privacy, owner: values.owner, retention: values.retention } },
  };
}

// Recorded in publish.json so unpublish/inbox can tell which Resend key made the site's sending key.
const keyHash = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

// The accounts the site was published with (publish.json), so unpublish and
// the inbox reach them even after the site's or the app's accounts changed.
// Sites published before this was recorded fall back to the current ones.
function publishedWith(app, accounts, state, unseal) {
  const tokens = [accounts.cloudflare, app.cloudflare].filter(Boolean);
  const keys = [accounts.resendKey, app.resendKey].filter(Boolean);
  const cf = state.accountId ? tokens.find((c) => c.accountId === state.accountId || c.accounts?.some((a) => a.id === state.accountId)) : tokens[0];
  return {
    cloudflare: cf ? { token: cf.token, accountId: state.accountId || cf.accountId } : null,
    resendKey: (state.resendKeyHash && keys.find((k) => keyHash(unseal(k)) === state.resendKeyHash)) || keys[0] || "",
  };
}

module.exports = { FIELDS, store, resolve, publishedWith, keyHash, migrateSite, migrateSettings };
