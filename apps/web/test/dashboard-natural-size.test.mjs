import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

// The restructure plan replaces whole-page scaling: long states and languages
// wrap or scroll, and text never shrinks to fit the window.
test("dashboard pages keep their natural size and scroll instead of scaling", () => {
  assert.doesNotMatch(source, /\.style\.zoom\b/u);
  assert.doesNotMatch(styles, /--overview-height/u);
  assert.doesNotMatch(styles, /body\[data-dashboard-page\]\s*\{[^}]*height:\s*100dvh/u);
  assert.match(styles, /\.topbar \{\s*position: sticky;/u);
  assert.match(styles, /\.dashboard-sidebar \{\s*position: sticky;/u);
});
