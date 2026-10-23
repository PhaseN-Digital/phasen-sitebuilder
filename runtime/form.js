// Client side of every generated form: posts JSON to /api/forms/<id> and
// renders the result inline. Turnstile is rendered explicitly so localhost
// (wrangler dev) can use Cloudflare's published test key.
const LIVE = location.protocol.startsWith("http");
const TEST_SITEKEY = "1x00000000000000000000AA";

window.onTurnstileLoad = () => {
  if (!LIVE) return; // in-app preview: no captcha, forms don't send
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  document.querySelectorAll(".cf-turnstile").forEach((el) => {
    el.dataset.widgetId = turnstile.render(el, { sitekey: local ? TEST_SITEKEY : el.dataset.sitekey });
  });
};

document.querySelectorAll("form[data-form]").forEach((form) => {
  const status = form.querySelector(".form-status");
  const button = form.querySelector("button");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!LIVE) {
      status.textContent = "Forms start sending once your website is published.";
      return;
    }
    status.className = "form-status";
    status.textContent = "Sending…";
    button.disabled = true;
    try {
      const response = await fetch(`/api/forms/${form.dataset.form}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error);
      form.reset();
      status.textContent = form.dataset.success;
    } catch (error) {
      status.className = "form-status error";
      status.textContent = error.message || "Something went wrong, please try again.";
    } finally {
      button.disabled = false;
      const widget = form.querySelector(".cf-turnstile");
      if (window.turnstile && widget) turnstile.reset(widget.dataset.widgetId);
    }
  });
});
