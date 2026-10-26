// Theme Builder UI (#130), opened from "Themes…" in the top bar. Themes are
// made from a few controls by lib/theme-builder.js (via main.js "builder:*")
// and saved to the user's local themes, which the Design tab lists under
// "Your themes". Uses app.js's helpers (h, call, labelled, loadSites…).
// Valid themes can be published to GitHub (#60, publishDialog).

let tbThemes = {}, tbSites = [], tbEdit = null, tbOn = "", tbTimer, tbPicking = false, tbTpl = "header", tbTplInfo = null;
// Page layouts (#171): the layout shown in the preview (and styled by the
// layout controls), and each layout's first page in the previewed site.
let tbLayout = "home", tbHrefs = {}, tbPreviewId = "";

async function openThemes() {
  await leaveSite($("#open-themes"));
  tbEdit = null;
  [tbThemes, tbSites, settings, tbTplInfo] = await Promise.all([call("builder:list"), call("sites:list"), call("settings:get"), call("builder:templates")]);
  renderThemes();
}
$("#open-themes").addEventListener("click", openThemes);

function renderThemes() {
  if (tbEdit) return renderThemeEditor();
  const from = h("select", {}, tbSites.map((s) => h("option", { value: s.id }, s.name || "Untitled")));
  $("#main").replaceChildren(h("div", { className: "import-wrap" }, h("div", { className: "import theme-list" },
    h("h1", {}, "Your themes"),
    h("p", { className: "hint" }, "Make your own themes here, separately from any website. They appear in every website's Design section under \"Your themes\"."),
    h("div", { className: "inline", style: "margin:16px 0" }, h("button", { className: "primary", onclick: async () => editTheme(await call("builder:new")) }, "New theme")),
    tbSites.length > 0 && h("div", { className: "inline", style: "align-items:center;margin-bottom:16px" }, h("span", { style: "white-space:nowrap" }, "New theme from a website's design:"), from,
      h("button", { onclick: async () => editTheme(await call("builder:from-site", from.value)) }, "Start")),
    h("div", { className: "themes" }, Object.entries(tbThemes).map(([id, t]) => h("div", { className: "theme card" },
      t.preview && h("img", { className: "theme-preview", src: t.preview, alt: "" }),
      h("strong", {}, t.label || id),
      t.errors.length ? h("p", { className: "error" }, t.errors.join("; ")) : [
        h("div", { className: "swatches" }, Object.values(t.colors).map((c) => h("i", { style: `background:${c}` }))),
        h("small", {}, t.about, t.version ? ` Version ${t.version}.` : "", t.templates ? " Uses HTML templates." : "")],
      h("div", { className: "inline", style: "margin-top:8px;flex-wrap:wrap" },
        t.controls && h("button", { onclick: () => editTheme({ ...t.controls, id }) }, "Edit"),
        !t.errors.length && h("button", { onclick: () => publishDialog(id, t, "push") }, "Push to repo…"),
        !t.errors.length && h("button", { onclick: () => publishDialog(id, t, "submit") }, "Submit to public repo…"),
        h("button", { className: "danger", onclick: async () => {
          if (!confirm(`Delete "${t.label || id}"? Websites using it keep their own copy.`)) return;
          await call("builder:delete", id);
          tbThemes = await call("builder:list"); loadSources(); renderThemes();
        } }, "Delete"))))),
    !Object.keys(tbThemes).length && h("p", { className: "hint" }, "No themes yet."))));
}

function editTheme(controls) {
  tbEdit = controls;
  tbOn = "";
  tbPicking = false;
  tbLayout = "home";
  renderThemes();
  previewThemeDraft();
}

// Rebuilds the preview from the controls; contrast hints and CSS errors come back from main.
function previewThemeDraft(delay = 0) {
  clearTimeout(tbTimer);
  tbTimer = setTimeout(async () => {
    try {
      const r = await call("builder:preview", tbEdit, tbOn || null);
      $("#tb-warnings").textContent = r.warnings.join(" ");
      $("#tb-errors").textContent = r.errors.length ? `This theme can't be used until these are fixed: ${r.errors.join("; ")}` : "";
      if (r.errors.length) return;
      [tbHrefs, tbPreviewId] = [r.layouts, r.id];
      if (!tbHrefs[tbLayout]) tbLayout = Object.keys(tbHrefs)[0] || "home";
      layoutPanel();
      $("#preview").src = `preview://${r.id}${tbHrefs[tbLayout] || "/"}?sb-theme&t=${Date.now()}`;
    } catch (e) {
      $("#tb-errors").textContent = errorText(e);
    }
  }, delay);
}

function renderThemeEditor() {
  const c = tbEdit;
  const changed = (fn) => (e) => { fn(e.target.value); previewThemeDraft(300); };
  const input = (label, key, hint) => labelled(label, h("input", { value: c[key], oninput: changed((v) => { c[key] = v; }) }), hint);
  const choice = (label, key, options) => labelled(label, h("select", { onchange: changed((v) => { c[key] = v; }) },
    options.map(([value, name]) => h("option", { value, selected: c[key] === value }, name))));
  const fonts = Object.entries(THEMES.fonts).filter(([id]) => !id.startsWith("theme-")).map(([id, f]) => [id, f.label]);
  if (!THEMES.fonts[c.font] || c.font.startsWith("theme-")) fonts.push([c.font, "The website's font"]);
  const saveBtn = h("button", { className: "primary", onclick: async () => {
    saveBtn.disabled = true; $("#tb-errors").textContent = ""; $(".save-state").textContent = "Saving…";
    try {
      const r = await call("builder:save", tbEdit);
      if (r.errors.length) { $("#tb-errors").textContent = `Can't save: ${r.errors.join("; ")}`; $(".save-state").textContent = ""; }
      else {
        tbEdit.id = r.id;
        tbThemes = await call("builder:list");
        loadSources().catch(() => {});
        $(".save-state").textContent = `Saved, version ${tbThemes[r.id]?.version}`;
        previewThemeDraft();
      }
    } catch (e) { $("#tb-errors").textContent = errorText(e); $(".save-state").textContent = ""; }
    saveBtn.disabled = false;
  } }, "Save theme");

  $("#main").replaceChildren(
    h("section", { className: "editor-panel" },
      h("header", { className: "panel-head", style: "padding-bottom:12px" },
        h("div", { className: "row" }, h("h1", {}, c.id ? "Edit theme" : "New theme"), h("span", { className: "save-state" }, "")),
        h("div", { className: "inline" }, saveBtn, h("button", { onclick: () => { tbEdit = null; renderThemes(); } }, "Back to your themes"))),
      h("div", { className: "panel-body", id: "tab" },
        input("Name", "label"),
        input("Short description", "about", "Shown under the name in the theme list."),
        h("h3", { className: "section-title" }, "Colours"),
        h("div", { className: "grid2" }, [["background", "Background"], ["text", "Text"], ["primary", "Main colour"], ["accent", "Buttons"]].map(([key, label]) =>
          labelled(label, h("input", { type: "color", value: c.colors[key], oninput: changed((v) => { c.colors[key] = v; }) })))),
        h("p", { className: "hint", id: "tb-warnings", role: "status" }),
        h("h3", { className: "section-title" }, "Style"),
        choice("Font", "font", fonts),
        labelled(`Corner rounding`, h("input", { type: "range", min: 0, max: 32, value: c.radius, oninput: changed((v) => { c.radius = Number(v); }) })),
        h("div", { className: "grid2" },
          choice("Header style", "header", [["left", "Name on the left"], ["centred", "Centred"], ["bar", "Coloured bar"]]),
          choice("Button style", "button", [["filled", "Filled"], ["outline", "Outline"], ["pill", "Pill"]]),
          choice("Section spacing", "spacing", [["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]]),
          choice("Links", "links", [["underlined", "Underlined"], ["plain", "Underlined on hover"]])),
        h("h3", { className: "section-title" }, "Page layout"),
        h("div", { id: "tb-layout-controls" }),
        h("details", { className: "sources", open: Boolean(c.css) },
          h("summary", {}, "Advanced CSS"),
          labelled("", h("textarea", { id: "tb-css", style: "font-family:monospace;min-height:160px", value: c.css, spellcheck: false, oninput: changed((v) => { c.css = v; }) }),
            "Added after the controls above. Plain CSS only: no @import, scripts or HTML. Right-click an element in the preview (or use Pick element) to add or find its rule, for every layout or that page's layout only. Rules starting with .layout-<id> (for example .layout-services .card) apply to one layout.")),
        templateEditor(changed),
        h("p", { className: "error", id: "tb-errors", role: "alert" }))),
    h("section", { className: `preview${previewMobile ? " mobile" : ""}` },
      h("div", { className: "preview-bar" },
        h("span", {}, "Preview with"),
        h("select", { style: "width:auto", onchange: (e) => { tbOn = e.target.value; previewThemeDraft(); } },
          h("option", { value: "" }, "Sample content"), tbSites.map((s) => h("option", { value: s.id, selected: tbOn === s.id }, s.name || "Untitled"))),
        h("select", { id: "tb-layout", "aria-label": "Page layout to preview", style: "width:auto", onchange: (e) => showLayout(e.target.value) }),
        h("button", { id: "tb-pick", className: tbPicking ? "primary" : "", "aria-pressed": String(tbPicking), onclick: () => setPicking(!tbPicking, true),
          title: "Then click an element, or use the arrow keys and Enter. Esc stops. Right-click or Alt+click works any time." }, "Pick element"),
        h("button", { className: previewMobile ? "" : "primary", onclick: () => { previewMobile = false; renderThemes(); previewThemeDraft(); } }, "Desktop"),
        h("button", { className: previewMobile ? "primary" : "", onclick: () => { previewMobile = true; renderThemes(); previewThemeDraft(); } }, "Mobile")),
      h("div", { className: "preview-stage" }, h("iframe", { id: "preview", title: "Theme preview" }))));
  layoutPanel();
}

// Page layouts (#171): the preview's layout switcher and the shown layout's
// controls (which ones apply to which layout comes from lib/theme-builder.js).
const LAYOUT_CONTROLS = {
  band: ["Title band", { plain: "Plain", tinted: "Tinted", coloured: "Main colour", centred: "Centred" }],
  width: ["Column width", { normal: "Normal", narrow: "Narrow", wide: "Wide" }],
  cards: ["Cards", { bordered: "Bordered", shadow: "Shadow", tinted: "Tinted", plain: "No box" }],
  meta: ["Post date and author", { plain: "Plain", caps: "Small capitals", coloured: "Main colour" }],
};
function showLayout(id) {
  tbLayout = id;
  layoutPanel();
  if (tbHrefs[id]) $("#preview").src = `preview://${tbPreviewId}${tbHrefs[id]}?sb-theme&t=${Date.now()}`;
}
function layoutPanel() {
  const label = LAYOUTS.find((l) => l.id === tbLayout)?.label;
  $("#tb-layout")?.replaceChildren(...LAYOUTS.map((l) => h("option", { value: l.id, selected: l.id === tbLayout, disabled: !tbHrefs[l.id] },
    l.label + (Object.keys(tbEdit.layouts[l.id] || {}).length ? " (changed)" : "") + (tbHrefs[l.id] ? "" : " (not on this site)"))));
  $("#tb-layout-controls")?.replaceChildren(
    h("p", { className: "hint", style: "margin-bottom:8px" }, `For ${label} pages only. Choose another layout above the preview.`),
    h("div", { className: "grid2" }, Object.entries(tbTplInfo.layoutControls[tbLayout] || {}).map(([k, options]) => labelled(LAYOUT_CONTROLS[k][0],
      h("select", { "data-layout-control": k, onchange: (e) => { (tbEdit.layouts[tbLayout] ||= {})[k] = e.target.value; layoutPanel(); previewThemeDraft(300); } },
        options.map((v) => h("option", { value: v, selected: (tbEdit.layouts[tbLayout]?.[k] ?? options[0]) === v }, LAYOUT_CONTROLS[k][1][v])))))));
}

// Advanced HTML (#200): one template at a time in a plain textarea with line
// numbers (no editor library: offline, no dependency). Highlighting (#226) is
// a <pre> behind the textarea, whose text is transparent; both use the same
// font, padding and border, and the <pre>'s content is moved with the
// textarea's scroll offsets so the caret lines up. Validated in main on
// every preview and save (lib/theme-validate.js); errors show in #tb-errors.
const HL = { tag: "#1d4ed8", attr: "#9333ea", str: "#15803d", ph: "#c2410c", comment: "#64748b" };
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (kind, t) => `<span style="color:${HL[kind]}">${esc(t)}</span>`;
const PH = /(\{\{[^}]*\}\})/;
const phs = (t) => t.split(PH).map((p, i) => (i % 2 ? span("ph", p) : esc(p))).join("");
function highlightHtml(src) {
  return src.split(/(<!--[\s\S]*?(?:-->|$)|\{\{[^}]*\}\}|<\/?[a-zA-Z][^>]*>?)/).map((p, i) => {
    if (i % 2 === 0) return esc(p);
    if (p.startsWith("<!--")) return span("comment", p);
    if (p.startsWith("{{")) return span("ph", p);
    // a tag: its name, then attribute names and quoted values (placeholders inside them too)
    const [, name, rest] = p.match(/^(<\/?[a-zA-Z][\w-]*)([\s\S]*)$/);
    return span("tag", name) + rest.split(/("[^"]*"?|'[^']*'?|[^\s=<>"'/]+(?=\s*=))/).map((q, j) =>
      j % 2 === 0 ? (q.endsWith(">") ? esc(q.slice(0, -1)) + span("tag", ">") : esc(q))
        : /^["']/.test(q) ? q.split(PH).map((r, k) => span(k % 2 ? "ph" : "str", r)).join("") : span("attr", q)).join("");
  }).join("") + "\n";
}
function templateEditor(changed) {
  const { defaults, placeholders } = tbTplInfo;
  const label = (name) => ({ header: "Header", footer: "Footer", section: "Section wrapper" })[name] || `Page layout: ${LAYOUTS.find((l) => `layout-${l.id}` === name)?.label}`;
  const font = "font:13px/1.5 monospace;tab-size:4;padding:8px;white-space:pre;";
  const lines = h("pre", { "aria-hidden": "true",
    style: "margin:0;padding:9px 6px;text-align:right;color:#94a3b8;user-select:none;overflow:hidden;font:13px/1.5 monospace;background:#f1f5f9;border-radius:6px 0 0 6px" });
  const code = h("div", { style: "will-change:transform" });
  const hl = h("pre", { "aria-hidden": "true", style: `${font}position:absolute;inset:0;margin:0;overflow:hidden;pointer-events:none;border:1px solid transparent;color:#0f172a` }, code);
  const box = h("textarea", { id: "tb-html", wrap: "off", spellcheck: false, "aria-label": "Template HTML", value: tbEdit.templates[tbTpl] ?? defaults[tbTpl],
    style: `${font}position:relative;flex:1;margin:0;min-height:220px;overflow:auto;border-radius:0 6px 6px 0;resize:vertical;background:transparent;color:transparent;caret-color:#0f172a`,
    onscroll: () => sync(),
    oninput: changed((v) => { tbEdit.templates[tbTpl] = v; numberLines(); }) });
  const sync = () => { lines.scrollTop = box.scrollTop; code.style.transform = `translate(${-box.scrollLeft}px,${-box.scrollTop}px)`; };
  const numberLines = () => {
    lines.textContent = Array.from({ length: box.value.split("\n").length }, (_, i) => i + 1).join("\n");
    code.innerHTML = highlightHtml(box.value); sync();
  };
  const insert = (p) => { box.focus(); box.setRangeText(`{{${p}}}`, box.selectionStart, box.selectionEnd, "end"); box.dispatchEvent(new Event("input")); };
  const reopen = () => { renderThemes(); $("#tb-html").closest("details").open = true; };
  numberLines();
  return h("details", { className: "sources", open: Object.keys(tbEdit.templates).length > 0 },
    h("summary", {}, "Advanced HTML"),
    h("p", { className: "hint" }, "Change the HTML of the header, footer, each page layout and the wrapper around every section. Placeholders like {{site.name}} are filled in when the site is built; {{#if name}} … {{/if}} shows its contents only when that placeholder isn't empty. No scripts, forms, event handlers or external files; videos only from YouTube or Vimeo."),
    labelled("Template", h("select", { onchange: (e) => { tbTpl = e.target.value; reopen(); } },
      Object.keys(defaults).map((name) => h("option", { value: name, selected: name === tbTpl }, label(name) + (tbEdit.templates[name] !== undefined ? " (changed)" : ""))))),
    h("div", { className: "inline", style: "flex-wrap:wrap;gap:4px;margin:4px 0 8px", role: "group", "aria-label": "Insert a placeholder" },
      placeholders[tbTpl].map((p) => h("button", { type: "button", title: "Insert at the cursor", onclick: () => insert(p) }, h("code", {}, `{{${p}}}`)))),
    h("div", { style: "display:flex;align-items:stretch" }, lines,
      h("div", { style: "position:relative;display:flex;flex:1;min-width:0;background:#fff;border-radius:0 6px 6px 0" }, hl, box)),
    h("div", { className: "inline", style: "margin-top:8px" },
      h("button", { type: "button", onclick: () => { delete tbEdit.templates[tbTpl]; reopen(); previewThemeDraft(); } }, "Reset to default template")));
}

// Right-click menu for the preview (#156). app/theme-builder-frame.js, injected
// into the preview, reports the clicked element's selectors and styles; the
// menu is rendered here, never inside the page. "Pick element" mode is the
// keyboard way in (and Alt+click).
const tbFrame = () => $("#preview")?.contentWindow;
function setPicking(on, focus = false) {
  tbPicking = on;
  const btn = $("#tb-pick");
  if (btn) { btn.className = on ? "primary" : ""; btn.setAttribute("aria-pressed", String(on)); }
  if (focus && on) $("#preview").focus();
  tbFrame()?.postMessage({ sbTheme: true, type: "pick", on, focus }, "*");
}

window.addEventListener("message", (event) => {
  if (!tbEdit || !tbFrame() || event.source !== tbFrame() || event.data?.sbTheme !== true) return;
  const d = event.data;
  if (d.type === "ready" && tbPicking) setPicking(true);
  if (d.type === "ready" && d.layout && d.layout !== tbLayout && tbHrefs[d.layout]) { tbLayout = d.layout; layoutPanel(); } // followed a link
  if (d.type === "pick-off") { setPicking(false); $("#tb-pick")?.focus(); }
  if (d.type === "element" && Array.isArray(d.selectors) && d.selectors.length) ruleMenu(d);
});

function ruleMenu({ selectors, styles, x, y, layout }) {
  $(".tb-menu")?.remove();
  const back = document.activeElement;
  const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const toggle = (part) => (e) => { part.hidden = !part.hidden; e.currentTarget.setAttribute("aria-expanded", String(!part.hidden)); };
  const pick = (list) => () => { close(); styleRule(list); };
  const choices = h("div", { className: "tb-menu-sub", hidden: true }, selectors.map((s) => h("button", { role: "menuitem", onclick: pick([s]) }, h("code", {}, s))));
  const current = h("dl", { className: "tb-menu-sub", hidden: true }, Object.entries(styles || {}).map(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v))]));
  const menu = h("div", { className: "tb-menu", role: "menu", "aria-label": `Element ${selectors[0]}`,
    onkeydown: (e) => {
      const items = [...menu.querySelectorAll("button")].filter((b) => b.offsetParent);
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      else if (e.key === "Escape" || e.key === "Tab") { close(); (back === document.body ? $("#preview") : back)?.focus(); }
      else return;
      e.preventDefault();
    } },
    h("button", { role: "menuitem", onclick: pick(selectors) }, "Style this element…"),
    LAYOUTS.some((l) => l.id === layout) && h("button", { role: "menuitem", onclick: pick(selectors.map((s) => (s === "body" ? `.layout-${layout}` : `.layout-${layout} ${s}`))) },
      `Style it on ${LAYOUTS.find((l) => l.id === layout).label} pages only…`),
    h("button", { role: "menuitem", "aria-expanded": "false", onclick: toggle(choices) }, "Choose selector…"), choices,
    h("button", { role: "menuitem", "aria-expanded": "false", onclick: toggle(current) }, "Show current styles"), current);
  document.body.append(menu);
  const frame = $("#preview").getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(frame.left + x, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(frame.top + y, innerHeight - menu.offsetHeight - 4))}px`;
  document.addEventListener("mousedown", outside, true);
  menu.querySelector("button").focus();
}

// Selects the existing rule for the first selector that has one, or adds an
// empty one (lib/theme-builder.js cssRule) with the cursor inside.
async function styleRule(selectors) {
  try {
    const r = await call("builder:css-rule", tbEdit.css, selectors);
    const box = $("#tb-css");
    if (!box) return;
    tbEdit.css = box.value = r.css;
    box.closest("details").open = true;
    box.focus();
    box.setSelectionRange(r.found ? r.start : r.cursor, r.found ? r.end : r.cursor);
    const cs = getComputedStyle(box), line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    box.scrollTop = Math.max(0, r.css.slice(0, r.start).split("\n").length * line - box.clientHeight / 3);
    box.scrollIntoView({ block: "nearest" });
  } catch (e) { $("#tb-errors").textContent = errorText(e); }
}

// "Push to repo" commits the theme to a repo the user can write to; "Submit to
// public repo" opens a PR to the public themes repo from the user's fork.
// main.js validates the theme and sends only theme.json, theme.css, its previews and templates.
async function publishDialog(id, t, kind) {
  const status = h("p", { role: "status" }), error = h("p", { className: "error" });
  const close = h("button", { onclick: () => dialog.close() }, "Close");
  const push = kind === "push";
  const repo = h("input", { placeholder: "owner/repo", value: push && settings.github ? await call("github:push-target").catch(() => "") : "" });
  const go = h("button", { className: "primary", onclick: async () => {
    go.disabled = true; error.textContent = ""; status.textContent = push ? "Pushing…" : "Opening a pull request… (making your copy of the themes repository can take a minute)";
    try {
      const r = push ? await call("github:push", id, repo.value) : await call("github:submit", id);
      status.replaceChildren(push ? "Pushed. " : "Pull request opened. PhaseN will review it. ", link(push ? "View on GitHub" : "View pull request", r.url));
      go.remove();
    } catch (e) { status.textContent = ""; error.textContent = errorText(e); go.disabled = false; }
  } }, push ? "Push" : "Open pull request");
  const what = h("div", { className: "about" }, t.preview && h("img", { className: "theme-preview", src: t.preview, alt: "" }),
    h("strong", {}, t.label || id), h("p", { className: "hint" }, t.about, t.version ? ` Version ${t.version}.` : ""));
  const dialog = h("dialog", { className: "publish-theme" },
    h("h2", {}, push ? "Push to a repository" : "Submit to the public themes"),
    what,
    !settings.github ? [
      h("p", {}, "Sign in with GitHub in Settings first."),
      h("div", { className: "inline" }, h("button", { className: "primary", onclick: () => { dialog.close(); openSettings(); } }, "Settings"), close),
    ] : [
      push ? [
        h("p", { className: "hint" }, `Commits theme.json, theme.css, its preview images and any HTML templates to themes/${id}/ in a GitHub repository you can write to.`),
        labelled("Repository", repo, "owner/repo, or owner/repo/folder@branch. Add it as a theme source in Settings to use the theme in other copies of the app."),
        !settings.github.privateRepos && h("p", { className: "hint" }, "For a private repository, sign out and sign in again in Settings with private repositories allowed."),
      ] : [
        h("p", { className: "hint" }, "Opens a pull request to PhaseN-Digital/phasen-sitebuilder-themes from your own copy (fork) of it on GitHub, with this theme's name and description. Once PhaseN accepts it, everyone can choose it under Design."),
        h("p", { className: "hint" }, "Only theme.json, theme.css, its preview images and any HTML templates are sent."),
      ],
      h("div", { className: "inline" }, go, close),
    ],
    status, error);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
