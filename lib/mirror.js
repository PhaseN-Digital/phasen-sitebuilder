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
const SKIP = /\/(wp-admin|wp-login\.php|wp-json|xmlrpc\.php|wp-cron\.php|cgi-bin)\b|\/(feed|trackback|embed)\/?$|\.php$/i;
const BAD_FILENAME = /[<>:"|?*\x00-\x1f]/;
const BUILDERS = {
  Elementor: /data-elementor-type|\belementor-(kit-\d|section|element)\b/i, Divi: /et_pb_|et-db/i, "Beaver Builder": /fl-builder/i, WPBakery: /vc_row|wpb_/i,
  Bricks: /brxe-/i, Oxygen: /ct-section/i, Avada: /fusion-builder|fusion-layout/i,
};
const SKIP_INPUTS = new Set(["hidden", "submit", "button", "reset", "image", "file", "password"]);
const HONEYPOT = /^ak_hp_|__fluent_sf$/; // Akismet, Fluent Forms: hidden by CSS, never questions
// Shop, comment, log-in and search forms aren't enquiries, whatever their method.
const NOT_ENQUIRY = /\b(cart|checkout|woocommerce-[\w-]+|comment-?form|search-?form|login|log-?in|register|lost_reset_password)\b/i;
const NOT_ENQUIRY_FIELD = /\bname\s*=\s*["']?(add-to-cart|comment_post_ID|log|pwd|s)(?=["'\s>])|\brole\s*=\s*["']?search/i;
// Conditional branches (Gravity, Fluent, Divi…) start hidden, so their fields can't be required.
const HIDDEN_CLASS = /(^|\s)(hidden|has-conditions|ff_excluded|gf_hidden)(\s|$)/i;
const hiddenByDefault = (a) => "hidden" in a || HIDDEN_CLASS.test(a.class || "") || /display\s*:\s*none/i.test(a.style || "")
  || (a["data-conditional-logic"] != null && a["data-conditional-logic"] !== "visible");
// Text-level tags that don't separate a question from its field.
const INLINE = new Set(["br", "span", "label", "strong", "b", "em", "i", "small", "abbr", "sup", "font", "input", "textarea", "select"]);
// `your-message` → "Your message", `f[first_name]` → "First name", for a field with nothing else to go on.
const humanise = (name) => {
  const s = name.replace(/\[\]$/, "").replace(/^.*\[([^\]]+)\]$/, "$1").replace(/[-_\s]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : name;
};
const VOID = new Set(["br", "img", "hr", "meta", "link", "source", "wbr", "col", "area", "embed", "track"]);
const FORM_SCRIPTS = `<script src="/form.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad" async defer></script>`;
const FORM_EXTRAS = `<label style="position:absolute;left:-10000px" aria-hidden="true">Leave blank<input name="website" tabindex="-1" autocomplete="off"></label><div class="cf-turnstile" data-sitekey="__TURNSTILE_SITEKEY__"></div><p class="form-status" role="status" aria-live="polite"></p>`;

// Third-party tracking the copy drops (#45): the new site has no consent for it, and it reports to the old site's accounts.
// A <script>, <noscript> or <link> whose markup matches is removed whole.
const TRACKERS = [
  ["Google Analytics / Tag Manager", /googletagmanager\.com|google-analytics\.com|\bgtag\(\s*["']config/i],
  ["Facebook pixel", /connect\.facebook\.net|facebook\.com\/tr\?/i],
  ["Hotjar", /hotjar\.com/i],
  ["Microsoft Clarity", /clarity\.ms/i],
  ["LinkedIn Insight", /snap\.licdn\.com|px\.ads\.linkedin\.com/i],
  ["TikTok pixel", /analytics\.tiktok\.com/i],
  ["Microsoft Ads", /bat\.bing\.com/i],
];
// Google serves woff2 subsets to browsers but one big TTF per weight to unknown clients.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

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
  const byId = (id) => decode((inner.match(new RegExp(`<(\\w+)[^>]*\\bid=["']?${id.replace(/\W/g, "\\$&")}["'\\s>][^>]*>([\\s\\S]*?)</\\1>`, "i")) || [])[2]);
  const fields = [];
  const open = []; // [tag, hidden, index] for each enclosing element, from a forgiving tag walk
  let nearby = "", last = 0; // text since the last block boundary, e.g. CF7's <p>Your Message<br><span><textarea>
  for (const m of inner.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = m[2].toLowerCase();
    nearby = INLINE.has(tag) ? `${nearby} ${inner.slice(last, m.index)}` : "";
    last = m.index + m[0].length;
    if (m[1]) {
      const i = open.findLastIndex(([t]) => t === tag);
      if (i >= 0) open.length = i;
      if (tag === "textarea" || tag === "select") nearby = ""; // its contents are an answer, not a question
      continue;
    }
    const a = attrsOf(m[3]);
    if (!["input", "textarea", "select"].includes(tag)) {
      if (!VOID.has(tag) && !m[3].trim().endsWith("/")) open.push([tag, hiddenByDefault(a), m.index]);
      continue;
    }
    const near = decode(nearby);
    nearby = "";
    const type = tag === "input" ? (a.type || "text").toLowerCase() : tag;
    if (!a.name || a.name === "website" || HONEYPOT.test(a.name) || SKIP_INPUTS.has(type) || fields.some((f) => f.id === a.name)) continue;
    const wrapping = (at) => {
      const l = open.findLast(([t]) => t === "label");
      return l ? decode(inner.slice(l[2], inner.indexOf("</label>", at) >>> 0).replace(/<(select|textarea)\b[\s\S]*?<\/\1>/gi, "")) : "";
    };
    const choice = ["checkbox", "radio", "select"].includes(type);
    fields.push({
      id: a.name,
      // A choice's own <label> is one option (Elementor labels the group by the id without its -0 suffix).
      // A wrapping <label> is the question for a text box, but only the last resort for a choice (one option, or a lone consent box).
      label: ((choice ? labels[(a.id || "").replace(/-\d+$/, "")] : labels[a.id] || wrapping(m.index))
        || (a["aria-labelledby"] || "").split(/\s+/).filter(Boolean).map(byId).join(" ")
        || a["aria-label"] || near || a.placeholder || (choice && wrapping(m.index)) || humanise(a.name)).slice(0, 100),
      type: choice ? "choice" : ["email", "tel", "textarea"].includes(type) ? type : "text",
      required: ("required" in a || a["aria-required"] === "true") && !open.some(([, hidden]) => hidden),
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
  const { origin, host, pathname: firstPath } = new URL(first.url);
  // WordPress can live in a subfolder (example.com/blog/): copy only that, from its home page. Paths keep the
  // folder and `/` redirects to it, so the copy's addresses match the old site's.
  const home = firstPath.replace(/[^/]*$/, "");
  const bare = host.replace(/^www\./, "");
  const hostRe = [bare, `www.${bare}`].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // This site's absolute URLs, plain, protocol-relative or JSON-escaped (https:\/\/host).
  const ABSOLUTE = new RegExp(String.raw`(?:https?:)?(?:\\?/){2}(?:${hostRe})(?![\w.-])`, "gi");
  const relativize = (text) => text.replace(ABSOLUTE, (m, offset, s) => (/[/\\]/.test(s[offset + m.length] || "") ? "" : "/"));
  const removed = new Set(); // TRACKERS names found
  const stripTrackers = (html) => html.replace(/<(script|noscript)\b[^>]*>[\s\S]*?<\/\1>\s*|<link\b[^>]*>\s*/gi, (tag) => {
    if (/^<link\b[^>]*\brel=["']?(preconnect|dns-prefetch)/i.test(tag) && /fonts\.(googleapis|gstatic)\.com/i.test(tag)) return "";
    const hit = TRACKERS.find(([, re]) => re.test(tag));
    if (hit) removed.add(hit[0]);
    return hit ? "" : tag;
  });
  // Google Fonts stylesheets are downloaded after the crawl (with their fonts) and served from /google-fonts/.
  const googleCss = new Map(); // stylesheet URL -> local path
  const selfHostFonts = (text) => text.replace(/(?:https?:)?\/\/fonts\.googleapis\.com\/[^"'()\s<>]+/gi, (m) => {
    const url = decode(m.startsWith("//") ? `https:${m}` : m); // &#038; in WordPress's hrefs
    if (!googleCss.has(url)) googleCss.set(url, `/google-fonts/${crypto.createHash("sha1").update(url).digest("hex").slice(0, 12)}.css`);
    return googleCss.get(url);
  });
  // <link>s to WordPress's API (REST discovery, oEmbed, EditURI) would be dead on the copy, and oEmbed ones carry the old address URL-encoded.
  const pageHtml = (text) => selfHostFonts(stripTrackers(relativize(text))).replace(/<link\b[^>]*\bhref=["'](\/[^"'?]*)[^>]*>\s*/gi, (m, href) => (SKIP.test(href) ? "" : m));
  // A canonical/og:url naming another host (a staging copy's live domain) would still send search engines there:
  // keep only the path. build() turns these tags back into absolute URLs on the published hostname (#115).
  const pageUrlTags = (html) => html.replace(/<(?:link|meta)\b[^>]*>/gi, (tag) => (/\b(?:rel=["']?canonical|(?:property|name)=["']?(?:og|twitter):url)\b/i.test(tag)
    ? tag.replace(/\b(href|content)=(["'])https?:\/\/[^/"']+\/?/i, "$1=$2/") : tag));

  const pages = new Map(); // pathname -> { title, file } once fetched
  const pageQueue = new Set([home]);
  const pagesSeen = new Set([home]);
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
    if (SKIP.test(pathname) || pathname.startsWith("/google-fonts/") || BAD_FILENAME.test(pathname) || pathname.includes("..")) return;
    const ext = path.posix.extname(pathname).toLowerCase();
    if (!ext || ext === ".html" || ext === ".htm") {
      if (url.search || pagesSeen.has(pathname) || !pathname.startsWith(home)) return;
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
    // Paths in inline scripts (page-builder config, WordPress's emoji loader), JSON-escaped or not: only take files.
    for (const m of html.matchAll(/["']((?:\\?\/)+[^"'\s?]+\.[a-z0-9]{2,5})(?:\?[^"'\s]*)?["']/gi)) enqueue(m[1]);
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
      const { class: cls = "", id = "" } = attrsOf(attrs);
      if (NOT_ENQUIRY.test(`${cls} ${id}`) || NOT_ENQUIRY_FIELD.test(attrs + inner) || /<input\b[^>]*\btype\s*=\s*["']?password/i.test(inner)) return whole;
      const fields = formFields(inner);
      if (!fields.length) return whole;
      // Fields in hidden branches lose `required` in the markup too, or the browser would block every submit.
      inner = inner.replace(/<(?:input|textarea|select)\b[^>]*>/gi, (tag) => (fields.find((f) => f.id === attrsOf(tag).name)?.required === false
        ? tag.replace(/\s([\w:-]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, (attr, name) => (name.toLowerCase() === "required" ? "" : attr)) : tag));
      const formName = decode(attrsOf(attrs).name || "") || `${pageTitle} form`;
      // Same form on many pages (footers) = one form, even when it's only named after the page.
      const key = `${attrsOf(attrs).name || ""}|${fields.map((f) => f.id).join("|")}`;
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
      if (finalUrl.host.replace(/^www\./, "") === bare && finalUrl.pathname.startsWith(home)) redirects.set(pathname, finalUrl.pathname);
      return enqueue(finalUrl.href);
    }
    const html = pageUrlTags(pageHtml(await res.text()));
    discoverHtml(html);
    if (pathname === home) siteName = decode(html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)/i)?.[1]) || decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]).split(/\s[–—|·-]\s/)[0];
    let title = decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]) || pathname;
    if (siteName) title = title.replace(new RegExp(`\\s[–—|·-]\\s${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
    if (pathname === home) title = "Home";
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
    if (/\.css$/i.test(pathname)) data = selfHostFonts(data);
    // Elementor builds some script/style addresses at runtime (widget chunks, popup dialog, swiper…),
    // so the crawl can't see them: take the names from its scripts.
    if (/\/elementor[\w-]*\/assets\/js\/.+\.js$/i.test(pathname)) {
      const js = new URL(pathname.replace(/(\/assets\/js\/).*/, "$1"), origin).href;
      for (const m of data.matchAll(/__elementorLoadChunk\(\s*[`'"]([\w-]+)[`'"]/g)) enqueue(`chunks/${m[1]}.min.js`, js);
      for (const m of data.matchAll(/`\$\{\w+\}((?:lib|css)\/[\w/.-]+?)\$\{\w+\}\.(js|css)/g)) enqueue(`../${m[1]}.min.${m[2]}`, js);
    }
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

  // WordPress's own "not found" page, so the copy's 404s look the same. Fetched
  // before the crawl so its own stylesheets and images get copied too.
  const missing = await fetch(new URL(`${home}sitebuilder-missing-${crypto.randomBytes(4).toString("hex")}/`, origin)).catch(() => null);
  const notFound = missing?.status === 404 && /text\/html/.test(missing.headers.get("content-type") || "") && pageHtml(await missing.text());
  if (notFound) discoverHtml(notFound);

  // Home on its own first (#273): it sets siteName, which every other page's title is stripped of, so a page in
  // home's batch (the 404 page's links join it) mustn't finish before it.
  pageQueue.delete(home);
  await fetchPage(home);

  // Pages first (they discover the assets), then assets (CSS can discover more).
  for (const [queue, run] of [[pageQueue, fetchPage], [assetQueue, fetchAsset]]) {
    while (queue.size) {
      const batch = [...queue].slice(0, BATCH);
      batch.forEach((p) => queue.delete(p));
      await Promise.all(batch.map(run));
    }
  }

  if (notFound) {
    const wired = wireForms(notFound, "Not found");
    if (wired !== notFound) formFiles.push("404.html");
    await save("404.html", wired);
  }

  for (const [url, local] of googleCss) {
    try {
      const res = await fetch(url, { headers: { "user-agent": BROWSER_UA } });
      if (!res.ok) throw new Error();
      const css = await res.text();
      await Promise.all([...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)"'\s]+/g))].map(async (font) => {
        const r = await fetch(font);
        if (!r.ok) throw new Error();
        await save(`google-fonts${new URL(font).pathname}`, Buffer.from(await r.arrayBuffer()));
      }));
      await save(local.slice(1), css.replaceAll("https://fonts.gstatic.com/", "/google-fonts/"));
    } catch {
      log(`Couldn't download Google Fonts from ${url}, so text using them falls back to the next font in the stylesheet.`);
    }
  }
  if (googleCss.size) log(`Google Fonts are now part of the copy, so visitors' browsers no longer contact Google for them.`);
  if (removed.size) log(`Removed the original site's tracking (${[...removed].join(", ")}): it would report to their accounts without your visitors' consent.`);

  // The original robots.txt and sitemap.xml (#115), root-relative like everything else (build() adds the published
  // hostname back). The sitemap keeps only pages that were copied; an index of sitemaps (WordPress's own, Yoast's)
  // is skipped and build() lists the copied pages instead, which is also where robots.txt's Sitemap line points.
  // A copy of a subfolder doesn't take them: they belong to whatever else lives on that domain.
  const fetchText = async (pathname, type) => {
    const res = await fetch(new URL(pathname, origin)).catch(() => null);
    return res?.ok && new URL(res.url).host.replace(/^www\./, "") === bare && type.test(res.headers.get("content-type") || "") ? relativize(await res.text()) : null;
  };
  const robots = home === "/" && (await fetchText("/robots.txt", /text\/plain/));
  if (robots) {
    const kept = robots.replace(/^Sitemap:\s*\/(?!\/).*(\r?\n|$)/gim, "");
    await save("robots.txt", kept === robots ? robots : `${kept.trimEnd()}\n\nSitemap: /sitemap.xml\n`);
    const blocked = robotsBlocked(robots);
    if (blocked.search) log("The original site's robots.txt asks search engines not to index it, and the copy keeps that.");
    if (blocked.others.length) log(`The copy keeps the original's AI crawler blocks (${blocked.others.join(", ")}).`);
  }
  const sitemap = home === "/" && (await fetchText("/sitemap.xml", /xml/));
  if (sitemap && /<urlset\b/.test(sitemap)) {
    const copied = new Set([...pages.keys()].map((p) => p.replace(/\/$/, "")));
    const urls = sitemap.replace(/<\?xml-stylesheet[^>]*\?>\s*/g, "").replace(/<url>[\s\S]*?<\/url>\s*/g, (url) => {
      try { return copied.has(decodeURIComponent(decode(url.match(/<loc>\s*([^<\s]*)/)[1])).replace(/\/$/, "")) ? url : ""; } catch { return ""; }
    });
    if (/<url>/.test(urls)) await save("sitemap.xml", urls);
  }

  if (home !== "/" && pages.has(home)) redirects.set("/", home);
  if (!pages.size) throw new Error("Couldn't copy any pages from that address.");
  if (redirects.size) await save("_redirects", [...redirects].map(([from, to]) => `${encodeURI(from)} ${encodeURI(to)} 301`).join("\n") + "\n");
  log(`Copied ${pages.size} pages and ${assetCount} files.${skippedPages ? ` Stopped at ${MAX_PAGES} pages.` : ""}`);
  return {
    name: siteName,
    // Crawl order, home first (#95): `pages` is in the order fetches finished, which a batch's slow home page loses.
    pages: [...pagesSeen].filter((p) => pages.has(p)).map((pathname) => [pathname, pages.get(pathname)]).map(([pathname, p]) => ({ path: pathname.endsWith("/") || /\.html?$/i.test(pathname) ? pathname : `${pathname}/`, title: p.title, file: p.file })),
    forms: [...forms.values()],
    formFiles,
    removed: [...removed],
  };
}

// Ownership verification for any import (#141): attempted and recorded, never required.
// Verified when the source's domain is a zone in the user's Cloudflare account
// (`zones`, from lib/publish.js listZones), when a WordPress import signed in with
// an application password (`wpAuthenticated`), or when the source serves
// /phasen-verify-<token>.txt containing the token shown in the import dialog.
async function verifyOwnership(source, { zones = [], wpAuthenticated = false, token = "" } = {}) {
  const host = new URL(source).hostname.toLowerCase();
  const bare = (h) => h.replace(/^www\./, "");
  let method = zones.some((z) => host === z.name || host.endsWith(`.${z.name}`)) ? "cloudflare-zone" : wpAuthenticated ? "wordpress-application-password" : null;
  if (!method && /^[a-f0-9]{16,64}$/.test(token)) {
    try {
      const res = await fetch(`${new URL(source).origin}/phasen-verify-${token}.txt`, { signal: AbortSignal.timeout(15000) });
      // Following a redirect is fine (http -> https, www), but only on the same site.
      if (res.ok && bare(new URL(res.url).hostname) === bare(host) && (await res.text()).includes(token)) method = "verification-file";
    } catch {}
  }
  return { status: method ? "verified" : "unverified", ...(method && { method }), checkedAt: new Date().toISOString() };
}

// Which user-agents robots.txt shuts out of the whole site (#167). Consecutive User-agent lines share the rules that
// follow them. `search` is true when `*`, Googlebot or Bingbot get `Disallow: /`; `others` lists the rest by name.
// ponytail: every other blocked agent is called an AI crawler (it's what managed robots.txt files block); Allow
// precedence and wildcard paths other than `/*` are ignored.
function robotsBlocked(text) {
  const blocked = new Set();
  let agents = [], inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, "").match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2];
    if (field === "user-agent") {
      if (inRules) agents = [], inRules = false;
      agents.push(value);
    } else {
      inRules = true;
      if (field === "disallow" && /^\/\*?$/.test(value)) agents.forEach((a) => blocked.add(a));
    }
  }
  const isSearch = (a) => /^(\*|googlebot|bingbot)$/i.test(a);
  return { search: [...blocked].some(isSearch), others: [...blocked].filter((a) => !isSearch(a)) };
}

module.exports = { robotsBlocked, mirrorSite, detectBuilder, formFields, decode, verifyOwnership };
