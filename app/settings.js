// The app-wide Settings page (#134), opened from "Settings" in the top bar:
// accounts, defaults for every website, theme sources, updates, data and
// about. Websites can override the accounts and defaults (app.js overridable
// and siteAccount; main.js settingsFor resolves them). Uses app.js's helpers.

async function openSettings() {
  await leaveSite($("#open-settings"));
  settings = await call("settings:get");
  $("#main").replaceChildren(h("div", { className: "import-wrap" }, h("div", { className: "import settings-page", id: "settings-page" })));
  renderSettings();
  // Does GitHub still accept the sign-in (#253)? Re-render only if that changed.
  if (settings.github && !settings.github.expired) call("github:check").then((s) => {
    if (s.github?.expired && $("#settings-page")) { settings = s; renderSettings(); }
  }, () => {});
}
$("#open-settings").addEventListener("click", openSettings);

// GitHub sign-in (#60): device flow. main.js shows no browser itself; the
// user copies the code and opens github.com from here while main polls.
let ghFlow = null, ghError = "";
function githubAccount() {
  const g = settings.github;
  if (g?.expired && !ghFlow) return [
    h("p", { className: "error", role: "alert" }, `You've been signed out of GitHub (${g.login}): the sign-in expired or was revoked on GitHub. Sign in again to publish themes and read private theme sources.`),
    h("div", { className: "inline" },
      h("button", { className: "primary", onclick: () => githubSignIn(g.privateRepos) }, "Sign in to GitHub again"),
      h("button", { onclick: () => accountCall(null, "settings:disconnect", "github") }, "Sign out")),
    h("p", { className: "error" }, ghError),
  ];
  if (g && !ghFlow) return [
    h("p", {}, `Signed in as ${g.login}${g.privateRepos ? ", including private repositories" : ""}.`),
    h("p", { className: "hint" }, "Used to publish themes from Themes… and to read private theme sources. To revoke the app's access completely, also remove it in GitHub's ", link("Applications settings", "https://github.com/settings/applications"), "."),
    h("button", { onclick: () => accountCall(null, "settings:disconnect", "github") }, "Sign out"),
  ];
  if (!settings.githubConfigured) return h("p", { className: "hint" }, "GitHub sign-in isn't configured in this copy of the app.");
  if (ghFlow) return [
    h("p", {}, "Enter this code on GitHub:"),
    h("p", { className: "device-code" }, ghFlow.userCode),
    h("div", { className: "inline" },
      h("button", { className: "primary", onclick: () => { navigator.clipboard.writeText(ghFlow.userCode).catch(() => {}); call("open", ghFlow.verificationUri); } }, "Copy code and open GitHub"),
      h("button", { onclick: () => { ghFlow = null; call("github:cancel"); renderSettings(); } }, "Cancel")),
    h("p", { className: "hint", role: "status" }, "Waiting for you to approve the sign-in on GitHub…"),
  ];
  const priv = h("input", { type: "checkbox" });
  return [
    h("p", { className: "hint" }, "Sign in to publish your themes to GitHub, and to use private theme sources without an access token."),
    h("label", { className: "field", style: "display:flex;gap:8px;align-items:center" }, priv, "Also allow private repositories"),
    h("button", { className: "primary", onclick: () => githubSignIn(priv.checked) }, "Sign in with GitHub"),
    h("p", { className: "error" }, ghError),
  ];
}
async function githubSignIn(privateRepos) {
  ghError = "";
  let flow;
  try {
    flow = ghFlow = await call("github:start", privateRepos);
    renderSettings();
    settings = await call("github:finish");
  } catch (e) {
    if (!flow || ghFlow === flow) ghError = errorText(e); // not when the user cancelled
  }
  if (!flow || ghFlow === flow) ghFlow = null;
  if ($("#settings-page")) renderSettings();
}

const LICENCES = [
  ["Electron", "MIT", "https://github.com/electron/electron/blob/main/LICENSE"],
  ["Quill", "BSD-3-Clause", "https://github.com/slab/quill/blob/main/LICENSE"],
  ["isomorphic-git", "MIT", "https://github.com/isomorphic-git/isomorphic-git/blob/main/LICENSE.md"],
  ["Wrangler", "MIT or Apache-2.0", "https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler"],
];

function renderSettings() {
  const page = $("#settings-page");
  const scroll = page.parentElement.scrollTop;
  const d = settings.defaults || {};
  const def = (label, key, hint, props = {}, tag = "input") => labelled(label, h(tag, {
    value: d[key] ?? "", placeholder: key === "inboxDays" ? String(FALLBACK.inboxDays) : "",
    onchange: async (e) => { settings = await call("settings:default", key, e.target.value); e.target.value = settings.defaults[key]; },
    ...props,
  }), hint);
  const updateStatus = h("p", { className: "hint", role: "status" });
  const checkNow = h("button", { onclick: async () => {
    checkNow.disabled = true; updateStatus.textContent = "Checking…";
    try {
      const u = await call("update:check", true);
      updateStatus.replaceChildren(...(u.newer ? [`Version ${u.version} is available. `, link("Download", u.url)] : ["You have the latest version."]));
      showUpdate(u);
    } catch (e) { updateStatus.textContent = errorText(e); }
    checkNow.disabled = false;
  } }, "Check now");
  const soon = (label) => h("button", { disabled: true }, label);

  page.replaceChildren(
    h("h1", {}, "Settings"),
    h("p", { className: "hint" }, "These apply to all your websites. A website can use its own accounts (its Site settings) or override a default where that setting appears."),

    h("h2", { className: "section-title" }, "Accounts"),
    step("Cloudflare (hosting)", Boolean(settings.cloudflare), cloudflareAccount()),
    step("Resend (sends your form emails)", settings.resend, resendAccount()),
    step("GitHub (publishing themes)", Boolean(settings.github && !settings.github.expired), githubAccount()),

    h("h2", { className: "section-title" }, "Defaults for websites"),
    h("p", { className: "hint" }, "Every website uses these unless you override them for that website. Changing one here changes it for every website that hasn't."),
    def("Send form messages to", "email", "Until a website uses its own domain, this must be the same email you signed up to Resend with.", { type: "email", placeholder: "you@example.com" }),
    def("Business or legal name", "owner", "Shown on privacy pages. Leave blank to use each website's name."),
    def("Delete form messages after (days)", "inboxDays", "", { type: "number", min: 1 }),
    def("Google Analytics measurement ID", "analyticsId", "Leave blank for no analytics.", { placeholder: "G-XXXXXXXXXX" }),
    def("How long you keep messages (privacy page wording)", "retention", "Leave blank for the standard wording.", {}, "textarea"),

    h("h2", { className: "section-title" }, "Themes"),
    themeSourcesSettings(),

    h("h2", { className: "section-title" }, "Updates"),
    h("p", {}, `You have version ${settings.version}. `, link("Release notes", settings.releasesUrl)),
    h("label", { className: "field", style: "display:flex;gap:8px;align-items:center" },
      h("input", { type: "checkbox", checked: settings.autoUpdate, onchange: async (e) => {
        settings = await call("settings:auto-update", e.target.checked);
        if (settings.autoUpdate) checkForUpdate();
      } }), "Check for updates automatically"),
    h("div", { className: "inline" }, checkNow),
    updateStatus,

    h("h2", { className: "section-title" }, "Data & support"),
    dataSettings(),
    h("p", { className: "hint" }, "Previews, caches and the app's own files are in ", h("code", {}, settings.dataDir), "."),
    h("div", { className: "inline", style: "flex-wrap:wrap" },
      h("button", { onclick: () => call("settings:open-data") }, "Open data folder"),
      soon("Backup/restore (coming)"), soon("Diagnostics (coming)")),

    h("h2", { className: "section-title" }, "About"),
    h("p", {}, `PhaseN Site Builder ${settings.version}, by `, link("PhaseN Digital", "https://phasen.digital"), ". ", link("Documentation", DOCS_URL)),
    h("p", { className: "hint" }, "Built with open-source software, including:"),
    h("ul", { className: "licences" }, LICENCES.map(([name, licence, url]) => h("li", {}, `${name} (${licence}) `, link("licence", url)))),
  );
  page.parentElement.scrollTop = scroll;
}

// Settings › Data (#136): the sites folder (one folder and history per website)
// and how saved passwords and keys are protected (main.js secrets:*).
function dataSettings() {
  const status = h("p", { className: "hint", role: "status" });
  const act = (fn) => async () => {
    status.className = "hint"; status.textContent = "Working…";
    try { await fn(); } catch (e) { status.className = "error"; status.textContent = errorText(e); }
  };
  const done = async (s, message) => {
    settings = s;
    if (!s.secretsProblem && !s.portable?.locked) $("#notice-banner")?.remove();
    renderSettings();
    await loadSites();
    $("#data-status").textContent = message || "";
  };
  const pass = (placeholder) => h("input", { type: "password", placeholder, autocomplete: "new-password" });
  const p1 = pass("Passphrase (at least 10 characters)"), p2 = pass("Type it again"), unlockIn = pass("Your passphrase");
  const portable = settings.portable || {};
  status.id = "data-status";
  return h("div", { className: "data-settings" },
    h("h3", {}, "Sites folder"),
    h("p", { className: "hint" }, "Each website is a folder in ", h("code", {}, settings.sitesFolder),
      ", with a history of its changes. Back it up or sync it like any of your documents. Passwords and keys are saved there too, encrypted, and never in a website's history."),
    h("div", { className: "inline", style: "flex-wrap:wrap" },
      h("button", { onclick: () => call("data:open-sites") }, "Open sites folder"),
      h("button", { onclick: act(async () => {
        const n = await call("data:find-sites");
        await done(settings, `Found ${n} website${n === 1 ? "" : "s"}.`);
      }) }, "Find sites"),
      h("button", { onclick: act(async () => {
        const r = await call("data:choose-folder");
        if (!r) return (status.textContent = "");
        let move = false;
        if (r.sites) {
          if (!confirm(`${r.path} already has ${r.sites} website${r.sites === 1 ? "" : "s"}. Use ${r.sites === 1 ? "it" : "them"}? Your current websites stay where they are, in ${settings.sitesFolder}.`)) return (status.textContent = "");
        } else if (r.current) {
          if (!confirm(`Move your ${r.current} website${r.current === 1 ? "" : "s"} and settings to ${r.path}?`)) return (status.textContent = "");
          move = true;
        }
        await flushSave();
        await done(await call("data:set-folder", r.path, move), `Now using ${r.path}.`);
      }) }, "Change folder…")),

    h("h3", {}, "Saved passwords and keys"),
    settings.secretsProblem && h("div", { className: "warn" }, settings.secretsProblem),
    portable.locked
      ? [h("p", {}, "Portable secrets are on: enter your passphrase to unlock your saved passwords and keys on this computer."),
        h("div", { className: "inline" }, unlockIn, h("button", { className: "primary", onclick: act(async () => done(await call("secrets:unlock", unlockIn.value), "Unlocked.")) }, "Unlock")),
        h("p", { className: "hint" }, "Forgotten it? ", h("a", { onclick: act(async () => {
          if (!confirm("Forget your saved passwords and keys? You'll connect your accounts again, and publishing re-creates each website's keys. The old files are kept aside, not deleted.")) return (status.textContent = "");
          await done(await call("secrets:forget"), "Start again by connecting your accounts.");
        }) }, "Forget saved secrets"), ".")]
      : portable.on
        ? [h("p", {}, "Portable secrets are on: on another computer, your passphrase unlocks them. This computer remembers it."),
          h("button", { onclick: act(async () => done(await call("secrets:portable-off"), "Portable secrets are off.")) }, "Turn off portable secrets")]
        : [h("p", { className: "hint" }, "They're protected by this computer's own keychain, so they only open here (also after reinstalling the app). Portable secrets protect them with a passphrase instead, so you can open them on a new computer. The passphrase is never saved, and can't be recovered."),
          h("div", { className: "inline", style: "flex-wrap:wrap" }, p1, p2, h("button", { onclick: act(async () => {
            if (p1.value !== p2.value) throw new Error("The passphrases don't match.");
            await done(await call("secrets:portable-on", p1.value), "Portable secrets are on.");
          }) }, "Turn on portable secrets"))],
    status);
}
