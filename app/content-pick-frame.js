// Injected into a copied page during the editable import's review step
// (#161; main.js adds it, with the page's own scripts blocked, when the URL has
// ?sb-pick=<selector>). Outlines the detected content, lets the user click a
// different block, and tells the editor (app/wordpress.js) with postMessage.
(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-sb-picked] { outline: 3px solid #2563eb !important; outline-offset: -3px; background-color: rgb(37 99 235 / .07) !important; }
    [data-sb-hover] { outline: 2px dashed #ea580c !important; outline-offset: -2px; cursor: pointer; }`;
  document.head.append(style);
  const send = (msg) => parent.postMessage({ sb: true, ...msg }, "*");
  const BLOCK = "main, article, section, div, aside, header, footer, ul, ol, table, blockquote, [role=main]";
  // Same as cssPath in app/content-detect.js.
  const cssPath = (el) => {
    const parts = [];
    for (; el && el.parentElement && el.tagName !== "BODY"; el = el.parentElement) parts.unshift(`${el.tagName.toLowerCase()}:nth-child(${[...el.parentElement.children].indexOf(el) + 1})`);
    return ["body", ...parts].join(" > ");
  };
  let picked = null;
  const pick = (el, report) => {
    picked?.removeAttribute("data-sb-picked");
    picked = el && el !== document.body ? el : null;
    picked?.setAttribute("data-sb-picked", "");
    if (picked && !report) picked.scrollIntoView({ block: "nearest" });
    if (report) send({ type: "pick", selector: picked ? cssPath(picked) : "body" });
  };
  try { pick(document.querySelector(new URLSearchParams(location.search).get("sb-pick") || "body")); } catch {}

  document.addEventListener("mouseover", (e) => e.target.closest?.(BLOCK)?.setAttribute("data-sb-hover", ""));
  document.addEventListener("mouseout", (e) => e.target.closest?.(BLOCK)?.removeAttribute("data-sb-hover"));
  document.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target.closest(BLOCK);
    if (el) pick(el, true);
  }, true);
  document.addEventListener("submit", (e) => e.preventDefault(), true);
  window.addEventListener("message", (e) => {
    if (e.source === parent && e.data?.sb === true && e.data.type === "widen" && picked?.parentElement) pick(picked.parentElement, true);
  });

  // The design's colours and font, for the closest theme: computed, so every stylesheet counts.
  const css = (el, prop) => (el ? getComputedStyle(el)[prop] : "");
  const link = document.querySelector("main a[href], article a[href], p a[href]") || document.querySelector("a[href]");
  const button = document.querySelector("button, .button, .btn, input[type=submit], a[class*=button]");
  send({
    type: "style",
    background: [css(document.body, "backgroundColor"), css(document.documentElement, "backgroundColor")],
    text: css(document.body, "color"),
    link: css(link, "color"),
    button: css(button, "backgroundColor"),
    font: css(document.body, "fontFamily"),
  });
})();
