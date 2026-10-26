// The whole editor UI. State lives in `site`; text inputs mutate it in place
// (so typing never loses focus), structural changes call renderTab().
const { call, onPublishLog, onImportLog } = window.cms;

let THEMES, site, publishedUrl, publishedAt, canUnpublish, paths = {}, settings, siteAccounts = {};
let tab = "dashboard", pageId = null, formId = null, previewMobile = false, publishing = false, publishLog = "";
const $ = (sel) => document.querySelector(sel);
const rid = () => Math.random().toString(16).slice(2, 10);
// Per-computer UI memory (#185: menu state, recent sites, last section, seen messages). Never site data.
const recall = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const errorText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

// ---------- form field helpers ----------
const labelled = (label, control, hint) => h("label", { className: "field" }, h("span", {}, label), control, hint && h("p", { className: "hint" }, hint));
const text = (label, obj, key, hint, props = {}) =>
  labelled(label, h("input", { value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; save(); }, ...props }), hint);
const area = (label, obj, key, hint) =>
  labelled(label, h("textarea", { value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; save(); } }), hint);
const select = (label, obj, key, options, onchange) =>
  labelled(label, h("select", { onchange: (e) => { obj[key] = e.target.value; save(); onchange?.(); } },
    options.map(([value, name]) => h("option", { value, selected: obj[key] === value }, name))));
const check = (label, obj, key) =>
  h("label", { className: "field", style: "display:flex;gap:8px;align-items:center" },
    h("input", { type: "checkbox", checked: Boolean(obj[key]), onchange: (e) => { obj[key] = e.target.checked; save(); } }), label);
// Per-site overrides of the app's defaults (#134, lib/settings.js). Blank
// defaults fall back to these, which is what build() does.
const FALLBACK = { email: "not set", owner: "the website name", retention: "the standard wording", inboxDays: 90, analyticsId: "none" };
const effective = (key) => (key in (site.overrides ||= {}) ? site.overrides[key] : settings.defaults?.[key]);
const shown = (v, key) => (v == null || v === "" ? FALLBACK[key] : String(v).length > 60 ? `${String(v).slice(0, 57)}…` : v);
// "Using app default (…)" with "Override for this site", or the site's own value with "Reset to default".
// A div, not a label: a label would pass clicks on its text to the button.
function overridable(label, key, hint, props = {}, tag = "input") {
  const o = (site.overrides ||= {});
  const edit = (change) => { change(); save(); renderTab(); };
  return h("div", { className: "field overridable", "data-key": key }, h("span", {}, label),
    key in o
      ? h("div", { className: "inline" },
          h(tag, { value: o[key], style: "flex:1", oninput: (e) => { o[key] = e.target.value; save(); }, ...props }),
          h("button", { onclick: () => edit(() => delete o[key]) }, "Reset to default"))
      : h("div", { className: "inline", style: "align-items:center" },
          h("span", { className: "default-value", style: "flex:1" }, `Using app default (${shown(settings.defaults?.[key], key)})`),
          h("button", { onclick: () => edit(() => { o[key] = settings.defaults?.[key] ?? (key === "inboxDays" ? FALLBACK.inboxDays : ""); }) }, "Override for this site")),
    hint && h("p", { className: "hint" }, hint));
}
const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; save(); renderTab(); };
const thumbUrl = (src) => `preview://${site.id}/${src}`;

// Resize in the browser with canvas: no native image library to package.
async function saveImage(siteId, blob, max) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const webp = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  return call("images:save", siteId, new Uint8Array(await webp.arrayBuffer()));
}

async function processImage(file, max) {
  try {
    return await saveImage(site.id, file, max);
  } catch {
    alert(`Sorry, "${file.name}" couldn't be used. Try a JPG or PNG photo.`);
    return null;
  }
}

function pickFiles(multiple, onFiles) {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple });
  input.onchange = () => onFiles([...input.files]);
  input.click();
}

function imageField(label, obj, key, max = 1920, hint) {
  const wrap = h("div", { className: "field" });
  const render = () => {
    const image = obj[key];
    const upload = h("button", { type: "button", onclick: () => pickFiles(false, async ([file]) => {
      const src = file && (await processImage(file, max));
      if (!src) return;
      obj[key] = { src, alt: image?.alt || "" };
      save(); render();
    }) }, image ? "Change…" : "Upload image…");
    wrap.replaceChildren(
      h("span", {}, label),
      h("div", { className: "image-field" },
        image ? h("img", { className: "thumb", src: thumbUrl(image.src), alt: "" }) : h("div", { className: "thumb" }),
        h("div", { className: "stack" },
          image && h("input", { value: image.alt, placeholder: "Describe the image (for screen readers)", oninput: (e) => { image.alt = e.target.value; save(); } }),
          h("div", { className: "inline" }, upload, image && h("button", { type: "button", className: "danger", onclick: () => { obj[key] = null; save(); render(); } }, "Remove")))),
      h("p", { className: "hint", hidden: !hint }, hint || "")
    );
  };
  render();
  return wrap;
}

// ---------- saving + preview ----------
let saveTimer = null, saving = Promise.resolve();
function save() {
  $(".save-state").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

// Writes any edit still waiting for save()'s debounce, and waits for copied-page
// edits (copied.js) to finish. Everything that leaves the editor (switching site,
// Settings, Themes, Import, delete, publish, closing the window) awaits this
// first, or the last 400ms of typing would be lost (#143). Never throws.
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const s = site;
    saving = saving.then(async () => {
      try {
        const saved = await call("sites:save", s);
        if (site !== s) return; // the editor has moved on; the write is all that mattered
        paths = saved;
        $(".save-state").textContent = "All changes saved";
        refreshPreview();
        const listed = SITES.find((x) => x.id === s.id);
        if (listed) { listed.name = s.name; renderSwitcher(); }
      } catch (e) {
        if (site === s) $(".save-state").textContent = `Not saved: ${errorText(e)}`;
      }
    });
  }
  return Promise.all([saving, copyEdits]).then(() => {});
}

function refreshPreview() {
  const frame = $("#preview");
  const editingCopy = tab === "pages" && site.pages.find((p) => p.id === pageId)?.mirror;
  if (frame) frame.src = `preview://${site.id}${paths[pageId] || "/"}?t=${Date.now()}${editingCopy ? "&sb-edit" : ""}`;
}

// ---------- sites and the top bar's site switcher (#185) ----------
let SITES = [];
async function loadSites() {
  SITES = await call("sites:list");
  renderSwitcher();
  renderSideMenu();
}

// Up/Down/Home/End move focus between a menu's items.
function arrowKeys(container, selector) {
  container.addEventListener("keydown", (e) => {
    const items = [...container.querySelectorAll(selector)].filter((b) => !b.disabled);
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (i < 0 || to === undefined) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  });
}

const switcherPanel = $("#switcher-panel"), siteSearch = $("#site-search");
function renderSwitcher() {
  $("#switcher-label").textContent = site ? site.name || "Untitled" : "Choose a website";
  const q = siteSearch.value.trim().toLowerCase();
  const item = (s) => h("button", { className: s.id === site?.id ? "active" : "", ariaCurrent: s.id === site?.id ? "page" : null, "data-id": s.id, onclick: () => openSite(s.id) }, s.name || "Untitled");
  const recent = recall("sb-recent", []).map((id) => SITES.find((s) => s.id === id)).filter(Boolean).slice(0, 5);
  $("#recent-sites").replaceChildren(...(!q && SITES.length > 6 && recent.length ? [h("h2", {}, "Recent"), ...recent.map(item)] : []));
  const found = SITES.filter((s) => (s.name || "Untitled").toLowerCase().includes(q));
  $("#site-list").replaceChildren(...(found.length ? found.map(item) : [h("p", { className: "hint" }, SITES.length ? "No websites match." : "No websites yet.")]));
}
function toggleSwitcher(open = switcherPanel.hidden) {
  if (open === !switcherPanel.hidden) return;
  switcherPanel.hidden = !open;
  $("#site-switcher").ariaExpanded = String(open);
  if (!open) return;
  siteSearch.value = "";
  renderSwitcher();
  siteSearch.focus();
}
$("#site-switcher").addEventListener("click", () => toggleSwitcher());
switcherPanel.addEventListener("keydown", (e) => { if (e.key === "Escape") { toggleSwitcher(false); $("#site-switcher").focus(); } });
document.addEventListener("click", (e) => { if (!e.target.closest(".switcher")) toggleSwitcher(false); });
$(".switcher").addEventListener("focusout", (e) => { if (e.relatedTarget && !e.relatedTarget.closest(".switcher")) toggleSwitcher(false); });
siteSearch.addEventListener("input", renderSwitcher);
siteSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#site-list button")?.click();
  if (e.key === "ArrowDown") { e.preventDefault(); switcherPanel.querySelector("#recent-sites button, #site-list button")?.focus(); }
});
arrowKeys(switcherPanel, "#recent-sites button, #site-list button");

async function openSite(id) {
  await flushSave();
  toggleSwitcher(false);
  publishLog = "";
  overriding = {};
  ({ site, url: publishedUrl, publishedAt, canUnpublish, accounts: siteAccounts } = await call("sites:get", id));
  pageId = site.pages[0].id;
  formId = site.forms[0]?.id;
  const last = recall("sb-sections", {})[id];
  tab = SECTIONS.some((s) => s.id === last) ? last : "dashboard";
  remember("sb-recent", [id, ...recall("sb-recent", []).filter((x) => x !== id)].slice(0, 10));
  unread = null;
  if (publishedUrl) countUnread(id);
  paths = await call("sites:save", site);
  THEMES = await call("themes"); // the build registers a theme source's font
  await loadSites();
  renderEditor();
  askDeclaration(); // imported before #141 (app/wordpress.js)
}

// Leaving the current website for an app-wide screen (Settings, Themes, Import): button is its top bar entry.
async function leaveSite(button) {
  await flushSave();
  site = null;
  toggleSwitcher(false);
  for (const b of document.querySelectorAll(".app-nav button")) b.ariaCurrent = b === button ? "page" : null;
  loadSites();
}

$("#new-site").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.name.value;
  e.target.reset();
  const created = await call("sites:create", name, "clean");
  await openSite(created.id);
});

// ---------- layout: the current website's menu (#185) ----------
// WordPress-style and data-driven: a new screen is one entry here (render returns the panel's content).
const SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: "⌂", render: dashboardTab },
  { id: "pages", label: "Pages", icon: "▤", render: pagesTab },
  { id: "design", label: "Design", icon: "◐", render: designTab },
  { id: "forms", label: "Forms", icon: "☑", render: formsTab },
  { id: "inbox", label: "Inbox", icon: "✉", render: inboxTab, count: () => unread },
  { id: "seo", label: "SEO", icon: "⌕", render: seoTab },
  { id: "publish", label: "Publish", icon: "⇪", render: publishTab },
  { id: "history", label: "History", icon: "↺", render: historyTab },
  { id: "site-settings", label: "Site settings", icon: "⚙", render: siteSettingsTab },
];
let menuCollapsed = recall("sb-menu-collapsed", innerWidth < 1100), previewHidden = recall("sb-preview-hidden", false);
const menu = $("#side-menu");
arrowKeys(menu, "button");

function renderSideMenu() {
  menu.hidden = !site;
  if (!site) return;
  const focused = document.activeElement?.dataset?.section;
  menu.classList.toggle("collapsed", menuCollapsed);
  menu.replaceChildren(
    h("ul", {}, SECTIONS.map((s) => {
      const n = s.count?.();
      return h("li", {}, h("button", { "data-section": s.id, ariaCurrent: tab === s.id ? "page" : null, title: menuCollapsed ? s.label : "", onclick: () => showSection(s.id) },
        h("span", { className: "icon", ariaHidden: "true" }, s.icon), h("span", { className: "label" }, s.label),
        n > 0 && h("span", { className: "count" }, String(n), h("span", { className: "sr" }, " unread"))));
    })),
    h("button", { className: "collapse", "data-section": "collapse", ariaExpanded: String(!menuCollapsed), title: menuCollapsed ? "Expand menu" : "", onclick: () => {
      menuCollapsed = !menuCollapsed;
      remember("sb-menu-collapsed", menuCollapsed);
      renderSideMenu();
    } }, h("span", { className: "icon", ariaHidden: "true" }, menuCollapsed ? "»" : "«"), h("span", { className: "label" }, "Collapse menu")));
  if (focused) menu.querySelector(`[data-section="${focused}"]`)?.focus();
}

function showSection(id) {
  tab = id;
  selectedCopyImage = null;
  remember("sb-sections", { ...recall("sb-sections", {}), [site.id]: id });
  renderEditor();
}

function renderEditor() {
  for (const b of document.querySelectorAll(".app-nav button")) b.ariaCurrent = null;
  const section = SECTIONS.find((s) => s.id === tab);
  $("#main").replaceChildren(
    h("section", { className: `editor-panel${previewHidden ? " wide" : ""}`, ariaLabel: section.label },
      h("header", { className: "panel-head" },
        h("div", { className: "row" }, h("h1", {}, section.label), h("span", { className: "save-state" }, "All changes saved"),
          h("button", { className: "preview-toggle", "aria-controls": "preview-section", ariaExpanded: String(!previewHidden), onclick: () => {
            previewHidden = !previewHidden;
            remember("sb-preview-hidden", previewHidden);
            renderEditor();
            $(".preview-toggle").focus();
          } }, previewHidden ? "Show preview" : "Hide preview"))),
      h("div", { className: "panel-body", id: "tab" })),
    h("section", { id: "preview-section", className: `preview${previewMobile ? " mobile" : ""}`, hidden: previewHidden, ariaLabel: "Preview" },
      h("div", { className: "preview-bar" },
        h("span", {}, "Preview (forms send once published)"),
        h("button", { className: previewMobile ? "" : "primary", ariaPressed: String(!previewMobile), onclick: () => { previewMobile = false; renderEditor(); } }, "Desktop"),
        h("button", { className: previewMobile ? "primary" : "", ariaPressed: String(previewMobile), onclick: () => { previewMobile = true; renderEditor(); } }, "Mobile")),
      h("div", { className: "preview-stage" }, h("iframe", { id: "preview", title: "Website preview" })))
  );
  renderSideMenu();
  renderTab();
  refreshPreview();
}

function renderTab() {
  if (!site) return $("#settings-page") && renderSettings(); // theme sources and accounts on the Settings page
  const body = $("#tab");
  const scroll = body.scrollTop;
  const content = SECTIONS.find((s) => s.id === tab).render();
  body.replaceChildren(...content.flat(Infinity).filter((k) => k != null && k !== false));
  body.scrollTop = scroll;
}

// ---------- Dashboard (#185) ----------
// Unread = messages newer than the newest one shown in the Inbox on this computer (there's no read flag in D1).
let unread = null;
const seenMessages = () => recall("sb-inbox-seen", {});
function countUnread(id) {
  call("inbox:list", id).then((rows) => {
    if (site?.id !== id) return;
    unread = (rows || []).filter((m) => m.id > (seenMessages()[id] || 0)).length;
    renderSideMenu();
    if (tab === "dashboard" && $("#tab")) renderTab();
  }).catch(() => {}); // the Inbox itself shows the error
}

function dashboardTab() {
  const when = (d) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return [
    h("dl", { className: "dash" },
      h("dt", {}, "Live address"), h("dd", {}, publishedUrl ? link(publishedUrl, publishedUrl) : "Not published yet"),
      h("dt", {}, "Last published"), h("dd", {}, publishedAt ? when(publishedAt) : publishedUrl ? "Unknown" : "Never"),
      h("dt", {}, "Unread messages"), h("dd", {}, !publishedUrl ? "Your inbox starts once the website is published."
        : unread == null ? "Checking…" : h("button", { className: "linkish", onclick: () => showSection("inbox") }, unread ? `${unread} unread` : "None, open the Inbox"))),
    h("h3", { className: "section-title" }, "Quick actions"),
    h("div", { className: "adders" },
      [["pages", "Edit pages"], ["design", "Change the design"], ["publish", publishedUrl ? "Publish changes" : "Publish website"]].map(([id, label]) => h("button", { onclick: () => showSection(id) }, label)),
      publishedUrl && h("button", { onclick: () => call("open", publishedUrl) }, "Open the live website")),
  ];
}

// ---------- SEO (#74): search and sharing for each page ----------
function seoTab() {
  const page = site.pages.find((p) => p.id === pageId) || site.pages[0];
  return [
    h("div", { className: "chips" }, site.pages.map((p) => h("button", { className: p === page ? "active" : "", ariaPressed: String(p === page), onclick: () => { pageId = p.id; renderTab(); refreshPreview(); } }, p.title || "Untitled"))),
    seoCard(page, site.pages.indexOf(page)),
  ];
}

// ---------- Site settings (#134): everything this website can override, in one place ----------
// The same fields also sit where they're used (Design, Inbox, Publish).
function siteSettingsTab() {
  return [
    h("p", { className: "hint" }, "Settings for this website only. Anything left on the app default follows ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); openSettings(); } }, "Settings"), "."),
    h("h3", { className: "section-title" }, "Cloudflare (hosting)"), siteAccount("cloudflare"),
    h("h3", { className: "section-title" }, "Resend (form emails)"), siteAccount("resend"),
    h("h3", { className: "section-title" }, "Defaults"),
    overridable("Send form messages to", "email", "", { type: "email", placeholder: "you@example.com" }),
    overridable("Business or legal name", "owner", "Shown on the privacy page.", { placeholder: site.name }),
    overridable("How long you keep messages", "retention", "Shown on the privacy page.", {}, "textarea"),
    overridable("Delete messages after (days)", "inboxDays", "", { type: "number", min: 1 }),
    overridable("Google Analytics measurement ID (optional)", "analyticsId", "", { placeholder: "G-XXXXXXXXXX" }),
    businessDetails(),
  ];
}

// Business details (#80): shown above the footer on every page, by the Contact
// details section, and to Google as LocalBusiness data (lib/build.js businessOf).
function businessDetails() {
  const b = (site.business ||= {});
  return [
    h("h3", { className: "section-title" }, "Business details"),
    h("p", { className: "hint" }, "Shown at the bottom of every page and in Contact details sections, and given to Google so your business can show up in local searches. Leave blank anything you don't want shown."),
    area("Street address", b, "street", "One line each, e.g. unit and street."),
    h("div", { className: "grid2" }, text("Town or city", b, "town"), text("Postcode", b, "postcode")),
    text("Country", b, "country", "", { placeholder: "United Kingdom" }),
    h("div", { className: "grid2" }, text("Phone", b, "phone", "", { type: "tel" }), text("Email", b, "email", "", { type: "email", placeholder: "you@example.com" })),
    area("Opening hours", b, "hours", "One line each, e.g. Monday to Friday: 9am to 5pm"),
    area("Social media links", b, "social", "One web address each, starting https://, e.g. https://www.instagram.com/yourbusiness"),
  ];
}

// ---------- Design ----------
function designTab() {
  const { themes, fonts } = THEMES;
  return [
    site.mirror && h("div", { className: "warn" }, "Pages copied from WordPress keep their original design. These settings only apply to pages you add here."),
    text("Website name", site, "name"),
    area("Short description", site, "description", "Shown under your site's name in Google search results."),
    overridable("Google Analytics measurement ID (optional)", "analyticsId", "Looks like G-XXXXXXXXXX, from Admin › Data streams in Google Analytics. Visitors are asked to accept analytics cookies first, and your privacy page explains them." +
      (site.mirror ? " Pages copied from WordPress aren't covered." : ""), { placeholder: "G-XXXXXXXXXX" }),
    h("h3", { className: "section-title" }, "Theme"),
    h("div", { className: "themes" }, Object.entries(themes).map(([id, t]) => themeButton(t, !site.themeSource && site.theme === id, () => {
      delete site.themeSource;
      Object.assign(site, { theme: id, colors: { ...t.colors }, font: t.font });
    }))),
    sourceThemes(),
    h("p", { className: "hint", style: "margin-top:8px" }, "Picking a theme resets colours and font to that theme's defaults."),
    h("h3", { className: "section-title" }, "Colours"),
    h("div", { className: "grid2" }, [["background", "Background"], ["text", "Text"], ["primary", "Main colour"], ["accent", "Buttons"]].map(([key, label]) =>
      labelled(label, h("input", { type: "color", value: site.colors[key], oninput: (e) => { site.colors[key] = e.target.value; save(); colourHint(); } })))),
    colourHint(h("p", { className: "hint", id: "colour-hint", role: "status", style: "margin-top:8px" })),
    select("Font", site, "font", Object.entries(fonts).map(([id, f]) => [id, f.label])),
    imageField("Logo", site, "logo", 600, "Shown at the top of every page instead of your website name. A wide image with a transparent background works best."),
    h("p", { className: "hint" }, "More themes can come from GitHub repositories: add them under Theme sources in ", h("a", { onclick: openSettings }, "Settings"), "."),
  ];
}

// Same WCAG maths as lib/build.js contrastRatio (the renderer can't require it).
function contrast(a, b) {
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A gentle, non-blocking note when text or links are hard to read on the background (WCAG AA is 4.5:1).
// Only for colours the user picked: a theme's own defaults are checked by its author, and some
// themes (e.g. minimal) don't colour links with the main colour at all.
// ponytail: assumes links use the main colour once the user changes it; ask themes to declare a link colour if that misleads.
function colourHint(el = $("#colour-hint")) {
  const c = site.colors;
  const d = (site.themeSource ? SOURCES.find((s) => s.spec === site.themeSource)?.themes?.[site.theme] : THEMES.themes[site.theme])?.colors || {};
  const low = [["Text", "text"], ["Links (main colour)", "primary"]]
    .filter(([, k]) => !(c[k] === d[k] && c.background === d.background) && contrast(c[k], c.background) < 4.5);
  el.hidden = !low.length;
  el.textContent = low.length ? `${low.map(([n]) => n).join(" and ")} may be hard to read on this background. Try a darker or lighter colour (aim for a contrast of at least 4.5:1).` : "";
  return el;
}

function themeButton(t, active, choose) {
  return h("button", { className: `theme${active ? " active" : ""}`, onclick: async () => {
    if (active) return;
    try { await choose(); } catch (e) { return alert(errorText(e)); }
    save(); renderTab();
  } },
    t.preview && h("img", { className: "theme-preview", src: t.preview, alt: "" }),
    h("strong", {}, t.label),
    h("div", { className: "swatches" }, Object.values(t.colors).map((c) => h("i", { style: `background:${c}` }))),
    h("small", {}, t.about, t.templates ? " Uses HTML templates." : ""));
}

// Themes from theme sources (#58, main.js listSources). Choosing one copies it
// into the site folder; "Update theme" fetches the source again.
let SOURCES = [], sourcesOpen = true, themeNote = "";
const loadSources = (p = call("themes:sources")) => p.then((s) => { SOURCES = s; if (site && tab === "design" && $("#tab")) renderTab(); });
const sourceThemeList = (src) => Object.entries(src.themes || {}).filter(([id, t]) => !t.errors.length && !(src.public && THEMES.themes[id]));

function sourceThemes() {
  const useTheme = async (channel, spec, id) => {
    const r = await call(channel, site.id, spec, id);
    THEMES.fonts = r.fonts;
    return r.theme;
  };
  const status = h("p", { className: "hint" }, themeNote);
  themeNote = "";
  const current = site.themeSource && SOURCES.find((s) => s.spec === site.themeSource)?.themes?.[site.theme];
  return [
    SOURCES.filter((src) => !src.hidden && sourceThemeList(src).length).map((src) => [
      h("p", { className: "hint", style: "margin:12px 0 6px" }, src.local ? "Your themes (Theme Builder)" : `From ${src.spec}`),
      h("div", { className: "themes" }, sourceThemeList(src).map(([id, t]) => themeButton(t, site.themeSource === src.spec && site.theme === id, async () => {
        const theme = await useTheme("themes:use", src.spec, id);
        Object.assign(site, { theme: id, themeSource: src.spec, colors: { ...theme.colors }, font: theme.font });
      }))),
    ]),
    site.themeSource && h("div", { className: "inline", style: "align-items:center;margin-top:8px" },
      h("button", { onclick: async (e) => {
        e.target.disabled = true; status.textContent = "Checking for a newer version…";
        try {
          const theme = await useTheme("themes:update", site.themeSource, site.theme);
          themeNote = `Updated "${theme.label}"${theme.version ? ` to version ${theme.version}` : ""}. Your colours and font are unchanged.`;
          save(); await loadSources().catch(renderTab); return; // re-renders with the note
        } catch (err) { status.textContent = errorText(err); }
        e.target.disabled = false;
      } }, "Update theme"),
      h("span", { className: "hint" }, `"${current?.label || site.theme}" from ${site.themeSource === "local" ? "your themes" : site.themeSource}${current?.version ? `, version ${current.version}` : ""}. A copy is kept with your website.`)),
    status,
  ];
}

function themeSourcesSettings() {
  const act = async (btn, error, channel, ...args) => {
    btn.disabled = true; error.textContent = "";
    try { SOURCES = await call(channel, ...args); renderTab(); }
    catch (e) { error.textContent = errorText(e); btn.disabled = false; }
  };
  const repo = h("input", { placeholder: "owner/repo" });
  const token = h("input", { type: "password", placeholder: "Access token (private repositories only)" });
  const addError = h("p", { className: "error" });
  const add = h("button", { className: "primary", onclick: () => act(add, addError, "themes:add", repo.value, token.value) }, "Add");
  return h("details", { className: "sources", open: sourcesOpen, ontoggle: (e) => { sourcesOpen = e.target.open; } },
    h("summary", {}, "Theme sources"),
    h("p", { className: "hint" }, "Extra themes come from GitHub repositories. Choosing one keeps a copy with your website, so it keeps working even if the repository changes or disappears."),
    SOURCES.filter((src) => !src.local).map((src) => {
      const error = h("p", { className: "error" }, src.error || "");
      const bad = Object.entries(src.themes || {}).filter(([, t]) => t.errors.length);
      const row = h("div", { className: "source" },
        h("div", { className: "inline", style: "align-items:center" },
          h("strong", { style: "flex:1" }, src.spec, src.public ? " (built in)" : "", src.hasToken ? " (private, token saved)" : ""),
          !src.hidden && h("button", { onclick: (e) => act(e.target, error, "themes:refresh", src.spec) }, "Refresh"),
          src.public
            ? h("button", { onclick: (e) => act(e.target, error, "themes:hide-public", !src.hidden) }, src.hidden ? "Show" : "Hide")
            : h("button", { className: "danger", onclick: (e) => act(e.target, error, "themes:remove", src.spec) }, "Remove")),
        src.hidden ? h("p", { className: "hint" }, "Hidden from the theme list.")
          : src.themes && h("p", { className: "hint" }, `${sourceThemeList(src).length} theme(s)${src.fetchedAt ? `, checked ${new Date(src.fetchedAt).toLocaleString()}` : ""}.`),
        bad.map(([id, t]) => h("p", { className: "hint" }, `"${id}" can't be used: ${t.errors.join("; ")}`)),
        error);
      return row;
    }),
    h("h4", {}, "Add a repository"),
    h("div", { className: "inline" }, repo, add),
    labelled("", token, ["Only needed for a private repository. On GitHub, create a ", link("fine-grained token", "https://github.com/settings/personal-access-tokens/new"),
      " with access to just that repository and ", h("b", {}, "Contents: Read-only"), ". It's stored encrypted on this computer and only ever sent to api.github.com."]),
    h("p", { className: "hint" }, "Themes go in a themes/ folder, one folder per theme (see the PhaseN-Digital/phasen-sitebuilder-themes repository). For another folder or branch, write owner/repo/folder@branch."),
    addError);
}

// ---------- Pages ----------
const SECTION_TYPES = {
  hero: { label: "Banner", make: () => ({ heading: "A big headline", text: "", image: null, buttonText: "", buttonPage: "" }) },
  text: { label: "Text & image", make: () => ({ heading: "A heading", text: "Your text here.", image: null, imageLeft: false }) },
  richtext: { label: "Rich text", make: () => ({ html: "<h2>A heading</h2><p>Your text here.</p>" }) },
  gallery: { label: "Photo gallery", make: () => ({ heading: "Gallery", images: [] }) },
  form: { label: "Form", make: () => ({ heading: "Get in touch", text: "", formId: site.forms[0]?.id || "", buttonText: "Send" }) },
  contact: { label: "Contact details", make: () => ({ heading: "Find us", text: "" }) },
};

function sectionEditor(s) {
  const pageOptions = [["", "(no button)"], ...site.pages.map((p) => [p.id, p.title])];
  switch (s.type) {
    case "hero":
      return [text("Headline", s, "heading"), area("Text", s, "text"), imageField("Background photo", s, "image"),
        h("div", { className: "grid2" }, text("Button text", s, "buttonText"), select("Button goes to", s, "buttonPage", pageOptions))];
    case "text":
      return [text("Heading", s, "heading"), area("Text", s, "text", "Leave a blank line between paragraphs."), imageField("Image (optional)", s, "image"), s.image && check("Show the image on the left", s, "imageLeft")];
    case "gallery": {
      const items = h("div", { className: "gallery-items" }, (s.images || []).map((img, i) =>
        h("div", { className: "image-field" },
          h("img", { className: "thumb", src: thumbUrl(img.src), alt: "" }),
          h("div", { className: "stack" },
            h("input", { value: img.alt, placeholder: "Describe the photo", oninput: (e) => { img.alt = e.target.value; save(); } }),
            h("div", { className: "inline" },
              h("button", { className: "icon", title: "Move up", onclick: () => move(s.images, i, -1) }, "↑"),
              h("button", { className: "icon", title: "Move down", onclick: () => move(s.images, i, 1) }, "↓"),
              h("button", { className: "danger", onclick: () => { s.images.splice(i, 1); save(); renderTab(); } }, "Remove"))))));
      return [text("Heading", s, "heading"), h("div", { className: "field" }, h("span", {}, "Photos"), items,
        h("button", { onclick: () => pickFiles(true, async (files) => {
          for (const file of files) {
            const src = await processImage(file, 1600);
            if (src) (s.images ||= []).push({ src, alt: "" });
          }
          save(); renderTab();
        }) }, "Add photos…"))];
    }
    case "richtext":
      return [richTextEditor(s), check("Show as cards: each small heading (Heading 3) starts a new card", s, "cards")];
    case "form":
      return [select("Which form", s, "formId", site.forms.map((f) => [f.id, f.name])), text("Heading", s, "heading"), area("Text above the form", s, "text"), text("Button text", s, "buttonText"),
        h("p", { className: "hint" }, "Edit the form's questions under Forms.")];
    case "contact":
      return [text("Heading", s, "heading"), area("Text", s, "text"),
        h("p", { className: "hint" }, "Shows your address (with a map link), phone, email, opening hours and social links from Business details in Site settings.")];
  }
}

// ---------- Rich text: Quill 2 (BSD-3-Clause, node_modules/quill) ----------
// Stored as sanitized HTML in s.html. Images are "assets/x.webp" in storage
// and preview://<site>/assets/x.webp in the editor; videos are a placeholder
// <div class="video-embed" data-src="…"> that lib/build.js makes click-to-load.
const RICH_FORMATS = ["header", "bold", "italic", "underline", "strike", "align", "blockquote", "list", "indent",
  "link", "button", "image", "figure", "video", "divider", "table"];
const RICH_TOOLBAR = [[{ header: [2, 3, 4, false] }], ["bold", "italic", "underline", "strike"], [{ align: [] }, "blockquote"],
  [{ list: "bullet" }, { list: "ordered" }, { indent: "-1" }, { indent: "+1" }], ["link", "image", "video", "table", "divider"], ["undo", "redo", "clean"]];
const MOD = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
const RICH_TITLES = { header: "Heading", bold: `Bold (${MOD}B)`, italic: `Italic (${MOD}I)`, underline: `Underline (${MOD}U)`, strike: "Strikethrough",
  align: "Alignment", blockquote: "Quote", "list:bullet": "Bulleted list", "list:ordered": "Numbered list", "indent:-1": "Indent less", "indent:+1": "Indent more",
  link: `Link (${MOD}K)`, image: "Image", video: "Video (YouTube or Vimeo)", table: "Table", divider: "Horizontal line",
  undo: `Undo (${MOD}Z)`, redo: `Redo (${MOD}Shift+Z)`, clean: "Clear formatting" };

// YouTube (any form, played from youtube-nocookie) or Vimeo links → the embed address, else null.
function videoEmbedUrl(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m)\./, "");
  const yt = host === "youtu.be" ? u.pathname.slice(1)
    : ["youtube.com", "youtube-nocookie.com"].includes(host) && (u.searchParams.get("v") || u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1]);
  if (yt) return /^[\w-]{11}$/.test(yt) ? `https://www.youtube-nocookie.com/embed/${yt}` : null;
  const vimeo = /^(player\.)?vimeo\.com$/.test(host) && u.pathname.match(/^\/(?:video\/)?(\d+)$/)?.[1];
  return vimeo ? `https://player.vimeo.com/video/${vimeo}` : null;
}

// Allowed rich text links: web addresses, email, phone, or one of the site's pages (#page:<id>).
const richLink = (v) => (v.startsWith("#page:") ? (site.pages.some((p) => `#page:${p.id}` === v) ? v : null) : [linkTarget(v)].find((t) => t && SAFE_HREF.test(t)) || null);

let quillSetUp = false;
function setUpQuill() {
  if (quillSetUp) return;
  quillSetUp = true;
  const Parchment = Quill.import("parchment"), BlockEmbed = Quill.import("blots/block/embed");
  const Link = Quill.import("formats/link"), Image = Quill.import("formats/image");
  class SafeLink extends Link { static sanitize(url) { return SAFE_HREF.test(url) ? url : "about:blank"; } }
  class ButtonLink extends SafeLink { static blotName = "button"; static className = "button"; }
  class SafeImage extends Image { static sanitize(url) { return /^(https?|preview):/i.test(url) ? url : "//:0"; } }
  class Divider extends BlockEmbed { static blotName = "divider"; static tagName = "HR"; }
  class Video extends BlockEmbed {
    static blotName = "video"; static tagName = "DIV"; static className = "video-embed";
    static create(url) { const node = super.create(); node.dataset.src = url; node.contentEditable = "false"; return node; }
    static value(node) { return SAFE_VIDEO.test(node.dataset.src || "") ? node.dataset.src : null; }
  }
  // An image with optional caption, alignment and link, or a gallery from a WordPress import.
  // Other figures (tables, quotes, several images) return null and load as their contents.
  class Figure extends BlockEmbed {
    static blotName = "figure"; static tagName = "FIGURE";
    static create(v) {
      const node = super.create(), el = (tag, props) => Object.assign(document.createElement(tag), props);
      node.contentEditable = "false";
      if (v.align) node.className = `align-${v.align}`;
      if (v.gallery) node.classList.add("gallery-grid");
      for (const item of v.gallery || [v]) {
        const img = el("img");
        img.setAttribute("src", item.src);
        img.setAttribute("alt", item.alt || "");
        const pic = item.href ? el("a", { href: item.href }) : img;
        if (item.href) pic.append(img);
        node.append(v.gallery ? el("figure", {}) : pic);
        if (v.gallery) { node.lastChild.append(pic); if (item.caption) node.lastChild.append(el("figcaption", { textContent: item.caption })); }
      }
      if (v.caption) node.append(el("figcaption", { textContent: v.caption }));
      return node;
    }
    static value(node) {
      const caption = (f) => f.querySelector(":scope > figcaption")?.textContent.trim() || "";
      const items = [...node.querySelectorAll("img")].map((img) => {
        const f = img.closest("figure");
        return { src: img.getAttribute("src"), alt: img.getAttribute("alt") || "", href: img.closest("a")?.getAttribute("href") || "", caption: f === node ? "" : caption(f) };
      });
      const align = node.className.match(/\balign-(left|center|right)\b/)?.[1] || "";
      if (node.classList.contains("gallery-grid")) return items.length ? { gallery: items, caption: caption(node), align } : null;
      if (items.length !== 1 || node.querySelector("table, blockquote, p, ul, ol, h1, h2, h3, h4")) return null;
      return { ...items[0], caption: caption(node), align };
    }
  }
  const Align = new Parchment.ClassAttributor("align", "align", { scope: Parchment.Scope.BLOCK, whitelist: ["right", "center", "justify"] });
  Quill.register({ "formats/link": SafeLink, "formats/button": ButtonLink, "formats/image": SafeImage, "formats/divider": Divider,
    "formats/video": Video, "formats/figure": Figure, "formats/align": Align, "attributors/class/align": Align }, true);
  const order = Quill.import("blots/inline").order;
  order.splice(order.indexOf("link") + 1, 0, "button");
}

function richTextEditor(s) {
  setUpQuill();
  const Delta = Quill.import("delta");
  const viewPrefix = `preview://${site.id}/assets/`;
  const box = h("div", { className: "rich" }), panel = h("div", { className: "rich-panel", hidden: true });
  const wrap = h("div", { className: "rich-editor" }, box, panel);
  const show = (...kids) => { panel.hidden = false; panel.replaceChildren(...kids); };
  const hide = () => { panel.hidden = true; panel.replaceChildren(); };
  const keepFocus = (label, action, className = "") => h("button", { type: "button", className, onmousedown: (e) => e.preventDefault(), onclick: action }, label);
  const range = () => quill.getSelection(true);
  // Block embeds go on a line of their own, so they land exactly at the returned index.
  const insertBlock = (at, name, value) => {
    if (quill.getLine(at)[1] > 0) quill.insertText(at++, "\n", "user");
    quill.insertEmbed(at, name, value, "user");
    quill.setSelection(at + 1, 0, "silent"); // silent, or the selection change would close the panel
    return at;
  };

  const quill = new Quill(box, {
    theme: "snow", formats: RICH_FORMATS,
    modules: {
      table: true,
      // Dropped or pasted image files go through the same resize/upload as the Image button, never data: URLs.
      uploader: { mimetypes: ["image/png", "image/jpeg", "image/webp", "image/gif"], handler: (r, files) => insertImages(r.index, files) },
      toolbar: { container: RICH_TOOLBAR, handlers: {
        link: () => linkPanel(),
        image: () => { const at = range().index; pickFiles(true, (files) => insertImages(at, files)); },
        video: () => videoPanel(range().index),
        table: () => { quill.getModule("table").insertTable(3, 3); tablePanel(); },
        divider: () => insertBlock(range().index, "divider", true),
        undo: () => quill.history.undo(),
        redo: () => quill.history.redo(),
      } },
    },
  });
  const toolbar = quill.getModule("toolbar").container;
  for (const el of toolbar.querySelectorAll("button, .ql-picker")) {
    const name = [...el.classList].find((c) => c.startsWith("ql-") && c !== "ql-picker" && c !== "ql-active")?.slice(3);
    const title = RICH_TITLES[el.value ? `${name}:${el.value}` : name];
    if (title) el.title = title;
    if (el.tagName === "BUTTON" && !el.innerHTML) el.textContent = { divider: "—", undo: "↶", redo: "↷" }[name] || name;
  }
  // Images from other sites' pasted HTML (data: URLs, tracking pixels on file:) are dropped.
  quill.clipboard.addMatcher("IMG", (node, delta) => (/^(https?|preview):/i.test(node.getAttribute("src") || "") ? delta : new Delta()));
  // Quill's tables have no header cells: imported <th>s become ordinary cells (or they'd merge into one).
  const html = String(s.html || "").replaceAll('src="assets/', `src="${viewPrefix}`).replace(/<(\/?)th>/g, "<$1td>");
  quill.setContents(quill.clipboard.convert({ html }), "silent");
  quill.history.clear();
  quill.on("text-change", () => {
    // getSemanticHTML writes every space as &nbsp;; real non-breaking spaces stay as the character.
    s.html = sanitizeHtml(quill.getSemanticHTML().replaceAll("&nbsp;", " ").replaceAll(viewPrefix, "assets/"));
    save();
  });

  async function insertImages(at, files) {
    for (const file of files) {
      const src = await processImage(file, 1600);
      if (!src) continue;
      at = insertBlock(at, "figure", { src: thumbUrl(src), alt: "", caption: "", align: "" });
      figurePanel(at++);
    }
  }

  // The link (or button link) under the cursor, as [index, length, href, isButton], or the selection.
  function linkAt(r) {
    const [blot] = quill.scroll.descendant((b) => ["link", "button"].includes(b?.statics.blotName), r.index);
    if (blot) return [quill.getIndex(blot), blot.length(), blot.domNode.getAttribute("href"), blot.statics.blotName === "button"];
    return r.length ? [r.index, r.length, "", false] : null;
  }

  function linkPanel(r = range(), focus = true) {
    const found = linkAt(r);
    if (!found) return show(h("p", { className: "hint" }, "Select some text first, then click Link."));
    const [at, length, href, isButton] = found;
    const page = href?.startsWith("#page:") ? href.slice(6) : "";
    const input = h("input", { value: page ? "" : href || "", placeholder: "https://…, mailto:… or tel:…", hidden: Boolean(page) });
    const target = h("select", { onchange: () => { input.hidden = Boolean(target.value); } },
      h("option", { value: "" }, "A web address, email or phone number"), site.pages.map((p) => h("option", { value: p.id, selected: p.id === page }, `Page: ${p.title}`)));
    const asButton = h("input", { type: "checkbox", checked: isButton });
    const error = h("p", { className: "error" });
    const apply = () => {
      const value = target.value ? `#page:${target.value}` : richLink(input.value.trim());
      if (!value) { error.textContent = "Use a web address (https://…), mailto:, tel: or one of your pages."; return; }
      quill.formatText(at, length, asButton.checked ? { link: false, button: value } : { button: false, link: value }, "user");
      hide();
    };
    show(h("div", { className: "inline" }, target, input), h("label", { className: "inline" }, asButton, "Show as a button"),
      h("div", { className: "inline" }, keepFocus("Apply link", apply, "primary"), href && keepFocus("Remove link", () => { quill.formatText(at, length, { link: false, button: false }, "user"); hide(); }, "danger")), error);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    if (focus && !page) input.focus();
  }

  function videoPanel(at) {
    const input = h("input", { placeholder: "https://www.youtube.com/watch?v=… or https://vimeo.com/…" });
    const error = h("p", { className: "error" });
    const insert = () => {
      const url = videoEmbedUrl(input.value);
      if (!url) { error.textContent = "Paste a YouTube or Vimeo video link."; return; }
      insertBlock(at, "video", url);
      hide();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); insert(); } });
    show(h("p", { className: "hint" }, "Visitors see a play button; nothing loads from YouTube or Vimeo until they click it."),
      h("div", { className: "inline" }, input, h("button", { type: "button", className: "primary", onclick: insert }, "Insert video")), error);
    input.focus();
  }

  // Edits replace the figure in one step, so undo works.
  function figurePanel(at) {
    const v = quill.getContents(at, 1).ops[0]?.insert?.figure;
    if (!v) return hide();
    const update = (change) => quill.updateContents(new Delta().retain(at).delete(1).insert({ figure: Object.assign(v, change) }), "user");
    const remove = h("button", { type: "button", className: "danger", onclick: () => { quill.deleteText(at, 1, "user"); hide(); } }, "Remove");
    if (v.gallery) return show(h("p", { className: "hint" }, `A gallery of ${v.gallery.length} photos.`), remove);
    show(
      labelled("Describe the image (for screen readers)", h("input", { value: v.alt, onchange: (e) => update({ alt: e.target.value }) })),
      labelled("Caption (optional)", h("input", { value: v.caption, onchange: (e) => update({ caption: e.target.value }) })),
      labelled("Position", h("select", { onchange: (e) => update({ align: e.target.value }) },
        [["", "Full width"], ["left", "Left, text wraps around"], ["center", "Centred"], ["right", "Right, text wraps around"]].map(([value, name]) => h("option", { value, selected: v.align === value }, name)))),
      remove);
  }

  function tablePanel() {
    const t = quill.getModule("table");
    show(h("div", { className: "inline" }, h("span", { className: "hint" }, "Table:"),
      keepFocus("Add row", () => t.insertRowBelow()), keepFocus("Add column", () => t.insertColumnRight()),
      keepFocus("Delete row", () => t.deleteRow()), keepFocus("Delete column", () => t.deleteColumn()),
      keepFocus("Delete table", () => { t.deleteTable(); hide(); }, "danger")));
  }

  quill.on("selection-change", (r) => {
    if (!r) return; // focus moved into the panel
    const inLink = !r.length && linkAt(r);
    if (inLink) linkPanel(r, false);
    else if (quill.getModule("table").getTable(r)[0]) tablePanel();
    else hide();
  });
  quill.root.addEventListener("click", (e) => {
    const el = e.target.closest(".ql-editor > figure, .ql-editor > .video-embed");
    const blot = el && Quill.find(el);
    if (!blot) return;
    const at = quill.getIndex(blot);
    if (el.tagName === "FIGURE") figurePanel(at);
    else show(h("p", { className: "hint" }, `Video: ${el.dataset.src}`), h("button", { type: "button", className: "danger", onclick: () => { quill.deleteText(at, 1, "user"); hide(); } }, "Remove video"));
  });
  return wrap;
}

function pagesTab() {
  const page = site.pages.find((p) => p.id === pageId) || site.pages[0];
  const index = site.pages.indexOf(page);
  const copied = page.mirror && copiedPageCard(page);
  return [
    h("div", { className: "chips" },
      site.pages.map((p) => h("button", { className: p === page ? "active" : "", onclick: () => { pageId = p.id; selectedCopyImage = null; renderTab(); refreshPreview(); } }, p.title || "Untitled")),
      h("button", { className: choosingLayout ? "active" : "", onclick: () => { choosingLayout = !choosingLayout; renderTab(); } }, "+ Add page")),
    choosingLayout && layoutChooser(),
    copied || [h("div", { className: "card" },
      text("Page name", page, "title", index === 0 ? "This is your home page. Its name appears in the menu." : "Appears in the menu and the page address."),
      select("Layout", page, "layout", LAYOUTS.map((l) => [l.id, l.label]), renderTab),
      h("p", { className: "hint" }, `${LAYOUT[page.layout]?.description || ""} Changing it keeps this page's sections.`),
      h("div", { className: "inline" },
        h("button", { disabled: index === 0, onclick: () => move(site.pages, index, -1) }, "Move left in menu"),
        h("button", { disabled: index === site.pages.length - 1, onclick: () => move(site.pages, index, 1) }, "Move right"),
        h("button", { className: "danger", disabled: site.pages.length === 1, onclick: () => {
          if (!confirm(`Delete the "${page.title}" page?`)) return;
          site.pages.splice(index, 1); pageId = site.pages[0].id; save(); renderTab();
        } }, "Delete page")),
      index === 0 && h("p", { className: "hint", style: "margin-top:8px" }, "The first page in the menu is always the home page.")),
    page.layout === "blog-post" && postCard(page),
    page.layout === "blog-index" && h("p", { className: "hint" }, "Your blog posts (pages with the Blog post layout) are listed on this page automatically, newest first, ten to a page. Sections added here appear above the list."),
    h("p", { className: "hint" }, "Search and sharing settings for this page are under SEO."),
    h("h3", { className: "section-title" }, "Sections on this page"),
    page.sections.map((s, i) =>
      h("div", { className: "card" },
        h("div", { className: "card-head" },
          h("strong", {}, SECTION_TYPES[s.type].label),
          h("button", { className: "icon", title: "Move up", onclick: () => move(page.sections, i, -1) }, "↑"),
          h("button", { className: "icon", title: "Move down", onclick: () => move(page.sections, i, 1) }, "↓"),
          h("button", { className: "icon danger", title: "Delete section", onclick: () => {
            if (confirm("Delete this section?")) { page.sections.splice(i, 1); save(); renderTab(); }
          } }, "✕")),
        sectionEditor(s))),
    h("div", { className: "adders" }, Object.entries(SECTION_TYPES).map(([type, t]) =>
      h("button", { onclick: () => { page.sections.push({ id: rid(), type, ...t.make() }); save(); renderTab(); } }, `+ ${t.label}`)))],
  ];
}

// "Add page" (#169): pick a layout (lib/layouts.js); the page starts with its sections.
let choosingLayout = false;
function layoutChooser() {
  const add = (layout) => {
    if (layout.sections.some((s) => s.type === "form") && !site.forms.length) site.forms.push({ id: rid(), name: "Contact", to: "", success: "Thanks, your message has been sent.", fields: [
      { id: rid(), label: "Your name", type: "text", required: true }, { id: rid(), label: "Email address", type: "email", required: true }, { id: rid(), label: "Message", type: "textarea", required: true }] });
    const contact = site.pages.find((p) => p.layout === "contact")?.id || "";
    const sections = layout.sections.map((s) => ({ id: rid(), ...SECTION_TYPES[s.type].make(), ...structuredClone(s), ...(s.buttonPage ? { buttonPage: contact } : {}) }));
    const p = { id: rid(), title: layout.id === "standard" ? "New page" : layout.label, layout: layout.id, sections };
    if (layout.id === "blog-post") p.date = new Date().toISOString().slice(0, 10);
    site.pages.push(p); pageId = p.id; choosingLayout = false; save(); renderTab();
  };
  return h("div", { className: "card" },
    h("strong", {}, "Choose a layout for the new page"),
    h("div", { className: "layout-choices" }, LAYOUTS.map((l) =>
      h("button", { className: "layout-choice", onclick: () => add(l) },
        h("img", { src: `data:image/svg+xml,${encodeURIComponent(l.thumb)}`, alt: "" }),
        h("strong", {}, l.label), h("span", {}, l.description)))));
}

// Blog post details (#169): shown on the post and in the blog list.
function postCard(page) {
  return h("div", { className: "card" },
    h("strong", {}, "Blog post"),
    h("div", { className: "grid2" }, text("Date", page, "date", "Posts are listed newest first.", { type: "date" }), text("Author", page, "author", "Optional.")),
    imageField("Featured image", page, "featuredImage", 1600, "Shown at the top of the post and in the blog list."),
    area("Excerpt", page, "excerpt", "A sentence or two for the blog list. Leave blank to use the start of the post."));
}

// Search and sharing settings for a page (#74). The share image is picked
// from images already uploaded to the site; the logo is the default.
function seoCard(page, index) {
  const images = [...new Set(JSON.stringify(site).match(/assets\/[\w.-]+/g) || [])];
  const fallbackTitle = index === 0 ? site.name : `${page.title} | ${site.name}`;
  const pick = (src) => { if (src) page.shareImage = src; else delete page.shareImage; save(); renderTab(); };
  return h("div", { className: "card" },
    h("strong", {}, "Search and sharing"),
    text("Title in search results", page, "seoTitle", "Leave blank to use the page name and website name.", { placeholder: fallbackTitle }),
    area("Description in search results", page, "seoDescription", "Leave blank to use the website's short description (Design)."),
    h("div", { className: "field" },
      h("span", {}, "Image when shared on social media"),
      h("div", { className: "chips" },
        h("button", { className: page.shareImage ? "" : "active", onclick: () => pick(null) }, site.logo ? "Logo (default)" : "None"),
        images.filter((src) => src !== site.logo?.src).map((src) =>
          h("button", { className: page.shareImage === src ? "active" : "", title: src, onclick: () => pick(src) },
            h("img", { className: "thumb", src: thumbUrl(src), alt: "" })))),
      h("p", { className: "hint" }, "Shown in link previews on Facebook, LinkedIn, X and messaging apps. Images uploaded anywhere on the site can be chosen here.")));
}

// ---------- Forms ----------
const FIELD_TYPES = [["text", "Short text"], ["email", "Email"], ["tel", "Phone"], ["textarea", "Long text"]];

function formsTab() {
  const form = site.forms.find((f) => f.id === formId) || site.forms[0];
  const chips = h("div", { className: "chips" },
    site.forms.map((f) => h("button", { className: f === form ? "active" : "", onclick: () => { formId = f.id; renderTab(); } }, f.name || "Untitled")),
    h("button", { onclick: () => {
      const f = { id: rid(), name: "New form", to: "", success: "Thanks, your message has been sent.", fields: [
        { id: rid(), label: "Your name", type: "text", required: true }, { id: rid(), label: "Email address", type: "email", required: true }] };
      site.forms.push(f); formId = f.id; save(); renderTab();
    } }, "+ New form"));
  if (!form) return [chips, h("p", {}, "No forms yet.")];

  const used = [...(form.shownOn || []), ...site.pages.filter((p) => p.sections.some((s) => s.type === "form" && s.formId === form.id)).map((p) => p.title)];
  return [
    chips,
    h("p", { className: "hint" }, used.length ? `Shown on: ${used.join(", ")}` : "Not on any page yet. Add a Form section under Pages to show it."),
    text("Form name", form, "name", "Used in the email subject so you know which form was filled in."),
    text("Send messages to", form, "to", "Leave blank to use the address in Publish › Form messages.", { type: "email", placeholder: effective("email") || "you@example.com" }),
    text("Thank-you message", form, "success"),
    h("h3", { className: "section-title" }, "Questions"),
    form.mirrored ? [
      h("p", { className: "hint" }, "This form was copied with your WordPress design, so its questions are set by the page and can't be changed here."),
      h("ul", {}, form.fields.map((f) => h("li", {}, `${f.label}${f.required ? " (required)" : ""}`))),
    ] : [form.fields.map((f, i) =>
      h("div", { className: "field-row" },
        h("input", { value: f.label, "aria-label": "Question", oninput: (e) => { f.label = e.target.value; save(); } }),
        h("select", { "aria-label": "Answer type", onchange: (e) => { f.type = e.target.value; save(); } },
          FIELD_TYPES.map(([v, n]) => h("option", { value: v, selected: f.type === v }, n))),
        h("label", {}, h("input", { type: "checkbox", checked: f.required, onchange: (e) => { f.required = e.target.checked; save(); } }), "Required"),
        h("button", { className: "icon", title: "Move up", onclick: () => move(form.fields, i, -1) }, "↑"),
        h("button", { className: "icon", title: "Move down", onclick: () => move(form.fields, i, 1) }, "↓"),
        h("button", { className: "icon danger", title: "Delete question", disabled: form.fields.length === 1, onclick: () => { form.fields.splice(i, 1); save(); renderTab(); } }, "✕"))),
    h("button", { onclick: () => { form.fields.push({ id: rid(), label: "New question", type: "text", required: false }); save(); renderTab(); } }, "+ Add question")],
    h("hr", { style: "margin:24px 0;border:0;border-top:1px solid var(--line)" }),
    h("button", { className: "danger", disabled: Boolean(form.mirrored), onclick: () => {
      if (!confirm(`Delete the "${form.name}" form?${used.length ? " It will disappear from your pages." : ""}`)) return;
      site.forms.splice(site.forms.indexOf(form), 1); formId = site.forms[0]?.id; save(); renderTab();
    } }, "Delete this form"),
  ];
}

// ---------- Inbox (#75) ----------
// Messages come from the site's D1 database through main.js, never the website itself.
function inboxTab() {
  const list = h("div", {}, h("p", { className: "hint" }, "Loading messages…"));
  const status = h("p", { className: "error" });
  const formName = (id) => site.forms.find((f) => f.id === id)?.name || "Deleted form";
  const exportBtn = h("button", { disabled: true, onclick: async () => {
    try { await call("inbox:export", site.id); } catch (e) { status.textContent = errorText(e); }
  } }, "Export as CSV…");
  call("inbox:list", site.id).then((rows) => {
    if (!rows) return list.replaceChildren(h("p", {}, "Your inbox starts once the website is published. Every message sent through your forms is kept here as well as emailed to you."));
    exportBtn.disabled = !rows.length;
    if (rows.length) remember("sb-inbox-seen", { ...seenMessages(), [site.id]: Math.max(...rows.map((m) => m.id)) });
    unread = 0;
    renderSideMenu();
    // Failed sends stand out (#218): with Resend's reason, so a bad key or address can be told apart.
    const failed = rows.filter((m) => m.email_status !== "sent");
    status.textContent = failed.length ? `${failed.length === 1 ? "1 message wasn't" : `${failed.length} messages weren't`} emailed to you (latest: ${failed[0].email_status}). Reply from here; if this keeps happening, check Settings › Resend and publish the website again.` : "";
    list.replaceChildren(...(rows.length ? rows.map((m) => {
      const fields = JSON.parse(m.fields);
      const item = h("details", { className: "message" },
        h("summary", {}, h("b", {}, formName(m.form)), ` · ${new Date(`${m.created_at.replace(" ", "T")}Z`).toLocaleString()} · `,
          fields.find((f) => f.value)?.value.slice(0, 60) || "",
          m.email_status !== "sent" && h("span", { className: "badge-warn", title: `Email ${m.email_status}` }, "⚠ Email not delivered")),
        m.email_status !== "sent" && h("p", { className: "error" }, `Email ${m.email_status}.`),
        h("dl", {}, fields.map((f) => [h("dt", {}, f.label), h("dd", {}, f.value || "-")])),
        h("button", { className: "danger", onclick: async () => {
          if (!confirm("Delete this message? This can't be undone.")) return;
          try { await call("inbox:delete", site.id, m.id); item.remove(); } catch (e) { status.textContent = errorText(e); }
        } }, "Delete"));
      return item;
    }) : [h("p", {}, "No messages yet.")]));
  }).catch((e) => { list.replaceChildren(); status.textContent = errorText(e); });
  return [
    h("p", { className: "hint" }, "Messages people send through your forms. Ones marked \u26a0 weren't emailed to you, so reply to them from here."),
    overridable("Delete messages after (days)", "inboxDays", "Your privacy page says this too. The website starts using a new value when you next publish.", { type: "number", min: 1 }),
    h("div", { className: "inline" }, exportBtn, h("button", { onclick: renderTab }, "Refresh")),
    status,
    list,
  ];
}

// ---------- History (#136) ----------
// The site's versions from its git repo (main.js history:*): edits are saved in
// batches, every publish is tagged. Restoring adds a new version, so nothing is lost.
function historyTab() {
  const list = h("div", {}, h("p", { className: "hint" }, "Loading history…"));
  const status = h("p", { className: "error" });
  const when = (d) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  call("history:list", site.id).then(({ versions, large }) => {
    list.replaceChildren(
      ...(large.length ? [h("div", { className: "warn" }, `Some files are very large (${large.map((f) => f.file).join(", ")}). Sites with files over 100MB can't be stored on GitHub.`)] : []),
      ...versions.map((v, i) => {
        const changes = h("ul", { className: "hint" });
        const item = h("details", { className: "message version", ontoggle: () => {
          if (!item.open || changes.childElementCount) return;
          call("history:changes", site.id, v.oid).then((lines) => changes.replaceChildren(...(lines.length ? lines : ["No changes to pages"]).map((l) => h("li", {}, l))), (e) => (status.textContent = errorText(e)));
        } },
          h("summary", {}, h("b", {}, v.message), ` · ${when(v.date)}`, ...v.tags.map((t) => h("span", { className: "badge-live", title: "Published" }, t))),
          changes,
          i > 0 && h("button", { onclick: async () => {
            if (!confirm(`Put the website back as it was on ${when(v.date)}? This is saved as a new version, so you can come back to today's too. What's live doesn't change until you publish.`)) return;
            try {
              await flushSave();
              await call("history:revert", site.id, v.oid);
              delete copyUndo[site.id]; // copied-page undo would re-apply edits from before the restore
              await openSite(site.id);
              tab = "history"; renderEditor();
            } catch (e) { status.textContent = errorText(e); }
          } }, "Restore this version"));
        return item;
      }));
  }).catch((e) => { list.replaceChildren(); status.textContent = errorText(e); });
  return [
    h("p", { className: "hint" }, "Every change you make is kept here, saved a few seconds after you stop editing. Publishing marks the version that went live."),
    status,
    list,
  ];
}

// ---------- Publish ----------
function step(title, done, ...content) {
  return h("div", { className: `step${done ? " done" : ""}` }, h("h3", {}, title), content);
}

// Account changes: the app's (Settings) or, with siteId, that site's own accounts (#134).
async function accountCall(siteId, ...args) {
  const r = await call(...args, siteId || null);
  if (siteId) siteAccounts = r; else settings = r;
  renderTab();
}

function secretInput(placeholder, channel, button, siteId) {
  const input = h("input", { type: "password", placeholder });
  const error = h("p", { className: "error" });
  const btn = h("button", { className: "primary", onclick: async () => {
    btn.disabled = true; error.textContent = "";
    try { await accountCall(siteId, channel, input.value); }
    catch (e) { error.textContent = errorText(e); btn.disabled = false; }
  } }, button);
  return [h("div", { className: "inline" }, input, btn), error];
}

const accountName = (c) => c.accounts.find((a) => a.id === c.accountId)?.name || c.accountId;
function cloudflareAccount(siteId) {
  const c = (siteId ? siteAccounts : settings).cloudflare;
  return c
    ? [
        c.accounts.length === 1 && h("p", {}, `Account: ${accountName(c)}`),
        c.accounts.length > 1 && labelled("Account", h("select", { onchange: (e) => accountCall(siteId, "settings:account", e.target.value) },
          c.accounts.map((a) => h("option", { value: a.id, selected: a.id === c.accountId }, a.name)))),
        c.warnings?.map((w) => h("div", { className: "warn" }, w)),
        h("button", { onclick: () => accountCall(siteId, "settings:disconnect", "cloudflare") }, siteId ? "Reset to the app's account" : "Disconnect"),
      ]
    : [
        h("ol", {},
          h("li", {}, "Create a free account at ", link("cloudflare.com", "https://dash.cloudflare.com/sign-up"), " (skip if you have one)."),
          h("li", {}, "Open ", link("API Tokens", "https://dash.cloudflare.com/profile/api-tokens"), " and click ", h("b", {}, "Create Token"), "."),
          h("li", {}, "Next to ", h("b", {}, "Edit Cloudflare Workers"), " click ", h("b", {}, "Use template"), "."),
          h("li", {}, "Click ", h("b", {}, "+ Add more"), " and add ", h("b", {}, "Account · Turnstile · Edit"), ", ", h("b", {}, "Account · D1 · Edit"), ", ", h("b", {}, "Zone · DNS · Edit"), " and ", h("b", {}, "Zone · Single Redirect · Edit"), " (called Dynamic Redirect on some accounts)."),
          h("li", {}, "Set Account Resources and Zone Resources to ", h("b", {}, "All"), ", then ", h("b", {}, "Continue to summary › Create Token"), "."),
          h("li", {}, "Copy the token and paste it here.")),
        secretInput("Paste your Cloudflare API token", "settings:cloudflare", "Connect", siteId),
      ];
}
function resendAccount(siteId) {
  return (siteId ? siteAccounts : settings).resend
    ? h("button", { onclick: () => accountCall(siteId, "settings:disconnect", "resend") }, siteId ? "Reset to the app's account" : "Disconnect")
    : [
        h("ol", {},
          h("li", {}, "Create a free account at ", link("resend.com", "https://resend.com/signup"), "."),
          h("li", {}, "Open ", link("API Keys", "https://resend.com/api-keys"), ", click ", h("b", {}, "Create API Key"), " and choose ", h("b", {}, "Full access"), "."),
          h("li", {}, "Copy the key and paste it here.")),
        secretInput("Paste your Resend API key", "settings:resend", "Connect", siteId),
      ];
}
// The Publish tab's account status: the app's account (set up in Settings), or this site's own (#134).
let overriding = {};
function siteAccount(which) {
  const own = siteAccounts[which], app = settings[which];
  const block = which === "cloudflare" ? cloudflareAccount : resendAccount;
  if (own) overriding[which] = false;
  if (own) return [h("p", { className: "account-status" }, "This website uses its own account."), block(site.id)];
  if (overriding[which]) return [h("p", { className: "hint" }, "Connect the account this website should use instead of the app's."), block(site.id),
    h("button", { onclick: () => { overriding[which] = false; renderTab(); } }, "Cancel")];
  return [
    h("p", { className: "account-status" }, app ? `Using app account (${which === "cloudflare" ? accountName(app) : "connected"}).` : "No account connected yet. Connect one in Settings, or just for this website."),
    h("div", { className: "inline" },
      h("button", { onclick: openSettings }, "Settings"),
      h("button", { onclick: () => { overriding[which] = true; renderTab(); } }, "Override for this site")),
  ];
}

const link = (label, url) => h("a", { href: url, onclick: (e) => { e.preventDefault(); call("open", url); } }, label);
const DOCS_URL = "https://sitebuilder.phasen.digital/docs"; // #165: the one place the docs address lives
$("#open-docs").addEventListener("click", () => call("open", DOCS_URL));

function publishTab() {
  const cfDone = Boolean(siteAccounts.cloudflare || settings.cloudflare);
  let zones = [];
  const domainSelect = h("select", { disabled: !cfDone, onchange: (e) => {
    const zone = zones.find((z) => z.id === e.target.value);
    site.domain = zone ? { zoneId: zone.id, zoneName: zone.name, label: site.domain?.label || "" } : null; save(); renderTab();
  } }, h("option", { value: "" }, "Free address (…workers.dev)"),
    site.domain && h("option", { value: site.domain.zoneId, selected: true }, site.domain.zoneName));
  if (cfDone) call("zones", site.id).then((z) => {
    zones = z;
    domainSelect.append(...z.filter((zone) => zone.id !== site.domain?.zoneId).map((zone) => h("option", { value: zone.id }, zone.name)));
  }).catch(() => {});
  // Optional subdomain (#135): "shop" publishes to shop.<zone>. Checked as typed; saved only when valid.
  const hostname = site.domain && (site.domain.label ? `${site.domain.label}.${site.domain.zoneName}` : site.domain.zoneName);
  const labelErr = h("p", { className: "error" }), domainWarn = h("div", {});
  const labelInput = site.domain && h("input", { value: site.domain.label, placeholder: "leave blank for the domain itself", oninput: (e) => {
    const label = e.target.value.trim().toLowerCase().replace(/\.$/, "");
    const err = label && !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/.test(label)
      ? "Use lowercase letters, numbers and hyphens (not at the start or end), with dots between parts, each part at most 63 characters." : "";
    labelErr.textContent = err;
    if (!err) { site.domain.label = label; save(); }
  }, onchange: () => { if (!labelErr.textContent) renderTab(); } });
  if (cfDone && site.domain) call("domain:check", site.id, site.domain).then((w) =>
    domainWarn.replaceChildren(...w.map((x) => h("div", { className: "warn" }, x)))).catch(() => {});

  const log = h("pre", { className: "log", hidden: !publishLog }, publishLog);
  const status = h("p", { className: "error" });
  // Runs a publish/unpublish/delete with its output streamed into the log.
  const run = async (btn, fn) => {
    publishing = true; btn.disabled = true; status.textContent = ""; log.hidden = false; log.textContent = publishLog = "";
    logSink = (line) => { publishLog += line; log.textContent = publishLog; log.scrollTop = log.scrollHeight; };
    let ok = true;
    try { await fn(); } catch (e) { ok = false; status.textContent = errorText(e); btn.disabled = false; }
    publishing = false;
    if (!site) return; // deleted
    ({ url: publishedUrl, publishedAt, canUnpublish } = await call("sites:get", site.id));
    if (ok) renderTab();
  };
  // Imported sites (#141): told about the provenance marker; ones imported before it must declare ownership first.
  const provenance = site.importProvenance;
  const undeclared = importedSite(site) && !provenance;
  const imported = importedSite(site) && h("div", { className: "warn" }, provenance
    ? [`Imported from ${provenance.source}${provenance.verification?.status === "verified" ? " (ownership verified)" : ""}. Every published page says it was made with PhaseN Site Builder and imported from that address on ${(provenance.importedAt || provenance.declaredAt).slice(0, 10)}, and /.well-known/phasen-provenance.json lists the address, date, app version and verification result. Your name and email aren't published.`]
    : ["This website was imported before Site Builder asked for an ownership declaration. Confirm that you own it, or have permission to copy it, before you publish it again. ",
       h("button", { onclick: () => askDeclaration(true) }, "Confirm ownership…")]);
  const publishBtn = h("button", { className: "primary big", disabled: publishing || !cfDone || !(siteAccounts.resend || settings.resend) || undeclared, onclick: () => run(publishBtn, async () => {
    await flushSave();
    paths = await call("sites:save", site);
    await call("sites:publish", site.id);
  }) }, publishedUrl ? "Publish changes" : "Publish website");
  const unpublishBtn = canUnpublish && h("button", { disabled: publishing || !cfDone, onclick: () => {
    if (confirm(`Take "${site.name}" offline? This deletes the website from Cloudflare, along with its www redirect, form keys and the messages in its Inbox (export them first if you need them). You can publish it again later.`)) run(unpublishBtn, async () => {
      await call("sites:unpublish", site.id);
    });
  } }, "Take website offline");

  // The delete confirmation, with the choice to take the live site down too (#71).
  const offline = h("input", { type: "checkbox", checked: Boolean(canUnpublish && cfDone), disabled: !canUnpublish || !cfDone });
  const deleteDialog = h("dialog", {},
    h("form", { method: "dialog" },
      h("p", {}, h("b", {}, `Delete "${site.name}" from this computer?`)),
      canUnpublish && h("label", {}, offline, " Also take it offline (deletes it from Cloudflare, with its www redirect, form keys and Inbox messages)"),
      canUnpublish && !cfDone && h("p", { className: "hint" }, "Connect Cloudflare above to take it offline too."),
      h("div", { className: "inline", style: "justify-content:flex-end;margin-top:16px" },
        h("button", { value: "" }, "Cancel"), h("button", { className: "danger", value: "delete" }, "Delete"))));
  const deleteBtn = h("button", { className: "danger", disabled: publishing, onclick: () => { deleteDialog.returnValue = ""; deleteDialog.showModal(); } }, "Delete this website");
  deleteDialog.addEventListener("close", () => {
    if (deleteDialog.returnValue !== "delete") return;
    run(deleteBtn, async () => {
      await flushSave();
      await call("sites:delete", site.id, offline.checked); // with offline set, nothing local is deleted unless taking it offline worked
      site = null;
      $("#main").replaceChildren(h("div", { className: "welcome" }, h("h1", {}, "Website deleted")));
      loadSites();
    });
  });

  return [
    publishedUrl && h("div", { className: "live" }, "Your website is live at ", link(publishedUrl, publishedUrl)),
    imported,
    step("1. Cloudflare (hosting)", cfDone, siteAccount("cloudflare")),
    step("2. Resend (sends your form emails)", Boolean(siteAccounts.resend || settings.resend), siteAccount("resend")),
    step("3. Form messages", Boolean(effective("email")),
      overridable("Send form messages to", "email", site.domain ? "" : "Until you use your own domain, this must be the same email you signed up to Resend with.", { type: "email", placeholder: "you@example.com" })),
    step("4. Web address", false,
      labelled("Domain", domainSelect,
        site.domain
          ? `Your site will be at https://${hostname}. Email records are added for you automatically${site.domain.label ? `, and form emails come from website@${site.domain.zoneName}` : ""}.`
          : ["To use your own domain, first ", link("add it to Cloudflare", "https://dash.cloudflare.com/?to=/:account/add-site"), ", then come back here."]),
      site.domain && labelled("Subdomain (optional)", labelInput, `e.g. "shop" for shop.${site.domain.zoneName}. Only the domain itself gets a www redirect.`),
      labelErr, domainWarn),
    paths.privacy && step("5. Privacy page", Boolean(effective("owner")),
      h("p", {}, "Because your site has a form or analytics, it gets a privacy page at ", h("b", {}, `${publishedUrl || ""}${paths.privacy}`), ". ",
        site.mirror ? "Copied pages keep their own footer, so add a link to it there if you can." : "It's linked from the footer of every page.",
        " It uses the email address form messages are sent to."),
      h("div", { className: "warn" }, "This is a starting point, not legal advice. Read it and check it matches how you handle people's information.",
        site.mirror ? " Copied pages may also load other services (analytics, maps, videos) that it doesn't mention." : ""),
      overridable("Business or legal name", "owner", "Who's responsible for the information people send, e.g. \"Smith Plumbing Ltd\" or \"Jane Smith, trading as Smith Plumbing\". Leave blank to use the website name.", { placeholder: site.name }),
      overridable("How long you keep messages", "retention", "Leave blank to say you keep them only as long as you need to deal with the enquiry.", {}, "textarea"),
      h("button", { onclick: () => { $("#preview").src = `preview://${site.id}${paths.privacy}?t=${Date.now()}`; } }, "Show it in the preview")),
    h("div", { className: "inline", style: "align-items:center;margin-top:8px" }, publishBtn,
      h("button", { onclick: async () => { try { await call("sites:export", site.id); } catch (e) { status.textContent = errorText(e); } } }, "Save as package…"),
      unpublishBtn),
    status,
    log,
    h("hr", { style: "margin:32px 0 16px;border:0;border-top:1px solid var(--line)" }),
    deleteDialog,
    deleteBtn,
  ];
}

let logSink = () => {};
onPublishLog((line) => logSink(line));

// "Version X is available" (#37). Main only goes online once a day, so asking
// every few hours is cheap and catches releases while the app stays open.
// Dismissing hides that version until the app restarts.
let dismissedUpdate;
async function checkForUpdate() {
  showUpdate(await call("update:check").catch(() => null)); // null when auto-check is off (Settings)
}
function showUpdate(u) {
  if (!u?.newer || u.version === dismissedUpdate) return;
  $("#update-banner")?.remove();
  $(".topbar").append(h("div", { id: "update-banner", className: "update-banner", role: "status" },
    h("span", {}, `Version ${u.version} is available`),
    h("div", { className: "inline" },
      h("button", { className: "primary", onclick: () => call("open", u.url) }, "Download"),
      h("button", { onclick: () => { dismissedUpdate = u.version; $("#update-banner").remove(); } }, "Dismiss"))));
}
checkForUpdate();
setInterval(checkForUpdate, 6 * 3600e3);

(async () => {
  [THEMES, settings] = await Promise.all([call("themes"), call("settings:get")]);
  await loadSites();
  loadSources().catch(() => {}); // may download, so not awaited
  showNotice(await call("notice:get").catch(() => null));
})();

// Sites moved into the sites folder, or saved secrets that need unlocking or re-entering (#136).
function showNotice(n) {
  const text = [n?.moved, n?.locked ? "Your saved passwords and keys are protected with a passphrase. Enter it in Settings › Data to unlock them." : n?.secrets].filter(Boolean);
  if (!text.length) return;
  $("#notices").append(h("div", { id: "notice-banner", className: "update-banner", role: "status" },
    ...text.map((t) => h("span", {}, t)),
    h("div", { className: "inline" },
      (n.locked || n.secrets) && h("button", { className: "primary", onclick: async () => { await openSettings(); $("#data-status")?.scrollIntoView(); } }, "Open Settings"),
      h("button", { onclick: () => $("#notice-banner").remove() }, "Dismiss"))));
}
