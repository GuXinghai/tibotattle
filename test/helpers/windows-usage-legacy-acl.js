import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { assertWindowsOwnerOnly } from "./windows-owner-only-fixture.js";

export const SYNTHETIC_USAGE_READER_SID = "S-1-5-21-111111111-222222222-333333333-4444";
export const SYNTHETIC_USAGE_LOGON_SID = "S-1-5-5-123456789-234567890";
export const SYNTHETIC_USAGE_OTHER_LOGON_SID = "S-1-5-5-123456789-345678901";
const readers = new Set([SYNTHETIC_USAGE_READER_SID, SYNTHETIC_USAGE_LOGON_SID, SYNTHETIC_USAGE_OTHER_LOGON_SID,
  "S-1-5-21-111111111-222222222-333333333-5555", "S-1-1-0"]);

// Fixture preparation only. SID-based .NET rules avoid resolving or creating
// a real Windows account for the invented account-domain SID.
export function grantSyntheticUsageLegacyAcl({ fixtureRoot, parent, paths = [], reader = SYNTHETIC_USAGE_READER_SID, rights = "ReadAndExecute" }) {
  const root = resolve(fixtureRoot), base = resolve(".release-build"), child = relative(base, root);
  if (!child || child.startsWith("..") || isAbsolute(child) || !/^(?:ub|uw)-[a-f0-9-]{36}$/u.test(basename(root))
      || !readers.has(reader) || !["ReadAndExecute", "Modify"].includes(rights)) throw new Error("synthetic_acl_scope_invalid");
  assertWindowsOwnerOnly(root);
  for (const path of [parent, ...paths]) {
    const scoped = relative(root, resolve(path));
    if (!scoped || scoped.startsWith("..") || isAbsolute(scoped) || lstatSync(path).isSymbolicLink()) throw new Error("synthetic_acl_scope_invalid");
  }
  const script = String.raw`
$ErrorActionPreference='Stop'
try{
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SyntheticUsageAcl {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
 public static void Apply(string path, byte[] descriptor, bool protect) {
  var memory=Marshal.AllocHGlobal(descriptor.Length);
  try { Marshal.Copy(descriptor,0,memory,descriptor.Length); bool present,defaulted;IntPtr dacl;
   if(!GetSecurityDescriptorDacl(memory,out present,out dacl,out defaulted)||!present||dacl==IntPtr.Zero)throw new InvalidOperationException("synthetic_dacl_invalid");
   uint code=SetNamedSecurityInfoW(path,1,4u|(protect?0x80000000u:0x20000000u),IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);
   if(code!=0)throw new InvalidOperationException("synthetic_dacl_apply_failed");
  } finally {Marshal.FreeHGlobal(memory);}
 }
}
'@
 $stage='parse'
 $inputRecord=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $stage='read_parent';$parentAcl=Get-Acl -LiteralPath $inputRecord.parent
 $item=Get-Item -LiteralPath $inputRecord.parent
 $inheritance=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
 foreach($pair in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($inputRecord.reader,$inputRecord.rights))){
  $stage='construct_rule'
  $sid=[Security.Principal.SecurityIdentifier]::new($pair[0])
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]$pair[1],$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $stage='set_rule';$parentAcl.SetAccessRule($rule)
 }
 $stage='persist_parent';[SyntheticUsageAcl]::Apply($inputRecord.parent,$parentAcl.GetSecurityDescriptorBinaryForm(),$parentAcl.AreAccessRulesProtected)
 foreach($path in $inputRecord.paths){$stage='persist_child';$acl=Get-Acl -LiteralPath $path;$acl.SetAccessRuleProtection($false,$true);[SyntheticUsageAcl]::Apply($path,$acl.GetSecurityDescriptorBinaryForm(),$false)}
}catch{[Console]::Error.WriteLine('SYNTHETIC_ACL_PREPARATION_FAILED_'+$stage+'_'+$_.Exception.GetType().Name);exit 1}
`;
  execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: JSON.stringify({ parent, paths, reader, rights }), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 20000,
  });
}
