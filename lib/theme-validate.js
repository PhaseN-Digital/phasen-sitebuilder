// Validates a theme package: themes/<id>/theme.json + theme.css (+ optional
// preview.png). Node stdlib only, because a copy is vendored into the public
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
const MAX_PREVIEW = 512 * 1024;
const ALLOWED = new Set(["theme.json", "theme.css", "preview.png"]);
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
  for (const f of files) if (!f.isFile() || !ALLOWED.has(f.name)) errors.push(`unexpected ${f.isFile() ? "file" : "entry"} ${f.name} (only ${[...ALLOWED].join(", ")})`);

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
      for (const k of Object.keys(t)) if (!["label", "about", "font", "colors", "version"].includes(k)) errors.push(`theme.json: unknown field "${k}"`);
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

module.exports = { validateTheme, validateAll };

if (require.main === module) {
  const dir = process.argv[2] || "themes";
  const bad = validateAll(dir);
  for (const [id, errors] of Object.entries(bad)) for (const e of errors) console.error(`${id}: ${e}`);
  if (Object.keys(bad).length) process.exit(1);
  console.log("All themes valid.");
}
