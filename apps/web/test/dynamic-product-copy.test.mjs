import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { evidenceWarningLocalization, translate, translateLegacyText } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function productionFunction(name) {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, name);
  return match[0];
}
function element(tag = "span", className = "", textContent = "") {
  return { tag, className, textContent, children: [], dataset: {}, attributes: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {} };
}

test("recognized evidence warnings localize while unknown text retains the raw boundary", () => {
  const warning = "The full history projection is still being recalculated in the background. The figures shown are the most recent completed projection and are replaced automatically when it finishes.";
  for (const locale of ["zh-Hans", "en-US", "es", "zh-Hans"]) {
    const list = element("ul");
    const context = createContext({ EVIDENCE_WARNING_ROUTES: [], EVIDENCE_WARNING_FALLBACK: "#warnings",
      EVIDENCE_WARNING_PROGRESS: /still/u, EVIDENCE_WARNING_INFORMATIONAL: /loading/u,
      $: () => list, node: element, clear: target => { target.children = []; }, evidenceWarningLocalization,
      setLocalizedText(target, key, values) { target.textContent = translate(key, values, locale); },
      setRawText(target, text) { target.textContent = text; target.setAttribute("data-i18n-skip", ""); },
    });
    runInContext(productionFunction("evidenceWarningTarget") + "\n" + productionFunction("renderEvidenceWarnings"), context);
    context.renderEvidenceWarnings({ warnings: [warning, "Ready"] });
    assert.equal(list.children[0].textContent, translate("dashboard.warning.retainedRefresh", {}, locale));
    assert.equal(list.children[0].attributes["data-i18n-skip"], undefined);
    assert.equal(list.children[0].className, "evidence-warning progress");
    assert.equal(list.children[1].textContent, "Ready");
    assert.equal(list.children[1].attributes["data-i18n-skip"], "");
  }
});

test("information labels translate visible text, help text and accessible names together", () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    const context = createContext({
      localization: { translateText: value => translateLegacyText(value, locale) },
      t: (key, values) => translate(key, values, locale), node: element,
      document: { createDocumentFragment: () => element("fragment"), createTextNode: textContent => ({ textContent }) },
    });
    runInContext(productionFunction("informationLabel"), context);
    const result = context.informationLabel("Time intervals", "The number of displayed hour, day, or week intervals.");
    assert.equal(result.children[0].textContent, translateLegacyText("Time intervals", locale));
    assert.equal(result.children[1].dataset.informationExplanation,
      translateLegacyText("The number of displayed hour, day, or week intervals.", locale));
    if (locale === "zh-Hans") assert.doesNotMatch(result.children[1].attributes["aria-label"], /Time intervals/u);
  }
});

test("component labels translate only the closed product vocabulary", () => {
  const mapping = source.match(/const COMPONENT_LABELS = Object\.freeze\(\{[\s\S]*?\}\);/u)?.[0];
  assert.ok(mapping);
  const context = createContext({ localization: { translateText: value => translateLegacyText(value, "zh-Hans") }, humanize: String });
  runInContext(mapping + "\n" + productionFunction("componentLabel"), context);
  assert.equal(context.componentLabel("input_cache_read_tokens"), "缓存输入");
  assert.equal(context.componentLabel("output_reasoning_tokens"), "推理输出");
  assert.equal(context.componentLabel("output_combined_tokens"), "输出（无法拆分）");
  assert.equal(context.componentLabel("constructor"), "constructor");
});
