// Injected into the preview of a copied page (main.js adds it when the URL
// has ?sb-edit). Outlines what app/copied.js tagged as editable, makes text
// editable in place and reports changes to the editor with postMessage.
(() => {
  const style = document.createElement("style");
  style.textContent = `
    [data-sb-edit] { outline: 1px dashed rgb(37 99 235 / .55); outline-offset: 2px; cursor: text; }
    [data-sb-edit^="s-"] { outline-color: rgb(234 88 12 / .65); }
    [data-sb-edit]:hover { outline: 2px solid #2563eb; }
    [data-sb-edit^="s-"]:hover { outline-color: #ea580c; }
    img[data-sb-edit] { cursor: pointer; }
    [data-sb-edit][contenteditable] { outline: 2px solid #2563eb; background: rgb(37 99 235 / .06); }`;
  document.head.append(style);
  const send = (msg) => parent.postMessage({ sb: true, ...msg }, "*");

  // While editing: no navigation, no page-builder click handlers (sliders, popups).
  document.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.target.closest("[data-sb-edit]");
    if (!el || el.isContentEditable) return;
    const links = el.closest("a") ? [el.closest("a")] : el.querySelectorAll("a");
    const href = links.length === 1 ? links[0].getAttribute("href") || "" : null;
    if (el.tagName === "IMG") return send({ type: "image", key: el.dataset.sbEdit, alt: el.alt, src: el.currentSrc || el.src, href });
    send({ type: "link", key: el.dataset.sbEdit, href });
    const before = el.innerHTML;
    el.contentEditable = "true";
    el.focus();
    el.addEventListener("blur", () => {
      el.removeAttribute("contenteditable");
      if (el.innerHTML !== before) send({ type: "text", key: el.dataset.sbEdit, html: el.innerHTML });
    }, { once: true });
  }, true);
  document.addEventListener("submit", (event) => { event.preventDefault(); event.stopPropagation(); }, true);

  // Paste as plain text, so formatting from elsewhere can't break the design.
  document.addEventListener("paste", (event) => {
    if (!event.target.closest?.("[contenteditable]")) return;
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  }, true);

  // Enter would insert new blocks inside headings and buttons; only rich text blocks (divs) take it.
  document.addEventListener("keydown", (event) => {
    const el = event.target.closest?.("[contenteditable]");
    if (!el) return;
    if (event.key === "Escape") el.blur();
    if (event.key === "Enter" && el.tagName !== "DIV") { event.preventDefault(); el.blur(); }
  }, true);

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.sb !== true) return;
    if (event.data.type === "link-updated") {
      // Kept in step with the stored page, or a later text edit would send the old link back.
      for (const el of document.querySelectorAll(`[data-sb-edit="${CSS.escape(event.data.key)}"]`)) (el.closest("a") || el.querySelector("a"))?.setAttribute("href", event.data.href);
      return;
    }
    if (event.data.type !== "image-updated") return;
    document.querySelectorAll(`img[data-sb-edit="${CSS.escape(event.data.key)}"]`).forEach((img) => {
      ["srcset", "sizes", "data-src", "data-srcset"].forEach((a) => img.removeAttribute(a));
      img.src = event.data.src;
    });
  });
})();
