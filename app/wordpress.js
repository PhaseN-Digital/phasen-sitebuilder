// WordPress import, renderer side. WordPress themes are PHP, so they can't run
// on a static Worker: we copy the parts that carry over (name, tagline, logo,
// colours, fonts) onto the closest built-in theme, and bring each page's
// content in as a sanitized "Rich text" section.

const ALLOWED_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "U", "S", "A", "BLOCKQUOTE", "BR", "HR",
  "IMG", "FIGURE", "FIGCAPTION", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "NOSCRIPT", "SVG", "MATH", "TEMPLATE", "BUTTON",
  "INPUT", "SELECT", "TEXTAREA", "LINK", "META", "VIDEO", "AUDIO", "CANVAS", "HEAD", "TITLE"]);
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

// "auto" makes an exact copy when the site uses a page builder (its layout
// lives in the builder, not in content the editable import can read) or when
// there's no usable REST API (including one hidden from visitors when no
// username and application password were given); otherwise it does the editable import.
async function runImport({ url, username, password, mode }, log) {
  if (mode === "exact") return copySite(url, log);
  log("Connecting to WordPress…");
  let wp;
  try {
    wp = await call("wp:fetch", url, username, password);
  } catch (e) {
    // A hidden API ("needs a username") with no credentials given is treated like a missing one.
    if (mode === "editable" || /refused|https/.test(errorText(e))) throw e;
    log("Couldn't read the content through WordPress's API, so we'll copy the site exactly as it looks.");
    return copySite(url, log);
  }
  if (mode === "auto" && wp.builder) {
    log(`This site is built with ${wp.builder}, so we'll copy its design exactly.`);
    return copySite(url, log);
  }
  return importWordPress(wp, log);
}

let importLogSink = () => {};
onImportLog((line) => importLogSink(line));

async function copySite(url, log) {
  importLogSink = log;
  try {
    const id = await call("wp:mirror", url);
    await annotateCopiedSite(id, log);
    return id;
  } finally {
    importLogSink = () => {};
  }
}

async function importWordPress(wp, log) {
  log(`Found "${plainText(wp.name)}" with ${wp.pages.length} page${wp.pages.length === 1 ? "" : "s"}.`);
  if (wp.skipped?.length) log(`Skipped ${wp.skipped.map((t) => `"${plainText(t)}"`).join(", ")}: shop, log-in and account pages only work on WordPress itself.`);
  const home = new DOMParser().parseFromString(wp.homeHtml, "text/html");

  const style = wordpressStyle(home, wp.kitCss);
  const themeId = isDark(style.colors.background) ? "bold" : style.serif ? "elegant" : "clean";
  const theme = THEMES.themes[themeId];
  const s = await call("sites:create", plainText(wp.name) || "Imported website", themeId);
  s.description = plainText(wp.description);
  s.colors = Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [k, style.colors[k] || v]));
  s.font = style.serif ? "serif" : theme.font;

  const downloaded = new Map();
  let failed = 0;
  const fetchImage = async (src, max) => {
    const abs = new URL(src, wp.base + "/").href;
    if (!downloaded.has(abs)) {
      downloaded.set(abs, (async () => {
        try { return await saveImage(s.id, new Blob([await call("wp:image", abs)]), max); }
        catch { failed++; return null; }
      })());
    }
    return downloaded.get(abs);
  };

  const logoImg = home.querySelector("img.custom-logo, .wp-block-site-logo img, .elementor-widget-theme-site-logo img, [data-elementor-type=header] img");
  if (logoImg?.getAttribute("src")) {
    log("Copying logo…");
    const src = await fetchImage(logoImg.getAttribute("src"), 600);
    if (src) s.logo = { src, alt: s.name };
  }

  if (wp.pages.length) {
    // The static front page (if any) becomes Home; WordPress marks it on <body>.
    const frontId = home.body.classList.contains("home") && Number(home.body.className.match(/\bpage-id-(\d+)\b/)?.[1]);
    wp.pages.sort((a, b) => (b.id === frontId) - (a.id === frontId));
    const norm = (u) => { try { const x = new URL(u, wp.base + "/"); return x.origin + x.pathname.replace(/\/+$/, ""); } catch { return ""; } };
    const ids = new Map(wp.pages.map((p) => [p.id, rid()]));
    const byLink = new Map(wp.pages.map((p) => [norm(p.link), ids.get(p.id)]));
    byLink.set(norm(wp.base), ids.get(wp.pages[0].id));

    s.pages = [];
    for (const [i, p] of wp.pages.entries()) {
      log(`Importing page ${i + 1} of ${wp.pages.length}: ${plainText(p.title)}`);
      const body = cleanFragment(p.html, wp.base + "/");
      for (const a of body.querySelectorAll("a[href]")) {
        // Links to anything not imported (posts, files) keep pointing at the old site.
        const target = byLink.get(norm(a.getAttribute("href")));
        if (target) a.setAttribute("href", `#page:${target}`);
      }
      for (const img of body.querySelectorAll("img")) {
        const src = await fetchImage(img.getAttribute("src"), 1920);
        if (src) { img.setAttribute("src", src); continue; }
        const figure = img.closest("figure");
        img.remove();
        if (figure && !figure.querySelector("img") && !figure.textContent.trim()) figure.remove();
      }
      const sections = [{ id: rid(), type: "richtext", html: body.innerHTML.trim() }];
      // WordPress forms (Contact Form 7, WPForms…) need PHP; swap in ours. Never for log-in/shop forms (lib/wordpress.js).
      if (p.form) sections.push({ id: rid(), type: "form", heading: "", text: "", formId: "contact", buttonText: "Send" });
      // The old address, so lib/build.js can keep it (or 301 it) and renaming the page doesn't move it.
      let oldPath = null;
      try { oldPath = decodeURIComponent(new URL(p.link, wp.base + "/").pathname); } catch {}
      s.pages.push({ id: ids.get(p.id), title: plainText(p.title) || "Untitled", ...(oldPath && { path: oldPath }), sections });
    }
  }

  await call("sites:save", s);
  log(`Done.${failed ? ` ${failed} image${failed === 1 ? "" : "s"} couldn't be copied.` : ""}`);
  return s.id;
}

function renderImport() {
  const status = h("pre", { className: "log", hidden: true });
  const error = h("p", { className: "error" });
  const form = h("form", { className: "import", onsubmit: async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true; error.textContent = ""; status.hidden = false; status.textContent = "";
    try {
      const id = await runImport(Object.fromEntries(new FormData(form)), (line) => { status.textContent += line + "\n"; status.scrollTop = status.scrollHeight; });
      await openSite(id);
    } catch (err) {
      error.textContent = errorText(err);
      button.disabled = false;
      loadSites();
    }
  } },
    h("h1", {}, "Import from WordPress"),
    h("p", { className: "hint" }, "Creates a new website from your WordPress site. Your WordPress site isn't changed."),
    labelled("WordPress website address", h("input", { name: "url", required: true, placeholder: "https://example.com" })),
    h("fieldset", { className: "modes" }, h("legend", {}, "How should we copy it?"),
      [["auto", "Decide for me", "Exact copy for sites built with Elementor, Divi and other page builders, otherwise editable."],
       ["editable", "Editable content", "Pages are rebuilt in one of our themes so you can edit everything here. Layouts aren't kept."],
       ["exact", "Exact copy of the design", "Every page looks exactly as it does now, including menus and styles. The text of copied pages can't be edited here."]]
        .map(([value, label, about]) => h("label", {}, h("input", { type: "radio", name: "mode", value, checked: value === "auto" }), h("span", {}, h("b", {}, label), h("br"), h("small", {}, about))))),
    labelled("Username (optional)", h("input", { name: "username", autocomplete: "off" })),
    labelled("Application password (optional)", h("input", { name: "password", type: "password", autocomplete: "off" }),
      "Only needed for an editable import when your site hides its content from visitors. In WordPress go to Users › Profile › Application Passwords, add one named \"Site Builder\" and paste it here. It's used once and not saved."),
    h("button", { className: "primary big" }, "Import website"),
    error,
    status);
  $("#main").replaceChildren(h("div", { className: "import-wrap" }, form));
}

$("#import-wp").addEventListener("click", () => {
  clearTimeout(saveTimer);
  site = null;
  loadSites();
  renderImport();
});
