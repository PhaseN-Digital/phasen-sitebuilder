// Theme Builder (#130): makes theme packages (lib/theme-validate.js format)
// from a few visual controls, kept in userData/themes-local/<id>/ apart from
// any website. Choosing one in the Design tab copies it into the site folder
// (sites/<id>/theme), exactly like a theme from a theme source, so builds load
// it through lib/themes.js's loadTheme. Publishing a theme to GitHub is #60.
//
// The controls are written into theme.css as its first-line comment, so a
// package needs no extra files or theme.json fields to be edited again.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateTheme } = require("./theme-validate");
const { fonts, loadTheme } = require("./themes");
const { contrastRatio, contrastText } = require("./build");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/; // same as lib/theme-validate.js
const HEX_RE = /^#[0-9a-f]{6}$/i;
const FONT_RE = /^[\w\s,"'-]{1,200}$/; // same as lib/theme-validate.js
const MARK = "/* theme-builder ";
const ADVANCED = "/* Advanced CSS */\n";

const CHOICES = {
  header: { left: "", centred: ".site-header .wrap { flex-direction: column; justify-content: center; }",
    bar: `.site-header { background: var(--primary); border: 0; }
.site-header .brand, .site-header nav a, .site-header .nav-toggle { color: var(--primary-text); }
.site-header nav a:hover, .site-header nav a[aria-current] { color: var(--primary-text); text-decoration: underline; }` },
  button: { filled: "", outline: ".button { background: transparent; color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }\n.hero .button { color: inherit; }",
    pill: ".button { border-radius: 999px; }" },
  spacing: { compact: "main section { padding: 40px 0; }\n.hero { padding: 72px 0; }", normal: "",
    roomy: "main section { padding: 96px 0; }\n.hero { padding: 160px 0; }" },
  links: { underlined: "", plain: "main a:not(.button) { text-decoration: none; }\nmain a:not(.button):hover { text-decoration: underline; }" },
};

const DEFAULTS = {
  label: "My theme", about: "", font: "sans",
  colors: { background: "#ffffff", text: "#1f2937", primary: "#2563eb", accent: "#f59e0b" },
  radius: 8, header: "left", button: "filled", spacing: "normal", links: "underlined", css: "",
};

// Controls from the renderer (or a theme.css comment), cleaned up: anything
// unknown or malformed falls back to the default.
function clean(c = {}) {
  const str = (v, d) => (typeof v === "string" ? v.trim().slice(0, 200) : d);
  const out = {
    id: ID_RE.test(c.id) ? c.id : undefined,
    label: str(c.label, "") || DEFAULTS.label,
    about: str(c.about, ""),
    font: typeof c.font === "string" && (fonts[c.font] || FONT_RE.test(c.font)) ? c.font : DEFAULTS.font,
    colors: Object.fromEntries(Object.entries(DEFAULTS.colors).map(([k, d]) => [k, HEX_RE.test(c.colors?.[k]) ? c.colors[k].toLowerCase() : d])),
    radius: Number.isFinite(Number(c.radius)) ? Math.max(0, Math.min(32, Math.round(Number(c.radius)))) : DEFAULTS.radius,
    css: typeof c.css === "string" ? c.css.slice(0, 32 * 1024) : "",
  };
  for (const k of Object.keys(CHOICES)) out[k] = Object.hasOwn(CHOICES[k], c[k]) ? c[k] : DEFAULTS[k];
  return out;
}

// { json, css } for theme.json and theme.css.
function generate(controls, version = "1.0.0") {
  const c = clean(controls);
  const font = fonts[c.font] && !c.font.startsWith("theme-") ? c.font : (fonts[c.font]?.stack ?? c.font);
  const style = Object.fromEntries(["radius", ...Object.keys(CHOICES)].map((k) => [k, c[k]]));
  const css = [`${MARK}${JSON.stringify(style)} */`, `:root { --radius: ${c.radius}px; }`,
    ...Object.keys(CHOICES).map((k) => CHOICES[k][c[k]]).filter(Boolean)].join("\n") + "\n" + (c.css.trim() ? `${ADVANCED}${c.css.trim()}\n` : "");
  return { json: { label: c.label, about: c.about || "Made with the Theme Builder.", font, colors: c.colors, version }, css };
}

// Controls back from a package made by generate(); null for any other theme.
function parse(json, css) {
  const m = /^\/\* theme-builder (\{[^}]*\}) \*\/\n/.exec(css);
  if (!m) return null;
  const at = css.indexOf(ADVANCED);
  return clean({ ...JSON.parse(m[1]), label: json.label, about: json.about === "Made with the Theme Builder." ? "" : json.about,
    font: json.font, colors: json.colors, css: at < 0 ? "" : css.slice(at + ADVANCED.length) });
}

// Non-blocking contrast hints (WCAG AA, 4.5:1), same maths as the Design tab's (#124).
function warnings(controls) {
  const { colors: c, button } = clean(controls);
  return [
    ["Text", c.text, c.background],
    ["Links (main colour)", c.primary, c.background],
    ["Header and banner text", contrastText(c.primary), c.primary],
    button === "outline" ? ["Buttons", c.accent, c.background] : ["Button text", contrastText(c.accent), c.accent],
  ].filter(([, fg, bg]) => contrastRatio(fg, bg) < 4.5)
    .map(([what, fg, bg]) => `${what} may be hard to read (contrast ${contrastRatio(fg, bg).toFixed(1)}:1, aim for at least 4.5:1).`);
}

// Writes a package into dir (replacing it); returns lib/theme-validate.js's errors.
async function writeTheme(dir, controls, { version, png } = {}) {
  const { json, css } = generate(controls, version);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "theme.json"), JSON.stringify(json, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "theme.css"), css);
  if (png) await fs.writeFile(path.join(dir, "preview.png"), png);
  return validateTheme(dir);
}

// { <id>: { label, about, font, colors, version, preview, errors, controls } },
// the same shape as a theme source's listing (lib/theme-sources.js readSource).
async function listLocal(root) {
  const out = {};
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of dirs.filter((d) => d.isDirectory() && ID_RE.test(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, e.name);
    const errors = validateTheme(dir);
    if (errors.length) { out[e.name] = { errors }; continue; }
    const json = JSON.parse(await fs.readFile(path.join(dir, "theme.json"), "utf8"));
    const png = await fs.readFile(path.join(dir, "preview.png")).catch(() => null);
    out[e.name] = { ...json, version: json.version || null, errors, preview: png && `data:image/png;base64,${png.toString("base64")}`,
      controls: parse(json, await fs.readFile(path.join(dir, "theme.css"), "utf8")) };
  }
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "theme";

// Saves controls as root/<id>, validated before it replaces anything. A new
// theme gets an id from its name; saving again bumps the patch version.
// Returns { id, errors }; nothing is saved when errors isn't empty.
async function saveLocal(root, controls, png) {
  const c = clean(controls);
  let id = c.id;
  const existing = id && (await fs.readFile(path.join(root, id, "theme.json"), "utf8").then(JSON.parse, () => null));
  if (!existing) {
    const taken = new Set(await fs.readdir(root).catch(() => []));
    const base = slug(c.label);
    id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  }
  const version = existing?.version ? existing.version.replace(/\d+$/, (n) => Number(n) + 1) : "1.0.0";
  const tmp = path.join(root, `.tmp-${crypto.randomBytes(4).toString("hex")}`, id);
  try {
    const errors = await writeTheme(tmp, { ...c, id }, { version, png });
    if (errors.length) return { id, errors };
    await fs.rm(path.join(root, id), { recursive: true, force: true });
    await fs.rename(tmp, path.join(root, id));
    return { id, errors };
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true });
  }
}

// Copies a local theme into siteDir/theme (like lib/theme-sources.js installTheme).
async function installLocal(root, id, siteDir) {
  if (!ID_RE.test(id) || validateTheme(path.join(root, id)).length) throw new Error(`The theme "${id}" isn't in your themes any more.`);
  const dest = path.join(siteDir, "theme");
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(path.join(root, id), dest, { recursive: true });
}

// Starting controls from a website's design: its colours and font, plus its
// theme's look. A builder theme brings back its controls; any other theme's
// CSS becomes the Advanced CSS. Exact copies keep their own CSS, so colours/font only.
async function fromSite(site, siteDir, builtins) {
  let style = {}, css = "";
  if (!site.mirror) {
    const dir = site.themeSource ? path.join(siteDir, "theme") : (builtins[site.theme] || builtins.clean).dir;
    const json = site.themeSource ? loadTheme(dir, site.theme) : null; // registers its font stack
    const themeCss = await fs.readFile(path.join(dir, "theme.css"), "utf8").catch(() => "");
    const parsed = json && parse(json, themeCss);
    if (parsed) ({ css, ...style } = parsed);
    else { // its corner radius moves to the control, so the slider still works
      css = themeCss.replace(/^:root \{ --radius: (\d+)(?:px)?; \}\n?/m, (_, r) => { style.radius = r; return ""; });
    }
  }
  const font = fonts[site.font]?.stack && site.font.startsWith("theme-") ? fonts[site.font].stack : site.font;
  return clean({ ...style, label: `${site.name} theme`, about: `Based on the design of ${site.name}.`, colors: site.colors, font, css });
}

// Built-in sample content for the preview: every section type, a form, and
// enough pages for the phone-width menu. Images are SVGs written by sampleAssets.
function sampleSite(controls, themeId = "draft") {
  const c = clean(controls);
  const img = (n, alt) => ({ src: `assets/sample-${n}.svg`, alt });
  const page = (id, title, sections) => ({ id, title, sections: sections.map((s, i) => ({ id: `${id}${i}`, ...s })) });
  return {
    id: "theme-preview", name: "Sample Studio", description: "", theme: themeId, themeSource: "local",
    colors: c.colors, font: fonts[c.font] && !c.font.startsWith("theme-") ? c.font : `theme-${themeId}`, logo: null, domain: null, workerName: "theme-preview",
    pages: [
      page("home", "Home", [
        { type: "hero", heading: "Websites that work as hard as you do", text: "A short sentence about what you do and who you do it for.", image: null, buttonText: "Get in touch", buttonPage: "contact" },
        { type: "text", heading: "About us", text: "We're a small team who care about getting the details right.\n\nThis paragraph shows how body text, line length and spacing look with your theme.", image: img(1, "A sample photo"), imageLeft: false },
        { type: "gallery", heading: "Our work", images: [img(1, "Sample one"), img(2, "Sample two"), img(3, "Sample three")] },
        { type: "richtext", html: '<h2>Rich text</h2><p>Text with <strong>bold</strong>, <em>italic</em> and <a href="#page:about">a link to another page</a>.</p><blockquote>A quote from a happy customer.</blockquote><ul><li>A list item</li><li>Another one</li></ul><p><a href="#page:contact" class="button">A button in text</a></p>' },
        { type: "form", heading: "Get in touch", text: "Send us a message and we'll get back to you.", formId: "contact", buttonText: "Send message" },
      ]),
      page("about", "About", [{ type: "text", heading: "About", text: "More about the business.", image: null }]),
      page("services", "Services", [{ type: "text", heading: "Services", text: "What we offer.", image: null }]),
      page("contact", "Contact", [{ type: "form", heading: "Contact", text: "", formId: "contact", buttonText: "Send" }]),
    ],
    forms: [{ id: "contact", name: "Contact", to: "", success: "Thanks!", fields: [
      { id: "name", label: "Your name", type: "text", required: true },
      { id: "email", label: "Email address", type: "email", required: true },
      { id: "message", label: "Message", type: "textarea", required: true },
    ] }],
  };
}

async function sampleAssets(dir) {
  await fs.mkdir(dir, { recursive: true });
  const hues = [[200, 160], [20, 340], [120, 60]];
  await Promise.all(hues.map(([a, b], i) => fs.writeFile(path.join(dir, `sample-${i + 1}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 55% 62%)"/><stop offset="1" stop-color="hsl(${b} 55% 38%)"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><circle cx="560" cy="200" r="90" fill="#fff8"/><path d="M0 600 280 300 460 470 600 360 800 560V600Z" fill="#0003"/></svg>`)));
}

module.exports = { DEFAULTS, CHOICES, clean, generate, parse, warnings, writeTheme, listLocal, saveLocal, installLocal, fromSite, sampleSite, sampleAssets };
