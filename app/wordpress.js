// Website import (WordPress or any other site), renderer side. Any site can
// come in editable or as an exact copy (lib/mirror.js). Other sites are
// made editable from an exact copy: app/content-detect.js finds each page's
// content and the user checks it in a review step first (#161).
// For editable WordPress imports: WordPress themes are PHP, so they can't run
// on a static Worker: we copy the parts that carry over (name, tagline, logo,
// colours, fonts) onto the closest built-in theme, and bring each page's
// content in as a sanitized "Rich text" section.

const ALLOWED_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "U", "S", "A", "BLOCKQUOTE", "BR", "HR",
  "IMG", "FIGURE", "FIGCAPTION", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "NOSCRIPT", "SVG", "MATH", "TEMPLATE", "BUTTON",
  "INPUT", "SELECT", "TEXTAREA", "LINK", "META", "VIDEO", "AUDIO", "CANVAS", "HEAD", "TITLE"]);
const INLINE_TAGS = new Set(["STRONG", "EM", "B", "I", "U", "S", "A", "BR", "IMG"]);
const SAFE_HREF = /^(https?:|mailto:|tel:|#page:[a-z0-9]+$)/i;
const SAFE_SRC = /^(https?:\/\/|assets\/[a-f0-9]+\.webp$)/i;
// The rich text editor's video placeholder; lib/build.js turns it into a click-to-load player.
const SAFE_VIDEO = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+)$/;

// Allowlist sanitizer. DOMParser documents are inert: nothing in them runs or
// loads. Unknown elements are unwrapped (their text kept), dangerous ones
// dropped with their contents, and every attribute but href/src/alt removed,
// apart from the rich text editor's classes (align-*, a.button) and its video
// placeholder, <div class="video-embed" data-src="…">, for approved hosts only.
// With `base`, relative links and images are resolved against it first.
function cleanFragment(html, base) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
      const tag = child.tagName.toUpperCase();
      if (DROPPED_TAGS.has(tag)) { child.remove(); continue; }
      walk(child);
      const video = tag === "DIV" && child.className === "video-embed" && SAFE_VIDEO.test(child.dataset.src || "") && child.dataset.src;
      if (video) { [...child.attributes].forEach(({ name }) => child.removeAttribute(name)); child.replaceChildren(); child.className = "video-embed"; child.dataset.src = video; continue; }
      if (!ALLOWED_TAGS.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      const gallery = tag === "FIGURE" && (child.classList.contains("wp-block-gallery") || child.classList.contains("gallery-grid"));
      const classes = [...child.classList].filter((c) => /^align-(left|center|right|justify)$/.test(c) || (tag === "A" && c === "button"));
      const keep = tag === "A" ? ["href"] : tag === "IMG" ? ["src", "alt"] : [];
      for (const { name } of [...child.attributes]) if (!keep.includes(name)) child.removeAttribute(name);
      if (classes.length) child.className = classes.join(" ");
      for (const name of base ? ["href", "src"] : []) {
        const value = child.getAttribute(name);
        if (value && !/^[a-z]+:/i.test(value)) try { child.setAttribute(name, new URL(value, base).href); } catch { child.removeAttribute(name); }
      }
      if (tag === "A" && !SAFE_HREF.test(child.getAttribute("href") || "")) child.removeAttribute("href");
      if (tag === "IMG" && !SAFE_SRC.test(child.getAttribute("src") || "")) child.remove();
      if (gallery) child.classList.add("gallery-grid");
    }
  };
  walk(doc.body);
  // Imports: text and images left loose by unwrapped <div>s (a block theme's cover, #24) go in
  // paragraphs, or the rich text editor folds them into the next heading.
  if (base) {
    let p = null;
    for (const n of [...doc.body.childNodes]) {
      if (n.nodeType === Node.ELEMENT_NODE && !INLINE_TAGS.has(n.tagName)) { p = null; continue; }
      if (!p && !n.textContent.trim() && n.nodeName !== "IMG") continue;
      if (!p) n.before((p = doc.createElement("p")));
      p.append(n);
    }
  }
  return doc.body;
}
const sanitizeHtml = (html) => cleanFragment(html).innerHTML.trim();
const plainText = (html) => new DOMParser().parseFromString(String(html || ""), "text/html").body.textContent.trim();

// Any CSS colour → #rrggbb, or null if it isn't a plain opaque colour.
function toHex(value) {
  if (!value) return null;
  const ctx = (toHex.ctx ||= new OffscreenCanvas(1, 1).getContext("2d"));
  ctx.fillStyle = "#000001";
  ctx.fillStyle = value.trim();
  return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) && ctx.fillStyle !== "#000001" ? ctx.fillStyle : null;
}

// Reads WordPress's generated global styles (block themes, WP 5.9+) from the
// home page, falling back to Elementor's global colours and fonts (its kit
// CSS, `kitCss`, fetched by lib/wordpress.js). Classic themes mostly expose
// neither, so they keep the built-in theme's defaults.
function wordpressStyle(home, kitCss = "") {
  const css = [...home.querySelectorAll("style")].map((s) => s.textContent).join("\n");
  const wp = blockThemeStyle(css);
  const el = elementorStyle(css + "\n" + kitCss);
  return {
    colors: Object.fromEntries(Object.entries(wp.colors).map(([k, v]) => [k, v || el.colors[k]])),
    serif: wp.font ? wp.serif : el.serif,
  };
}

const isSerif = (font) => /serif/i.test(font) && !/sans-serif/i.test(font);

function blockThemeStyle(css) {
  const vars = Object.fromEntries([...css.matchAll(/(--wp--preset--[a-z0-9-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
  const resolve = (v) => v?.replace(/var\((--wp--preset--[a-z0-9-]+)\)/g, (_, name) => vars[name] || "").trim();
  const blocks = (re) => [...css.matchAll(re)].map((m) => m[1]).join(";");
  // Last declaration wins, as in CSS: the theme's rules come after WordPress's own defaults.
  const prop = (block, name) => resolve([...block.matchAll(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`, "g"))].pop()?.[1]);

  const body = blocks(/(?:^|[}\s,])(?::root\s+:where\(body\)|body)\s*\{([^}]*)\}/g);
  const button = blocks(/wp-element-button[^{]*\{([^}]*)\}/g);
  const link = blocks(/a:where\(:not\(\.wp-element-button\)\)\s*\{([^}]*)\}/g);
  const preset = (slug) => vars[`--wp--preset--color--${slug}`];
  const font = prop(body, "font-family") || "";
  return {
    colors: {
      background: toHex(prop(body, "background-color") || prop(body, "background")),
      text: toHex(prop(body, "color")),
      primary: toHex(prop(link, "color")) || toHex(preset("primary")) || toHex(preset("accent")),
      // #32373c is WordPress's own default button colour, on every site, so it says nothing about the theme.
      accent: [toHex(prop(button, "background-color"))].find((c) => c !== "#32373c") || toHex(preset("secondary")) || toHex(preset("accent")),
    },
    font,
    serif: isSerif(font),
  };
}

// Elementor's kit: `.elementor-kit-<id>{--e-global-color-primary:…;
// --e-global-typography-primary-font-family:"Fraunces";background-color:…}`.
// Its fonts are bare names with no generic family, so serif is guessed by name.
// ponytail: a short list of common serif web fonts; anything else counts as sans.
const SERIF_NAMES = /serif|georgia|times|garamond|baskerville|playfair|lora|merriweather|fraunces|cormorant|crimson|libre caslon|spectral|cardo|prata|bitter|slab|bodoni|didot|cinzel|literata|noto serif|pt serif|dm serif|eb garamond/i;
function elementorStyle(css) {
  const vars = Object.fromEntries([...css.matchAll(/(--e-global-[a-z0-9-]+)\s*:\s*([^;}]+)/gi)].map((m) => [m[1], m[2].trim()]));
  const resolve = (v) => v?.replace(/var\(\s*(--e-global-[a-z0-9-]+)\s*\)/gi, (_, name) => vars[name] || "").trim();
  const kit = [...css.matchAll(/\.elementor-kit-\d+\s*\{([^}]*)\}/g)].map((m) => m[1]).join(";");
  const prop = (name) => resolve([...kit.matchAll(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`, "g"))].pop()?.[1]);
  const color = (slug) => toHex(vars[`--e-global-color-${slug}`]);
  const font = vars["--e-global-typography-primary-font-family"] || "";
  return {
    colors: {
      background: toHex(prop("background-color")),
      text: toHex(prop("color")) || color("text"),
      primary: color("primary"),
      // Many kits set accent to the primary colour; secondary is then the only other one.
      accent: [color("accent")].find((c) => c && c !== color("primary")) || color("secondary"),
    },
    serif: SERIF_NAMES.test(font) && !/sans/i.test(font),
  };
}

const isDark = (hex) => hex && [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0) / 3 < 100;

// The closest built-in theme for a site's style ({ colors, serif }), with its colours and font.
function themeFrom(style) {
  const id = isDark(style.colors.background) ? "bold" : style.serif ? "elegant" : "clean";
  const theme = THEMES.themes[id];
  return { theme: id, colors: Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [k, style.colors[k] || v])), font: style.serif ? "serif" : theme.font };
}

// Each image downloaded once, through the upload pipeline; null (and counted in `failed`) when it can't be.
// `fetch` gets an image's bytes by absolute URL (app/markdown.js reads local ones through main.js).
function imageFetcher(siteId, base, fetch = (abs) => call("wp:image", abs)) {
  const downloaded = new Map();
  const images = {
    failed: 0,
    get(src, max) {
      let abs;
      try { abs = new URL(src, base).href; } catch { images.failed++; return null; }
      if (!downloaded.has(abs)) {
        downloaded.set(abs, fetch(abs).then(async (bytes) => saveImage(siteId, isSvg(bytes) ? await rasterSvg(bytes, max) : new Blob([bytes]), max))
          .catch(() => { images.failed++; return null; }));
      }
      return downloaded.get(abs);
    },
  };
  return images;
}

// No raster format starts with "<"; SVG (and anything else that's markup) does.
const isSvg = (bytes) => /^\uFEFF?\s*</.test(new TextDecoder().decode(bytes.slice(0, 64)));

// SVG is active content, so it never reaches a site as markup (#282): an <img> draws it, which
// runs no script and loads nothing external, and only the pixels are kept, at `max` on the long side.
async function rasterSvg(bytes, max) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || max, h = img.naturalHeight || max, scale = max / Math.max(w, h);
    const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A page's address, for matching links to imported pages: no trailing slash or index.html.
const pageKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/index\.html?$/i, "").replace(/\/+$/, ""); } catch { return ""; } };

// Sanitized content (cleanFragment with a base) → stored rich text: links to
// imported pages become #page:<id> (links to anything else keep pointing at
// the old site), images are downloaded, or dropped when they can't be.
async function rewriteContent(body, byLink, images) {
  for (const a of body.querySelectorAll("a[href]")) {
    const target = byLink.get(pageKey(a.getAttribute("href")));
    if (target) a.setAttribute("href", `#page:${target}`);
  }
  for (const img of body.querySelectorAll("img")) {
    const src = await images.get(img.getAttribute("src"), 1920);
    if (src) { img.setAttribute("src", src); continue; }
    const figure = img.closest("figure");
    img.remove();
    if (figure && !figure.querySelector("img") && !figure.textContent.trim()) figure.remove();
  }
  return body.innerHTML.trim();
}

// "auto" makes an exact copy when the site uses a page builder (its layout
// lives in the builder, not in content the editable import can read) or when
// there's no usable REST API (including one hidden from visitors when no
// username and application password were given); otherwise it does the editable import.
async function runImport({ url, username, password, mode, declaration }, log) {
  if (mode === "exact") return copySite(url, log, declaration);
  log("Connecting to WordPress…");
  let wp;
  try {
    wp = await call("wp:fetch", url, username, password, declaration);
  } catch (e) {
    if (/refused|https/.test(errorText(e))) throw e;
    if (/Couldn't find a WordPress site/.test(errorText(e))) return importAnySite(url, mode, log, declaration);
    // A hidden API ("needs a username") with no credentials given is treated like a missing one.
    if (mode === "editable") throw e;
    log("Couldn't read the content through WordPress's API, so we'll copy the site exactly as it looks.");
    return copySite(url, log, declaration);
  }
  if (mode === "auto" && wp.builder) {
    log(`This site is built with ${wp.builder}, so we'll copy its design exactly.`);
    return copySite(url, log, declaration);
  }
  return importWordPress(wp, log);
}

let importLogSink = () => {};
onImportLog((line) => importLogSink(line));

async function crawl(url, log, declaration) {
  importLogSink = log;
  try {
    return await call("wp:mirror", url, declaration);
  } finally {
    importLogSink = () => {};
  }
}

async function copySite(url, log, declaration) {
  const id = await crawl(url, log, declaration);
  await annotateCopiedSite(id, log);
  return id;
}

async function importWordPress(wp, log) {
  log(`Found "${plainText(wp.name)}" with ${wp.pages.length} page${wp.pages.length === 1 ? "" : "s"}.`);
  if (wp.skipped?.length) log(`Skipped ${wp.skipped.map((t) => `"${plainText(t)}"`).join(", ")}: shop, log-in and account pages only work on WordPress itself.`);
  const home = new DOMParser().parseFromString(wp.homeHtml, "text/html");

  const { theme, colors, font } = themeFrom(wordpressStyle(home, wp.kitCss));
  const s = await call("sites:create", plainText(wp.name) || "Imported website", theme);
  s.description = plainText(wp.description);
  s.importProvenance = wp.provenance;
  Object.assign(s, { colors, font });
  const images = imageFetcher(s.id, wp.base + "/");

  const logoImg = home.querySelector("img.custom-logo, .wp-block-site-logo img, .elementor-widget-theme-site-logo img, [data-elementor-type=header] img");
  if (logoImg?.getAttribute("src")) {
    log("Copying logo…");
    const src = await images.get(logoImg.getAttribute("src"), 600);
    if (src) s.logo = { src, alt: s.name };
  }

  if (wp.pages.length) {
    // The static front page (if any) becomes Home; WordPress marks it on <body>.
    const frontId = home.body.classList.contains("home") && Number(home.body.className.match(/\bpage-id-(\d+)\b/)?.[1]);
    wp.pages.sort((a, b) => (b.id === frontId) - (a.id === frontId));
    const norm = (u) => { try { return pageKey(new URL(u, wp.base + "/").href); } catch { return ""; } };
    const ids = new Map(wp.pages.map((p) => [p.id, rid()]));
    const byLink = new Map(wp.pages.map((p) => [norm(p.link), ids.get(p.id)]));
    byLink.set(norm(wp.base), ids.get(wp.pages[0].id));

    s.pages = [];
    for (const [i, p] of wp.pages.entries()) {
      log(`Importing page ${i + 1} of ${wp.pages.length}: ${plainText(p.title)}`);
      // The Blog page lib/wordpress.js adds (#180) lists the posts and has nothing of its own.
      const sections = p.layout === "blog-index" && !p.html.trim() ? [] : [{ id: rid(), type: "richtext", html: await rewriteContent(cleanFragment(p.html, wp.base + "/"), byLink, images) }];
      // WordPress forms (Contact Form 7, WPForms…) need PHP; swap in ours. Never for log-in/shop forms (lib/wordpress.js).
      if (p.form) sections.push({ id: rid(), type: "form", heading: "", text: "", formId: "contact", buttonText: "Send" });
      // The old address, so lib/build.js can keep it (or 301 it) and renaming the page doesn't move it.
      let oldPath = null;
      try { oldPath = decodeURIComponent(new URL(p.link, wp.base + "/").pathname); } catch {}
      const page = { id: ids.get(p.id), title: plainText(p.title) || "Untitled", ...(oldPath && { path: oldPath }), sections };
      if (p.layout) page.layout = p.layout;
      if (p.layout === "blog-post") {
        Object.assign(page, { date: p.date, author: plainText(p.author), excerpt: plainText(p.excerpt) });
        const src = p.featuredImage && (await images.get(p.featuredImage.src, 1600));
        if (src) page.featuredImage = { src, alt: plainText(p.featuredImage.alt) };
      }
      s.pages.push(page);
    }
  }

  await call("sites:save", s);
  log(`Done.${imagesFailed(images)}`);
  return s.id;
}

const imagesFailed = ({ failed }) => (failed ? ` ${failed} image${failed === 1 ? "" : "s"} couldn't be copied.` : "");

// ---------- any other website, editable (#161) ----------
// Copied exactly first (lib/mirror.js), so the review step can show each page
// as it looks; on Import the copy is rebuilt as theme pages and its files
// removed. "Decide for me" keeps the exact copy when most pages' content
// couldn't be told apart from their design.
async function importAnySite(url, mode, log, declaration) {
  log("This isn't a WordPress site (or its content API is switched off), so we'll copy it and then find the content on each page.");
  const id = await crawl(url, log, declaration);
  const { site: s } = await call("sites:get", id);
  log("Finding the content on each page…");
  const pages = [];
  for (const page of s.pages) {
    const html = await call("mirror:read", id, page.file).catch(() => null);
    if (html != null) pages.push({ page, doc: new DOMParser().parseFromString(html, "text/html"), include: true });
  }
  const chrome = sharedChrome(pages.map((p) => p.doc));
  for (const p of pages) Object.assign(p, mainContent(p.doc, chrome));
  if (mode === "auto" && pages.filter((p) => p.confidence === "low").length * 2 > pages.length) {
    log("Couldn't tell the content apart from the design on most pages, so we'll keep an exact copy.");
    await annotateCopiedSite(id, log);
    return id;
  }
  // Home first (the crawl starts there), then the site menu's order, then the rest.
  const origin = s.importProvenance.source;
  const menu = menuLinks(pages[0].doc, chrome).map((href) => { try { return pageKey(new URL(href, origin + pages[0].page.mirror).href); } catch { return ""; } });
  const rank = (p) => { const i = menu.indexOf(pageKey(origin + p.page.mirror)); return p === pages[0] ? -1 : i < 0 ? menu.length : i; };
  pages.sort((a, b) => rank(a) - rank(b));
  return reviewImport(s, pages, chrome);
}

// The review step: each page's preview with its detected content outlined
// (app/content-pick-frame.js), a different block chosen by clicking it, pages
// left out by unticking them. Resolves to the site id, or null if cancelled.
const PICKED = /^body( > [a-z][a-z0-9-]*:nth-child\(\d+\))*$/;
function reviewImport(s, pages, chrome) {
  return new Promise((resolve) => {
    let current, style = null;
    const frame = h("iframe", { id: "review-frame", title: "Page preview" });
    const status = h("pre", { className: "log", hidden: true });
    const error = h("p", { className: "error" });
    const note = (p) => (p.confidence === "chosen" ? "Your choice" : p.confidence === "low" ? "Check this page" : "");
    const items = pages.map((p) => h("li", { onclick: () => show(p) },
      h("input", { type: "checkbox", checked: true, title: "Import this page", onclick: (e) => e.stopPropagation(), onchange: (e) => { p.include = e.target.checked; } }),
      h("span", {}, h("b", {}, p.page.title), h("small", {}, p.page.mirror)),
      h("span", { className: "badge" }, note(p))));
    const show = (p) => {
      current = p;
      items.forEach((li, i) => li.classList.toggle("active", pages[i] === p));
      frame.src = `preview://${s.id}${p.page.mirror}?sb-pick=${encodeURIComponent(p.selector)}`;
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow || e.data?.sb !== true) return;
      if (e.data.type === "pick" && PICKED.test(e.data.selector || "")) {
        Object.assign(current, { selector: e.data.selector, confidence: "chosen" });
        items[pages.indexOf(current)].querySelector(".badge").textContent = note(current);
      }
      // ponytail: the first page shown is Home, so its colours are the site's; a page switched to before it loads is ignored.
      if (e.data.type === "style" && current === pages[0] && !style) style = e.data;
    };
    window.addEventListener("message", onMessage);
    const done = (id) => { window.removeEventListener("message", onMessage); resolve(id); };
    const busy = (fn) => async (e) => {
      const buttons = [...e.target.closest(".review-actions").querySelectorAll("button")];
      buttons.forEach((b) => { b.disabled = true; });
      error.textContent = "";
      status.hidden = false;
      const log = (line) => { status.textContent += line + "\n"; status.scrollTop = status.scrollHeight; };
      try { done(await fn(log)); } catch (err) { error.textContent = errorText(err); buttons.forEach((b) => { b.disabled = false; }); }
    };
    $("#main").replaceChildren(h("div", { className: "review-wrap" },
      h("div", { className: "review-side" },
        h("h1", {}, "Check what gets imported"),
        h("p", { className: "hint" }, "The content we found on each page is outlined in blue. The header, menu, footer and anything else on every page are left out: your new theme has its own. Click a different block to import that instead, or untick a page to leave it out."),
        h("ul", { className: "review-pages" }, items),
        error, status,
        h("div", { className: "review-actions" },
          h("button", { onclick: busy(async () => { await call("sites:delete", s.id, false); return null; }) }, "Cancel"),
          h("button", { onclick: busy(async (log) => { await annotateCopiedSite(s.id, log); return s.id; }) }, "Keep an exact copy"),
          h("button", { className: "primary", onclick: busy((log) => rebuildEditable(s, pages, chrome, style, log)) }, "Import"))),
      h("div", { className: "review-preview" },
        h("div", { className: "preview-bar" },
          h("span", {}, "Click the block that holds this page's content"),
          h("button", { onclick: () => frame.contentWindow?.postMessage({ sb: true, type: "widen" }, "*") }, "Choose the block around it")),
        frame)));
    show(pages[0]);
  });
}

// The review frame's computed style → { colors, serif } for themeFrom.
// Browser defaults (unstyled links and buttons) say nothing about the design.
function frameStyle(st) {
  if (!st) return { colors: {}, serif: false };
  const link = toHex(st.link), button = toHex(st.button);
  const first = String(st.font || "").split(",")[0].replace(/["']/g, "").trim();
  return {
    colors: {
      background: [].concat(st.background).map((c) => toHex(String(c || ""))).find(Boolean) || null,
      text: toHex(String(st.text || "")),
      primary: link !== "#0000ee" ? link : null,
      accent: button !== "#efefef" ? button : null,
    },
    serif: SERIF_NAMES.test(first) && !/sans/i.test(first),
  };
}

async function rebuildEditable(s, pages, chrome, style, log) {
  const kept = pages.filter((p) => p.include);
  if (!kept.length) throw new Error("Choose at least one page to import.");
  const origin = s.importProvenance.source;
  Object.assign(s, themeFrom(frameStyle(style)));
  const images = imageFetcher(s.id, origin + "/");
  const logo = logoSrc(pages[0].doc, chrome);
  if (logo) {
    log("Copying logo…");
    const src = await images.get(new URL(logo, origin + pages[0].page.mirror).href, 600);
    if (src) s.logo = { src, alt: s.name };
  }
  const ids = new Map(kept.map((p) => [p, rid()]));
  const byLink = new Map(kept.map((p) => [pageKey(origin + p.page.mirror), ids.get(p)]));
  const forms = new Set();
  const out = [];
  for (const [i, p] of kept.entries()) {
    log(`Importing page ${i + 1} of ${kept.length}: ${p.page.title}`);
    const el = p.doc.querySelector(p.selector) || p.doc.body;
    const sections = [];
    for (const { html } of toSections(el, chrome, origin + p.page.mirror)) sections.push({ id: rid(), type: "richtext", html: await rewriteContent(cleanFragment(html), byLink, images) });
    // An enquiry form in the content (lib/mirror.js wired it up) becomes our form section; ones in the chrome (newsletters) go.
    const shared = chromeIn(el, chrome);
    const form = [...el.querySelectorAll("form[data-form]")].find((f) => !shared.some((c) => c.contains(f)))?.dataset.form;
    if (form && s.forms.some((f) => f.id === form)) {
      sections.push({ id: rid(), type: "form", heading: "", text: "", formId: form, buttonText: "Send" });
      forms.add(form);
    }
    // The old address, kept by lib/build.js (or 301ed) as for an editable WordPress import (#72).
    out.push({ id: ids.get(p), title: p.page.title || "Untitled", path: p.page.mirror, sections });
  }
  s.pages = out;
  // Our form editor has no choice fields, so a copied checkbox group becomes a text answer.
  s.forms = s.forms.filter((f) => forms.has(f.id)).map(({ mirrored, shownOn, ...f }) => ({ ...f, fields: f.fields.map((x) => ({ ...x, type: x.type === "choice" ? "text" : x.type })) }));
  delete s.mirror;
  await call("sites:save", s);
  await call("mirror:discard", s.id);
  log(`Done.${imagesFailed(images)}`);
  return s.id;
}

// ---------- ownership declaration (#141) ----------
// Wording reviewed alongside the privacy page (#30); not legal advice.
const DECLARATION = "I confirm I own this website, or have the owner's written permission to copy and republish it";
const importedSite = (s) => Boolean(s.importProvenance || s.mirror || s.pages.some((p) => p.path));
const originOf = (url) => { try { return new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).origin; } catch { return ""; } };

// The modal shown before every import, and once for sites imported before it
// existed (`legacy`, which also asks where the site came from). Resolves to the
// declaration main.js requires ({ confirmed, statement, token, url }), or null.
// `local`: files on this computer (Markdown, #255), with no website to verify.
function declarationDialog({ url = "", legacy = false, local = false } = {}) {
  return new Promise((resolve) => {
    const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const source = h("input", { name: "source", required: true, placeholder: "https://example.com", value: url });
    const file = h("code", {});
    const showFile = () => { file.textContent = `${originOf(source.value) || "https://your-website"}/phasen-verify-${token}.txt`; };
    source.addEventListener("input", showFile);
    showFile();
    const ok = h("button", { className: "primary", value: "ok", disabled: true }, legacy ? "Confirm" : "Import website");
    const box = h("input", { type: "checkbox", onchange: () => { ok.disabled = !box.checked; } });
    const dialog = h("dialog", { className: "declaration" },
      h("form", { method: "dialog" },
        h("h2", {}, legacy ? "Confirm you own this website" : "Before you import"),
        legacy && h("p", {}, "This website was imported before Site Builder asked for an ownership declaration. Confirm that you own it, or have permission to copy it, before you publish it again."),
        legacy ? labelled("Address of the website it was copied from", source) : h("p", {}, "Importing ", h("b", {}, url), "."),
        h("div", { className: "warn" }, "Only import a website you own, or one whose owner has given you written permission to copy and republish it. Copying a website you don't have rights to can infringe copyright, trademarks and database rights, and you're responsible for what you publish. This isn't legal advice."),
        h("label", { className: "declare" }, box, " ", DECLARATION),
        h("p", { className: "hint" }, "Every published page will say it was made with PhaseN Site Builder and imported from this address, with the import date, and /.well-known/phasen-provenance.json will list the address, date, app version and whether ownership was verified. Your name and email are never published; they're kept with the website on this computer, with your declaration."),
        !local && h("details", {},
          h("summary", {}, "Verify that you own it (optional)"),
          h("p", { className: "hint" }, "We check automatically: it's verified if the domain is in your connected Cloudflare account, or if you import a WordPress site with an application password. Or put a file at this address before you continue, containing just ", h("code", {}, token), ": ", file)),
        h("div", { className: "inline", style: "justify-content:flex-end;margin-top:16px" },
          h("button", { value: "" }, "Cancel"), ok)));
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "ok" && box.checked ? { confirmed: true, statement: DECLARATION, token, url: legacy ? source.value : url } : null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Sites imported before #141 are asked once per session when opened; the Publish tab asks again (`force`).
const declarationAsked = new Set();
async function askDeclaration(force) {
  const s = site;
  if (!s || s.importProvenance || !importedSite(s) || (!force && declarationAsked.has(s.id))) return;
  declarationAsked.add(s.id);
  const declaration = await declarationDialog({ legacy: true });
  if (!declaration) return;
  try {
    s.importProvenance = await call("import:declare", s.id, declaration.url, declaration);
  } catch (e) {
    return alert(errorText(e));
  }
  if (site === s && tab === "publish") renderTab();
}

function renderImport() {
  const status = h("pre", { className: "log", hidden: true });
  const error = h("p", { className: "error" });
  const form = h("form", { className: "import", onsubmit: async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true; error.textContent = "";
    const values = Object.fromEntries(new FormData(form));
    const declaration = await declarationDialog({ url: values.url });
    if (!declaration) { button.disabled = false; return; }
    status.hidden = false; status.textContent = "";
    try {
      const id = await runImport({ ...values, declaration }, (line) => { status.textContent += line + "\n"; status.scrollTop = status.scrollHeight; });
      if (!id) return renderImport(); // the review step was cancelled
      await openSite(id);
    } catch (err) {
      error.textContent = errorText(err);
      button.disabled = false;
      loadSites();
    }
  } },
    h("h1", {}, "Import a website"),
    h("p", { className: "hint" }, "Creates a new website from one you own. The original website isn't changed."),
    labelled("Website address", h("input", { name: "url", required: true, placeholder: "https://example.com" })),
    h("fieldset", { className: "modes" }, h("legend", {}, "How should we copy it?"),
      [["auto", "Decide for me", "Editable when we can tell each page's content apart from its design, otherwise an exact copy. Always an exact copy for WordPress sites built with Elementor, Divi and other page builders."],
       ["editable", "Editable content", "Pages are rebuilt in one of our themes so you can edit everything here. Layouts aren't kept. For sites not made with WordPress, you check what we found on each page before importing."],
       ["exact", "Exact copy of the design", "Every page looks exactly as it does now, including menus and styles. The text of copied pages can't be edited here."]]
        .map(([value, label, about]) => h("label", {}, h("input", { type: "radio", name: "mode", value, checked: value === "auto" }), h("span", {}, h("b", {}, label), h("br"), h("small", {}, about))))),
    labelled("WordPress username (optional)", h("input", { name: "username", autocomplete: "off" })),
    labelled("WordPress application password (optional)", h("input", { name: "password", type: "password", autocomplete: "off" }),
      "Only needed for an editable import when your site hides its content from visitors. In WordPress go to Users › Profile › Application Passwords, add one named \"Site Builder\" and paste it here. It's used once and not saved, and it also verifies that you own the site."),
    h("button", { className: "primary big" }, "Import website"),
    error,
    status);
  $("#main").replaceChildren(h("div", { className: "import-wrap" }, form, markdownImportCard())); // app/markdown.js (#255)
}

$("#import-wp").addEventListener("click", async () => {
  await leaveSite(null); // in the site switcher, not the top bar's app screens
  renderImport();
});
