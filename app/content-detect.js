// Editable import for any website (#161), renderer side. Finds what every page
// shares (header, menu, footer, sidebar, cookie banner: the "chrome" a theme
// replaces) and each page's own content, for app/wordpress.js to rebuild as
// rich text. Pure functions over parsed (inert) Documents, so test/drive.js can
// check them directly. Readability is Mozilla's reader-view library, loaded by
// app/index.html from node_modules like Quill.

// Blocks that can be chrome: containers near the top of the page.
const CHROME_TAGS = new Set(["HEADER", "NAV", "FOOTER", "ASIDE", "DIV", "SECTION", "UL", "DIALOG", "FORM"]);
const CHROME_DEPTH = 6;
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

function chromeBlocks(root, depth = CHROME_DEPTH, out = []) {
  for (const el of root.children) {
    if (CHROME_TAGS.has(el.tagName)) out.push(el);
    if (depth > 1) chromeBlocks(el, depth - 1, out);
  }
  return out;
}

// Same tag, id, classes, text and images = the same block. Empty blocks never count.
function signature(el) {
  const text = squash(el.textContent);
  const media = [...el.querySelectorAll("img")].map((i) => i.getAttribute("src")).join(" ");
  return text || media ? `${el.tagName}#${el.id}.${squash(el.getAttribute("class"))}|${text}|${media}` : null;
}

// Signatures of the blocks found on at least 60% of pages (and at least two).
// ponytail: whole-block text equality; a menu that marks the current page in its *text* won't match. Fuzzy matching if real sites need it.
function sharedChrome(docs) {
  if (docs.length < 2) return new Set();
  const counts = new Map();
  for (const doc of docs) {
    for (const sig of new Set(chromeBlocks(doc.body).map(signature))) if (sig) counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  const need = Math.max(2, Math.ceil(docs.length * 0.6));
  return new Set([...counts].filter(([, n]) => n >= need).map(([sig]) => sig));
}

const chromeIn = (root, chrome) => chromeBlocks(root, Infinity).filter((el) => chrome.has(signature(el)));

// A path the review frame (app/content-pick-frame.js has the same one) and
// this document both resolve to the same element: the frame shows the same
// HTML with the page's own scripts blocked, so the trees match.
function cssPath(el) {
  const parts = [];
  for (; el && el.parentElement && el.tagName !== "BODY"; el = el.parentElement) parts.unshift(`${el.tagName.toLowerCase()}:nth-child(${[...el.parentElement.children].indexOf(el) + 1})`);
  return ["body", ...parts].join(" > ");
}

// The page's content: a <main>/[role=main] (or a lone <article>) outside the
// chrome; otherwise Readability, run on a copy without the chrome, mapped back
// to this document through data-sb-i markers. Confidence: "high" for a
// landmark, "medium" for a Readability result with real text, else "low".
const CONTENT_BLOCK = /^(DIV|SECTION|ARTICLE|MAIN|TD|BLOCKQUOTE)$/;
function mainContent(doc, chrome = new Set()) {
  const shared = chromeIn(doc.body, chrome);
  const outside = (el) => !shared.some((c) => c.contains(el));
  const articles = [...doc.querySelectorAll("article")].filter((a) => outside(a) && !a.parentElement.closest("article"));
  const landmark = [...doc.querySelectorAll("main, [role=main]")].find(outside) || (articles.length === 1 && articles[0]);
  if (landmark && squash(landmark.textContent)) return { selector: cssPath(landmark), confidence: "high", method: "landmark" };

  const all = [...doc.body.querySelectorAll("*")];
  const copy = doc.cloneNode(true);
  const copied = [...copy.body.querySelectorAll("*")];
  copied.forEach((el, i) => el.setAttribute("data-sb-i", i));
  const index = new Map(all.map((el, i) => [el, i]));
  for (const el of shared) copied[index.get(el)].remove();
  let article = null;
  try { article = new Readability(copy, { charThreshold: 20, keepClasses: true }).parse(); } catch {}
  const found = article ? [...new DOMParser().parseFromString(article.content || "", "text/html").querySelectorAll("[data-sb-i]")] : [];
  // The tightest block around what Readability kept (its own text and images), not its wrapper, which can hold what it threw away.
  const kept = (el) => el.tagName === "IMG" || [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  const tops = found.filter(kept).map((el) => all[Number(el.dataset.sbI)]).filter(Boolean);
  if (!tops.length) return { selector: "body", confidence: "low", method: "none" };
  let el = tops[0];
  while (el.parentElement && !tops.every((t) => el.contains(t))) el = el.parentElement;
  // A lone paragraph means Readability dropped what was around it (often a heading made of a styled div): take its block.
  while (el.parentElement && el.tagName !== "BODY" && !CONTENT_BLOCK.test(el.tagName)) el = el.parentElement;
  return { selector: cssPath(el), confidence: squash(article.textContent).length >= 200 ? "medium" : "low", method: "readability" };
}

// The content as rich text sections (sanitized, links and images still
// pointing at the old site): chrome inside it, menus and pop-ups left out. A
// content area made only of <section>s keeps them as separate sections.
function toSections(contentEl, chrome = new Set(), base) {
  const copy = contentEl.cloneNode(true);
  for (const el of chromeIn(copy, chrome)) el.remove();
  copy.querySelectorAll("nav, [role=navigation], dialog, [role=dialog], [aria-modal]").forEach((el) => el.remove());
  const kids = [...copy.children];
  const parts = kids.length > 1 && kids.every((k) => k.tagName === "SECTION") ? kids : [copy];
  return parts.map((part) => ({ type: "richtext", html: cleanFragment(part.innerHTML, base).innerHTML.trim() })).filter((s) => s.html);
}

// The site menu's links, in order: the first shared block that is (or holds) a <nav>, else the shared block with the most links.
function menuLinks(doc, chrome) {
  const shared = chromeIn(doc.body, chrome);
  const nav = shared.find((el) => el.matches("nav, [role=navigation]") || el.querySelector("nav, [role=navigation]"))
    || shared.sort((a, b) => b.querySelectorAll("a").length - a.querySelectorAll("a").length)[0];
  return nav ? [...nav.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")) : [];
}

// The logo: an image named like one in the shared blocks, else the first shared image.
function logoSrc(doc, chrome) {
  const imgs = chromeIn(doc.body, chrome).flatMap((el) => [...el.querySelectorAll("img[src]")]);
  return (imgs.find((i) => /logo/i.test(`${i.className} ${i.id} ${i.alt} ${i.getAttribute("src")}`)) || imgs[0])?.getAttribute("src") || null;
}
