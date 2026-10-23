// Loads theme packages (themes/<id>/theme.json + theme.css, see
// lib/theme-validate.js for the format). Built-in themes use the same format
// as downloaded ones, so everything goes through here: lib/build.js for the
// CSS, main.js's `themes` handler for the Design tab.
const fs = require("node:fs");
const path = require("node:path");

const BUNDLED = path.join(__dirname, "..", "themes");
const fonts = require("../themes/fonts.json");

// { <id>: { label, about, font, colors, version?, dir } }. A theme whose font
// is a CSS stack rather than a font id gets that stack added to `fonts`.
function loadThemes(dir) {
  const themes = {};
  // Alphabetical, but the default theme (clean) first.
  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    .sort((a, b) => (b.name === "clean") - (a.name === "clean") || a.name.localeCompare(b.name));
  for (const e of dirs) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, e.name, "theme.json"), "utf8"));
    if (!fonts[t.font]) {
      fonts[`theme-${e.name}`] = { label: `${t.label} theme font`, stack: t.font };
      t.font = `theme-${e.name}`;
    }
    themes[e.name] = { ...t, dir: path.join(dir, e.name) };
  }
  return themes;
}

const themes = loadThemes(BUNDLED);

module.exports = { themes, fonts, loadThemes, baseCss: path.join(BUNDLED, "base.css") };
