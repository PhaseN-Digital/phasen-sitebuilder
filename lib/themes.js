// Loads theme packages (themes/<id>/theme.json + theme.css, see
// lib/theme-validate.js for the format). Built-in themes use the same format
// as downloaded ones, so everything goes through here: lib/build.js for the
// CSS, main.js's `themes` handler for the Design tab.
const fs = require("node:fs");
const path = require("node:path");

const BUNDLED = path.join(__dirname, "..", "themes");
const fonts = require("../themes/fonts.json");

// One theme package as { label, about, font, colors, version?, dir }. A
// theme whose font is a CSS stack rather than a font id gets that stack added
// to `fonts` as theme-<id>. `id` defaults to the folder name; a site's own
// copy (sites/<id>/theme, see lib/theme-sources.js) passes its theme id.
function loadTheme(dir, id = path.basename(dir)) {
  const t = JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf8"));
  if (!fonts[t.font]) {
    fonts[`theme-${id}`] = { label: `${t.label} theme font`, stack: t.font };
    t.font = `theme-${id}`;
  }
  return { ...t, dir };
}

// { <id>: theme } for every package in dir.
function loadThemes(dir) {
  const themes = {};
  // Alphabetical, but the default theme (clean) first.
  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    .sort((a, b) => (b.name === "clean") - (a.name === "clean") || a.name.localeCompare(b.name));
  for (const e of dirs) themes[e.name] = loadTheme(path.join(dir, e.name));
  return themes;
}

const themes = loadThemes(BUNDLED);

module.exports = { themes, fonts, loadTheme, loadThemes, baseCss: path.join(BUNDLED, "base.css") };
