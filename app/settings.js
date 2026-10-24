// The app-wide Settings page (#134), opened from "Settings" in the sidebar:
// accounts, defaults for every website, theme sources, updates, data and
// about. Websites can override the accounts and defaults (app.js overridable
// and siteAccount; main.js settingsFor resolves them). Uses app.js's helpers.

async function openSettings() {
  if (site) { // keep an edit made just before leaving the editor
    clearTimeout(saveTimer);
    await call("sites:save", site).catch(() => {});
  }
  site = null;
  loadSites();
  settings = await call("settings:get");
  $("#main").replaceChildren(h("div", { className: "import-wrap" }, h("div", { className: "import settings-page", id: "settings-page" })));
  renderSettings();
}
$("#open-settings").addEventListener("click", openSettings);

const LICENCES = [
  ["Electron", "MIT", "https://github.com/electron/electron/blob/main/LICENSE"],
  ["Quill", "BSD-3-Clause", "https://github.com/slab/quill/blob/main/LICENSE"],
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
    h("p", { className: "hint" }, "These apply to all your websites. A website can use its own accounts (Publish tab) or override a default where that setting appears."),

    h("h2", { className: "section-title" }, "Accounts"),
    step("Cloudflare (hosting)", Boolean(settings.cloudflare), cloudflareAccount()),
    step("Resend (sends your form emails)", settings.resend, resendAccount()),
    step("GitHub", false, soon("Sign in with GitHub (coming)"), h("p", { className: "hint" }, "For private theme sources. Until then, add an access token with the repository below.")),

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
    h("p", { className: "hint" }, "Your websites and settings are stored in ", h("code", {}, settings.dataDir), "."),
    h("div", { className: "inline", style: "flex-wrap:wrap" },
      h("button", { onclick: () => call("settings:open-data") }, "Open data folder"),
      soon("Backup/restore (coming)"), soon("Diagnostics (coming)"), soon("Sites folder (coming, #136)"), soon("Portable secrets (coming, #136)")),

    h("h2", { className: "section-title" }, "About"),
    h("p", {}, `PhaseN Site Builder ${settings.version}, by `, link("PhaseN Digital", "https://phasen.digital"), "."),
    h("p", { className: "hint" }, "Built with open-source software, including:"),
    h("ul", { className: "licences" }, LICENCES.map(([name, licence, url]) => h("li", {}, `${name} (${licence}) `, link("licence", url)))),
  );
  page.parentElement.scrollTop = scroll;
}
