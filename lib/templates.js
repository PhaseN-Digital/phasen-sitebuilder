// HTML templates (#200): a theme may replace the header, footer, page layouts
// (the inside of <main>) and section wrappers with <name>.html files, checked
// by lib/theme-validate.js. This is the whole engine: {{name}} (escaped, or
// app-built markup for the html placeholders) and {{#if name}} … {{/if}}.
// No expressions, no loops: lists like the menu arrive already rendered.
const fs = require("node:fs");
const path = require("node:path");
const { validateTemplate, templateKind, LAYOUT_IDS, TEMPLATES } = require("./theme-validate");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The built-in templates; lib/build.js renders through these when a theme has none.
const DEFAULTS = {
  header: '<header class="site-header"><div class="wrap"><a class="brand" href="/">{{brand}}</a>{{menu}}</div></header>',
  footer: '<footer class="site-footer"><div class="wrap">&copy; {{year}} {{site.name}}{{#if footer.links}} · {{footer.links}}{{/if}}</div></footer>',
  section: "{{content}}",
  ...Object.fromEntries(LAYOUT_IDS.map((id) => [`layout-${id}`, "{{content}}"])),
};

// Placeholders per template name, for the Theme Builder's palette.
const PLACEHOLDERS = Object.fromEntries(Object.keys(DEFAULTS).map((name) => {
  const t = TEMPLATES[name.startsWith("layout-") ? "layout" : name];
  return [name, [...t.html, ...t.text, ...t.url]];
}));

// vars: { name: string | { html } }. Strings are escaped; { html } is trusted markup from the build.
const value = (v) => (v && typeof v === "object" ? v.html : esc(v));
function render(tpl, vars) {
  const IF = /\{\{#if ([\w.]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/g; // innermost first
  for (let prev; prev !== tpl;) { prev = tpl; tpl = tpl.replace(IF, (_, k, body) => (value(vars[k]) ? body : "")); }
  return tpl.replace(/\{\{([\w.]+)\}\}/g, (_, k) => value(vars[k]));
}

// A theme folder's templates over the defaults. Any invalid template means
// none of the theme's are used: { templates, error } with error saying why.
function themeTemplates(dir) {
  const own = {}, errors = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const kind = templateKind(f);
    if (!kind) continue;
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    errors.push(...validateTemplate(kind, html).map((e) => `${f}: ${e}`));
    own[f.slice(0, -5)] = html;
  }
  if (errors.length) return { templates: { ...DEFAULTS }, error: `The theme's HTML templates can't be used, so the built-in ones were used instead: ${errors.join("; ")}` };
  return { templates: { ...DEFAULTS, ...own }, error: null };
}

module.exports = { DEFAULTS, PLACEHOLDERS, render, themeTemplates, esc };
