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

  const homeHtml = await (await get(`${base}/`)).text();
  const pages = [];
  for (let page = 1; ; page++) {
    const res = await get(api("/wp/v2/pages", `per_page=100&page=${page}&orderby=menu_order&order=asc&_fields=id,title,content,link`));
    pages.push(...(await json(res)));
    if (page >= Number(res.headers.get("x-wp-totalpages") || 1)) break;
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
    kitCss,
    name: info.name || "",
    description: info.description || "",
    homeHtml,
    builder: detectBuilder(homeHtml),
    ...splitPages(pages.map((p) => ({ id: p.id, title: p.title?.rendered || "", html: p.content?.rendered || "", link: p.link }))),
  };
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

async function downloadImage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Not a web address.");
  const res = await fetch(url);
  if (!res.ok || !/^image\/(jpeg|png|webp|gif)/.test(res.headers.get("content-type") || "")) throw new Error(`Couldn't download ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 25e6) throw new Error(`${url} is too large.`);
  return bytes;
}

module.exports = { fetchWordPress, downloadImage, classifyPage };
