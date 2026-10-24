// The whole editor UI. State lives in `site`; text inputs mutate it in place
// (so typing never loses focus), structural changes call renderTab().
const { call, onPublishLog, onImportLog } = window.cms;

let THEMES, site, publishedUrl, canUnpublish, paths = {}, settings;
let tab = "design", pageId = null, formId = null, previewMobile = false, publishing = false, publishLog = "";
const $ = (sel) => document.querySelector(sel);
const rid = () => Math.random().toString(16).slice(2, 10);
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
let saveTimer;
function save() {
  $(".save-state").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      paths = await call("sites:save", site);
      $(".save-state").textContent = "All changes saved";
      refreshPreview();
      document.querySelector(`#site-list [data-id="${site.id}"]`).textContent = site.name || "Untitled";
    } catch (e) {
      $(".save-state").textContent = `Not saved: ${errorText(e)}`;
    }
  }, 400);
}

function refreshPreview() {
  const frame = $("#preview");
  const editingCopy = tab === "pages" && site.pages.find((p) => p.id === pageId)?.mirror;
  if (frame) frame.src = `preview://${site.id}${paths[pageId] || "/"}?t=${Date.now()}${editingCopy ? "&sb-edit" : ""}`;
}

// ---------- sites ----------
async function loadSites(activeId) {
  const sites = await call("sites:list");
  $("#site-list").replaceChildren(
    ...sites.map((s) => h("button", { className: s.id === activeId ? "active" : "", "data-id": s.id, onclick: () => openSite(s.id) }, s.name || "Untitled"))
  );
}

async function openSite(id) {
  clearTimeout(saveTimer);
  publishLog = "";
  ({ site, url: publishedUrl, canUnpublish } = await call("sites:get", id));
  pageId = site.pages[0].id;
  formId = site.forms[0]?.id;
  paths = await call("sites:save", site);
  THEMES = await call("themes"); // the build registers a theme source's font
  await loadSites(id);
  renderEditor();
}

$("#new-site").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.name.value;
  e.target.reset();
  const created = await call("sites:create", name, "clean");
  await openSite(created.id);
});

// ---------- layout ----------
function renderEditor() {
  const tabs = [["design", "Design"], ["pages", "Pages"], ["forms", "Forms"], ["publish", "Publish"]];
  $("#main").replaceChildren(
    h("section", { className: "editor-panel" },
      h("header", { className: "panel-head" },
        h("div", { className: "row" }, h("h1", {}, site.name), h("span", { className: "save-state" }, "All changes saved")),
        h("div", { className: "tabs" }, tabs.map(([id, label]) =>
          h("button", { className: tab === id ? "active" : "", onclick: () => { tab = id; selectedCopyImage = null; renderEditor(); } }, label)))),
      h("div", { className: "panel-body", id: "tab" })),
    h("section", { className: `preview${previewMobile ? " mobile" : ""}` },
      h("div", { className: "preview-bar" },
        h("span", {}, "Preview (forms send once published)"),
        h("button", { className: previewMobile ? "" : "primary", onclick: () => { previewMobile = false; renderEditor(); } }, "Desktop"),
        h("button", { className: previewMobile ? "primary" : "", onclick: () => { previewMobile = true; renderEditor(); } }, "Mobile")),
      h("div", { className: "preview-stage" }, h("iframe", { id: "preview", title: "Website preview" })))
  );
  renderTab();
  refreshPreview();
}

function renderTab() {
  const body = $("#tab");
  const scroll = body.scrollTop;
  const content = { design: designTab, pages: pagesTab, forms: formsTab, publish: publishTab }[tab]();
  body.replaceChildren(...content.flat(Infinity).filter((k) => k != null && k !== false));
  body.scrollTop = scroll;
}

// ---------- Design ----------
function designTab() {
  const { themes, fonts } = THEMES;
  return [
    site.mirror && h("div", { className: "warn" }, "Pages copied from WordPress keep their original design. These settings only apply to pages you add here."),
    text("Website name", site, "name"),
    area("Short description", site, "description", "Shown under your site's name in Google search results."),
    text("Google Analytics measurement ID (optional)", site, "analyticsId", "Looks like G-XXXXXXXXXX, from Admin › Data streams in Google Analytics. Visitors are asked to accept analytics cookies first, and your privacy page explains them." +
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
    themeSourcesSettings(),
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
    h("small", {}, t.about));
}

// Themes from theme sources (#58, main.js listSources). Choosing one copies it
// into the site folder; "Update theme" fetches the source again.
let SOURCES = [], sourcesOpen = false, themeNote = "";
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
      h("p", { className: "hint", style: "margin:12px 0 6px" }, `From ${src.spec}`),
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
      h("span", { className: "hint" }, `"${current?.label || site.theme}" from ${site.themeSource}${current?.version ? `, version ${current.version}` : ""}. A copy is kept with your website.`)),
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
    SOURCES.map((src) => {
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
      return [richTextEditor(s)];
    case "form":
      return [select("Which form", s, "formId", site.forms.map((f) => [f.id, f.name])), text("Heading", s, "heading"), area("Text above the form", s, "text"), text("Button text", s, "buttonText"),
        h("p", { className: "hint" }, "Edit the form's questions in the Forms tab.")];
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
      h("button", { onclick: () => {
        const p = { id: rid(), title: "New page", sections: [{ id: rid(), type: "text", ...SECTION_TYPES.text.make() }] };
        site.pages.push(p); pageId = p.id; save(); renderTab();
      } }, "+ Add page")),
    copied || [h("div", { className: "card" },
      text("Page name", page, "title", index === 0 ? "This is your home page. Its name appears in the menu." : "Appears in the menu and the page address."),
      h("div", { className: "inline" },
        h("button", { disabled: index === 0, onclick: () => move(site.pages, index, -1) }, "Move left in menu"),
        h("button", { disabled: index === site.pages.length - 1, onclick: () => move(site.pages, index, 1) }, "Move right"),
        h("button", { className: "danger", disabled: site.pages.length === 1, onclick: () => {
          if (!confirm(`Delete the "${page.title}" page?`)) return;
          site.pages.splice(index, 1); pageId = site.pages[0].id; save(); renderTab();
        } }, "Delete page")),
      index === 0 && h("p", { className: "hint", style: "margin-top:8px" }, "The first page in the menu is always the home page.")),
    seoCard(page, index),
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

// Search and sharing settings for a page (#74). The share image is picked
// from images already uploaded to the site; the logo is the default.
function seoCard(page, index) {
  const images = [...new Set(JSON.stringify(site).match(/assets\/[\w.-]+/g) || [])];
  const fallbackTitle = index === 0 ? site.name : `${page.title} | ${site.name}`;
  const pick = (src) => { if (src) page.shareImage = src; else delete page.shareImage; save(); renderTab(); };
  return h("div", { className: "card" },
    h("strong", {}, "Search and sharing"),
    text("Title in search results", page, "seoTitle", "Leave blank to use the page name and website name.", { placeholder: fallbackTitle }),
    area("Description in search results", page, "seoDescription", "Leave blank to use the website's short description (Design tab)."),
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
    h("p", { className: "hint" }, used.length ? `Shown on: ${used.join(", ")}` : "Not on any page yet. Add a Form section in the Pages tab to show it."),
    text("Form name", form, "name", "Used in the email subject so you know which form was filled in."),
    text("Send messages to", form, "to", "Leave blank to use the address in Publish › Form messages.", { type: "email", placeholder: settings.email || "you@example.com" }),
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

// ---------- Publish ----------
function step(title, done, ...content) {
  return h("div", { className: `step${done ? " done" : ""}` }, h("h3", {}, title), content);
}

function secretInput(placeholder, channel, button) {
  const input = h("input", { type: "password", placeholder });
  const error = h("p", { className: "error" });
  const btn = h("button", { className: "primary", onclick: async () => {
    btn.disabled = true; error.textContent = "";
    try { settings = await call(channel, input.value); renderTab(); }
    catch (e) { error.textContent = errorText(e); btn.disabled = false; }
  } }, button);
  return [h("div", { className: "inline" }, input, btn), error];
}

const link = (label, url) => h("a", { onclick: () => call("open", url) }, label);

function publishTab() {
  const cfDone = Boolean(settings.cloudflare);
  let zones = [];
  const domainSelect = h("select", { disabled: !cfDone, onchange: (e) => {
    const zone = zones.find((z) => z.id === e.target.value);
    site.domain = zone || null; save(); renderTab();
  } }, h("option", { value: "" }, "Free address (…workers.dev)"),
    site.domain && h("option", { value: site.domain.id, selected: true }, site.domain.name));
  if (cfDone) call("zones").then((z) => {
    zones = z;
    domainSelect.append(...z.filter((zone) => zone.id !== site.domain?.id).map((zone) => h("option", { value: zone.id }, zone.name)));
  }).catch(() => {});

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
    ({ url: publishedUrl, canUnpublish } = await call("sites:get", site.id));
    if (ok) renderTab();
  };
  const publishBtn = h("button", { className: "primary big", disabled: publishing || !cfDone || !settings.resend, onclick: () => run(publishBtn, async () => {
    clearTimeout(saveTimer);
    paths = await call("sites:save", site);
    await call("sites:publish", site.id);
  }) }, publishedUrl ? "Publish changes" : "Publish website");
  const unpublishBtn = canUnpublish && h("button", { disabled: publishing || !cfDone, onclick: () => {
    if (confirm(`Take "${site.name}" offline? This deletes the website from Cloudflare, along with its www redirect and form keys. You can publish it again later.`)) run(unpublishBtn, async () => {
      await call("sites:unpublish", site.id);
    });
  } }, "Take website offline");

  // The delete confirmation, with the choice to take the live site down too (#71).
  const offline = h("input", { type: "checkbox", checked: Boolean(canUnpublish && cfDone), disabled: !canUnpublish || !cfDone });
  const deleteDialog = h("dialog", {},
    h("form", { method: "dialog" },
      h("p", {}, h("b", {}, `Delete "${site.name}" from this computer?`)),
      canUnpublish && h("label", {}, offline, " Also take it offline (deletes it from Cloudflare, with its www redirect and form keys)"),
      canUnpublish && !cfDone && h("p", { className: "hint" }, "Connect Cloudflare above to take it offline too."),
      h("div", { className: "inline", style: "justify-content:flex-end;margin-top:16px" },
        h("button", { value: "" }, "Cancel"), h("button", { className: "danger", value: "delete" }, "Delete"))));
  const deleteBtn = h("button", { className: "danger", disabled: publishing, onclick: () => { deleteDialog.returnValue = ""; deleteDialog.showModal(); } }, "Delete this website");
  deleteDialog.addEventListener("close", () => {
    if (deleteDialog.returnValue !== "delete") return;
    run(deleteBtn, async () => {
      clearTimeout(saveTimer);
      await call("sites:delete", site.id, offline.checked); // with offline set, nothing local is deleted unless taking it offline worked
      site = null;
      $("#main").replaceChildren(h("div", { className: "welcome" }, h("h1", {}, "Website deleted")));
      loadSites();
    });
  });

  return [
    publishedUrl && h("div", { className: "live" }, "Your website is live at ", link(publishedUrl, publishedUrl)),
    step("1. Cloudflare (hosting)", cfDone,
      cfDone
        ? [
            settings.cloudflare.accounts.length > 1 && labelled("Account", h("select", { onchange: async (e) => { settings = await call("settings:account", e.target.value); renderTab(); } },
              settings.cloudflare.accounts.map((a) => h("option", { value: a.id, selected: a.id === settings.cloudflare.accountId }, a.name)))),
            settings.cloudflare.warnings?.map((w) => h("div", { className: "warn" }, w)),
            h("button", { onclick: async () => { settings = await call("settings:disconnect", "cloudflare"); renderTab(); } }, "Disconnect"),
          ]
        : [
            h("ol", {},
              h("li", {}, "Create a free account at ", link("cloudflare.com", "https://dash.cloudflare.com/sign-up"), " (skip if you have one)."),
              h("li", {}, "Open ", link("API Tokens", "https://dash.cloudflare.com/profile/api-tokens"), " and click ", h("b", {}, "Create Token"), "."),
              h("li", {}, "Next to ", h("b", {}, "Edit Cloudflare Workers"), " click ", h("b", {}, "Use template"), "."),
              h("li", {}, "Click ", h("b", {}, "+ Add more"), " and add ", h("b", {}, "Account · Turnstile · Edit"), ", ", h("b", {}, "Zone · DNS · Edit"), " and ", h("b", {}, "Zone · Single Redirect · Edit"), " (called Dynamic Redirect on some accounts)."),
              h("li", {}, "Set Account Resources and Zone Resources to ", h("b", {}, "All"), ", then ", h("b", {}, "Continue to summary › Create Token"), "."),
              h("li", {}, "Copy the token and paste it here.")),
            secretInput("Paste your Cloudflare API token", "settings:cloudflare", "Connect"),
          ]),
    step("2. Resend (sends your form emails)", settings.resend,
      settings.resend
        ? h("button", { onclick: async () => { settings = await call("settings:disconnect", "resend"); renderTab(); } }, "Disconnect")
        : [
            h("ol", {},
              h("li", {}, "Create a free account at ", link("resend.com", "https://resend.com/signup"), "."),
              h("li", {}, "Open ", link("API Keys", "https://resend.com/api-keys"), ", click ", h("b", {}, "Create API Key"), " and choose ", h("b", {}, "Full access"), "."),
              h("li", {}, "Copy the key and paste it here.")),
            secretInput("Paste your Resend API key", "settings:resend", "Connect"),
          ]),
    step("3. Form messages", Boolean(settings.email),
      labelled("Send form messages to", h("input", { type: "email", value: settings.email, placeholder: "you@example.com",
        onchange: async (e) => { settings = await call("settings:email", e.target.value); renderTab(); } }),
        site.domain ? "" : "Until you use your own domain, this must be the same email you signed up to Resend with.")),
    step("4. Web address", false,
      labelled("Domain", domainSelect,
        site.domain
          ? `Your site will be at https://${site.domain.name}. Email records are added for you automatically.`
          : ["To use your own domain, first ", link("add it to Cloudflare", "https://dash.cloudflare.com/?to=/:account/add-site"), ", then come back here."])),
    paths.privacy && step("5. Privacy page", Boolean(site.privacy?.owner),
      h("p", {}, "Because your site has a form or analytics, it gets a privacy page at ", h("b", {}, `${publishedUrl || ""}${paths.privacy}`), ". ",
        site.mirror ? "Copied pages keep their own footer, so add a link to it there if you can." : "It's linked from the footer of every page.",
        " It uses the email address form messages are sent to."),
      h("div", { className: "warn" }, "This is a starting point, not legal advice. Read it and check it matches how you handle people's information.",
        site.mirror ? " Copied pages may also load other services (analytics, maps, videos) that it doesn't mention." : ""),
      text("Business or legal name", site.privacy ||= {}, "owner", "Who's responsible for the information people send, e.g. \"Smith Plumbing Ltd\" or \"Jane Smith, trading as Smith Plumbing\". Leave blank to use the website name.", { placeholder: site.name }),
      area("How long you keep messages", site.privacy, "retention", "Leave blank to say you keep them only as long as you need to deal with the enquiry."),
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
  const u = await call("update:check").catch(() => null);
  if (!u || u.version === dismissedUpdate) return;
  $("#update-banner")?.remove();
  $(".sidebar").append(h("div", { id: "update-banner", className: "update-banner", role: "status" },
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
})();
