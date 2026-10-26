// Validates a theme package: themes/<id>/theme.json + theme.css (+ optional
// preview.png and HTML templates, see TEMPLATES below). Node stdlib only, because a copy is vendored into the public
// PhaseN-Digital/phasen-sitebuilder-themes repo for its CI (this repo is
// private). The two copies must stay identical: change both together.
//
//   node theme-validate.js <themes-dir>   validates every theme, exits 1 on errors
const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
// A font id ("sans") or a CSS font stack. It's written into a CSS variable,
// so no characters that could end the declaration.
const FONT_RE = /^[\w\s,"'-]{1,200}$/;
const MAX_CSS = 32 * 1024;
// Page layouts (lib/layouts.js in the app; listed here so this file stays
// standalone). theme.css styles them with `.layout-<id> …` selectors, and
// theme.json may carry a note per layout: "layouts": { "<id>": { "notes": "…" } }.
const LAYOUT_IDS = ["home", "standard", "landing", "services", "contact", "blog-post", "blog-index", "legal"];
const MAX_PREVIEW = 512 * 1024;
const ALLOWED = new Set(["theme.json", "theme.css", "preview.png"]);

// HTML templates (#200): optional <name>.html files, rendered by the app's
// lib/templates.js. Each name lists its placeholders: `text` ones are escaped
// (also allowed inside quoted attribute values), `html` ones are markup the
// app builds (text position only), `url` ones are paths the app builds (the
// whole value of href/src). `required` keep the site working (menu, content,
// and the footer's privacy/cookie links, which UK GDPR/PECR need).
const TEMPLATES = {
  header: { required: ["menu"], text: ["site.name", "page.title", "layout"], html: ["brand", "menu"], url: ["site.logo"] },
  footer: { required: ["footer.links"], text: ["site.name", "year", "page.title", "layout"], html: ["footer.links"], url: [] },
  section: { required: ["content"], text: ["section.type", "layout"], html: ["content"], url: [] },
  layout: { required: ["content"], text: ["site.name", "page.title", "layout"], html: ["content"], url: [] },
};
// header.html, footer.html, section.html, layout-<id>.html -> its TEMPLATES kind.
const templateKind = (file) => {
  const m = /^(header|footer|section|layout-([\w-]+))\.html$/.exec(file);
  return !m ? null : !m[2] ? m[1] : LAYOUT_IDS.includes(m[2]) ? "layout" : null;
};
const MAX_TEMPLATE = 16 * 1024;
const TAGS = new Set(["a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "cite", "code", "dd", "div", "dl", "dt", "em", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "iframe", "img", "li", "mark", "nav", "ol", "p", "picture", "s", "section", "small", "source",
  "span", "strong", "sub", "sup", "time", "u", "ul"]);
const FORBIDDEN_TAGS = { script: "<script> is not allowed", style: "<style> is not allowed (put CSS in theme.css)", object: "<object> is not allowed", embed: "<embed> is not allowed",
  form: "forms are not allowed (forms come from the app)", input: "forms are not allowed (forms come from the app)", button: "forms are not allowed (forms come from the app)",
  select: "forms are not allowed (forms come from the app)", textarea: "forms are not allowed (forms come from the app)", link: "<link> is not allowed (no external resources)",
  meta: "<meta> is not allowed", base: "<base> is not allowed" };
const ATTRS = new Set(["class", "id", "title", "lang", "dir", "role", "hidden", "tabindex", "style", "href", "target", "rel", "src", "srcset", "sizes", "alt",
  "width", "height", "loading", "decoding", "datetime", "allow", "allowfullscreen", "referrerpolicy"]);
// Videos as in rich text (#120): YouTube's privacy-enhanced player and Vimeo only.
const EMBED_RE = /^https:\/\/(?:www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+)(?:\?[\w=&;.-]*)?$/;
// Images may load from the site itself (relative paths) or over https from these hosts.
const IMAGE_HOSTS = ["images.unsplash.com"];

// Errors for one URL attribute value (already known to be quoted).
function urlErrors(v, attr, tag, kind) {
  if (v.includes("{{")) return /^\{\{([\w.]+)\}\}$/.test(v) && TEMPLATES[kind].url.includes(v.slice(2, -2)) ? [] : [`${attr}= may only be a whole URL placeholder (${TEMPLATES[kind].url.map((p) => `{{${p}}}`).join(", ") || "none here"})`];
  if (/&(?!amp;)/i.test(v)) return [`${attr}=: character references aren't allowed in URLs`];
  const u = v.replace(/&amp;/gi, "&").replace(/[\u0000-\u0020]/g, "");
  if (u.includes("\\")) return [`${attr}=: backslashes aren't allowed in URLs`];
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1].toLowerCase();
  if (scheme === "javascript" || scheme === "vbscript" || scheme === "data") return [`${scheme}: URLs are not allowed`];
  if (tag === "iframe") return EMBED_RE.test(u) ? [] : ["<iframe> may only embed YouTube (youtube-nocookie.com/embed) or Vimeo (player.vimeo.com/video) videos"];
  if (attr === "href") return !scheme || ["http", "https", "mailto", "tel"].includes(scheme) ? [] : [`${scheme}: links are not allowed`];
  // src/srcset: a resource the page loads.
  if (!scheme) return u.startsWith("//") ? [`${attr}=: external images must be https from ${IMAGE_HOSTS.join(", ")}`] : [];
  if (scheme === "https" && IMAGE_HOSTS.includes(/^https:\/\/([^/?#:]+)/i.exec(u)?.[1].toLowerCase())) return [];
  return [`${attr}=: external images must be https from ${IMAGE_HOSTS.join(", ")}`];
}

// Errors for one template's text; kind is a TEMPLATES key. Run on install,
// on save in the Theme Builder and at every build (lib/build.js).
function validateTemplate(kind, html) {
  const spec = TEMPLATES[kind];
  const errors = [];
  if (Buffer.byteLength(html) > MAX_TEMPLATE) errors.push(`larger than ${MAX_TEMPLATE / 1024} KB`);
  // Placeholders: {{name}}, {{#if name}} … {{/if}}; nothing else.
  const names = [...spec.text, ...spec.html, ...spec.url];
  let depth = 0;
  for (const m of html.matchAll(/\{\{([^{}]*)\}\}|\{\{|\}\}/g)) {
    const t = m[1];
    const name = /^(?:#if )?([\w.]+)$/.exec(t ?? "")?.[1];
    if (t === "/if") { if (--depth < 0) { errors.push("{{/if}} without {{#if …}}"); depth = 0; } }
    else if (!name) errors.push(`malformed placeholder ${m[0]}`);
    else if (!names.includes(name)) errors.push(`unknown placeholder {{${name}}} (one of ${names.map((n) => `{{${n}}}`).join(", ")})`);
    else if (t.startsWith("#if ")) depth++;
  }
  if (depth) errors.push("{{#if …}} without {{/if}}");
  for (const r of spec.required) if (!html.includes(`{{${r}}}`)) errors.push(`must include {{${r}}}`);
  // Browsers read these as comments, which could hide markup from the checks below.
  if (/<(?:[!?]|\/(?![a-zA-Z]))/.test(html)) errors.push("comments, <!…>, <?…> and </ not followed by a tag name are not allowed");
  // Tags: an allowlist of elements and attributes. A tag runs to the first '>' outside quotes.
  const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  if (/<[\/a-zA-Z]/.test(html.replace(TAG, ""))) errors.push("unfinished tag (a '<' with no matching '>')");
  for (const [, close, rawTag, attrs] of html.matchAll(TAG)) {
    const tag = rawTag.toLowerCase();
    if (FORBIDDEN_TAGS[tag]) { errors.push(FORBIDDEN_TAGS[tag]); continue; }
    if (!TAGS.has(tag)) { errors.push(`<${tag}> is not allowed`); continue; }
    if (close) { if (attrs.trim()) errors.push(`</${tag}> can't have attributes`); continue; }
    const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    if (attrs.replace(ATTR, "").replace(/[\s/]/g, "")) errors.push(`<${tag}>: can't read its attributes`);
    let src = false;
    for (const [, rawName, dq, sq, bare] of attrs.matchAll(ATTR)) {
      const name = rawName.toLowerCase();
      const v = dq ?? sq ?? bare ?? "";
      if (/^on/.test(name)) { errors.push(`event-handler attributes (${name}=) are not allowed`); continue; }
      if (!ATTRS.has(name) && !/^aria-[a-z-]+$/.test(name)) { errors.push(`<${tag}>: attribute ${name}= is not allowed`); continue; }
      if (bare !== undefined && bare.includes("{{")) { errors.push(`${name}=: put placeholders in quotes`); continue; }
      if (/\{\{[#/]/.test(v)) { errors.push(`${name}=: {{#if}} can't be used inside a tag`); continue; }
      if (["href", "src"].includes(name)) { errors.push(...urlErrors(v, name, tag, kind)); src ||= name === "src"; }
      else if (name === "srcset") for (const part of v.split(",")) errors.push(...urlErrors(part.trim().split(/\s+/)[0], name, tag, kind));
      else if (name === "style" && /url\s*\(|expression|javascript:|@import|behavior|-moz-binding|[\\&{}]/i.test(v)) errors.push("style=: no url(), expression(), escapes or braces (put CSS in theme.css)");
      else for (const p of v.matchAll(/\{\{([\w.]+)\}\}/g)) if (!spec.text.includes(p[1])) errors.push(`${name}=: {{${p[1]}}} can't be used inside a tag`);
    }
    if (tag === "iframe" && !src) errors.push("<iframe> needs a src (YouTube or Vimeo)");
    if (/\{\{/.test(attrs.replace(ATTR, ""))) errors.push(`<${tag}>: placeholders only go inside quoted attribute values`);
  }
  return [...new Set(errors)];
}
const BANNED_CSS = [
  [/@import/i, "@import is not allowed"],
  [/javascript:/i, "javascript: URLs are not allowed"],
  [/expression\s*\(/i, "expression() is not allowed"],
  [/behavior\s*:|-moz-binding/i, "behavior/-moz-binding is not allowed"],
  [/</, "'<' is not allowed (no HTML in theme.css)"],
];

// Returns a list of error strings; empty means valid.
function validateTheme(dir) {
  const id = path.basename(dir);
  const errors = [];
  if (!ID_RE.test(id)) errors.push(`folder name "${id}" must be lowercase letters, digits and dashes`);
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [`can't read ${dir}`];
  }
  for (const f of files) if (!f.isFile() || !(ALLOWED.has(f.name) || templateKind(f.name))) errors.push(`unexpected ${f.isFile() ? "file" : "entry"} ${f.name} (only ${[...ALLOWED].join(", ")}, header.html, footer.html, section.html, layout-<id>.html)`);
  for (const f of files) {
    const kind = f.isFile() && templateKind(f.name);
    if (kind) for (const e of validateTemplate(kind, fs.readFileSync(path.join(dir, f.name), "utf8"))) errors.push(`${f.name}: ${e}`);
  }

  let t;
  try {
    t = JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf8"));
  } catch (e) {
    errors.push(`theme.json: ${e.code === "ENOENT" ? "missing" : e.message}`);
  }
  if (t) {
    if (typeof t !== "object" || Array.isArray(t)) errors.push("theme.json must be an object");
    else {
      for (const k of ["label", "about"]) if (typeof t[k] !== "string" || !t[k].trim() || t[k].length > 200) errors.push(`theme.json: "${k}" must be a non-empty string up to 200 characters`);
      if (typeof t.font !== "string" || !FONT_RE.test(t.font)) errors.push('theme.json: "font" must be a font id or a plain CSS font stack');
      if (t.version !== undefined && (typeof t.version !== "string" || !/^\d+\.\d+\.\d+$/.test(t.version))) errors.push('theme.json: "version" must look like 1.0.0');
      for (const k of ["background", "text", "primary", "accent"]) if (!HEX_RE.test(t.colors?.[k])) errors.push(`theme.json: colors.${k} must be a #rrggbb hex colour`);
      if (t.layouts !== undefined) {
        if (!t.layouts || typeof t.layouts !== "object" || Array.isArray(t.layouts)) errors.push('theme.json: "layouts" must be an object');
        else for (const [id, l] of Object.entries(t.layouts)) {
          if (!LAYOUT_IDS.includes(id)) errors.push(`theme.json: unknown layout "${id}" (one of ${LAYOUT_IDS.join(", ")})`);
          else if (!l || typeof l !== "object" || Array.isArray(l) || Object.keys(l).some((k) => k !== "notes") || (l.notes !== undefined && (typeof l.notes !== "string" || l.notes.length > 500))) errors.push(`theme.json: layouts.${id} may only have "notes", a string up to 500 characters`);
        }
      }
      for (const k of Object.keys(t)) if (!["label", "about", "font", "colors", "version", "layouts"].includes(k)) errors.push(`theme.json: unknown field "${k}"`);
    }
  }

  let css;
  try {
    css = fs.readFileSync(path.join(dir, "theme.css"), "utf8");
  } catch {
    errors.push("theme.css: missing");
  }
  if (css !== undefined) {
    if (Buffer.byteLength(css) > MAX_CSS) errors.push(`theme.css: larger than ${MAX_CSS / 1024} KB`);
    for (const id of new Set([...css.matchAll(/\.layout-([\w-]+)/g)].map((m) => m[1]))) if (!LAYOUT_IDS.includes(id)) errors.push(`theme.css: unknown layout class .layout-${id}`);
    for (const [re, msg] of BANNED_CSS) if (re.test(css)) errors.push(`theme.css: ${msg}`);
  }

  const preview = path.join(dir, "preview.png");
  if (fs.existsSync(preview)) {
    const buf = fs.readFileSync(preview);
    if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) errors.push("preview.png: not a PNG");
    if (buf.length > MAX_PREVIEW) errors.push(`preview.png: larger than ${MAX_PREVIEW / 1024} KB`);
  }
  return errors;
}

// Validates every subfolder of themesDir. Returns { <id>: [errors] } for the invalid ones.
function validateAll(themesDir) {
  const bad = {};
  for (const e of fs.readdirSync(themesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const errors = validateTheme(path.join(themesDir, e.name));
    if (errors.length) bad[e.name] = errors;
  }
  return bad;
}

module.exports = { validateTheme, validateAll, validateTemplate, templateKind, LAYOUT_IDS, TEMPLATES };

if (require.main === module) {
  const dir = process.argv[2] || "themes";
  const bad = validateAll(dir);
  for (const [id, errors] of Object.entries(bad)) for (const e of errors) console.error(`${id}: ${e}`);
  if (Object.keys(bad).length) process.exit(1);
  console.log("All themes valid.");
}
