// WordPress import, network side: fetches the site's pages over the REST API
// plus its home page HTML (for logo/colours/fonts). Parsing and sanitizing
// happen in the renderer (app/wordpress.js), which has a DOM to do it with.
const { detectBuilder } = require("./mirror");

async function fetchWordPress(siteUrl, username, password) {
  let base = String(siteUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  const useAuth = Boolean(username && password);
  if (useAuth && !base.startsWith("https://")) throw new Error("For safety, a username and password can only be sent to an https:// address.");
  const headers = useAuth
    ? { Authorization: `Basic ${Buffer.from(`${username.trim()}:${password.replace(/\s+/g, "")}`).toString("base64")}` }
    : {};

  const get = async (url) => {
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
      throw new Error(useAuth ? "WordPress refused the username or application password." : "This WordPress site needs a username and application password.");
    }
    if (!res.ok) throw new Error(`WordPress returned an error (HTTP ${res.status}).`);
    return res;
  };

  // Pretty permalinks first, then the ?rest_route= form every WordPress supports.
  const styles = [
    (route, query = "") => `${base}/wp-json${route}${query && `?${query}`}`,
    (route, query = "") => `${base}/?rest_route=${route}${query && `&${query}`}`,
  ];
  let api, info;
  for (const style of styles) {
    try {
      info = await (await get(style("/"))).json();
      if (info?.namespaces?.includes("wp/v2")) { api = style; break; }
    } catch (e) {
      if (/refused|needs a username/.test(e.message)) throw e;
    }
  }
  if (!api) throw new Error("Couldn't find a WordPress site at that address (or its REST API is switched off).");

  const homeHtml = await (await get(`${base}/`)).text();
  const pages = [];
  for (let page = 1; ; page++) {
    const res = await get(api("/wp/v2/pages", `per_page=100&page=${page}&orderby=menu_order&order=asc&_fields=id,title,content,link`));
    pages.push(...(await res.json()));
    if (page >= Number(res.headers.get("x-wp-totalpages") || 1)) break;
  }

  return {
    base,
    name: info.name || "",
    description: info.description || "",
    homeHtml,
    builder: detectBuilder(homeHtml),
    pages: pages.map((p) => ({ id: p.id, title: p.title?.rendered || "", html: p.content?.rendered || "", link: p.link })),
  };
}

async function downloadImage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Not a web address.");
  const res = await fetch(url);
  if (!res.ok || !/^image\/(jpeg|png|webp|gif)/.test(res.headers.get("content-type") || "")) throw new Error(`Couldn't download ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 25e6) throw new Error(`${url} is too large.`);
  return bytes;
}

module.exports = { fetchWordPress, downloadImage };
