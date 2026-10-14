/**
 * The four dashboard destinations. A page id is also its hash target: the
 * sidebar, the desktop shell's fixed section map and `#<page>/<view>` links all
 * use these values, so there is nothing to translate between them.
 */
export const DASHBOARD_PAGES = Object.freeze([
  "overview",
  "usage",
  "allowance",
  "performance",
]);

const DEFAULT_PAGE = "overview";

/**
 * Splits `#<page>` or `#<page>/<view>` into its parts. An unknown page, or a
 * hash that cannot be decoded, yields `page: null` so the caller keeps the
 * current page. A view is only reported when the hash names one; whether that
 * view exists is decided by the page's own view switch, which falls back to its
 * default for an unknown value.
 */
export function parseDashboardHash(hash) {
  let target;
  try {
    target = decodeURIComponent(String(hash ?? "").replace(/^#/u, ""));
  } catch {
    return { page: null, view: null };
  }
  const separator = target.indexOf("/");
  const pageName = separator < 0 ? target : target.slice(0, separator);
  const viewName = separator < 0 ? "" : target.slice(separator + 1);
  return {
    page: DASHBOARD_PAGES.includes(pageName) ? pageName : null,
    view: viewName === "" ? null : viewName,
  };
}

/**
 * Keeps the dashboard's major areas as real pages.  The old scroll-spy made
 * every section appear to be a destination, which was awkward in a desktop
 * app and could leave people lost halfway down a long technical report.
 *
 * `#<page>/<view>` additionally asks the page to show one of its level-1 views
 * through the `tibotattle:page-view` event. The page view switch owns the list
 * of valid views, so mount it before this function (or read the initial hash
 * with `parseDashboardHash`) if the first hash must select a view.
 */
export function mountDashboardNavigation({ documentRef, windowRef }) {
  const links = [...documentRef.querySelectorAll("[data-nav]")];
  const pages = [...documentRef.querySelectorAll("[data-dashboard-page]")];
  let activePage = null;

  function focusPageHeading(page) {
    const heading = pages
      .find((element) => element.dataset.dashboardPage === page)
      ?.querySelector?.("h1, h2");
    if (!heading) return;
    heading.setAttribute?.("tabindex", "-1");
    heading.focus?.({ preventScroll: true });
  }

  function setPage(page, { focusHeading = false } = {}) {
    if (!pages.some((element) => element.dataset.dashboardPage === page)) {
      return false;
    }
    activePage = page;
    if (documentRef.body?.dataset) documentRef.body.dataset.dashboardPage = page;
    for (const element of pages) {
      const inactive = element.dataset.dashboardPage !== page;
      element.classList.toggle("dashboard-page-inactive", inactive);
      element.inert = inactive;
      if (inactive) element.setAttribute("aria-hidden", "true");
      else element.removeAttribute("aria-hidden");
    }
    for (const link of links) {
      const active = link.dataset.nav === page;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (focusHeading) focusPageHeading(page);
    return true;
  }

  function requestView(page, view) {
    const CustomEventConstructor = windowRef.CustomEvent;
    if (typeof CustomEventConstructor !== "function"
        || typeof documentRef.dispatchEvent !== "function") return;
    documentRef.dispatchEvent(new CustomEventConstructor(
      "tibotattle:page-view",
      { detail: { page, view } },
    ));
  }

  function syncNavigationFromHash() {
    const { page: target, view } = parseDashboardHash(windowRef.location.hash);
    const hadActivePage = activePage !== null;
    const page = target ?? activePage ?? DEFAULT_PAGE;
    if (setPage(page, { focusHeading: hadActivePage })) {
      if (target !== null && view !== null) requestView(page, view);
      if (hadActivePage) windowRef.scrollTo?.({ top: 0, behavior: "instant" });
    }
  }

  function navigate(event) {
    const link = event.currentTarget;
    const page = link.dataset.nav;
    if (!setPage(page, { focusHeading: true })) return;
    event.preventDefault();
    const hash = link.getAttribute("href") ?? `#${page}`;
    if (windowRef.location.hash !== hash) {
      windowRef.history?.pushState?.({}, "", hash);
    }
    windowRef.scrollTo?.({ top: 0, behavior: "instant" });
  }

  for (const link of links) link.addEventListener("click", navigate);
  windowRef.addEventListener("hashchange", syncNavigationFromHash);
  windowRef.addEventListener("popstate", syncNavigationFromHash);
  syncNavigationFromHash();

  return () => {
    for (const link of links) link.removeEventListener("click", navigate);
    windowRef.removeEventListener("hashchange", syncNavigationFromHash);
    windowRef.removeEventListener("popstate", syncNavigationFromHash);
  };
}
