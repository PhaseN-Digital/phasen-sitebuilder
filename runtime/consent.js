// Cookie consent for sites with Google Analytics (UK PECR): the analytics
// script only loads after the visitor clicks Accept on #cookie-banner. The
// measurement ID comes from this script tag's data-ga-id (lib/build.js).
// Follows phasen.digital's public/consent.js.
(() => {
  const ID = document.currentScript.dataset.gaId;
  const KEY = "cookie-consent";
  const LIVE = location.protocol.startsWith("http"); // in-app preview: never load analytics

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }

  let loaded = false;
  const load = () => {
    if (!LIVE || loaded) return;
    loaded = true;
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ID)}`;
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", ID);
  };
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  // Storage can be blocked (private browsing); the choice then just doesn't persist.
  const set = (v) => { try { localStorage.setItem(KEY, v); } catch {} };
  const banner = () => document.getElementById("cookie-banner");

  const init = () => {
    const consent = get();
    if (consent === "accepted") load();
    else if (consent !== "rejected" && banner()) banner().hidden = false;
    document.getElementById("cookie-accept")?.addEventListener("click", () => {
      set("accepted"); banner().hidden = true; load();
    });
    document.getElementById("cookie-reject")?.addEventListener("click", () => {
      set("rejected"); banner().hidden = true;
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // The footer's "Cookie preferences" link reopens the banner.
  window.reopenCookieBanner = () => { if (banner()) banner().hidden = false; };
})();
