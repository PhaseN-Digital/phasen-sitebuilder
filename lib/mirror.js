// "Exact copy" import: crawls a site's rendered pages (what visitors see, so
// page builders like Elementor or Divi come out exactly as designed) and saves
// the HTML plus every same-site asset at its original path. Keeping original
// paths means making the copy portable is just stripping the domain from URLs:
// links, CSS url()s and srcsets all keep working as root-relative paths.
// POST forms are re-wired to the site's own form Worker (runtime/worker.js).
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_PAGES = 500;
const MAX_ASSETS = 5000;
const MAX_FILE = 25 * 1024 * 1024; // Cloudflare's per-file limit for Worker assets
const BATCH = 6;
const SKIP = /^\/(wp-admin|wp-login\.php|wp-json|xmlrpc\.php|wp-cron\.php|cgi-bin)\b|\/(feed|trackback|embed)\/?$|\.php$/i;
const BAD_FILENAME = /[<>:"|?*\x00-\x1f]/;
const BUILDERS = {
  Elementor: /elementor/i, Divi: /et_pb_|et-db/i, "Beaver Builder": /fl-builder/i, WPBakery: /vc_row|wpb_/i,
  Bricks: /brxe-/i, Oxygen: /ct-section/i, Avada: /fusion-builder|fusion-layout/i,
};
const SKIP_INPUTS = new Set(["hidden", "submit", "button", "reset", "image", "file", "password"]);
const FORM_SCRIPTS = `<script src="/form.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad" async defer></script>`;
const FORM_EXTRAS = `<label style="position:absolute;left:-10000px" aria-hidden="true">Leave blank<input name="website" tabindex="-1" autocomplete="off"></label><div class="cf-turnstile" data-sitekey="__TURNSTILE_SITEKEY__"></div><p class="form-status" role="status" aria-live="polite"></p>`;

const detectBuilder = (html) => Object.keys(BUILDERS).find((name) => BUILDERS[name].test(html)) || null;

const decode = (s) => String(s || "")
  .replace(/<[^>]*>/g, "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[e])
  .replace(/\s+/g, " ")
  .trim();

const attrsOf = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ""])
);

// The site's questions, read from the form's own markup.
function formFields(inner) {
  const labels = {};
  for (const m of inner.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const target = attrsOf(m[1]).for;
    if (target) labels[target] = decode(m[2]);
  }
  const fields = [];
  for (const m of inner.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const a = attrsOf(m[2]);
    const tag = m[1].toLowerCase();
    const type = tag === "input" ? (a.type || "text").toLowerCase() : tag;
    if (!a.name || a.name === "website" || SKIP_INPUTS.has(type) || fields.some((f) => f.id === a.name)) continue;
    fields.push({
      id: a.name,
      label: (labels[a.id] || a.placeholder || a["aria-label"] || a.name).slice(0, 100),
      type: ["email", "tel", "textarea"].includes(type) ? type : "text",
      required: "required" in a || a["aria-required"] === "true",
    });
  }
  return fields;
}

const pageFile = (pathname) => (/\.html?$/i.test(pathname) ? pathname.slice(1) : `${pathname.replace(/^\/|\/$/g, "")}/index.html`.replace(/^\//, ""));

async function mirrorSite(startUrl, outDir, log) {
  let start = String(startUrl).trim();
  if (!/^https?:\/\//i.test(start)) start = `https://${start}`;
  const first = await fetch(start).catch(() => {
    throw new Error("Couldn't reach that address. Check it's typed correctly and the site is online.");
  });
  if (!first.ok) throw new Error(`The site returned an error (HTTP ${first.status}).`);
  const { origin, host } = new URL(first.url);
  const bare = host.replace(/^www\./, "");
  const hostRe = [bare, `www.${bare}`].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // This site's absolute URLs, plain, protocol-relative or JSON-escaped (https:\/\/host).
  const ABSOLUTE = new RegExp(String.raw`(?:https?:)?(?:\\?/){2}(?:${hostRe})(?![\w.-])`, "gi");
  const relativize = (text) => text.replace(ABSOLUTE, (m, offset, s) => (/[/\\]/.test(s[offset + m.length] || "") ? "" : "/"));

  const pages = new Map(); // pathname -> { title, file } once fetched
  const pageQueue = new Set(["/"]);
  const pagesSeen = new Set(["/"]);
  const assetQueue = new Set();
  const assetsSeen = new Set();
  let assetCount = 0;
  const forms = new Map();
  const formFiles = [];
  const redirects = new Map(); // old path -> new path, written as Cloudflare's _redirects
  let skippedPages = 0;
  let siteName = "";

  const enqueue = (ref, base = origin + "/") => {
    let url;
    try { url = new URL(ref.replace(/\\\//g, "/"), base); } catch { return; }
    if (url.origin !== origin && url.host.replace(/^www\./, "") !== bare) return;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return; }
    if (SKIP.test(pathname) || BAD_FILENAME.test(pathname) || pathname.includes("..")) return;
    const ext = path.posix.extname(pathname).toLowerCase();
    if (!ext || ext === ".html" || ext === ".htm") {
      if (url.search || pagesSeen.has(pathname)) return;
      if (pagesSeen.size >= MAX_PAGES) { skippedPages++; return; }
      pagesSeen.add(pathname);
      pageQueue.add(pathname);
    } else if (!assetsSeen.has(pathname) && assetsSeen.size < MAX_ASSETS) {
      assetsSeen.add(pathname);
      assetQueue.add(pathname);
    }
  };

  const discoverHtml = (html) => {
    for (const m of html.matchAll(/\b(?:src|href|srcset|data-[\w-]+|poster|content)\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of m[1].split(",")) {
        const ref = part.trim().split(/\s+/)[0];
        if (ref.startsWith("/") && !ref.startsWith("//")) enqueue(ref);
      }
    }
    for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) if (m[1].startsWith("/")) enqueue(m[1]);
    // JSON-escaped paths in inline scripts (page-builder config): only take files.
    for (const m of html.matchAll(/["'](\\\/[^"'\s]+\.[a-z0-9]{2,5})["']/gi)) enqueue(m[1]);
  };

  const save = async (rel, data) => {
    const target = path.join(outDir, ...rel.split("/"));
    if (!target.startsWith(outDir + path.sep)) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  };

  const wireForms = (html, pageTitle) => {
    let wired = false;
    html = html.replace(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi, (whole, attrs, inner) => {
      if (!/\bmethod\s*=\s*["']?post/i.test(attrs)) return whole; // search forms etc. stay as they are
      const fields = formFields(inner);
      if (!fields.length) return whole;
      const formName = decode(attrsOf(attrs).name || "") || `${pageTitle} form`;
      const key = `${formName}|${fields.map((f) => f.id).join("|")}`; // same form on many pages (footers) = one form
      if (!forms.has(key)) forms.set(key, { id: crypto.randomBytes(4).toString("hex"), name: formName, fields, pages: [] });
      const form = forms.get(key);
      if (!form.pages.includes(pageTitle)) form.pages.push(pageTitle);
      wired = true;
      const kept = attrs.replace(/\s(action|method|onsubmit|novalidate|target)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
      return `<form${kept} data-form="${form.id}" data-success="__FORM_SUCCESS__">${inner}${FORM_EXTRAS}</form>`;
    });
    return wired ? html.replace(/<\/body>/i, `${FORM_SCRIPTS}</body>`) : html;
  };

  const fetchPage = async (pathname) => {
    const res = await fetch(new URL(pathname, origin)).catch(() => null);
    if (!res?.ok || !/text\/html/.test(res.headers.get("content-type") || "")) return;
    const finalUrl = new URL(res.url);
    if (finalUrl.pathname !== new URL(pathname, origin).pathname) {
      // Redirected: copy the target instead and keep the old address working.
      if (finalUrl.host.replace(/^www\./, "") === bare) redirects.set(pathname, finalUrl.pathname);
      return enqueue(finalUrl.href);
    }
    const html = relativize(await res.text());
    discoverHtml(html);
    if (pathname === "/") siteName = decode(html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)/i)?.[1]) || decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]).split(/\s[–—|·-]\s/)[0];
    let title = decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]) || pathname;
    if (siteName) title = title.replace(new RegExp(`\\s[–—|·-]\\s${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
    if (pathname === "/") title = "Home";
    const file = pageFile(pathname);
    const wired = wireForms(html, title);
    if (wired !== html) formFiles.push(file);
    await save(file, wired);
    pages.set(pathname, { title, file });
    log(`Copied page ${pages.size}: ${pathname}`);
  };

  const fetchAsset = async (pathname) => {
    const res = await fetch(new URL(pathname, origin)).catch(() => null);
    if (!res?.ok || Number(res.headers.get("content-length") || 0) > MAX_FILE) return;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FILE) return;
    const textual = /\.(css|js|mjs|json|svg|txt|xml)$/i.test(pathname);
    let data = textual ? relativize(bytes.toString("utf8")) : bytes;
    if (/\.css$/i.test(pathname)) {
      // url()s and @imports in CSS are relative to the stylesheet.
      const base = new URL(pathname, origin).href;
      for (const m of data.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) {
        const ref = m[1] || m[2];
        if (!/^(data|#)/i.test(ref)) enqueue(ref, base);
      }
    }
    await save(pathname.slice(1), data);
    if (++assetCount % 50 === 0) log(`Copied ${assetCount} files…`);
  };

  // Pages first (they discover the assets), then assets (CSS can discover more).
  for (const [queue, run] of [[pageQueue, fetchPage], [assetQueue, fetchAsset]]) {
    while (queue.size) {
      const batch = [...queue].slice(0, BATCH);
      batch.forEach((p) => queue.delete(p));
      await Promise.all(batch.map(run));
    }
  }

  // WordPress's own "not found" page, so the copy's 404s look the same.
  const missing = await fetch(new URL(`/sitebuilder-missing-${crypto.randomBytes(4).toString("hex")}/`, origin)).catch(() => null);
  if (missing?.status === 404 && /text\/html/.test(missing.headers.get("content-type") || "")) {
    const html = relativize(await missing.text());
    const wired = wireForms(html, "Not found");
    if (wired !== html) formFiles.push("404.html");
    await save("404.html", wired);
  }

  if (!pages.size) throw new Error("Couldn't copy any pages from that address.");
  if (redirects.size) await save("_redirects", [...redirects].map(([from, to]) => `${encodeURI(from)} ${encodeURI(to)} 301`).join("\n") + "\n");
  log(`Copied ${pages.size} pages and ${assetCount} files.${skippedPages ? ` Stopped at ${MAX_PAGES} pages.` : ""}`);
  return {
    name: siteName,
    pages: [...pages].map(([pathname, p]) => ({ path: pathname.endsWith("/") || /\.html?$/i.test(pathname) ? pathname : `${pathname}/`, title: p.title, file: p.file })),
    forms: [...forms.values()],
    formFiles,
  };
}

module.exports = { mirrorSite, detectBuilder, formFields, decode };
