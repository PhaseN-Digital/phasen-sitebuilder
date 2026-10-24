// Theme Builder UI (#130), opened from "Themes…" in the sidebar. Themes are
// made from a few controls by lib/theme-builder.js (via main.js "builder:*")
// and saved to the user's local themes, which the Design tab lists under
// "Your themes". Uses app.js's helpers (h, call, labelled, loadSites…).

let tbThemes = {}, tbSites = [], tbEdit = null, tbOn = "", tbTimer;

async function openThemes() {
  clearTimeout(saveTimer);
  site = null;
  tbEdit = null;
  loadSites();
  [tbThemes, tbSites] = await Promise.all([call("builder:list"), call("sites:list")]);
  renderThemes();
}
$("#open-themes").addEventListener("click", openThemes);

function renderThemes() {
  if (tbEdit) return renderThemeEditor();
  const from = h("select", {}, tbSites.map((s) => h("option", { value: s.id }, s.name || "Untitled")));
  $("#main").replaceChildren(h("div", { className: "import-wrap" }, h("div", { className: "import theme-list" },
    h("h1", {}, "Your themes"),
    h("p", { className: "hint" }, "Make your own themes here, separately from any website. They appear in every website's Design tab under \"Your themes\"."),
    h("div", { className: "inline", style: "margin:16px 0" }, h("button", { className: "primary", onclick: async () => editTheme(await call("builder:new")) }, "New theme")),
    tbSites.length > 0 && h("div", { className: "inline", style: "align-items:center;margin-bottom:16px" }, h("span", { style: "white-space:nowrap" }, "New theme from a website's design:"), from,
      h("button", { onclick: async () => editTheme(await call("builder:from-site", from.value)) }, "Start")),
    h("div", { className: "themes" }, Object.entries(tbThemes).map(([id, t]) => h("div", { className: "theme card" },
      t.preview && h("img", { className: "theme-preview", src: t.preview, alt: "" }),
      h("strong", {}, t.label || id),
      t.errors.length ? h("p", { className: "error" }, t.errors.join("; ")) : [
        h("div", { className: "swatches" }, Object.values(t.colors).map((c) => h("i", { style: `background:${c}` }))),
        h("small", {}, t.about, t.version ? ` Version ${t.version}.` : "")],
      h("div", { className: "inline", style: "margin-top:8px" },
        t.controls && h("button", { onclick: () => editTheme({ ...t.controls, id }) }, "Edit"),
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
      $("#tb-errors").textContent = r.errors.length ? `Advanced CSS can't be used: ${r.errors.join("; ")}` : "";
      if (!r.errors.length) $("#preview").src = `preview://${r.id}/?t=${Date.now()}`;
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
        h("details", { className: "sources", open: Boolean(c.css) },
          h("summary", {}, "Advanced CSS"),
          labelled("", h("textarea", { style: "font-family:monospace;min-height:160px", value: c.css, spellcheck: false, oninput: changed((v) => { c.css = v; }) }),
            "Added after the controls above. Plain CSS only: no @import, scripts or HTML.")),
        h("p", { className: "error", id: "tb-errors" }))),
    h("section", { className: `preview${previewMobile ? " mobile" : ""}` },
      h("div", { className: "preview-bar" },
        h("span", {}, "Preview with"),
        h("select", { style: "width:auto", onchange: (e) => { tbOn = e.target.value; previewThemeDraft(); } },
          h("option", { value: "" }, "Sample content"), tbSites.map((s) => h("option", { value: s.id, selected: tbOn === s.id }, s.name || "Untitled"))),
        h("button", { className: previewMobile ? "" : "primary", onclick: () => { previewMobile = false; renderThemes(); previewThemeDraft(); } }, "Desktop"),
        h("button", { className: previewMobile ? "primary" : "", onclick: () => { previewMobile = true; renderThemes(); previewThemeDraft(); } }, "Mobile")),
      h("div", { className: "preview-stage" }, h("iframe", { id: "preview", title: "Theme preview" }))));
}
