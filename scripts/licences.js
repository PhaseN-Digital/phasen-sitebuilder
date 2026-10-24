// Third-party licences (#182). `npm run dist` runs this first (predist): it
// writes THIRD-PARTY-NOTICES.txt (shipped via build.files) from the
// production dependencies electron-builder will package, and fails if any of
// them is copyleft. `npm test` runs the same copyleft check from the lockfile.
// Electron/Chromium notices ship separately (LICENSE.electron.txt, LICENSES.chromium.html).
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const COPYLEFT = /\b(A?GPL|LGPL|MPL|SSPL|EUPL|CDDL|EPL|OSL)\b/i;
// Copyleft packages allowed into builds anyway: { name: "justification" }. None today.
const ALLOW = {};

// Lockfile entries electron-builder packages: production deps, minus the
// `!node_modules/<x>/**` exclusions in package.json's build.files (sharp/libvips).
function packaged(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const excluded = pkg.build.files.filter((f) => /^!node_modules\/.+\/\*\*$/.test(f)).map((f) => f.slice(1, -3));
  return Object.entries(lock.packages)
    .filter(([key, p]) => key.startsWith("node_modules/") && !p.dev && !excluded.some((x) => key === x || key.startsWith(`${x}/`)))
    .map(([key, p]) => ({ key, name: p.name || key.slice(key.lastIndexOf("node_modules/") + 13), version: p.version, license: p.license || "UNKNOWN" }));
}

// "A OR B" is fine if any choice is permissive; anything else is copyleft if any part is.
function isCopyleft(license) {
  return license.replace(/[()]/g, "").split(/\s+OR\s+/i).every((choice) => COPYLEFT.test(choice));
}

function copyleft(pkgs) {
  return pkgs.filter((p) => isCopyleft(p.license) && !ALLOW[p.name]);
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

// Licence and NOTICE texts of the packages installed here (optional platform
// packages for other OSes aren't installed, and aren't packaged either). A
// package without a licence file gets its package.json author as the
// copyright holder and the standard text of its licence, listed once at the end.
function notices(pkgs, root = ROOT) {
  const seen = new Set();
  const parts = [];
  const standard = { MIT };
  for (const p of pkgs.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, p.key);
    if (!fs.existsSync(dir) || seen.has(`${p.name}@${p.version}`)) continue;
    seen.add(`${p.name}@${p.version}`);
    const files = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
    const texts = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim());
    if (!standard["Apache-2.0"]) standard["Apache-2.0"] = texts.find((t) => /^Apache License\s+Version 2\.0/.test(t));
    if (!texts.length) {
      const { author } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const holder = (typeof author === "object" ? author.name : author) || `the ${p.name} authors`;
      texts.push(`Copyright (c) ${holder}\nThe package has no licence file; the standard ${p.license} text is under "Standard licence texts" at the end.`);
    }
    parts.push(`${p.name} ${p.version}\nLicense: ${p.license}\n\n${texts.join("\n\n")}`);
  }
  for (const [id, text] of Object.entries(standard)) {
    if (!text) throw new Error(`No ${id} licence text found to cite`);
    parts.push(`Standard licence texts: ${id}\n\n${text}`);
  }
  return "PhaseN Site Builder includes the following third-party software.\n"
    + "Electron and Chromium notices are in LICENSE.electron.txt and LICENSES.chromium.html in the install folder.\n\n"
    + parts.join(`\n\n${"=".repeat(72)}\n\n`) + "\n";
}

if (require.main === module) {
  const pkgs = packaged();
  const bad = copyleft(pkgs);
  if (bad.length) {
    console.error(`Copyleft dependencies would be packaged (#182), exclude them in build.files or justify them in ALLOW:\n${bad.map((p) => `  ${p.key} (${p.license})`).join("\n")}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(ROOT, "THIRD-PARTY-NOTICES.txt"), notices(pkgs));
  console.log("Wrote THIRD-PARTY-NOTICES.txt");
}
module.exports = { packaged, isCopyleft, copyleft, notices };
