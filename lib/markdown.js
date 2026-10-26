// Markdown import (#255), main-process side: reads .md files, renders them to
// HTML with marked and works out each page's title, address and menu order.
// The HTML is untrusted (raw HTML passes through marked): app/markdown.js
// runs it through the editable imports' allowlist sanitizer before storing it.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Marked } = require("marked");

const MAX_FILES = 500;
const MAX_BYTES = 2e6;

// Our rich text has no code blocks or h5/h6 (app/wordpress.js's allowlist):
// code keeps its line breaks as a paragraph, small headings become h4.
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const marked = new Marked({
  renderer: {
    code({ text }) { return `<p>${text.split("\n").map(esc).join("<br>")}</p>\n`; },
    heading({ tokens, depth }) { const d = Math.min(depth, 4); return `<h${d}>${this.parser.parseInline(tokens)}</h${d}>\n`; },
  },
});

// `---` front matter, `key: value` lines only.
// ponytail: not full YAML (no lists, nesting or multi-line values); only title/slug/path/order are read.
function frontMatter(text) {
  text = String(text).replace(/^\uFEFF/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (kv) data[kv[1].toLowerCase()] = kv[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { data, body: text.slice(m[0].length) };
}

const plain = (s) => String(s).replace(/<[^>]*>/g, "").replace(/[*_`~[\]]/g, "").replace(/\s+/g, " ").trim();
const fileTitle = (rel) => { const t = path.basename(rel).replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

// One file → { rel, title, path?, order, html }. Title: front matter, else the first `# heading`, else the file name.
// `path:` (or `slug:`) sets page.path; lib/build.js keeps it, or 301s it when it can't.
function toPage(rel, text) {
  const { data, body } = frontMatter(text);
  const h1 = marked.lexer(body).find((t) => t.type === "heading" && t.depth === 1);
  const title = plain(data.title || "") || (h1 && plain(h1.text)) || fileTitle(rel);
  const slug = data.path || (data.slug && `/${data.slug.replace(/^\/+|\/+$/g, "")}/`);
  const order = Number.parseFloat(data.order);
  return { rel, title, ...(slug && { path: slug.startsWith("/") ? slug : `/${slug}` }), order: Number.isFinite(order) ? order : Infinity, html: marked.parse(body) };
}

// Menu order: a top-level index.md (else README.md) is the home page, then front matter `order:`, then the file path.
function toPages(files) {
  const pages = files.map((f) => toPage(f.rel, f.text));
  const home = pages.find((p) => /^index\.(md|markdown)$/i.test(p.rel)) || pages.find((p) => /^readme\.(md|markdown)$/i.test(p.rel));
  return pages.sort((a, b) => (b === home) - (a === home) || a.order - b.order || a.rel.localeCompare(b.rel, undefined, { numeric: true }));
}

// Every .md file in `dir` and its subfolders (skipping hidden ones and node_modules), or just `files` in it.
// Paths are relative to `dir`, with forward slashes.
async function readMarkdown(dir, files) {
  if (!files) {
    files = (await fs.readdir(dir, { recursive: true }))
      .filter((f) => /\.(md|markdown)$/i.test(f) && !f.split(path.sep).some((part) => part.startsWith(".") || part === "node_modules"))
      .map((f) => path.join(dir, f));
  }
  if (!files.length) throw new Error("There are no Markdown (.md) files there.");
  if (files.length > MAX_FILES) throw new Error(`That's more than ${MAX_FILES} Markdown files. Choose a smaller folder.`);
  const out = [];
  for (const file of files) {
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error(`${path.basename(file)} is too large to import.`);
    out.push({ rel: path.relative(dir, file).split(path.sep).join("/"), text: await fs.readFile(file, "utf8") });
  }
  return toPages(out);
}

// An image a page refers to by relative path, only from inside the chosen folder (symlinks resolved).
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
async function readImage(dir, rel) {
  const root = await fs.realpath(dir);
  const file = await fs.realpath(path.join(root, ...String(rel).split("/")));
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !IMAGE.test(file)) throw new Error("Not an image in the imported folder.");
  if ((await fs.stat(file)).size > 20e6) throw new Error("Image too large.");
  return new Uint8Array(await fs.readFile(file));
}

module.exports = { frontMatter, toPage, toPages, readMarkdown, readImage };
