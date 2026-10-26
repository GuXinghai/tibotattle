// Qualification-only usage-directory freeze primitives. Never automatically
// restore on close/GC: a killed process leaves the fixed deny in place until
// the exact identity-bound protected journal is used for explicit recovery.
constexpr DWORD kUsageDenyMask = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY
    | FILE_DELETE_CHILD | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA | DELETE;
constexpr DWORD kUsageFileDenyMask = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA | DELETE;
constexpr DWORD kUsageParentDenyMask = FILE_DELETE_CHILD | DELETE;
constexpr std::size_t kUsageMaximumSecurityBytes = 65536;
struct UsageDirectoryLease {
  RelativeHandles opened;
  HandleIdentity identity;
  std::vector<BYTE> original;
  std::vector<BYTE> frozen;
  bool directory = true;
  bool maintenanceParent = false;
  bool legacySourceAcl = false;
  bool usageSourceRoot = false;
  bool primaryTimingRoot = false;
  std::vector<BYTE> legacyReader;
  std::wstring leafName;
  std::array<BYTE, 16> operationTag{};
};
std::array<UsageDirectoryLease*, 256> gUsageDirectories{};
std::mutex gUsageDirectoriesMutex;

bool UsageRelativeBounds(const std::vector<BYTE>& bytes) {
  if (bytes.size() < sizeof(SECURITY_DESCRIPTOR_RELATIVE)) return false;
  const auto* sd = reinterpret_cast<const SECURITY_DESCRIPTOR_RELATIVE*>(bytes.data());
  if (sd->Revision != SECURITY_DESCRIPTOR_REVISION || !(sd->Control & SE_SELF_RELATIVE) || sd->Sacl != 0) return false;
  const auto sid = [&](DWORD offset, bool required) {
    if (offset == 0) return !required;
    if (offset % 4 || offset < sizeof(*sd) || offset > bytes.size() - 8) return false;
    const auto* value = bytes.data() + offset;
    return value[0] == SID_REVISION && value[1] <= SID_MAX_SUB_AUTHORITIES
        && 8 + 4 * static_cast<std::size_t>(value[1]) <= bytes.size() - offset;
  };
  if (!sid(sd->Owner, true) || !sid(sd->Group, false) || sd->Dacl == 0 || sd->Dacl % 4
      || sd->Dacl < sizeof(*sd) || sd->Dacl > bytes.size() - sizeof(ACL)) return false;
  const auto* acl = reinterpret_cast<const ACL*>(bytes.data() + sd->Dacl);
  if (acl->AclSize < sizeof(ACL) || acl->AclSize > bytes.size() - sd->Dacl) return false;
  std::size_t offset = sizeof(ACL);
  for (DWORD i = 0; i < acl->AceCount; ++i) {
    if (offset > acl->AclSize - sizeof(ACE_HEADER)) return false;
    const auto* ace = reinterpret_cast<const ACE_HEADER*>(reinterpret_cast<const BYTE*>(acl) + offset);
    if (ace->AceSize < sizeof(ACE_HEADER) || ace->AceSize > acl->AclSize - offset) return false;
    offset += ace->AceSize;
  }
  return true;
}

bool UsageSecurity(const std::vector<BYTE>& bytes, PSID* owner, PSID* group,
    PACL* dacl, SECURITY_DESCRIPTOR_CONTROL* control) {
  if (bytes.size() > kUsageMaximumSecurityBytes || !UsageRelativeBounds(bytes)) return false;
  auto* sd = reinterpret_cast<PSECURITY_DESCRIPTOR>(const_cast<BYTE*>(bytes.data()));
  if (!IsValidSecurityDescriptor(sd) || GetSecurityDescriptorLength(sd) > bytes.size()) return false;
  BOOL ownerDefaulted = FALSE, groupDefaulted = FALSE, present = FALSE, defaulted = FALSE;
  DWORD revision = 0;
  if (!GetSecurityDescriptorOwner(sd, owner, &ownerDefaulted)
      || !GetSecurityDescriptorGroup(sd, group, &groupDefaulted)
      || !GetSecurityDescriptorDacl(sd, &present, dacl, &defaulted)
      || !GetSecurityDescriptorControl(sd, control, &revision)
      || !present || *dacl == nullptr || !IsValidAcl(*dacl)) return false;
  std::vector<BYTE> current;
  return GetCurrentUserSid(&current) && IsSidEqual(*owner, current.data());
}

bool UsageEncodeSecurity(PSID owner, PSID group, PACL dacl,
    SECURITY_DESCRIPTOR_CONTROL control, std::vector<BYTE>* bytes) {
  SECURITY_DESCRIPTOR absolute{};
  if (!InitializeSecurityDescriptor(&absolute, SECURITY_DESCRIPTOR_REVISION)
      || !SetSecurityDescriptorOwner(&absolute, owner, (control & SE_OWNER_DEFAULTED) != 0)
      || !SetSecurityDescriptorGroup(&absolute, group, (control & SE_GROUP_DEFAULTED) != 0)
      || !SetSecurityDescriptorDacl(&absolute, TRUE, dacl, (control & SE_DACL_DEFAULTED) != 0)) return false;
  const auto mask = static_cast<SECURITY_DESCRIPTOR_CONTROL>(SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ);
  if (!SetSecurityDescriptorControl(&absolute, mask, static_cast<SECURITY_DESCRIPTOR_CONTROL>(control & mask))) return false;
  DWORD length = 0;
  MakeSelfRelativeSD(&absolute, nullptr, &length);
  if (length < SECURITY_DESCRIPTOR_MIN_LENGTH || length > kUsageMaximumSecurityBytes) return false;
  bytes->resize(length);
  return MakeSelfRelativeSD(&absolute, bytes->data(), &length) != FALSE;
}

bool UsageReadSecurity(HANDLE handle, std::vector<BYTE>* bytes) {
  const SECURITY_INFORMATION info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  DWORD length = 0;
  GetKernelObjectSecurity(handle, info, nullptr, 0, &length);
  if (length < SECURITY_DESCRIPTOR_MIN_LENGTH || length > kUsageMaximumSecurityBytes) return false;
  std::vector<BYTE> raw(length);
  if (!GetKernelObjectSecurity(handle, info, raw.data(), length, &length)) return false;
  PSID owner = nullptr, group = nullptr; PACL dacl = nullptr; SECURITY_DESCRIPTOR_CONTROL control = 0;
  return UsageSecurity(raw, &owner, &group, &dacl, &control)
      && UsageEncodeSecurity(owner, group, dacl, control, bytes);
}

bool UsageOriginalPolicy(const std::vector<BYTE>& bytes, bool legacySourceAcl = false,
    const std::vector<BYTE>* pinnedReader = nullptr, std::vector<BYTE>* reader = nullptr,
    bool snapshotLogonReader = false) {
  PSID owner = nullptr, group = nullptr; PACL dacl = nullptr; SECURITY_DESCRIPTOR_CONTROL control = 0;
  if (!UsageSecurity(bytes, &owner, &group, &dacl, &control)) return false;
  bool ownerAllow = false;
  std::vector<BYTE> selectedReader;
  bool logonReaderSeen = false;
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void* raw = nullptr; if (!GetAce(dacl, i, &raw)) return false;
    const auto* header = static_cast<const ACE_HEADER*>(raw);
    const DWORD offset = FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & ~0x1f) != 0
        || header->AceSize < offset + 8) return false;
    auto* sid = reinterpret_cast<BYTE*>(raw) + offset;
    if (sid[0] != SID_REVISION || sid[1] > SID_MAX_SUB_AUTHORITIES
        || 8 + 4 * static_cast<std::size_t>(sid[1]) > header->AceSize - offset || !IsValidSid(sid)) return false;
    if (IsSidEqual(sid, owner)) {
      if (!(header->AceFlags & INHERIT_ONLY_ACE)) ownerAllow = true;
      continue;
    }
    if (!legacySourceAcl) return false;
    if (IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) continue;
    if (snapshotLogonReader && IsWellKnownSid(sid, WinLogonIdsSid)) {
      DWORD mask = static_cast<const ACCESS_ALLOWED_ACE*>(raw)->Mask;
      GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
      MapGenericMask(&mask, &mapping);
      // Only one pre-existing, non-inheriting read/execute session ACE on a
      // fixed snapshot file. Its exact SID stays in that file's original SD;
      // it is never treated as provider/account continuity or propagated.
      if (logonReaderSeen || header->AceFlags != 0 || mask == 0
          || (mask & ~(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)) != 0) return false;
      logonReaderSeen = true;
      continue;
    }
    // One existing account-domain SID may retain read/execute ONLY. It is
    // pinned from the exact maintenance-parent ACL and must remain identical
    // across children. This grants no rights and implies no account continuity.
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    if (std::memcmp(GetSidIdentifierAuthority(sid), &authority, sizeof(authority)) != 0
        || *GetSidSubAuthorityCount(sid) != 5 || *GetSidSubAuthority(sid, 0) != 21) return false;
    DWORD mask = static_cast<const ACCESS_ALLOWED_ACE*>(raw)->Mask;
    GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    MapGenericMask(&mask, &mapping);
    if (mask == 0 || (mask & ~(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)) != 0) return false;
    const auto length = GetLengthSid(sid);
    std::vector<BYTE> candidate(sid, sid + length);
    if (pinnedReader != nullptr && candidate != *pinnedReader) return false;
    if (!selectedReader.empty() && candidate != selectedReader) return false;
    selectedReader = std::move(candidate);
  }
  if (reader != nullptr) *reader = pinnedReader != nullptr ? *pinnedReader : selectedReader;
  // Owner-only remains the default. The separate legacy-source exception
  // preserves exact existing ACEs; it never repairs or adds a source grant.
  return ownerAllow;
}

bool UsageFrozenSecurity(const std::vector<BYTE>& original, std::vector<BYTE>* frozen,
    bool directory, const std::array<BYTE, 16>& operationTag, bool maintenanceParent = false,
    bool legacySourceAcl = false, const std::vector<BYTE>* pinnedReader = nullptr, std::vector<BYTE>* reader = nullptr,
    bool snapshotLogonReader = false) {
  PSID owner = nullptr, group = nullptr; PACL dacl = nullptr; SECURITY_DESCRIPTOR_CONTROL control = 0;
  if (!UsageSecurity(original, &owner, &group, &dacl, &control)
      || !UsageOriginalPolicy(original, legacySourceAcl, pinnedReader, reader, snapshotLogonReader)) return false;
  BYTE world[SECURITY_MAX_SID_SIZE]; DWORD worldSize = sizeof(world);
  if (!CreateWellKnownSid(WinWorldSid, nullptr, world, &worldSize)) return false;
  BYTE marker[SECURITY_MAX_SID_SIZE]; SID_IDENTIFIER_AUTHORITY markerAuthority = SECURITY_NULL_SID_AUTHORITY;
  if (!InitializeSid(marker, &markerAuthority, 4)) return false;
  std::memcpy(GetSidSubAuthority(marker, 0), operationTag.data(), operationTag.size());
  // A deny-only operation SID (null authority, four nonce subauthorities)
  // cannot grant rights. Unlike a zero-mask ACE, it survives Windows ACL
  // normalization and binds recovery to this operation's persistent nonce.
  const DWORD size = dacl->AclSize + 2 * (sizeof(ACCESS_DENIED_ACE) - sizeof(DWORD)) + worldSize + GetLengthSid(marker);
  if (size > 65535) return false;
  std::vector<BYTE> memory(size);
  auto* next = reinterpret_cast<PACL>(memory.data());
  if (!InitializeAcl(next, size, dacl->AclRevision)
      || !AddAccessDeniedAceEx(next, dacl->AclRevision, 0, maintenanceParent ? kUsageParentDenyMask : directory ? kUsageDenyMask : kUsageFileDenyMask, world)
      || !AddAccessDeniedAceEx(next, dacl->AclRevision, 0, READ_CONTROL, marker)) return false;
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void* ace = nullptr;
    if (!GetAce(dacl, i, &ace)
        || !AddAce(next, dacl->AclRevision, MAXDWORD, ace, static_cast<ACE_HEADER*>(ace)->AceSize)) return false;
  }
  return UsageEncodeSecurity(owner, group, next, control, frozen);
}

bool UsageHasFreezeDeny(const std::vector<BYTE>& bytes, bool directory = true, bool maintenanceParent = false) {
  PSID owner = nullptr, group = nullptr; PACL dacl = nullptr; SECURITY_DESCRIPTOR_CONTROL control = 0;
  if (!UsageSecurity(bytes, &owner, &group, &dacl, &control)) return false;
  BYTE world[SECURITY_MAX_SID_SIZE]; DWORD worldSize = sizeof(world);
  if (!CreateWellKnownSid(WinWorldSid, nullptr, world, &worldSize)) return false;
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void* raw = nullptr; if (!GetAce(dacl, i, &raw)) return false;
    const auto* header = static_cast<ACE_HEADER*>(raw);
    if (header->AceType == ACCESS_DENIED_ACE_TYPE && header->AceFlags == 0
        && header->AceSize >= sizeof(ACCESS_DENIED_ACE)) {
      const auto* ace = static_cast<ACCESS_DENIED_ACE*>(raw);
      if (ace->Mask == (maintenanceParent ? kUsageParentDenyMask : directory ? kUsageDenyMask : kUsageFileDenyMask) && IsSidEqual(const_cast<DWORD*>(&ace->SidStart), world)) return true;
    }
  }
  return false;
}

bool UsageGetLease(napi_env env, napi_value value, UsageDirectoryLease** result) {
  void* raw = nullptr;
  if (napi_get_value_external(env, value, &raw) != napi_ok || raw == nullptr) return false;
  auto* lease = static_cast<UsageDirectoryLease*>(raw);
  if (std::find(gUsageDirectories.begin(), gUsageDirectories.end(), lease) == gUsageDirectories.end()) return false;
  *result = lease; return true;
}
void UsageFinalize(napi_env, void* raw, void*) {
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  auto* lease = static_cast<UsageDirectoryLease*>(raw);
  const auto slot = std::find(gUsageDirectories.begin(), gUsageDirectories.end(), lease);
  if (slot != gUsageDirectories.end()) *slot = nullptr;
  delete lease;
}
bool UsageValid(UsageDirectoryLease* lease) {
  HandleIdentity current; SecuritySnapshot security;
  return GetIdentity(lease->opened.final, &current) && EqualIdentity(current, lease->identity)
      && current.directory == lease->directory && current.linkCount == 1
      && ReadSecurity(lease->opened.final, &security) && security.ownerMatches && !security.nullDacl
      && !security.broadAccess && (lease->legacySourceAcl || !security.nonOwnerAllow) && !security.unrecognizedAce;
}
napi_value UsageResult(napi_env env, UsageDirectoryLease* lease) {
  napi_value result, token, original, frozen;
  if (napi_create_external(env, lease, UsageFinalize, nullptr, &token) != napi_ok) return nullptr;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, lease->original.size(), lease->original.data(), nullptr, &original);
  napi_create_buffer_copy(env, lease->frozen.size(), lease->frozen.data(), nullptr, &frozen);
  napi_set_named_property(env, result, "lease", token);
  napi_set_named_property(env, result, "identity", IdentityValue(env, lease->identity));
  napi_set_named_property(env, result, "originalSecurity", original);
  napi_set_named_property(env, result, "frozenSecurity", frozen);
  return result;
}

napi_value OpenUsageDirectory(napi_env env, napi_callback_info info, bool recovering, bool maintenanceParent = false, bool legacySourceAcl = false) {
  std::vector<napi_value> args; std::wstring path; HandleIdentity expected;
  const BYTE* original = nullptr; std::size_t originalSize = 0; const BYTE* tag = nullptr; std::size_t tagSize = 0;
  if (!GetArguments(env, info, &args, recovering ? 4 : legacySourceAcl ? 3 : 2) || !GetString(env, args[0], &path)
      || !GetBuffer(env, args[recovering ? 3 : 1], &tag, &tagSize) || tagSize != 16
      || (recovering && !ParseExpectedIdentity(env, args[1], &expected))
      || ((recovering || legacySourceAcl) && (!GetBuffer(env, args[2], &original, &originalSize)
        || originalSize < SECURITY_DESCRIPTOR_MIN_LENGTH || originalSize > kUsageMaximumSecurityBytes)))
    return ThrowFailure(env, InvalidConfiguration());
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  const auto slot = std::find(gUsageDirectories.begin(), gUsageDirectories.end(), nullptr);
  if (slot == gUsageDirectories.end()) return ThrowFailure(env, {"USAGE_FREEZE_LIMIT"});
  auto* lease = new (std::nothrow) UsageDirectoryLease;
  if (lease == nullptr) return ThrowFailure(env, OperationFailed());
  lease->maintenanceParent = maintenanceParent;
  lease->legacySourceAcl = legacySourceAcl;
  std::copy(tag, tag + 16, lease->operationTag.begin());
  Failure failure = OperationFailed(); ParsedPath parsed; bool missing = false;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true; options.finalDirectory = true;
  options.access = kDirectoryTraversalAccess | WRITE_DAC;
  options.shareMode = 0; // prevents granted directory-write handles and propagation
  options.protectedAncestorDepth = (std::numeric_limits<std::size_t>::max)();
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  if (!ParseAndValidatePath(path, false, &parsed, &failure)
      || !OpenRelativePath(parsed, options, &lease->opened, &missing, &failure) || missing
      || !ResolveFinalPath(lease->opened.final, &parsed)
      || !GetIdentity(lease->opened.final, &lease->identity) || lease->identity.linkCount != 1
      || (recovering && !EqualIdentity(lease->identity, expected))) {
    delete lease; return ThrowFailure(env, recovering ? Failure{"USAGE_FREEZE_IDENTITY_OR_OPEN"} : failure);
  }
  std::vector<BYTE> current;
  if (!UsageValid(lease) || !UsageReadSecurity(lease->opened.final, &current)) {
    delete lease; return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"});
  }
  if (!recovering && legacySourceAcl && current != std::vector<BYTE>(original, original + originalSize)) {
    delete lease; return ThrowFailure(env, {"USAGE_FREEZE_SOURCE_POLICY_CHANGED"});
  }
  if (recovering) lease->original.assign(original, original + originalSize);
  else {
    if (UsageHasFreezeDeny(current, true, maintenanceParent)) { delete lease; return ThrowFailure(env, {"USAGE_FREEZE_RESUME_REQUIRED"}); }
    lease->original = current;
  }
  lease->leafName = parsed.components.back();
  if (!UsageFrozenSecurity(lease->original, &lease->frozen, true, lease->operationTag, maintenanceParent,
      legacySourceAcl, nullptr, &lease->legacyReader)
      || (current != lease->original && current != lease->frozen)) {
    delete lease; return ThrowFailure(env, {"USAGE_FREEZE_ACL_MISMATCH"});
  }
  *slot = lease;
  napi_value result = UsageResult(env, lease);
  if (result == nullptr) { *slot = nullptr; delete lease; return ThrowFailure(env, OperationFailed()); }
  return result;
}
napi_value OpenUsageDirectoryCallback(napi_env env, napi_callback_info info) { return OpenUsageDirectory(env, info, false); }
napi_value ReopenUsageDirectoryCallback(napi_env env, napi_callback_info info) { return OpenUsageDirectory(env, info, true); }
napi_value OpenUsageParentCallback(napi_env env, napi_callback_info info) { return OpenUsageDirectory(env, info, false, true); }
napi_value ReopenUsageParentCallback(napi_env env, napi_callback_info info) { return OpenUsageDirectory(env, info, true, true); }
napi_value OpenLegacyUsageParentCallback(napi_env env, napi_callback_info info) { return OpenUsageDirectory(env, info, false, true, true); }
napi_value ReopenLegacyUsageParentCallback(napi_env env, napi_callback_info info) { return OpenUsageDirectory(env, info, true, true, true); }

// Metadata only, through an already issued, pinned legacy directory guard.
// Raw descriptor bytes are private preflight operands, never loggable output.
napi_value ReadUsageDirectorySecurityCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; void* raw = nullptr;
  if (!GetArguments(env, info, &args, 1) || napi_get_value_external(env, args[0], &raw) != napi_ok || raw == nullptr)
    return ThrowFailure(env, CredentialAuditGuardForeign());
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  auto* guard = static_cast<CredentialAuditFileGuard*>(raw);
  if (!IsIssuedCredentialAuditFileGuard(guard) || !guard->active || !guard->directoryGuard
      || !guard->legacyDirectory || guard->handles.empty()) return ThrowFailure(env, CredentialAuditGuardForeign());
  std::vector<BYTE> bytes;
  if (!UsageReadSecurity(guard->handles.back(), &bytes)) return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"});
  napi_value result; napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result); return result;
}

napi_value InspectUsageSourcePolicyCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; const BYTE *parent = nullptr, *source = nullptr; std::size_t parentSize = 0, sourceSize = 0;
  if (!GetArguments(env, info, &args, 2) || !GetBuffer(env, args[0], &parent, &parentSize)
      || !GetBuffer(env, args[1], &source, &sourceSize) || parentSize < SECURITY_DESCRIPTOR_MIN_LENGTH
      || sourceSize < SECURITY_DESCRIPTOR_MIN_LENGTH || parentSize > kUsageMaximumSecurityBytes
      || sourceSize > kUsageMaximumSecurityBytes) return ThrowFailure(env, InvalidConfiguration());
  const std::vector<BYTE> parentBytes(parent, parent + parentSize), sourceBytes(source, source + sourceSize);
  std::vector<BYTE> reader;
  const bool ownerOnly = UsageOriginalPolicy(parentBytes) && UsageOriginalPolicy(sourceBytes);
  const bool legacy = UsageOriginalPolicy(parentBytes, true, nullptr, &reader) && UsageOriginalPolicy(sourceBytes, true, &reader);
  napi_value result, value; napi_create_object(env, &result);
  napi_get_boolean(env, ownerOnly, &value); napi_set_named_property(env, result, "ownerOnly", value);
  napi_get_boolean(env, legacy, &value); napi_set_named_property(env, result, "preserveLegacyUsage", value);
  return result;
}

// Exclude existing share-tracked directory access at acquisition, install the
// non-inheriting deny, THEN admit traversal handles. New DELETE_CHILD access is
// denied by the persisted ACL throughout this exact-identity reopen. The
// journal must be outside this parent so its own handles do not defeat share=0.
napi_value SealUsageParentCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  std::vector<BYTE> current;
  if (!GetArguments(env, info, &args, 1) || !UsageGetLease(env, args[0], &lease)
      || !lease->maintenanceParent || !UsageValid(lease) || lease->opened.parents.empty()
      || !UsageReadSecurity(lease->opened.final, &current) || current != lease->frozen)
    return ThrowFailure(env, {"USAGE_FREEZE_NOT_FROZEN"});
  // READ_CONTROL/attributes do not request share-tracked data access. Retain
  // this no-delete-sharing identity pin while switching the traversal handle;
  // never leave the parent name replaceable between close and reopen.
  ScopedHandle pin; Failure failure = OperationFailed(); HandleIdentity pinned;
  if (!OpenRelativeComponent(lease->opened.parents.back(), lease->leafName,
      READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      kFileOpen, kFileDirectoryFile, nullptr, &pin.handle, nullptr, &failure)
      || !GetIdentity(pin.handle, &pinned) || !EqualIdentity(pinned, lease->identity))
    return ThrowFailure(env, {"USAGE_FREEZE_PARENT_PIN_FAILED"});
  if (!CloseHandle(lease->opened.final)) return ThrowFailure(env, {"USAGE_FREEZE_CLOSE_FAILED"});
  lease->opened.final = INVALID_HANDLE_VALUE;
  if (!OpenRelativeComponent(lease->opened.parents.back(), lease->leafName,
      kDirectoryTraversalAccess | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE,
      kFileOpen, kFileDirectoryFile, nullptr, &lease->opened.final, nullptr, &failure)
      || !UsageValid(lease) || !UsageReadSecurity(lease->opened.final, &current) || current != lease->frozen)
    return ThrowFailure(env, {"USAGE_FREEZE_PARENT_REOPEN_FAILED"});
  napi_value result; napi_get_boolean(env, true, &result); return result;
}

bool UsageLegacySnapshotName(const std::wstring& name) {
  if (name == L"model-performance-snapshot.json") return true;
  const std::wstring prefix = L"model-performance-snapshot-v6-";
  if (name.size() != prefix.size() + 64 + 5 || name.compare(0, prefix.size(), prefix) != 0
      || name.compare(name.size() - 5, 5, L".json") != 0) return false;
  return std::all_of(name.begin() + prefix.size(), name.end() - 5,
      [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}

napi_value OpenUsageChildDirectory(napi_env env, napi_callback_info info, bool recovering, bool directory = true,
    bool snapshotLogonReader = false) {
  std::vector<napi_value> args; UsageDirectoryLease* parent = nullptr; std::wstring name; HandleIdentity expected;
  const BYTE* original = nullptr; std::size_t size = 0;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  if (!GetArguments(env, info, &args, recovering ? 4 : 3) || !UsageGetLease(env, args[0], &parent)
      || !GetString(env, args[1], &name) || !ParseExpectedIdentity(env, args[2], &expected)
      || name.empty() || name == L"." || name == L".." || name.find_first_of(L"\\/:") != std::wstring::npos
      || name.find(L'\0') != std::wstring::npos
      || (recovering && (!GetBuffer(env, args[3], &original, &size) || size < SECURITY_DESCRIPTOR_MIN_LENGTH || size > kUsageMaximumSecurityBytes)))
    return ThrowFailure(env, InvalidConfiguration());
  if (snapshotLogonReader && (directory || !parent->legacySourceAcl || !parent->primaryTimingRoot
      || !UsageLegacySnapshotName(name)))
    return ThrowFailure(env, {"USAGE_FREEZE_SNAPSHOT_POLICY_SCOPE"});
  std::vector<BYTE> currentParent;
  if (!parent->directory || !UsageValid(parent) || !UsageReadSecurity(parent->opened.final, &currentParent)
      || (currentParent != parent->frozen && !(recovering && currentParent == parent->original)))
    return ThrowFailure(env, {"USAGE_FREEZE_NOT_FROZEN"});
  const auto slot = std::find(gUsageDirectories.begin(), gUsageDirectories.end(), nullptr);
  if (slot == gUsageDirectories.end()) return ThrowFailure(env, {"USAGE_FREEZE_LIMIT"});
  auto* lease = new (std::nothrow) UsageDirectoryLease;
  if (lease == nullptr) return ThrowFailure(env, OperationFailed());
  lease->directory = directory;
  lease->usageSourceRoot = directory && parent->maintenanceParent;
  lease->primaryTimingRoot = directory && parent->usageSourceRoot && name == L"inference-timing-v2";
  lease->legacySourceAcl = parent->legacySourceAcl;
  lease->legacyReader = parent->legacyReader;
  lease->operationTag = parent->operationTag;
  const auto duplicate = [&](HANDLE source) {
    HANDLE copy = INVALID_HANDLE_VALUE;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) return false;
    lease->opened.parents.push_back(copy); return true;
  };
  bool okay = true;
  for (auto ancestor : parent->opened.parents) if (!duplicate(ancestor)) { okay = false; break; }
  okay = okay && duplicate(parent->opened.final);
  Failure failure = OperationFailed();
  if (!okay || !OpenRelativeComponent(parent->opened.final, name,
      (directory ? kDirectoryTraversalAccess : (GENERIC_READ | READ_CONTROL | SYNCHRONIZE)) | WRITE_DAC,
      directory ? 0 : FILE_SHARE_READ, kFileOpen, directory ? kFileDirectoryFile : kFileNonDirectoryFile,
      nullptr, &lease->opened.final, nullptr, &failure)
      || !GetIdentity(lease->opened.final, &lease->identity) || lease->identity.linkCount != 1
      || lease->identity.directory != directory
      || !EqualIdentity(lease->identity, expected)) { delete lease; return ThrowFailure(env, {"USAGE_FREEZE_IDENTITY_OR_OPEN"}); }
  bool reparse = false; std::vector<BYTE> current;
  if (!HasReparsePoint(lease->opened.final, &reparse) || reparse || !UsageValid(lease)
      || !UsageReadSecurity(lease->opened.final, &current)) { delete lease; return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"}); }
  if (recovering) lease->original.assign(original, original + size);
  else {
    if (UsageHasFreezeDeny(current, directory)) { delete lease; return ThrowFailure(env, {"USAGE_FREEZE_RESUME_REQUIRED"}); }
    lease->original = current;
  }
  if (!UsageFrozenSecurity(lease->original, &lease->frozen, directory, lease->operationTag, false,
      lease->legacySourceAcl, &parent->legacyReader, &lease->legacyReader, snapshotLogonReader)
      || (current != lease->original && current != lease->frozen)) { delete lease; return ThrowFailure(env, {"USAGE_FREEZE_ACL_MISMATCH"}); }
  *slot = lease; napi_value result = UsageResult(env, lease);
  if (result == nullptr) { *slot = nullptr; delete lease; return ThrowFailure(env, OperationFailed()); }
  return result;
}
napi_value OpenUsageChildDirectoryCallback(napi_env env, napi_callback_info info) { return OpenUsageChildDirectory(env, info, false); }
napi_value ReopenUsageChildDirectoryCallback(napi_env env, napi_callback_info info) { return OpenUsageChildDirectory(env, info, true); }
napi_value OpenUsageChildFileCallback(napi_env env, napi_callback_info info) { return OpenUsageChildDirectory(env, info, false, false); }
napi_value ReopenUsageChildFileCallback(napi_env env, napi_callback_info info) { return OpenUsageChildDirectory(env, info, true, false); }
napi_value OpenUsageSnapshotFileCallback(napi_env env, napi_callback_info info) { return OpenUsageChildDirectory(env, info, false, false, true); }
napi_value ReopenUsageSnapshotFileCallback(napi_env env, napi_callback_info info) { return OpenUsageChildDirectory(env, info, true, false, true); }

napi_value ListUsageChildrenCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  if (!GetArguments(env, info, &args, 1) || !UsageGetLease(env, args[0], &lease)) return ThrowFailure(env, {"USAGE_FREEZE_FOREIGN"});
  std::vector<BYTE> current;
  if (!lease->directory || !UsageValid(lease) || !UsageReadSecurity(lease->opened.final, &current) || current != lease->frozen)
    return ThrowFailure(env, {"USAGE_FREEZE_NOT_FROZEN"});
  napi_value result; napi_create_array(env, &result); uint32_t count = 0;
  std::vector<BYTE> buffer(65536); bool restart = true;
  for (;;) {
    if (!GetFileInformationByHandleEx(lease->opened.final,
        restart ? FileIdExtdDirectoryRestartInfo : FileIdExtdDirectoryInfo, buffer.data(), static_cast<DWORD>(buffer.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      return ThrowFailure(env, {"USAGE_FREEZE_ENUMERATION_FAILED"});
    }
    restart = false; std::size_t offset = 0;
    for (;;) {
      const auto header = FIELD_OFFSET(FILE_ID_EXTD_DIR_INFO, FileName);
      if (offset > buffer.size() - header) return ThrowFailure(env, {"USAGE_FREEZE_ENUMERATION_INVALID"});
      const auto* entry = reinterpret_cast<const FILE_ID_EXTD_DIR_INFO*>(buffer.data() + offset);
      if (entry->FileNameLength % sizeof(wchar_t) || entry->FileNameLength > buffer.size() - offset - header)
        return ThrowFailure(env, {"USAGE_FREEZE_ENUMERATION_INVALID"});
      const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L"..") {
        if (count >= 8192 || name.empty() || name.find_first_of(L"\\/:") != std::wstring::npos || name.find(L'\0') != std::wstring::npos)
          return ThrowFailure(env, {"USAGE_FREEZE_LIMIT_OR_NAME"});
        HandleIdentity identity = lease->identity;
        std::memcpy(identity.fileId.data(), entry->FileId.Identifier, identity.fileId.size());
        identity.linkCount = 0; // Enumeration does NOT establish link count.
        napi_value item, value; napi_create_object(env, &item);
        napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(name.data()), name.size(), &value);
        napi_set_named_property(env, item, "name", value);
        const char* kind = (entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? "reparse"
            : (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? "directory" : "file";
        napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, item, "kind", value);
        napi_set_named_property(env, item, "identity", IdentityValue(env, identity));
        napi_set_element(env, result, count++, item);
      }
      if (entry->NextEntryOffset == 0) break;
      if (entry->NextEntryOffset < header || entry->NextEntryOffset > buffer.size() - offset)
        return ThrowFailure(env, {"USAGE_FREEZE_ENUMERATION_INVALID"});
      offset += entry->NextEntryOffset;
    }
  }
  return result;
}

napi_value SetUsageFreeze(napi_env env, napi_callback_info info, bool restore) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  if (!GetArguments(env, info, &args, 1) || !UsageGetLease(env, args[0], &lease)) return ThrowFailure(env, {"USAGE_FREEZE_FOREIGN"});
  std::vector<BYTE> current;
  if (!UsageValid(lease) || !UsageReadSecurity(lease->opened.final, &current)) return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"});
  const auto& expected = restore ? lease->frozen : lease->original;
  const auto& target = restore ? lease->original : lease->frozen;
  if (current != expected && current != target) return ThrowFailure(env, {"USAGE_FREEZE_ACL_MISMATCH"});
  if (restore) {
    for (const auto* child : gUsageDirectories) if (child != nullptr && child != lease) {
      for (auto handle : child->opened.parents) {
        HandleIdentity ancestor;
        if (handle != INVALID_HANDLE_VALUE && GetIdentity(handle, &ancestor) && EqualIdentity(ancestor, lease->identity))
          return ThrowFailure(env, {"USAGE_FREEZE_DESCENDANTS_ACTIVE"});
      }
    }
    // SQLite/read borrowers must release their independently retained frozen
    // handles before any source ACL is restored, including failed-close cases.
    const std::lock_guard<std::mutex> borrowedLock(gCredentialAuditFileGuardsMutex);
    for (const auto* guard : gCredentialAuditFileGuards) if (guard != nullptr && guard->active && guard->frozenSource) {
      for (auto handle : guard->handles) {
        HandleIdentity held;
        if (GetIdentity(handle, &held) && EqualIdentity(held, lease->identity))
          return ThrowFailure(env, {"USAGE_FREEZE_BORROWERS_ACTIVE"});
      }
    }
  }
  if (current != target) {
    PSID owner = nullptr, group = nullptr; PACL dacl = nullptr; SECURITY_DESCRIPTOR_CONTROL control = 0;
    if (!UsageSecurity(target, &owner, &group, &dacl, &control)) return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"});
    // Exclusive directory handle: SetSecurityInfo must not propagate inherited
    // ACEs to descendants. Exact child ACL invariance is a separate native test.
    const DWORD error = SetSecurityInfo(lease->opened.final, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | ((control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION),
      nullptr, nullptr, dacl, nullptr);
    if (error != ERROR_SUCCESS) return ThrowFailure(env, {"USAGE_FREEZE_SET_FAILED"});
    if (!UsageReadSecurity(lease->opened.final, &current) || current != target)
      return ThrowFailure(env, {"USAGE_FREEZE_READBACK_FAILED"});
  }
  napi_value result; napi_get_boolean(env, true, &result); return result;
}
napi_value ApplyUsageFreezeCallback(napi_env env, napi_callback_info info) { return SetUsageFreeze(env, info, false); }
napi_value RestoreUsageFreezeCallback(napi_env env, napi_callback_info info) { return SetUsageFreeze(env, info, true); }
napi_value UsageFreezeStateCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  if (!GetArguments(env, info, &args, 1) || !UsageGetLease(env, args[0], &lease)) return ThrowFailure(env, {"USAGE_FREEZE_FOREIGN"});
  std::vector<BYTE> current;
  if (!UsageValid(lease) || !UsageReadSecurity(lease->opened.final, &current)) return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"});
  const char* state = current == lease->original ? "original" : current == lease->frozen ? "frozen" : nullptr;
  if (state == nullptr) return ThrowFailure(env, {"USAGE_FREEZE_ACL_MISMATCH"});
  napi_value result; napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &result); return result;
}
napi_value ReadUsageChildSecurityCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr; std::wstring name;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  if (!GetArguments(env, info, &args, 2) || !UsageGetLease(env, args[0], &lease)
      || !GetString(env, args[1], &name) || name.empty() || name == L"." || name == L".."
      || name.find_first_of(L"\\/:") != std::wstring::npos || name.find(L'\0') != std::wstring::npos)
    return ThrowFailure(env, {"USAGE_FREEZE_FOREIGN_OR_CHILD"});
  if (!UsageValid(lease)) return ThrowFailure(env, {"USAGE_FREEZE_IDENTITY"});
  ScopedHandle child; Failure failure = OperationFailed();
  if (!OpenRelativeComponent(lease->opened.final, name,
      READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen, 0, nullptr,
      &child.handle, nullptr, &failure)) return ThrowFailure(env, failure);
  bool reparse = false; HandleIdentity identity; std::vector<BYTE> security;
  if (!HasReparsePoint(child.handle, &reparse) || reparse || !GetIdentity(child.handle, &identity)
      || identity.linkCount != 1 || !UsageReadSecurity(child.handle, &security)) return ThrowFailure(env, {"USAGE_FREEZE_SECURITY"});
  napi_value result;
  napi_create_buffer_copy(env, security.size(), security.data(), nullptr, &result);
  return result;
}
napi_value BorrowUsageObject(napi_env env, napi_callback_info info, bool directory) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  std::vector<BYTE> current;
  if (!GetArguments(env, info, &args, 1) || !UsageGetLease(env, args[0], &lease) || lease->directory != directory
      || !UsageValid(lease) || !UsageReadSecurity(lease->opened.final, &current) || current != lease->frozen)
    return ThrowFailure(env, {"USAGE_FREEZE_NOT_FROZEN"});
  auto* guard = new (std::nothrow) CredentialAuditFileGuard;
  if (guard == nullptr) return ThrowFailure(env, OperationFailed());
  const auto duplicate = [&](HANDLE source) {
    HANDLE copy = INVALID_HANDLE_VALUE;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) return false;
    guard->handles.push_back(copy); return true;
  };
  bool okay = true;
  for (auto parent : lease->opened.parents) if (!duplicate(parent)) { okay = false; break; }
  okay = okay && duplicate(lease->opened.final);
  guard->active = true; guard->sourceFile = !directory; guard->frozenSource = true;
  guard->directoryGuard = directory; guard->legacyDirectory = directory;
  {
    const std::lock_guard<std::mutex> guardLock(gCredentialAuditFileGuardsMutex);
    okay = okay && RegisterCredentialAuditFileGuard(guard);
  }
  if (!okay) { for (auto handle : guard->handles) CloseHandle(handle); delete guard; return ThrowFailure(env, {"USAGE_FREEZE_LIMIT_OR_DUPLICATE"}); }
  napi_value token;
  if (napi_create_external(env, guard, FinalizeCredentialAuditFileGuard, nullptr, &token) != napi_ok) {
    FinalizeCredentialAuditFileGuard(env, guard, nullptr); return ThrowFailure(env, OperationFailed());
  }
  return token;
}
napi_value BorrowUsageObjectFileCallback(napi_env env, napi_callback_info info) { return BorrowUsageObject(env, info, false); }
napi_value BorrowUsageDirectoryCallback(napi_env env, napi_callback_info info) { return BorrowUsageObject(env, info, true); }
napi_value CloseUsageDirectoryCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args; UsageDirectoryLease* lease = nullptr;
  const std::lock_guard<std::mutex> lock(gUsageDirectoriesMutex);
  if (!GetArguments(env, info, &args, 1) || !UsageGetLease(env, args[0], &lease)) return ThrowFailure(env, {"USAGE_FREEZE_FOREIGN"});
  const auto slot = std::find(gUsageDirectories.begin(), gUsageDirectories.end(), lease);
  // Keep the token allocation alive until its external finalizer. Otherwise
  // an old token could match a newly allocated lease at the same address (ABA).
  bool closed = true;
  if (lease->opened.final != INVALID_HANDLE_VALUE) {
    if (CloseHandle(lease->opened.final)) lease->opened.final = INVALID_HANDLE_VALUE;
    else closed = false;
  }
  for (auto& handle : lease->opened.parents) if (handle != INVALID_HANDLE_VALUE) {
    if (CloseHandle(handle)) handle = INVALID_HANDLE_VALUE;
    else closed = false;
  }
  if (!closed) return ThrowFailure(env, {"USAGE_FREEZE_CLOSE_FAILED"});
  *slot = nullptr;
  napi_value result; napi_get_undefined(env, &result); return result;
}
