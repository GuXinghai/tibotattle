import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CATALOGS } from "../../../packages/i18n/index.js";
import * as dataClient from "../public/data-client.js";
import { LEGACY_TEXT_CATALOG } from "../public/localization.js";
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("self-service participant deletion is absent from the UI, client, and catalogs", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/data-client.js", import.meta.url), "utf8");
  const retired = /delete-contributions|deleteCommunityContributions|deleteParticipant|normalizeParticipantDeletionReceipt|CONTRIBUTION_DELETION_CONFIRMATION|participant_deletion/u;
  for (const source of [html, appSource, client]) assert.doesNotMatch(source, retired);
  assert.equal(Object.hasOwn(dataClient, "CommunityClient"), false);
  assert.equal(Object.hasOwn(dataClient, "normalizeParticipantDeletionReceipt"), false);
  assert.equal(Object.hasOwn(LEGACY_TEXT_CATALOG, "Delete my contributions"), false);
  assert.doesNotMatch(JSON.stringify(CATALOGS), /Delete my contributions|删除我的贡献|Eliminar mis contribuciones/u);
});
