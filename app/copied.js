// Editing copied pages (exact-copy import, lib/mirror.js).
//
// Copy vs theme structure: at import every copied page is parsed once and
// each editable piece gets a data-sb-edit key:
//   "p-…" page content: text blocks and images in the page body. Edits
//         apply to this page only.
//   "s-…" site structure: text and images inside the header, menu, footer
//         or sidebar. Keys come from the element's original text (or image
//         address), so the same menu item or logo has the same key on every
//         page, and an edit is applied to all of them.
// Layout (sections, columns, wrappers) is never tagged, so it can't be
// broken from here. Edits are written into the stored HTML (not the live
// preview DOM, which the page's own scripts have already changed).

const STRUCTURE = [
  "header", "footer", "nav", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]",
  "[data-elementor-type=header]", "[data-elementor-type=footer]", "[data-elementor-type=popup]",
  ".site-header", ".site-footer", "#masthead", "#colophon", ".et-l--header", ".et-l--footer",
  "#main-header", "#main-footer", ".widget-area", ".fl-builder-content[data-type=header]", ".fl-builder-content[data-type=footer]",
].join(",");
// Page-builder text widgets: edited as one rich block rather than per paragraph.
const RICH = ".elementor-widget-text-editor > .elementor-widget-container, .et_pb_text_inner, .fl-rich-text, .wpb_text_column .wpb_wrapper, .brxe-text, .fusion-text";
const TEXT = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,th,td,a,button,.elementor-icon-list-text,.elementor-button-text,.elementor-icon-box-description,.elementor-image-box-description";
// A text leaf may only contain inline content, otherwise editing it could break layout.
const BLOCK = "address,article,aside,blockquote,dd,div,dl,dt,fieldset,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,ul,img,picture,video,iframe,svg,canvas,select,textarea,input";
// Hidden copies (e.g. Elementor's mobile menu) are still tagged: they share keys with the visible one.
const NOT_EDITABLE = "script,style,noscript,template,form,svg,select,textarea";
const ALL_COPY_FILES = () => [...new Set([...site.pages.filter((p) => p.mirror).map((p) => p.file), "404.html"])];

const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const serialize = (doc) => `${doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : ""}${doc.documentElement.outerHTML}`;

function annotateCopy(html) {
  if (html.includes("data-sb-edit=")) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pageKeys = new Set();
  const tag = (el, identity) => {
    if (el.closest(STRUCTURE)) return el.setAttribute("data-sb-edit", `s-${hash(identity)}`);
    let key = `p-${hash(identity)}`;
    for (let n = 2; pageKeys.has(key); n++) key = `p-${hash(identity)}-${n}`;
    pageKeys.add(key);
    el.setAttribute("data-sb-edit", key);
  };
  const free = (el) => !el.closest(NOT_EDITABLE) && !el.parentElement?.closest("[data-sb-edit]") && !el.hasAttribute("data-sb-edit");
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

  // A text widget holding a form (e.g. a contact form shortcode) isn't edited as one block; its text is tagged below.
  for (const el of doc.body.querySelectorAll(RICH)) if (free(el) && text(el) && !el.querySelector(NOT_EDITABLE)) tag(el, `rich|${text(el)}`);
  for (const el of doc.body.querySelectorAll(TEXT)) if (free(el) && text(el) && !el.querySelector(BLOCK)) tag(el, `${el.tagName}|${text(el)}`);
  for (const img of doc.body.querySelectorAll("img")) if (free(img) && img.getAttribute("src")) tag(img, `img|${img.getAttribute("src")}`);
  return serialize(doc);
}

// Tags every copied page right after an exact-copy import.
async function annotateCopiedSite(siteId, log) {
  const { site: s } = await call("sites:get", siteId);
  const files = [...new Set([...s.pages.filter((p) => p.mirror).map((p) => p.file), "404.html"])];
  log("Finding the editable text and images on each page…");
  for (const file of files) {
    const html = await call("mirror:read", siteId, file).catch(() => null);
    const tagged = html && annotateCopy(html);
    if (tagged) await call("mirror:write", siteId, file, tagged);
  }
}

// Edited text keeps its classes and inline formatting (they carry the
// page's design) but loses anything that can run code.
function cleanEdit(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}`, "text/html");
  doc.body.querySelectorAll("script,object,embed,template,link,meta,base").forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*(javascript|vbscript|data):/i.test(value))) el.removeAttribute(name);
    }
  }
  return doc.body.innerHTML;
}

// Edits are applied one at a time so two quick edits can't overwrite each other.
let copyEdits = Promise.resolve();
const copyFailed = (e) => {
  const state = $(".save-state");
  if (state) state.textContent = `Not saved: ${errorText(e)}`;
};
// Undo: per site, each entry is the files one edit wrote and their previous
// HTML (a site-wide edit touches several). Kept in memory only, so it's gone
// after the app restarts; "Revert this page" works from the kept original.
const copyUndo = {};
const UNDO_LIMIT = 20;
function pushCopyUndo(siteId, files) {
  const stack = (copyUndo[siteId] ||= []);
  stack.push(files);
  if (stack.length > UNDO_LIMIT) stack.shift();
  const button = $(".copy-undo");
  if (button && site?.id === siteId) button.disabled = false;
}
function copyRestored(siteId, message) {
  if (site?.id !== siteId) return;
  selectedCopyImage = null;
  renderTab();
  refreshPreview();
  $(".save-state").textContent = message;
}

function applyCopyEdit(key, change) {
  const page = site.pages.find((p) => p.id === pageId);
  const files = key.startsWith("s-") ? ALL_COPY_FILES() : [page.file];
  const siteId = site.id;
  $(".save-state").textContent = files.length > 1 ? "Saving to every page…" : "Saving…";
  copyEdits = copyEdits.then(async () => {
    const before = [];
    for (const file of files) {
      const html = await call("mirror:read", siteId, file).catch(() => null);
      if (!html) continue;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const els = doc.querySelectorAll(`[data-sb-edit="${CSS.escape(key)}"]`);
      if (!els.length) continue;
      els.forEach(change);
      await call("mirror:keep-original", siteId, file);
      await call("mirror:write", siteId, file, serialize(doc));
      before.push({ file, html });
    }
    if (before.length) pushCopyUndo(siteId, before);
    const state = $(".save-state");
    if (state) state.textContent = before.length > 1 ? `Saved on ${before.length} pages` : "All changes saved";
  }).catch(copyFailed);
  return copyEdits;
}

function undoCopyEdit() {
  const siteId = site.id;
  copyEdits = copyEdits.then(async () => {
    const last = copyUndo[siteId]?.pop();
    if (!last) return;
    for (const { file, html } of last) await call("mirror:write", siteId, file, html);
    copyRestored(siteId, last.length > 1 ? `Undone on ${last.length} pages` : "Undone");
  }).catch(copyFailed);
}

// Puts the page's file back as imported, which also drops this page's share
// of site-wide (header/menu/footer) edits. Can itself be undone.
function revertCopiedPage(page) {
  if (!confirm(`Revert "${page.title}" to how it was imported? All changes on this page are lost, including header, menu and footer changes made from any page. Those changes stay on your other pages.`)) return;
  const siteId = site.id;
  copyEdits = copyEdits.then(async () => {
    const original = await call("mirror:original", siteId, page.file).catch(() => null);
    const current = await call("mirror:read", siteId, page.file);
    if (!original || original === current) return copyRestored(siteId, "This page has no changes");
    await call("mirror:write", siteId, page.file, original);
    pushCopyUndo(siteId, [{ file: page.file, html: current }]);
    copyRestored(siteId, "Page reverted");
  }).catch(copyFailed);
}

let selectedCopyImage = null; // { key, alt, src }

function copiedPageCard(page) {
  const imagePanel = selectedCopyImage && h("div", { className: "card" },
    h("div", { className: "card-head" }, h("strong", {}, selectedCopyImage.key.startsWith("s-") ? "Image (on every page)" : "Image"),
      h("button", { className: "icon", title: "Close", onclick: () => { selectedCopyImage = null; renderTab(); } }, "✕")),
    h("div", { className: "image-field" },
      h("img", { className: "thumb", src: selectedCopyImage.src, alt: "" }),
      h("div", { className: "stack" },
        h("input", { value: selectedCopyImage.alt, placeholder: "Describe the image (for screen readers)",
          onchange: (e) => { const alt = e.target.value; selectedCopyImage.alt = alt; applyCopyEdit(selectedCopyImage.key, (el) => el.setAttribute("alt", alt)); } }),
        h("button", { onclick: () => pickFiles(false, async ([file]) => {
          const src = file && (await processImage(file, 1920));
          if (!src) return;
          const { key } = selectedCopyImage;
          await applyCopyEdit(key, (el) => {
            el.setAttribute("src", `/${src}`);
            // Responsive/lazy-load variants would still show the old image.
            for (const a of ["srcset", "sizes", "data-src", "data-srcset", "data-lazy-src", "data-lazy-srcset", "height"]) el.removeAttribute(a);
          });
          selectedCopyImage.src = `preview://${site.id}/${src}`;
          $("#preview").contentWindow.postMessage({ sb: true, type: "image-updated", key, src: `/${src}` }, "*");
          renderTab();
        }) }, "Replace image…"))));
  return [
    h("div", { className: "card" },
      h("strong", {}, page.title), h("p", { className: "hint" }, `Address: ${page.mirror}`),
      h("p", {}, "Click any outlined text in the preview to change it, or click an image to replace it."),
      h("ul", { className: "legend" },
        h("li", {}, h("i", { className: "swatch page" }), "This page's content"),
        h("li", {}, h("i", { className: "swatch site" }), "Header, menu and footer: changes apply to every page")),
      h("p", { className: "hint" }, "Layout and styling come from your original design and can't be changed here."),
      h("div", { className: "inline", style: "margin-top:8px" },
        h("button", { className: "copy-undo", disabled: !copyUndo[site.id]?.length, onclick: undoCopyEdit }, "Undo last change"),
        h("button", { onclick: () => revertCopiedPage(page) }, "Revert this page to the original")),
      h("p", { className: "hint" }, "Reverting also undoes header, menu and footer changes on this page only; they stay on your other pages.")),
    imagePanel,
  ];
}

window.addEventListener("message", (event) => {
  const frame = $("#preview");
  if (!frame || event.source !== frame.contentWindow || !event.data?.sb || !site) return;
  const { type, key, html, alt, src } = event.data;
  if (typeof key !== "string" || !/^[ps]-[a-z0-9-]+$/.test(key)) return;
  if (type === "text" && typeof html === "string") {
    const clean = cleanEdit(html);
    applyCopyEdit(key, (el) => { el.innerHTML = clean; });
  } else if (type === "image") {
    selectedCopyImage = { key, alt: String(alt || ""), src: String(src || "") };
    renderTab();
  }
});
