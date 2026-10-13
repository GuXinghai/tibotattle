import test from "node:test";
import assert from "node:assert/strict";

import { syncDirectory } from "../src/platform/owner-only-filesystem.js";

test("directory sync is an explicit no-op on Windows", async () => {
  assert.equal(await syncDirectory("C:\state"), undefined);
});
