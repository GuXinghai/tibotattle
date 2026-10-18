import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DASHBOARD_PAGES,
  mountDashboardNavigation,
  parseDashboardHash,
} from "../public/navigation.js";

const PAGE_IDS = ["overview", "usage", "allowance", "performance", "settings"];

class FakeClassList {
  #values = new Set();

  toggle(value, force) {
    if (force) this.#values.add(value);
    else this.#values.delete(value);
  }

  contains(value) {
    return this.#values.has(value);
  }
}

function fakeLink(nav) {
  const attributes = new Map([["href", `#${nav}`]]);
  const listeners = new Map();
  return {
    attributes,
    classList: new FakeClassList(),
    dataset: { nav },
    addEventListener(type, listener) { listeners.set(type, listener); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    setAttribute(name, value) { attributes.set(name, value); },
    click() {
      let prevented = false;
      listeners.get("click")?.({
        currentTarget: this,
        preventDefault() { prevented = true; },
      });
      return prevented;
    },
  };
}

function fakePage(name, { hidden = false, hasHeading = true } = {}) {
  const headingAttributes = new Map();
  const heading = {
    attributes: headingAttributes,
    focusOptions: null,
    setAttribute(name, value) { headingAttributes.set(name, value); },
    focus(options) { this.focusOptions = options; },
  };
  return {
    attributes: new Map(),
    classList: new FakeClassList(),
    dataset: { dashboardPage: name },
    hidden,
    inert: false,
    heading,
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    querySelector(selector) {
      assert.equal(selector, "h1, h2");
      return hasHeading ? heading : null;
    },
  };
}

function fakeBrowser({ hash = "" } = {}) {
  const links = PAGE_IDS.map(fakeLink);
  const pages = PAGE_IDS.map(fakePage);
  const listeners = new Map();
  const pushed = [];
  const scrolls = [];
  const viewRequests = [];
  const documentRef = {
    querySelectorAll(selector) {
      if (selector === "[data-nav]") return links;
      assert.equal(selector, "[data-dashboard-page]");
      return pages;
    },
    dispatchEvent(event) {
      if (event.type === "tibotattle:page-view") viewRequests.push(event.detail);
      return true;
    },
  };
  const windowRef = {
    CustomEvent,
    history: { pushState(_state, _title, hashValue) { pushed.push(hashValue); windowRef.location.hash = hashValue; } },
    location: { hash },
    scrollTo(options) { scrolls.push(options); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  return { documentRef, links, listeners, pages, pushed, scrolls, viewRequests, windowRef };
}

function assertActivePage(browser, expected) {
  for (const page of browser.pages) {
    const inactive = page.dataset.dashboardPage !== expected;
    assert.equal(page.classList.contains("dashboard-page-inactive"), inactive, page.dataset.dashboardPage);
    assert.equal(page.inert, inactive, page.dataset.dashboardPage);
    assert.equal(page.attributes.get("aria-hidden"), inactive ? "true" : undefined, page.dataset.dashboardPage);
  }
  for (const link of browser.links) {
    const active = link.dataset.nav === expected;
    assert.equal(link.classList.contains("active"), active, link.dataset.nav);
    assert.equal(link.attributes.get("aria-current"), active ? "page" : undefined, link.dataset.nav);
  }
}

function assertExactlyOneVisiblePage(browser, expected) {
  assertActivePage(browser, expected);
  assert.equal(
    browser.pages.filter((page) => !page.classList.contains("dashboard-page-inactive")).length,
    1,
  );
}

function changeHash(browser, hash, event = "hashchange") {
  browser.windowRef.location.hash = hash;
  browser.listeners.get(event)();
}

test("the dashboard has five destinations and no compatibility aliases", () => {
  assert.deepEqual([...DASHBOARD_PAGES], PAGE_IDS);

  for (const retired of [
    "community", "weekly", "trends", "method", "projects",
    "accounting", "timeline", "history", "backend", "data", "coverage",
  ]) {
    assert.deepEqual(
      parseDashboardHash(`#${retired}`),
      { page: null, view: null },
      retired,
    );
    const browser = fakeBrowser({ hash: `#${retired}` });
    mountDashboardNavigation(browser);
    assertExactlyOneVisiblePage(browser, "overview");
  }
});

test("each page id is its own hash and selects that page", () => {
  for (const page of PAGE_IDS) {
    const browser = fakeBrowser({ hash: `#${page}` });
    mountDashboardNavigation(browser);
    assertExactlyOneVisiblePage(browser, page);
    assert.deepEqual(browser.viewRequests, [], "a bare page hash requests no view");
  }
});

test("an unknown hash keeps the current page, or overview", () => {
  const browser = fakeBrowser({ hash: "#nowhere" });
  mountDashboardNavigation(browser);
  assertActivePage(browser, "overview");

  changeHash(browser, "#allowance");
  assertActivePage(browser, "allowance");

  changeHash(browser, "#nowhere");
  assertActivePage(browser, "allowance");

  changeHash(browser, "#weekly", "popstate");
  assertActivePage(browser, "allowance");

  changeHash(browser, "#%E0%A4%A");
  assertActivePage(browser, "allowance");
});

test("#page/view selects the page and asks it for a level-1 view", () => {
  assert.deepEqual(parseDashboardHash("#allowance/changes"), { page: "allowance", view: "changes" });
  assert.deepEqual(parseDashboardHash("#usage/"), { page: "usage", view: null });
  assert.deepEqual(parseDashboardHash("#nowhere/changes"), { page: null, view: "changes" });

  const browser = fakeBrowser({ hash: "#allowance/forecast" });
  mountDashboardNavigation(browser);
  assertExactlyOneVisiblePage(browser, "allowance");
  assert.deepEqual(browser.viewRequests, [{ page: "allowance", view: "forecast" }]);

  changeHash(browser, "#usage/cache");
  assertExactlyOneVisiblePage(browser, "usage");
  assert.deepEqual(browser.viewRequests.at(-1), { page: "usage", view: "cache" });

  // Validity of the view belongs to the page's own switch, which falls back to
  // its default; navigation only forwards what the hash names.
  changeHash(browser, "#performance/not-a-view");
  assertExactlyOneVisiblePage(browser, "performance");
  assert.deepEqual(browser.viewRequests.at(-1), { page: "performance", view: "not-a-view" });
});

test("an unknown page with a view neither switches page nor requests a view", () => {
  const browser = fakeBrowser({ hash: "#usage" });
  mountDashboardNavigation(browser);
  const before = browser.viewRequests.length;

  changeHash(browser, "#community/status");
  assertExactlyOneVisiblePage(browser, "usage");
  assert.equal(browser.viewRequests.length, before);
});

test("page links prevent long-document anchor scrolling and retain normal history", () => {
  const browser = fakeBrowser();
  mountDashboardNavigation(browser);
  assertActivePage(browser, "overview");

  const allowance = browser.links.find((link) => link.dataset.nav === "allowance");
  assert.equal(allowance.click(), true);
  assert.deepEqual(browser.pushed, ["#allowance"]);
  assert.deepEqual(browser.scrolls, [{ top: 0, behavior: "instant" }]);
  assertActivePage(browser, "allowance");
  const allowancePage = browser.pages.find((page) => page.dataset.dashboardPage === "allowance");
  assert.equal(allowancePage.heading.attributes.get("tabindex"), "-1");
  assert.deepEqual(allowancePage.heading.focusOptions, { preventScroll: true });
});

test("initial mount does not steal focus but later hash changes move it", () => {
  const browser = fakeBrowser({ hash: "#allowance" });
  mountDashboardNavigation(browser);
  const page = browser.pages.find((candidate) => candidate.dataset.dashboardPage === "allowance");
  assert.equal(page.heading.focusOptions, null);

  changeHash(browser, "#overview");
  changeHash(browser, "#allowance");
  assert.deepEqual(page.heading.focusOptions, { preventScroll: true });
});

test("page transitions focus the page heading after headingless controls for that page", () => {
  const browser = fakeBrowser({ hash: "#usage" });
  const allowanceControl = fakePage("allowance", { hasHeading: false });
  browser.pages.unshift(allowanceControl);
  mountDashboardNavigation(browser);

  browser.links.find((link) => link.dataset.nav === "allowance").click();

  const allowancePage = browser.pages.find((page) =>
    page !== allowanceControl && page.dataset.dashboardPage === "allowance");
  assert.equal(allowanceControl.heading.focusOptions, null);
  assert.deepEqual(allowancePage.heading.focusOptions, { preventScroll: true });
});

test("repeated transitions and a navigation remount keep exactly one page visible", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  let teardown = mountDashboardNavigation(browser);

  for (let index = 0; index < 50; index += 1) {
    const nav = PAGE_IDS[index % PAGE_IDS.length];
    browser.links.find((link) => link.dataset.nav === nav).click();
    assertExactlyOneVisiblePage(browser, nav);
  }

  teardown();
  browser.windowRef.location.hash = "#usage";
  teardown = mountDashboardNavigation(browser);
  assertExactlyOneVisiblePage(browser, "usage");

  for (const hash of PAGE_IDS.map((page) => `#${page}`)) {
    changeHash(browser, hash);
    assertExactlyOneVisiblePage(browser, hash.slice(1));
  }

  teardown();
});

test("navigation never overrides component-owned hidden state", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  const hiddenOverviewComponent = browser.pages.find(
    (page) => page.dataset.dashboardPage === "overview",
  );
  hiddenOverviewComponent.hidden = true;
  mountDashboardNavigation(browser);

  browser.links.find((link) => link.dataset.nav === "usage").click();
  browser.links.find((link) => link.dataset.nav === "overview").click();

  assert.equal(hiddenOverviewComponent.hidden, true);
  assertActivePage(browser, "overview");
});

test("teardown removes page and history listeners", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  const teardown = mountDashboardNavigation(browser);
  teardown();

  assert.equal(browser.listeners.has("hashchange"), false);
  assert.equal(browser.listeners.has("popstate"), false);
  assert.equal(browser.links[1].click(), false);
  assertActivePage(browser, "overview");
});

test("settings category links deliver their view without exposing another page", () => {
  const browser = fakeBrowser({ hash: "#settings/notifications" });
  const teardown = mountDashboardNavigation(browser);
  assertExactlyOneVisiblePage(browser, "settings");
  assert.deepEqual(browser.viewRequests.at(-1), { page: "settings", view: "notifications" });
  changeHash(browser, "#settings/data");
  assert.deepEqual(browser.viewRequests.at(-1), { page: "settings", view: "data" });
  teardown();
});
