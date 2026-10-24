// Injected into the Theme Builder's preview (main.js adds it when the URL has
// ?sb-theme, #156). Right-click, Alt+click or "Pick element" mode reports the
// element's selector candidates and computed styles to the builder
// (app/theme-builder.js), which renders the menu. Messages carry sbTheme: true.
//
// Selectors use only the classes and landmarks lib/build.js's renderPage and
// renderSection generate, never ids or nth-child, so a rule works on any
// site. test.js checks STABLE against that output; this is the one list.
const STABLE = ["site-header", "brand", "nav-toggle", "site-footer", "hero", "has-image", "text", "image-left", "wrap", "split",
  "richtext", "gallery", "gallery-grid", "form", "hp", "cf-turnstile", "form-status", "button", "video-embed", "notfound",
  "cookie-banner", "cookie-banner-actions"];
const LANDMARKS = ["header", "nav", "main", "footer"];

// From specific to broad, e.g. [".hero h1", "main h1", "h1"]. chain is the
// element then its ancestors, each { tag, classes }.
function candidates(chain) {
  const stable = (e) => e.classes.find((c) => STABLE.includes(c));
  const name = (e) => (stable(e) ? `.${stable(e)}` : e.tag);
  const own = name(chain[0]);
  const up = chain.slice(1);
  const section = up.find((e) => stable(e) && stable(e) !== "wrap");
  const landmark = up.find((e) => LANDMARKS.includes(e.tag));
  return [...new Set([section && `${name(section)} ${own}`, landmark && `${landmark.tag} ${own}`, own].filter(Boolean))];
}

if (typeof document === "undefined") module.exports = { STABLE, candidates };
else (() => {
  const send = (msg) => parent.postMessage({ sbTheme: true, ...msg }, "*");
  const style = document.createElement("style");
  style.textContent = `.sb-pick-on * { cursor: crosshair !important; } .sb-picked { outline: 2px solid #2563eb !important; outline-offset: 2px; }`;
  document.head.append(style);
  let picking = false, current = null;
  const mark = (el) => { current?.classList.remove("sb-picked"); current = el; el?.classList.add("sb-picked"); el?.scrollIntoView({ block: "nearest" }); };

  const report = (el, x, y) => {
    const chain = [];
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement)
      chain.push({ tag: e.tagName.toLowerCase(), classes: [...e.classList].filter((c) => c !== "sb-picked") });
    if (!chain.length) chain.push({ tag: "body", classes: [] });
    const cs = getComputedStyle(el);
    const styles = Object.fromEntries(["color", "background-color", "font-family", "font-size", "font-weight", "padding", "margin"].map((p) => [p, cs.getPropertyValue(p)]));
    if (x === undefined) ({ left: x, bottom: y } = el.getBoundingClientRect());
    send({ type: "element", selectors: candidates(chain), styles, x, y });
  };

  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    report(event.target === document.documentElement ? document.body : event.target, event.clientX, event.clientY);
  }, true);
  document.addEventListener("click", (event) => {
    if (!picking && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    mark(event.target);
    report(event.target, event.clientX, event.clientY);
  }, true);
  document.addEventListener("mouseover", (event) => { if (picking) mark(event.target); });

  // Keyboard picking: arrows walk the page's elements in order, Enter opens the menu.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (["SCRIPT", "STYLE"].includes(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  document.addEventListener("keydown", (event) => {
    if (!picking) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      walker.currentNode = current || document.body;
      const next = event.key === "ArrowDown" ? walker.nextNode() : walker.previousNode();
      if (next && next !== document.body) mark(next);
    } else if ((event.key === "Enter" || event.key === " ") && current) report(current);
    else if (event.key === "Escape") send({ type: "pick-off" });
    else return;
    event.preventDefault();
  }, true);

  // Links keep ?sb-theme so the menu still works on the next page.
  document.addEventListener("click", (event) => {
    const a = event.target.closest?.("a[href]");
    if (!a || event.defaultPrevented) return;
    const url = new URL(a.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    url.searchParams.set("sb-theme", "");
    location.href = url.href;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.sbTheme !== true || event.data.type !== "pick") return;
    picking = event.data.on;
    document.documentElement.classList.toggle("sb-pick-on", picking);
    if (event.data.focus) window.focus();
    if (picking) { mark(current || document.querySelector("main h1, main *") || document.body); }
    else mark(null);
  });
  send({ type: "ready" });
})();
