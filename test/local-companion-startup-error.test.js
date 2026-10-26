import test from "node:test";
import assert from "node:assert/strict";
import {companionStartupErrorCode,companionStartupErrorLine,createCompanionStartupErrorParser} from "../src/local-companion-startup-error.js";
test("startup failures project fixed categories and omit private diagnostics",()=>{
  const e=Object.assign(new Error("private source and credential must never escape"),{code:"WINDOWS_FILESYSTEM_SECURITY_POLICY",securityPolicyReason:"dacl_not_protected"});
  assert.equal(companionStartupErrorCode(e),"companion_state_security_policy");
  assert.equal(companionStartupErrorLine(e),"USAGE_MONITOR_COMPANION_FAILURE companion_state_security_policy\n");
  assert.equal(companionStartupErrorCode({name:"CompanionInstanceLockError"}),"companion_instance_lock_failed");
  assert.equal(companionStartupErrorCode({code:"ERR_SQLITE_ERROR"}),"companion_database_unavailable");
  assert.equal(companionStartupErrorCode({code:"ERR_MODULE_NOT_FOUND"}),"companion_dependency_missing");
  assert.equal(companionStartupErrorCode(new TypeError("private")),"companion_configuration_invalid");
  assert.equal(companionStartupErrorCode(new Error("private")),"companion_startup_failed");
});
test("stderr protocol accepts split fixed lines and rejects unknown or oversized payloads",()=>{
  const codes=[],feed=createCompanionStartupErrorParser(c=>codes.push(c));
  feed("private\nUSAGE_MONITOR_COMPANION_FAIL");feed("URE companion_database_unavailable\n");
  feed("USAGE_MONITOR_COMPANION_FAILURE private\n");
  feed("x".repeat(1000)+"USAGE_MONITOR_COMPANION_FAILURE companion_database_unavailable\n");
  assert.deepEqual(codes,["companion_database_unavailable"]);
});
