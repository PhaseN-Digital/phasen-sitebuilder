// WordPress import, network side: fetches the site's pages over the REST API
// plus its home page HTML (for logo/colours/fonts). Parsing and sanitizing
// happen in the renderer (app/wordpress.js), which has a DOM to do it with.
const { detectBuilder } = require("./mirror");

// Pages that only work on WordPress itself (#56): shop, log-in and account pages.
// Copied from lib/mirror.js's form wiring (#22): shop, comment, log-in and search forms aren't enquiries.
const NOT_ENQUIRY = /\b(cart|checkout|woocommerce-[\w-]+|comment-?form|search-?form|login|log-?in|register|lost_reset_password)\b/i;
const NOT_ENQUIRY_FIELD = /\bname\s*=\s*["']?(add-to-cart|comment_post_ID|log|pwd|s)(?=["'\s>])|\brole\s*=\s*["']?search/i;
const PASSWORD = /<input\b[^>]*\btype\s*=\s*["']?password/i;
// Of those, the ones that make a page WordPress-only (a comment or search form doesn't).
const ACCOUNT_FORM = /\b(cart|checkout|woocommerce-[\w-]+|login|log-?in|register|lost_reset_password)\b/i;
const ACCOUNT_FIELD = /\bname\s*=\s*["']?(add-to-cart|log|pwd)(?=["'\s>])|\baction\s*=\s*["']?[^"'\s>]*wp-login\.php/i;
const ACCOUNT_SLUG = /^(cart|basket|checkout|(my-)?account|log-?in|sign-?in|log-?out|sign-?out|register|registration|sign-?up|lost-?password|(reset|forgot(ten)?)-?password|password-?reset|members?-?area|membership-(account|checkout|levels|billing|cancel|confirmation|invoice))$/;
// Shortcodes/blocks of WooCommerce and the common membership/login plugins, rendered or left unrendered.
const ACCOUNT_MARKUP = /\[(woocommerce_(cart|checkout|my_account)|pmpro_\w+|ultimatemember|um_\w+|swpm_\w+|mepr-\w+|rcp_\w+|wppb-\w+|user_registration_\w+|theme-my-login|wpmem_\w+)\b|\b(wp-block-woocommerce-(cart|checkout)|woocommerce-(cart|checkout|account)|woocommerce-MyAccount-\w+|pmpro_(login|checkout|account)\w*|um-(login|register|account))\b/i;

const slugOf = (s) => String(s || "").toLowerCase().replace(/&[^;\s]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// { wpOnly, enquiry }: wpOnly = skip the page; enquiry = it has a form ours should replace.
function classifyPage({ title, html, link }) {
  let enquiry = false, account = false;
  for (const [, attrs, inner] of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const cls = [...attrs.matchAll(/\b(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3]).join(" ");
    if (ACCOUNT_FORM.test(cls) || ACCOUNT_FIELD.test(attrs + inner) || PASSWORD.test(inner)) account = true;
    else if (!NOT_ENQUIRY.test(cls) && !NOT_ENQUIRY_FIELD.test(attrs + inner)) enquiry = true;
  }
  let path = "";
  try { path = new URL(link).pathname; } catch {}
  const slug = path.split("/").filter(Boolean).pop() || "";
  const wpOnly = ACCOUNT_SLUG.test(slugOf(title)) || ACCOUNT_SLUG.test(slug) || ACCOUNT_MARKUP.test(html) || (account && !enquiry);
  return { wpOnly, enquiry: !wpOnly && enquiry };
}

async function fetchWordPress(siteUrl, username, password) {
  let base = String(siteUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  const useAuth = Boolean(username && password);
  if (useAuth && !base.startsWith("https://")) throw new Error("For safety, a username and password can only be sent to an https:// address.");
  const auth = useAuth
    ? { Authorization: `Basic ${Buffer.from(`${username.trim()}:${password.replace(/\s+/g, "")}`).toString("base64")}` }
    : null;

  // Anonymous first, even with credentials: authenticated requests render
  // pages as that (admin) user, so login/account shortcodes would come out as
  // "You're already signed in" (#43). Credentials are only used, from then on,
  // once the site refuses an anonymous request.
  let headers = {};
  const get = async (url) => {
    let res = await fetch(url, { headers });
    if ((res.status === 401 || res.status === 403) && auth && headers !== auth) {
      headers = auth;
      res = await fetch(url, { headers });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(useAuth ? "WordPress refused the username or application password." : "This WordPress site needs a username and application password.");
    }
    if (!res.ok) throw new Error(`WordPress returned an error (HTTP ${res.status}).`);
    return res;
  };
  // Some plugins print HTML (notices, debug output) before the JSON, so parse from where the JSON starts.
  const json = async (res) => {
    const text = await res.text();
    try { return JSON.parse(text.slice(Math.max(0, text.search(/\[\s*\{|\{\s*"/)))); } catch {
      throw new Error("WordPress's content API sent back something that isn't valid data (often a plugin printing errors).");
    }
  };

  // Pretty permalinks first, then the ?rest_route= form every WordPress supports.
  const styles = [
    (route, query = "") => `${base}/wp-json${route}${query && `?${query}`}`,
    (route, query = "") => `${base}/?rest_route=${route}${query && `&${query}`}`,
  ];
  let api, info;
  const discover = async () => {
    for (const style of styles) {
      try {
        info = await json(await get(style("/")));
        if (info?.namespaces?.includes("wp/v2")) { api = style; return; }
      } catch (e) {
        if (/refused|needs a username/.test(e.message)) throw e;
      }
    }
  };
  await discover();
  // Some security plugins hide wp/v2 from anonymous visitors instead of refusing them.
  if (!api && auth && headers !== auth) { headers = auth; await discover(); }
  if (!api) throw new Error("Couldn't find a WordPress site at that address (or its REST API is switched off).");

  // Ownership verification (#141): the application password was accepted, either
  // because the site needed it above or by WordPress's "who am I" endpoint.
  const authenticated = useAuth && (headers === auth || (await fetch(api("/wp/v2/users/me"), { headers: auth }).then((r) => r.ok, () => false)));

  const homeHtml = await (await get(`${base}/`)).text();
  const pages = [];
  for (let page = 1; ; page++) {
    const res = await get(api("/wp/v2/pages", `per_page=100&page=${page}&orderby=menu_order&order=asc&_fields=id,title,content,link`));
    pages.push(...(await json(res)));
    if (page >= Number(res.headers.get("x-wp-totalpages") || 1)) break;
  }
  // Posts (#180), newest first. A site without the posts route (a plugin can remove it) just has none.
  const posts = [];
  try {
    for (let page = 1; ; page++) {
      const res = await get(api("/wp/v2/posts", `per_page=100&page=${page}&_embed=author,wp:featuredmedia&_fields=id,title,content,link,date,excerpt,_links,_embedded`));
      posts.push(...(await json(res)));
      if (page >= Number(res.headers.get("x-wp-totalpages") || 1)) break;
    }
  } catch (e) {
    if (/refused|needs a username/.test(e.message)) throw e;
  }

  // Elementor keeps its global colours and fonts in the active kit's stylesheet,
  // an external file (unless it's set to print CSS inline, which homeHtml already has).
  const kitId = homeHtml.match(/\belementor-kit-(\d+)\b/)?.[1];
  let kitCss = "";
  if (kitId) try {
    const res = await fetch(`${base}/wp-content/uploads/elementor/css/post-${kitId}.css`);
    if (res.ok) kitCss = (await res.text()).slice(0, 2e6);
  } catch {}

  return {
    base,
    authenticated,
    kitCss,
    name: info.name || "",
    description: info.description || "",
    homeHtml,
    builder: detectBuilder(homeHtml),
    ...splitPages(await fromTemplates(base, homeHtml, withBlog(base, homeHtml, pages.map(asPage), posts.map(asPost)), async (url) => (await get(url)).text())),
  };
}

const asPage = (p) => ({ id: p.id, title: p.title?.rendered || "", html: stripShortcodes(p.content?.rendered || ""), link: p.link });

// Divi and WPBakery keep layouts as shortcodes, which the REST API returns as
// text when the builder isn't rendering them (#24). Drop the shortcode tags and
// keep what's between them; a Divi image module's src becomes an <img>.
// Unrendered shortcodes are run through wptexturize, so quotes may be &#8221; etc.
// WPBakery's raw HTML/JS blocks are encoded, so they go with their contents.
// ponytail: other modules' attribute text (button labels, CTA titles) is lost; map them when a real site needs it.
const BUILDER_SHORTCODE = /\[\/?(?:et_pb|vc)_[\w-]*(?:\s[^\]]*)?\]/g;
function stripShortcodes(html) {
  return String(html)
    .replace(/\[vc_raw_(html|js)\b[^\]]*\][\s\S]*?\[\/vc_raw_\1\]/g, "")
    .replace(/\[et_pb_image\b[^\]]*?\bsrc=[^\s\]]*?(https?:\/\/[^\s"'\]]+?)(?=&#\d+;|["'\s\]])[^\]]*\]/g, (m, src) => `<img src="${src}" alt="">`)
    .replace(BUILDER_SHORTCODE, "")
    .replace(/<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>/g, "");
}

// Block themes build some pages (often the front page) from templates, so
// their content is empty (#24): use the <main> of the page as WordPress shows
// it instead. Only for the site's own addresses; the blog page is ours to build.
const isEmpty = (html) => !html.replace(/<[^>]*>|&nbsp;|\s/g, "");
// The page's own title heading goes: the page's title band shows it.
const mainOf = (html) => (String(html).match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] || "").replace(/<h1\b[^>]*\b(wp-block-post-title|entry-title)\b[^>]*>[\s\S]*?<\/h1>/gi, "");
async function fromTemplates(base, homeHtml, pages, text) {
  for (const p of pages) {
    if (p.layout || !isEmpty(p.html)) continue;
    let url;
    try { url = new URL(p.link, `${base}/`); } catch { continue; }
    if (url.origin !== new URL(base).origin) continue;
    try { p.html = mainOf(url.pathname === new URL(`${base}/`).pathname ? homeHtml : await text(url.href)); } catch {}
  }
  return pages;
}
// A post as a "blog-post" page. Its excerpt is HTML (the renderer makes it plain text); WordPress
// writes one from the content when the author didn't, ending in "[&hellip;]".
function asPost(p) {
  const media = p._embedded?.["wp:featuredmedia"]?.[0];
  return {
    ...asPage(p),
    layout: "blog-post",
    date: /^\d{4}-\d{2}-\d{2}/.test(p.date || "") ? p.date.slice(0, 10) : "",
    author: p._embedded?.author?.[0]?.name || "",
    excerpt: String(p.excerpt?.rendered || "").replace(/\s*\[(&hellip;|&#8230;|…|\.\.\.)\]\s*(<\/p>)?\s*$/, "…$2"),
    ...(media?.source_url && { featuredImage: { src: media.source_url, alt: media.alt_text || "" } }),
  };
}

// With any posts, one "blog-index" page lists them, at the old blog's address: the
// home page when WordPress shows posts there, else its empty "Blog"/"News" page, else /blog/.
function withBlog(base, homeHtml, pages, posts) {
  if (!posts.length) return pages;
  const pathOf = (link) => { try { return new URL(link, `${base}/`).pathname; } catch { return ""; } };
  const bodyClass = homeHtml.match(/<body\b[^>]*\bclass\s*=\s*["']([^"']*)/i)?.[1].split(/\s+/) || [];
  if (bodyClass.includes("blog") && bodyClass.includes("home")) {
    return [{ id: "blog", title: "Home", html: "", link: `${base}/`, layout: "blog-index" }, ...pages, ...posts];
  }
  const own = pages.find((p) => /^(blog|news|articles|posts)$/.test(pathOf(p.link).split("/").filter(Boolean).pop() || "") && isEmpty(p.html));
  if (own) own.layout = "blog-index";
  const free = ["/blog/", "/posts/", "/articles/"].find((x) => !pages.some((p) => pathOf(p.link).replace(/\/?$/, "/") === x));
  return [...pages, ...(own ? [] : [{ id: "blog", title: "Blog", html: "", link: `${base}${free || "/blog-posts/"}`, layout: "blog-index" }]), ...posts];
}

// { pages (each with `form`: swap in our contact form), skipped: titles of WordPress-only pages }.
function splitPages(all) {
  const pages = [], skipped = [];
  for (const p of all) {
    const { wpOnly, enquiry } = classifyPage(p);
    if (wpOnly) skipped.push(p.title); else pages.push({ ...p, form: enquiry });
  }
  return { pages, skipped };
}

// SVG (a block theme's logo, #282) is allowed through as bytes only: app/wordpress.js rasterises it.
async function downloadImage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Not a web address.");
  const res = await fetch(url);
  if (!res.ok || !/^image\/(jpeg|png|webp|gif|svg\+xml)/.test(res.headers.get("content-type") || "")) throw new Error(`Couldn't download ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 25e6) throw new Error(`${url} is too large.`);
  return bytes;
}

module.exports = { fetchWordPress, downloadImage, classifyPage, withBlog, stripShortcodes, fromTemplates };
