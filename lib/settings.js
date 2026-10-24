// App settings and per-site overrides (#134). Everything a site operation
// needs (build, publish, unpublish, inbox, import) comes from resolve() or
// publishedWith(), never from settings.json directly.
//
// Storage lives behind store() (#136): values come back with their secrets in
// them, but on disk every secret is split out into an encrypted secrets.enc
// (lib/secrets.js), so these files can sit in the user's sites folder and the
// site's git repo:
//   <sites folder>/.phasen/settings.json  app settings, { defaults, cloudflare, resendKey, ... }
//   <site folder>/accounts.json           the site's own accounts, { cloudflare?, resendKey? }
//   <site folder>/publish.json            deploy state (Turnstile, sending key, D1, url)
//   site.json `overrides`                 the site's non-secret overrides
// A Cloudflare account whose token couldn't be decrypted counts as not connected.
const crypto = require("node:crypto");
const path = require("node:path");
const secrets = require("./secrets");

// Overridable values. A key present in site.overrides (even "") overrides the
// app default; reset deletes it. build() still reads them from the site
// object, so resolve() hands it a copy with the resolved values filled in.
const FIELDS = ["email", "owner", "retention", "inboxDays", "analyticsId"];

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

// Changes go through update()/updateSite() (lib/json-store.js), never a
// load-then-save, so two overlapping changes can't drop one another (#147).
// keyring: see lib/secrets.js.
const store = (root, keyring) => {
  const appFile = path.join(root, "settings.json"), appSecrets = path.join(root, "secrets.enc");
  const siteSecrets = (siteDir) => path.join(siteDir, ".secrets", "secrets.enc");
  const load = (siteDir, name) => secrets.readJoined(path.join(siteDir, name), siteSecrets(siteDir), keyring, {});
  const update = (siteDir, name, change) => secrets.updateJoined(path.join(siteDir, name), siteSecrets(siteDir), keyring, change);
  return {
    secretFiles: (siteDirs) => [appSecrets, ...siteDirs.map(siteSecrets)],
    load: () => secrets.readJoined(appFile, appSecrets, keyring, {}).then(migrateSettings),
    update: (change) => secrets.updateJoined(appFile, appSecrets, keyring, change, {}, migrateSettings),
    loadSite: (siteDir) => load(siteDir, "accounts.json"),
    updateSite: (siteDir, change) => update(siteDir, "accounts.json", change),
    loadState: (siteDir) => load(siteDir, "publish.json"),
    updateState: (siteDir, change) => update(siteDir, "publish.json", change),
  };
};
const connected = (c) => (c?.token ? c : null);

// The settings that apply to one site: its overrides, else the app's.
function resolve(app, site, accounts = {}) {
  const overrides = site.overrides || {};
  const values = Object.fromEntries(FIELDS.map((k) => [k, k in overrides ? overrides[k] : app.defaults?.[k]]));
  return {
    ...values,
    cloudflare: connected(accounts.cloudflare) || connected(app.cloudflare),
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
  const tokens = [accounts.cloudflare, app.cloudflare].filter(connected);
  const keys = [accounts.resendKey, app.resendKey].filter(Boolean);
  const cf = state.accountId ? tokens.find((c) => c.accountId === state.accountId || c.accounts?.some((a) => a.id === state.accountId)) : tokens[0];
  return {
    cloudflare: cf ? { token: cf.token, accountId: state.accountId || cf.accountId } : null,
    resendKey: (state.resendKeyHash && keys.find((k) => keyHash(unseal(k)) === state.resendKeyHash)) || keys[0] || "",
  };
}

module.exports = { FIELDS, store, connected, resolve, publishedWith, keyHash, migrateSite, migrateSettings };
