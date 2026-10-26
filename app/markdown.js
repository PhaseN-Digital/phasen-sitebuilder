// Markdown import (#255), renderer side. main.js reads and renders the files
// (lib/markdown.js); here their HTML goes through the editable imports'
// allowlist sanitizer and image copying (app/wordpress.js), and links between
// the files become links to their pages. A folder makes a new website; files
// picked on the Pages tab are added to the open one.

// Relative links and images resolve against this made-up origin (.invalid never resolves), so they can be found again.
const MD_BASE = "https://markdown.invalid/";

// Resolves to the new website's id (folder) or the first added page's id (files), or null if cancelled.
async function importMarkdown(kind, log = () => {}) {
  const declaration = await declarationDialog({ url: kind === "folder" ? "a folder of Markdown files" : "Markdown files", local: true });
  if (!declaration) return null;
  const picked = await call("md:open", kind, declaration);
  if (!picked) return null;
  log(`Found ${picked.pages.length} Markdown file${picked.pages.length === 1 ? "" : "s"}.`);
  let s;
  if (kind === "folder") {
    s = await call("sites:create", picked.name, "clean");
    s.importProvenance = picked.provenance;
  } else {
    await flushSave();
    s = site;
    s.importProvenance ||= picked.provenance; // a site imported from a website keeps that source
  }
  const local = (abs) => decodeURIComponent(new URL(abs).pathname.slice(1));
  const images = imageFetcher(s.id, MD_BASE, (abs) => (abs.startsWith(MD_BASE) ? call("md:image", picked.token, local(abs)) : call("wp:image", abs)));
  const ids = picked.pages.map(() => rid());
  const byLink = new Map(picked.pages.map((p, i) => [pageKey(new URL(p.rel, MD_BASE).href), ids[i]]));
  const pages = [];
  for (const [i, p] of picked.pages.entries()) {
    log(`Importing ${p.rel}`);
    const body = cleanFragment(p.html, new URL(p.rel, MD_BASE).href);
    // Links to other files in the folder that aren't pages (a PDF, a missing file) would lead nowhere.
    for (const a of body.querySelectorAll("a[href]")) if (a.getAttribute("href").startsWith(MD_BASE) && !byLink.has(pageKey(a.getAttribute("href")))) a.removeAttribute("href");
    pages.push({ id: ids[i], title: p.title, ...(p.path && { path: p.path }), sections: [{ id: rid(), type: "richtext", html: await rewriteContent(body, byLink, images) }] });
  }
  // Home for a new site's first page, else Standard, as lib/layouts.js's migrateLayouts would decide on the next load.
  pages.forEach((p, i) => { p.layout = kind === "folder" && i === 0 ? "home" : "standard"; });
  if (kind === "folder") {
    s.pages = pages;
    await call("sites:save", s);
  } else {
    s.pages.push(...pages);
    if (site === s) save();
    else await call("sites:save", s);
  }
  log(`Done.${imagesFailed(images)}`);
  return kind === "folder" ? s.id : pages[0].id;
}

// The Import screen's Markdown card: a folder becomes a new website.
function markdownImportCard() {
  const status = h("pre", { className: "log", hidden: true });
  const error = h("p", { className: "error" });
  const button = h("button", { type: "button", onclick: async () => {
    button.disabled = true; error.textContent = ""; status.textContent = "";
    try {
      const id = await importMarkdown("folder", (line) => { status.hidden = false; status.textContent += line + "\n"; });
      if (id) return openSite(id);
    } catch (e) {
      error.textContent = errorText(e);
      loadSites();
    }
    button.disabled = false;
  } }, "Import a folder of Markdown files…");
  return h("div", { className: "import markdown-import", style: "margin-top:40px" },
    h("h2", {}, "Import Markdown"),
    h("p", { className: "hint" }, "Choose a folder: each Markdown (.md) file becomes a page of a new website, with index.md or README.md as the home page. To add Markdown files to a website you already have, use Import Markdown on its Pages screen."),
    button, error, status);
}

// The Pages tab's "Import Markdown…": the files become pages of the open website.
async function addMarkdownPages() {
  try {
    const first = await importMarkdown("files");
    if (first) { pageId = first; renderTab(); }
  } catch (e) {
    alert(errorText(e));
  }
}
