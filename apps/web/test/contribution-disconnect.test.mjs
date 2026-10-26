import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

import { CATALOGS, SUPPORTED_LOCALES, translate as canonicalTranslate } from "../../../packages/i18n/index.js";
import * as dataClient from "../public/data-client.js";
import { translate, WEB_MESSAGES, LEGACY_TEXT_CATALOG } from "../public/localization.js";
import { withContributionReviewDeadline } from "../public/lib.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

const receipt = Object.freeze({
  schemaVersion: "local-contribution-device-disconnect-v0.1",
  status: "disconnected",
  deliveryPaused: true,
  localCredential: "deleted",
  localBinding: "removed",
  hostedDataDeleted: false,
  includesIdentifiers: false,
  includesCredentials: false,
});

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

test("disconnect receipts reject extra identifiers and every unconfirmed contract field", () => {
  for (const mutation of [
    { schemaVersion: "local-contribution-device-disconnect-v0.2" },
    { status: "pending" }, { deliveryPaused: false },
    { localCredential: "unknown" }, { localBinding: "unknown" },
    { hostedDataDeleted: true }, { includesIdentifiers: true }, { includesCredentials: true },
    { participantId: "participant:00000000-0000-4000-8000-000000000001" },
  ]) {
    const result = dataClient.normalizeLocalContributionDeviceDisconnect({ ...receipt, ...mutation });
    assert.equal(result.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /participant:/u);
  }
});

test("disconnect and sign-out semantics come from complete canonical three-locale catalogs", () => {
  const keys = Object.keys(CATALOGS["en-US"]).filter((key) => key.startsWith("contribution."));
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      assert.equal(translate(key, {}, locale), canonicalTranslate(key, {}, { locale, brandName: translate("app.name", {}, locale) }), `${locale}: ${key}`);
      assert.equal(WEB_MESSAGES[key].length, 3);
      if (locale !== "en-US") assert.notEqual(CATALOGS[locale][key], CATALOGS["en-US"][key]);
    }
  }
  assert.match(translate("contribution.signOutCompleted"), /upload connection is unchanged/u);
  assert.match(translate("contribution.deviceLimit"), /Signing out does not disconnect/u);
});
