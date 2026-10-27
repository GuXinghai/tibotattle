#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <fileapi.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <iomanip>
#include <limits>
#include <mutex>
#include <new>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::size_t kMaximumFileBytes = 1024 * 1024;
constexpr std::size_t kMaximumReportBytes = 64 * 1024 * 1024;
constexpr std::size_t kMaximumReportPathComponents = 256;
constexpr DWORD kReportPublicationMutexWaitMilliseconds = 30000;

// The Win32 CreateFile API has no root-directory parameter.  Calling it once
// for every component, even with FILE_FLAG_OPEN_REPARSE_POINT, leaves a
// window in which an ancestor can be renamed or replaced between the
// validation pass and the final open.  The native NT API does expose the
// root-directory handle, so the sensitive path walk below uses these small
// private declarations instead of relying on SDK-specific winternl.h
// prototypes.  The layouts are the documented x64/x86 ABI layouts and are
// intentionally kept local to this binding.
using NativeNtStatus = LONG;

struct NativeUnicodeString {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
};

struct NativeObjectAttributes {
  ULONG Length;
  HANDLE RootDirectory;
  NativeUnicodeString* ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
};

struct NativeIoStatusBlock {
  union {
    NativeNtStatus Status;
    PVOID Pointer;
  };
  ULONG_PTR Information;
};

using NativeNtCreateFile = NativeNtStatus (NTAPI *)(
    PHANDLE,
    ACCESS_MASK,
    NativeObjectAttributes*,
    NativeIoStatusBlock*,
    PLARGE_INTEGER,
    ULONG,
    ULONG,
    ULONG,
    ULONG,
    PVOID,
    ULONG);

using NativeNtSetInformationFile = NativeNtStatus (NTAPI *)(
    HANDLE,
    NativeIoStatusBlock*,
    PVOID,
    ULONG,
    ULONG);

using NativeRtlNtStatusToDosError = ULONG (WINAPI *)(NativeNtStatus);

constexpr ULONG kObjCaseInsensitive = 0x00000040;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;
constexpr ULONG kFileSynchronousIoNonalert = 0x00000020;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
constexpr ULONG kFileRenameInformation = 10;
constexpr ULONG kFileOpen = 1;
constexpr ULONG kFileCreate = 2;
constexpr ULONG_PTR kFileOpened = 1;
constexpr ULONG_PTR kFileCreated = 2;
constexpr DWORD kDirectoryTraversalAccess = FILE_LIST_DIRECTORY
    | FILE_TRAVERSE
    | FILE_READ_ATTRIBUTES
    | READ_CONTROL
    | SYNCHRONIZE;
constexpr DWORD kDirectoryShareMode = FILE_SHARE_READ
    | FILE_SHARE_WRITE
    | FILE_SHARE_DELETE;
constexpr DWORD kCredentialMutexAccess = READ_CONTROL
    | SYNCHRONIZE
    | MUTEX_MODIFY_STATE;
constexpr DWORD kReportPublicationMutexAccess = READ_CONTROL
    | SYNCHRONIZE
    | MUTEX_MODIFY_STATE;
constexpr NativeNtStatus kStatusObjectNameNotFound = static_cast<NativeNtStatus>(0xC0000034L);
constexpr NativeNtStatus kStatusObjectPathNotFound = static_cast<NativeNtStatus>(0xC000003AL);
constexpr NativeNtStatus kStatusObjectNameCollision = static_cast<NativeNtStatus>(0xC0000035L);
constexpr NativeNtStatus kStatusAccessDenied = static_cast<NativeNtStatus>(0xC0000022L);
constexpr NativeNtStatus kStatusSharingViolation = static_cast<NativeNtStatus>(0xC0000043L);
constexpr NativeNtStatus kStatusNotADirectory = static_cast<NativeNtStatus>(0xC0000103L);
constexpr NativeNtStatus kStatusObjectTypeMismatch = static_cast<NativeNtStatus>(0xC0000024L);
constexpr NativeNtStatus kStatusReparsePointEncountered = static_cast<NativeNtStatus>(0xC000050BL);

NativeNtCreateFile ResolveNtCreateFile() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  return ntdll == nullptr
      ? nullptr
      : reinterpret_cast<NativeNtCreateFile>(GetProcAddress(ntdll, "NtCreateFile"));
}

NativeNtSetInformationFile ResolveNtSetInformationFile() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  return ntdll == nullptr
      ? nullptr
      : reinterpret_cast<NativeNtSetInformationFile>(
          GetProcAddress(ntdll, "NtSetInformationFile"));
}

DWORD NativeStatusToWin32(NativeNtStatus status) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll != nullptr) {
    const auto convert = reinterpret_cast<NativeRtlNtStatusToDosError>(
        GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    if (convert != nullptr) {
      const ULONG result = convert(status);
      if (result != ERROR_MR_MID_NOT_FOUND) return result;
    }
  }
  switch (status) {
    case kStatusObjectNameNotFound:
    case kStatusObjectPathNotFound:
      return ERROR_FILE_NOT_FOUND;
    case kStatusObjectNameCollision:
      return ERROR_FILE_EXISTS;
    case kStatusAccessDenied:
      return ERROR_ACCESS_DENIED;
    case kStatusSharingViolation:
      return ERROR_SHARING_VIOLATION;
    case kStatusNotADirectory:
    case kStatusObjectTypeMismatch:
      return ERROR_DIRECTORY;
    case kStatusReparsePointEncountered:
      return ERROR_CANT_ACCESS_FILE;
    default:
      return ERROR_GEN_FAILURE;
  }
}

struct Failure {
  const char* code;
  const char* detail = nullptr;
  const char* stage = nullptr;
};

Failure InvalidConfiguration() { return {"INVALID_CONFIGURATION"}; }
Failure InvalidPath() { return {"INVALID_PATH"}; }
Failure NotFound() { return {"NOT_FOUND"}; }
Failure AlreadyExists() { return {"ALREADY_EXISTS"}; }
Failure AccessDenied() { return {"ACCESS_DENIED"}; }
Failure ReparsePoint() { return {"REPARSE_POINT"}; }
Failure HardLink() { return {"HARD_LINK"}; }
Failure SecurityPolicy(const char* detail = "unspecified") {
  return {"SECURITY_POLICY", detail};
}
Failure NotDirectory() { return {"NOT_DIRECTORY"}; }
Failure NotRegularFile() { return {"NOT_REGULAR_FILE"}; }
Failure TooLarge() { return {"FILE_TOO_LARGE"}; }
Failure IdentityMismatch() { return {"IDENTITY_MISMATCH"}; }
Failure OperationFailed() { return {"OPERATION_FAILED"}; }
Failure ReportPublishMutexContended() { return {"REPORT_PUBLISH_MUTEX_CONTENDED"}; }
Failure ReportPublishMutexAbandoned() { return {"REPORT_PUBLISH_MUTEX_ABANDONED"}; }
Failure ReportPublishMutexReleaseFailed() { return {"REPORT_PUBLISH_MUTEX_RELEASE_FAILED"}; }
Failure ReportPublishStageCleanupFailed() { return {"REPORT_PUBLISH_STAGE_CLEANUP_FAILED"}; }
Failure ReportPublishUncertain() {
  return {"REPORT_PUBLISH_COMMIT_UNCERTAIN", nullptr, "commit_uncertain"};
}
Failure CredentialMutexInvalidCapability() { return {"CREDENTIAL_MUTEX_INVALID_CAPABILITY"}; }
Failure CredentialMutexContended() { return {"CREDENTIAL_MUTEX_CONTENDED"}; }
Failure CredentialMutexAbandoned() { return {"CREDENTIAL_MUTEX_ABANDONED"}; }
Failure CredentialMutexReleaseFailed() { return {"CREDENTIAL_MUTEX_RELEASE_FAILED"}; }
Failure CredentialMutexForeign() { return {"CREDENTIAL_MUTEX_FOREIGN"}; }
Failure AccountlessInstallationCredentialMutexContended() {
  return {"ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_CONTENDED"};
}
Failure AccountlessInstallationCredentialMutexReleaseFailed() {
  return {"ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_RELEASE_FAILED"};
}
Failure AccountlessInstallationCredentialMutexForeign() {
  return {"ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_FOREIGN"};
}
Failure CredentialAuditGuardReleaseFailed() {
  return {"CREDENTIAL_AUDIT_GUARD_RELEASE_FAILED"};
}
Failure CredentialAuditGuardForeign() { return {"CREDENTIAL_AUDIT_GUARD_FOREIGN"}; }

bool IsNotFoundError(DWORD error) {
  return error == ERROR_FILE_NOT_FOUND
      || error == ERROR_PATH_NOT_FOUND
      || error == ERROR_INVALID_DRIVE;
}

Failure FromLastError(DWORD error = GetLastError()) {
  if (IsNotFoundError(error)) return NotFound();
  if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
    return AlreadyExists();
  }
  if (error == ERROR_ACCESS_DENIED
      || error == ERROR_SHARING_VIOLATION
      || error == ERROR_LOCK_VIOLATION
      || error == ERROR_WRITE_PROTECT) {
    return AccessDenied();
  }
  if (error == ERROR_DIRECTORY) return NotDirectory();
  if (error == ERROR_CANT_ACCESS_FILE) return ReparsePoint();
  return OperationFailed();
}

napi_value ThrowFailure(napi_env env, Failure failure) {
  napi_value message;
  napi_value error;
  napi_value code;
  napi_create_string_utf8(env, "Windows filesystem operation failed", NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &error);
  std::string publicCode = "WINDOWS_FILESYSTEM_";
  publicCode.append(failure.code);
  napi_create_string_utf8(env, publicCode.c_str(), NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, error, "code", code);
  if (failure.detail != nullptr) {
    napi_value detail;
    napi_create_string_utf8(env, failure.detail, NAPI_AUTO_LENGTH, &detail);
    napi_set_named_property(env, error, "securityPolicyReason", detail);
  }
  if (failure.stage != nullptr) {
    napi_value stage;
    napi_create_string_utf8(env, failure.stage, NAPI_AUTO_LENGTH, &stage);
    napi_set_named_property(env, error, "windowsFilesystemStage", stage);
  }
  napi_throw(env, error);
  return nullptr;
}

bool GetString(napi_env env, napi_value value, std::wstring* result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  std::size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char16_t> buffer(length + 1, 0);
  if (napi_get_value_string_utf16(
          env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  result->assign(reinterpret_cast<const wchar_t*>(buffer.data()), length);
  return true;
}

bool GetBuffer(napi_env env, napi_value value, const std::uint8_t** bytes, std::size_t* length) {
  bool isBuffer = false;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer) return false;
  void* data = nullptr;
  if (napi_get_buffer_info(env, value, &data, length) != napi_ok) return false;
  *bytes = static_cast<const std::uint8_t*>(data);
  return true;
}

bool GetUint32(napi_env env, napi_value value, std::uint32_t* result) {
  std::uint32_t candidate = 0;
  if (napi_get_value_uint32(env, value, &candidate) != napi_ok) return false;
  *result = candidate;
  return true;
}

bool GetNamedString(napi_env env, napi_value object, const char* name, std::string* result) {
  napi_value value;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok || !present) return false;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1, 0);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  result->assign(buffer.data(), length);
  return true;
}

bool GetNamedUint32(napi_env env, napi_value object, const char* name, std::uint32_t* result) {
  napi_value value;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok || !present) return false;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  return GetUint32(env, value, result);
}

struct ParsedPath {
  std::wstring root;
  std::vector<std::wstring> components;
};

struct ParsedRelativePath {
  std::vector<std::wstring> components;
};

bool IsDriveLetter(wchar_t value) {
  return (value >= L'A' && value <= L'Z') || (value >= L'a' && value <= L'z');
}

bool EqualInsensitive(const std::wstring& left, const wchar_t* right) {
  if (left.size() != std::wcslen(right)) return false;
  for (std::size_t i = 0; i < left.size(); ++i) {
    if (std::towlower(left[i]) != std::towlower(right[i])) return false;
  }
  return true;
}

bool IsReservedDeviceName(const std::wstring& component) {
  std::wstring base = component;
  const std::size_t dot = base.find(L'.');
  if (dot != std::wstring::npos) base.resize(dot);
  return EqualInsensitive(base, L"CON")
      || EqualInsensitive(base, L"PRN")
      || EqualInsensitive(base, L"AUX")
      || EqualInsensitive(base, L"NUL")
      || EqualInsensitive(base, L"COM1")
      || EqualInsensitive(base, L"COM2")
      || EqualInsensitive(base, L"COM3")
      || EqualInsensitive(base, L"COM4")
      || EqualInsensitive(base, L"COM5")
      || EqualInsensitive(base, L"COM6")
      || EqualInsensitive(base, L"COM7")
      || EqualInsensitive(base, L"COM8")
      || EqualInsensitive(base, L"COM9")
      || EqualInsensitive(base, L"LPT1")
      || EqualInsensitive(base, L"LPT2")
      || EqualInsensitive(base, L"LPT3")
      || EqualInsensitive(base, L"LPT4")
      || EqualInsensitive(base, L"LPT5")
      || EqualInsensitive(base, L"LPT6")
      || EqualInsensitive(base, L"LPT7")
      || EqualInsensitive(base, L"LPT8")
      || EqualInsensitive(base, L"LPT9");
}

bool ParsePath(const std::wstring& supplied, ParsedPath* result) {
  if (supplied.empty() || supplied.find(L'\0') != std::wstring::npos) return false;
  std::wstring path = supplied;
  std::replace(path.begin(), path.end(), L'/', L'\\');

  std::size_t offset = 0;
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0
      || (path.rfind(L"\\\\", 0) == 0 && path.rfind(L"\\\\?\\", 0) != 0)) {
    // Network and device locations are not a private local state root. They
    // fail closed instead of silently accepting a different trust boundary.
    return false;
  }
  if (path.rfind(L"\\\\?\\", 0) == 0) {
    if (path.size() < 7 || !IsDriveLetter(path[4]) || path[5] != L':' || path[6] != L'\\') {
      return false;
    }
    result->root = path.substr(0, 7);
    offset = 7;
  } else {
    if (path.size() < 3 || !IsDriveLetter(path[0]) || path[1] != L':' || path[2] != L'\\') {
      return false;
    }
    result->root = path.substr(0, 3);
    offset = 3;
  }

  while (offset < path.size()) {
    while (offset < path.size() && path[offset] == L'\\') ++offset;
    if (offset >= path.size()) break;
    const std::size_t start = offset;
    while (offset < path.size() && path[offset] != L'\\') ++offset;
    std::wstring component = path.substr(start, offset - start);
    if (component.empty() || component == L"." || component == L".."
        || component.back() == L'.' || component.back() == L' '
        || IsReservedDeviceName(component)
        || component.find_first_of(L"<>:\"|?*") != std::wstring::npos) {
      return false;
    }
    result->components.push_back(std::move(component));
  }
  return !result->components.empty();
}

// Protected-state child operations receive a root identity separately from a
// relative child name.  Parse that name again inside the native boundary: a
// JavaScript lexical check is useful input hygiene, but it must not become the
// authority that decides whether a native operation stays below its held root.
bool ParseRelativePath(const std::wstring& supplied, ParsedRelativePath* result) {
  if (supplied.empty() || supplied.find(L'\0') != std::wstring::npos) return false;
  std::wstring path = supplied;
  std::replace(path.begin(), path.end(), L'/', L'\\');
  if (path.rfind(L"\\\\?\\", 0) == 0
      || path.rfind(L"\\\\", 0) == 0
      || path.front() == L'\\'
      || (path.size() >= 2 && IsDriveLetter(path[0]) && path[1] == L':')) {
    return false;
  }
  std::size_t offset = 0;
  while (offset < path.size()) {
    while (offset < path.size() && path[offset] == L'\\') ++offset;
    if (offset >= path.size()) break;
    const std::size_t start = offset;
    while (offset < path.size() && path[offset] != L'\\') ++offset;
    std::wstring component = path.substr(start, offset - start);
    if (component.empty() || component == L"." || component == L".."
        || component.back() == L'.' || component.back() == L' '
        || IsReservedDeviceName(component)
        || component.find_first_of(L"<>:\"|?*") != std::wstring::npos) {
      return false;
    }
    result->components.push_back(std::move(component));
  }
  return !result->components.empty();
}

std::wstring JoinComponent(const std::wstring& parent, const std::wstring& component) {
  if (!parent.empty() && parent.back() == L'\\') return parent + component;
  return parent + L"\\" + component;
}

bool GetFileAttributesFromHandle(HANDLE handle, DWORD* attributes) {
  FILE_BASIC_INFO basic{};
  if (GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) {
    *attributes = static_cast<DWORD>(basic.FileAttributes);
    return true;
  }
  BY_HANDLE_FILE_INFORMATION legacy{};
  if (!GetFileInformationByHandle(handle, &legacy)) return false;
  *attributes = legacy.dwFileAttributes;
  return true;
}

struct HandleIdentity {
  std::uint64_t volumeSerialNumber = 0;
  std::array<BYTE, 16> fileId{};
  std::uint32_t linkCount = 0;
  bool directory = false;
};

bool GetIdentity(HANDLE handle, HandleIdentity* identity) {
  FILE_ID_INFO fileId{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &fileId, sizeof(fileId))) return false;
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))) return false;
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(handle, &attributes)) return false;
  identity->volumeSerialNumber = fileId.VolumeSerialNumber;
  std::memcpy(identity->fileId.data(), fileId.FileId.Identifier, identity->fileId.size());
  identity->linkCount = standard.NumberOfLinks;
  identity->directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return true;
}

std::string HexIdentity(const HandleIdentity& identity) {
  std::ostringstream stream;
  stream << std::hex << std::setfill('0');
  for (BYTE byte : identity.fileId) stream << std::setw(2) << static_cast<unsigned int>(byte);
  return stream.str();
}

bool EqualIdentity(const HandleIdentity& left, const HandleIdentity& right) {
  return left.volumeSerialNumber == right.volumeSerialNumber
      && std::equal(left.fileId.begin(), left.fileId.end(), right.fileId.begin());
}

bool GetCurrentUserSid(std::vector<BYTE>* sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (size == 0) {
    CloseHandle(token);
    return false;
  }
  std::vector<BYTE> buffer(size);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) {
    CloseHandle(token);
    return false;
  }
  const TOKEN_USER* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  const DWORD sidLength = GetLengthSid(user->User.Sid);
  const auto* sidBytes = static_cast<const BYTE*>(user->User.Sid);
  sid->assign(sidBytes, sidBytes + sidLength);
  CloseHandle(token);
  return true;
}

bool IsSidEqual(PSID left, PSID right) {
  return left != nullptr && right != nullptr && IsValidSid(left) && IsValidSid(right)
      && EqualSid(left, right) != FALSE;
}

bool IsBroadSid(PSID sid) {
  BYTE worldBuffer[SECURITY_MAX_SID_SIZE];
  DWORD worldSize = sizeof(worldBuffer);
  if (CreateWellKnownSid(WinWorldSid, nullptr, worldBuffer, &worldSize)
      && IsSidEqual(sid, worldBuffer)) return true;
  BYTE authBuffer[SECURITY_MAX_SID_SIZE];
  DWORD authSize = sizeof(authBuffer);
  if (CreateWellKnownSid(WinAuthenticatedUserSid, nullptr, authBuffer, &authSize)
      && IsSidEqual(sid, authBuffer)) return true;
  BYTE usersBuffer[SECURITY_MAX_SID_SIZE];
  DWORD usersSize = sizeof(usersBuffer);
  if (CreateWellKnownSid(WinBuiltinUsersSid, nullptr, usersBuffer, &usersSize)
      && IsSidEqual(sid, usersBuffer)) return true;
  return false;
}

struct SecuritySnapshot {
  bool ownerMatches = false;
  bool nullDacl = true;
  bool daclProtected = false;
  bool broadAccess = false;
  bool nonOwnerAllow = false;
  bool unrecognizedAce = false;
  bool denyAce = false;
  DWORD ownerAllowAceCount = 0;
  DWORD ownerAllowMask = 0;
};

bool ReadObjectSecurity(
    HANDLE handle,
    SE_OBJECT_TYPE objectType,
    SecuritySnapshot* snapshot) {
  std::vector<BYTE> currentSid;
  if (!GetCurrentUserSid(&currentSid)) return false;
  PSID ownerSid = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(
      handle,
      objectType,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &ownerSid,
      nullptr,
      &dacl,
      nullptr,
      &descriptor);
  if (result != ERROR_SUCCESS) return false;

  snapshot->ownerMatches = IsSidEqual(ownerSid, currentSid.data());
  snapshot->nullDacl = dacl == nullptr;
  SECURITY_DESCRIPTOR_CONTROL descriptorControl = 0;
  DWORD descriptorRevision = 0;
  if (!GetSecurityDescriptorControl(
          descriptor,
          &descriptorControl,
          &descriptorRevision)) {
    LocalFree(descriptor);
    return false;
  }
  snapshot->daclProtected = (descriptorControl & SE_DACL_PROTECTED) != 0;
  if (dacl != nullptr) {
    ACL_SIZE_INFORMATION size{};
    if (!GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation)) {
      LocalFree(descriptor);
      return false;
    }
    for (DWORD index = 0; index < size.AceCount; ++index) {
      void* rawAce = nullptr;
      if (!GetAce(dacl, index, &rawAce)) {
        LocalFree(descriptor);
        return false;
      }
      const ACE_HEADER* header = static_cast<const ACE_HEADER*>(rawAce);
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE
          && header->AceType != ACCESS_ALLOWED_OBJECT_ACE_TYPE
          && header->AceType != ACCESS_DENIED_ACE_TYPE
          && header->AceType != ACCESS_DENIED_OBJECT_ACE_TYPE) {
        snapshot->unrecognizedAce = true;
        continue;
      }
      if (header->AceType == ACCESS_DENIED_ACE_TYPE
          || header->AceType == ACCESS_DENIED_OBJECT_ACE_TYPE) {
        snapshot->denyAce = true;
        continue;
      }
      PSID aceSid = nullptr;
      DWORD sidOffset = 0;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        sidOffset = FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
        if (header->AceSize < sidOffset + 8) {
          snapshot->unrecognizedAce = true;
          continue;
        }
        auto* allowedAce = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        aceSid = static_cast<PSID>(&allowedAce->SidStart);
      } else {
        const auto* objectAce = static_cast<const ACCESS_ALLOWED_OBJECT_ACE*>(rawAce);
        if (header->AceSize
            < FIELD_OFFSET(ACCESS_ALLOWED_OBJECT_ACE, Flags) + sizeof(objectAce->Flags)) {
          snapshot->unrecognizedAce = true;
          continue;
        }
        // The SID begins at ObjectType's offset when no GUID is present; the
        // structure's SidStart placeholder is not a safe base for variable
        // length object ACEs.
        sidOffset = FIELD_OFFSET(ACCESS_ALLOWED_OBJECT_ACE, ObjectType);
        if ((objectAce->Flags & ACE_OBJECT_TYPE_PRESENT) != 0) sidOffset += sizeof(GUID);
        if ((objectAce->Flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) != 0) sidOffset += sizeof(GUID);
        if (header->AceSize < sidOffset + 8) {
          snapshot->unrecognizedAce = true;
          continue;
        }
        aceSid = reinterpret_cast<PSID>(reinterpret_cast<BYTE*>(rawAce) + sidOffset);
      }
      if (!IsValidSid(aceSid)
          || sidOffset > header->AceSize
          || GetLengthSid(aceSid) > header->AceSize - sidOffset) {
        snapshot->unrecognizedAce = true;
        continue;
      }
      if (IsBroadSid(aceSid)) snapshot->broadAccess = true;
      if (!IsSidEqual(aceSid, currentSid.data())) {
        snapshot->nonOwnerAllow = true;
      } else if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        const auto* allowedAce = static_cast<const ACCESS_ALLOWED_ACE*>(rawAce);
        snapshot->ownerAllowAceCount += 1;
        snapshot->ownerAllowMask |= allowedAce->Mask;
      }
    }
  }
  LocalFree(descriptor);
  return true;
}

bool ReadSecurity(HANDLE handle, SecuritySnapshot* snapshot) {
  return ReadObjectSecurity(handle, SE_FILE_OBJECT, snapshot);
}

bool IsOwnerOnlySecurityForAccess(
    const SecuritySnapshot& descriptor,
    DWORD accessMask) {
  return descriptor.ownerMatches
      && !descriptor.nullDacl
      && descriptor.daclProtected
      && !descriptor.broadAccess
      && !descriptor.nonOwnerAllow
      && !descriptor.unrecognizedAce
      && !descriptor.denyAce
      && descriptor.ownerAllowAceCount == 1
      && descriptor.ownerAllowMask == accessMask;
}

bool IsOwnerOnlySecurity(const SecuritySnapshot& descriptor) {
  return IsOwnerOnlySecurityForAccess(descriptor, kCredentialMutexAccess);
}

bool HasReparsePoint(HANDLE handle, bool* result) {
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(handle, &attributes)) return false;
  *result = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  return true;
}

std::wstring ExpectedPath(const ParsedPath& parsed) {
  std::wstring result = parsed.root;
  for (const auto& component : parsed.components) result = JoinComponent(result, component);
  return result;
}

std::wstring ComparablePath(std::wstring value) {
  std::replace(value.begin(), value.end(), L'/', L'\\');
  if (value.rfind(L"\\\\?\\", 0) == 0) value.erase(0, 4);
  while (value.size() > 3 && value.back() == L'\\') value.pop_back();
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return std::towlower(character);
  });
  return value;
}

std::wstring CanonicalExpectedPath(const ParsedPath& parsed) {
  const std::wstring expected = ExpectedPath(parsed);
  DWORD size = MAX_PATH;
  for (int attempt = 0; attempt < 8; ++attempt) {
    std::vector<wchar_t> buffer(size, L'\0');
    const DWORD length = GetLongPathNameW(
        expected.c_str(),
        buffer.data(),
        static_cast<DWORD>(buffer.size()));
    if (length == 0) return {};
    // GetLongPathNameW returns the required length when the supplied buffer
    // is too small.  A spare element is retained for the NUL terminator.
    if (length + 1 < buffer.size()) return std::wstring(buffer.data(), length);
    size = length + 1;
  }
  return {};
}

bool ResolveFinalPath(HANDLE handle, const ParsedPath* parsed = nullptr) {
  DWORD size = 256;
  std::vector<wchar_t> buffer(size);
  for (int attempt = 0; attempt < 4; ++attempt) {
    const DWORD length = GetFinalPathNameByHandleW(
        handle,
        buffer.data(),
        static_cast<DWORD>(buffer.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0) return false;
    if (length < buffer.size()) {
      if (parsed == nullptr) return true;
      const std::wstring observed(buffer.data(), length);
      const std::wstring expected = CanonicalExpectedPath(*parsed);
      return !expected.empty() && ComparablePath(observed) == ComparablePath(expected);
    }
    buffer.resize(length + 1);
  }
  return false;
}

// Forward declaration: newly-created objects are passed an owner-only
// descriptor at creation and are re-applied through the handle before the
// operation returns.  The declaration keeps the handle-relative walker near
// the NT API declarations while the descriptor builder remains below it.
bool SetOwnerOnlyDacl(HANDLE handle);
bool MarkHandleForDeletion(HANDLE handle);

struct RelativeHandles {
  std::vector<HANDLE> parents;
  HANDLE final = INVALID_HANDLE_VALUE;

  ~RelativeHandles() {
    if (final != INVALID_HANDLE_VALUE) CloseHandle(final);
    for (auto iterator = parents.rbegin(); iterator != parents.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
  }

  HANDLE releaseFinal() {
    for (auto iterator = parents.rbegin(); iterator != parents.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
    parents.clear();
    const HANDLE result = final;
    final = INVALID_HANDLE_VALUE;
    return result;
  }

  void closeFinal() {
    if (final != INVALID_HANDLE_VALUE) CloseHandle(final);
    final = INVALID_HANDLE_VALUE;
  }
};

struct ScopedHandle {
  HANDLE handle = INVALID_HANDLE_VALUE;

  ~ScopedHandle() {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }

  HANDLE release() {
    const HANDLE result = handle;
    handle = INVALID_HANDLE_VALUE;
    return result;
  }
};

bool OpenRootDirectory(
    const std::wstring& root,
    HANDLE* result,
    Failure* failure) {
  *result = CreateFileW(
      root.c_str(),
      kDirectoryTraversalAccess,
      kDirectoryShareMode,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr);
  if (*result == INVALID_HANDLE_VALUE) {
    *failure = FromLastError();
    return false;
  }
  bool reparse = false;
  DWORD attributes = 0;
  if (!GetFileAttributesFromHandle(*result, &attributes)
      || !HasReparsePoint(*result, &reparse)) {
    CloseHandle(*result);
    *result = INVALID_HANDLE_VALUE;
    *failure = OperationFailed();
    return false;
  }
  if (reparse || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(*result);
    *result = INVALID_HANDLE_VALUE;
    *failure = reparse ? ReparsePoint() : NotDirectory();
    return false;
  }
  return true;
}

bool OpenRelativeComponent(
    HANDLE parent,
    const std::wstring& component,
    DWORD access,
    DWORD shareMode,
    ULONG disposition,
    ULONG createOptions,
    PSECURITY_DESCRIPTOR securityDescriptor,
    HANDLE* result,
    ULONG_PTR* information,
    Failure* failure,
    bool synchronous = true) {
  if (component.empty()
      || component.size() > static_cast<std::size_t>(USHRT_MAX / sizeof(wchar_t))) {
    *failure = InvalidPath();
    return false;
  }
  const auto createFile = ResolveNtCreateFile();
  if (createFile == nullptr) {
    *failure = OperationFailed();
    return false;
  }
  NativeUnicodeString name{};
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  name.Buffer = const_cast<PWSTR>(component.c_str());
  NativeObjectAttributes objectAttributes{};
  objectAttributes.Length = sizeof(objectAttributes);
  objectAttributes.RootDirectory = parent;
  objectAttributes.ObjectName = &name;
  // The owner-repair metadata open cannot ask for READ_ATTRIBUTES. Fail in
  // the kernel if that component itself is a reparse point instead.
  objectAttributes.Attributes = kObjCaseInsensitive | (synchronous ? 0 : 0x00001000 /* OBJ_DONT_REPARSE */);
  objectAttributes.SecurityDescriptor = securityDescriptor;
  NativeIoStatusBlock ioStatus{};
  const NativeNtStatus status = createFile(
      result,
      access,
      &objectAttributes,
      &ioStatus,
      nullptr,
      FILE_ATTRIBUTE_NORMAL,
      shareMode,
      disposition,
      createOptions | kFileOpenReparsePoint | (synchronous ? kFileSynchronousIoNonalert : 0),
      nullptr,
      0);
  if (status < 0 || *result == nullptr || *result == INVALID_HANDLE_VALUE) {
    SetLastError(NativeStatusToWin32(status));
    *failure = FromLastError();
    *result = INVALID_HANDLE_VALUE;
    return false;
  }
  if (information != nullptr) *information = ioStatus.Information;
  return true;
}

struct OpenRelativeOptions {
  bool finalMayBeMissing = false;
  bool finalDirectoryKnown = false;
  bool finalDirectory = false;
  bool ownerOnlyOnCreate = false;
  DWORD access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  DWORD shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  std::size_t protectedAncestorDepth = 0;
  DWORD protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  ULONG disposition = kFileOpen;
  ULONG extraOptions = 0;
  PSECURITY_DESCRIPTOR securityDescriptor = nullptr;
};

bool OpenRelativeComponents(
    HANDLE startingParent,
    const std::vector<std::wstring>& components,
    const OpenRelativeOptions& options,
    RelativeHandles* opened,
    bool* finalMissing,
    Failure* failure) {
  *finalMissing = false;
  if (startingParent == INVALID_HANDLE_VALUE || components.empty()) {
    *failure = InvalidPath();
    return false;
  }
  HANDLE current = startingParent;
  for (std::size_t index = 0; index < components.size(); ++index) {
    const bool final = index + 1 == components.size();
    const ULONG typeOption = !final
        ? kFileDirectoryFile
        : options.finalDirectoryKnown
          ? (options.finalDirectory ? kFileDirectoryFile : kFileNonDirectoryFile)
          : 0;
    // Intermediate components are always opened as existing directories with
    // directory-only access.  In particular, never reuse a final-file
    // disposition (CREATE_NEW/OPEN_IF) or final-file sharing policy while
    // traversing ancestors.  Creation of missing directories is a separate
    // parent-handle operation in EnsureDirectoryCallback below.
    const DWORD access = final ? options.access : kDirectoryTraversalAccess;
    const std::size_t remainingComponents = components.size() - index - 1;
    const bool protectedAncestor = !final
        && options.protectedAncestorDepth > 0
        && remainingComponents <= options.protectedAncestorDepth;
    const DWORD shareMode = final
        ? options.shareMode
        : protectedAncestor
          ? options.protectedAncestorShareMode
          : kDirectoryShareMode;
    const ULONG disposition = final ? options.disposition : kFileOpen;
    const PSECURITY_DESCRIPTOR securityDescriptor = final
        ? options.securityDescriptor
        : nullptr;
    HANDLE next = INVALID_HANDLE_VALUE;
    ULONG_PTR information = 0;
    if (!OpenRelativeComponent(
            current,
            components[index],
            access,
            shareMode,
            disposition,
            (final ? options.extraOptions : 0) | typeOption,
            securityDescriptor,
            &next,
            &information,
            failure)) {
      if (final && options.finalMayBeMissing && failure->code == NotFound().code) {
        *finalMissing = true;
        return true;
      }
      return false;
    }
    const bool created = information == kFileCreated;
    const auto rejectCreated = [&](Failure reason) -> bool {
      if (created && !MarkHandleForDeletion(next)) {
        *failure = OperationFailed();
      } else {
        *failure = reason;
      }
      CloseHandle(next);
      return false;
    };
    bool reparse = false;
    DWORD attributes = 0;
    if (!GetFileAttributesFromHandle(next, &attributes)
        || !HasReparsePoint(next, &reparse)) {
      return rejectCreated(OperationFailed());
    }
    if (reparse) {
      return rejectCreated(ReparsePoint());
    }
    if (!final && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      return rejectCreated(NotDirectory());
    }
    if (final && options.finalDirectoryKnown
        && (((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != options.finalDirectory)) {
      return rejectCreated(options.finalDirectory ? NotDirectory() : NotRegularFile());
    }
    if (final && options.ownerOnlyOnCreate && created
        && !SetOwnerOnlyDacl(next)) {
      return rejectCreated(SecurityPolicy("dacl_update_failed"));
    }
    if (final) {
      opened->final = next;
      return true;
    }
    opened->parents.push_back(next);
    current = next;
  }
  *failure = InvalidPath();
  return false;
}

bool OpenRelativePath(
    const ParsedPath& parsed,
    const OpenRelativeOptions& options,
    RelativeHandles* opened,
    bool* finalMissing,
    Failure* failure) {
  HANDLE root = INVALID_HANDLE_VALUE;
  if (!OpenRootDirectory(parsed.root, &root, failure)) return false;
  opened->parents.push_back(root);
  return OpenRelativeComponents(
      root,
      parsed.components,
      options,
      opened,
      finalMissing,
      failure);
}

bool ParseAndValidatePath(
    const std::wstring& path,
    bool /*finalMayBeMissing*/,
    ParsedPath* parsed,
    Failure* failure) {
  if (!ParsePath(path, parsed)) {
    *failure = InvalidPath();
    return false;
  }
  // Component validation is performed while each component is opened
  // relative to the already-open parent handle.  There is intentionally no
  // path-based preflight here: a separate validation pass would recreate the
  // ancestor replacement race this binding exists to prevent.
  return true;
}

bool ValidateSecurity(
    HANDLE handle,
    bool directory,
    Failure* failure,
    HandleIdentity* identity = nullptr,
    SecuritySnapshot* security = nullptr) {
  bool reparse = false;
  if (!HasReparsePoint(handle, &reparse)) {
    *failure = OperationFailed();
    return false;
  }
  if (reparse) {
    *failure = ReparsePoint();
    return false;
  }
  HandleIdentity observed;
  if (!GetIdentity(handle, &observed)) {
    *failure = OperationFailed();
    return false;
  }
  if (observed.directory != directory) {
    *failure = directory ? NotDirectory() : NotRegularFile();
    return false;
  }
  if (!directory && observed.linkCount != 1) {
    *failure = HardLink();
    return false;
  }
  SecuritySnapshot descriptor;
  if (!ReadSecurity(handle, &descriptor)) {
    *failure = OperationFailed();
    return false;
  }
  if (!descriptor.ownerMatches) {
    *failure = SecurityPolicy("owner_mismatch");
    return false;
  }
  if (descriptor.nullDacl) {
    *failure = SecurityPolicy("null_dacl");
    return false;
  }
  if (!descriptor.daclProtected) {
    *failure = SecurityPolicy("dacl_not_protected");
    return false;
  }
  if (descriptor.broadAccess) {
    *failure = SecurityPolicy("broad_access");
    return false;
  }
  if (descriptor.nonOwnerAllow) {
    *failure = SecurityPolicy("non_owner_allow");
    return false;
  }
  if (descriptor.unrecognizedAce) {
    *failure = SecurityPolicy("unrecognized_ace");
    return false;
  }
  if (identity != nullptr) *identity = observed;
  if (security != nullptr) *security = descriptor;
  return true;
}

bool BuildOwnerOnlyObjectSecurity(
    DWORD accessMask,
    std::vector<BYTE>* ownerSid,
    PACL* acl,
    PSECURITY_DESCRIPTOR* descriptor,
    SECURITY_ATTRIBUTES* attributes,
    DWORD inheritance = NO_INHERITANCE) {
  if (!GetCurrentUserSid(ownerSid)) return false;
  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = accessMask;
  entry.grfAccessMode = SET_ACCESS;
  entry.grfInheritance = inheritance;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
  entry.Trustee.ptstrName = reinterpret_cast<LPWSTR>(ownerSid->data());
  if (SetEntriesInAclW(1, &entry, nullptr, acl) != ERROR_SUCCESS) return false;
  *descriptor = static_cast<PSECURITY_DESCRIPTOR>(LocalAlloc(LPTR, SECURITY_DESCRIPTOR_MIN_LENGTH));
  if (*descriptor == nullptr) {
    LocalFree(*acl);
    *acl = nullptr;
    return false;
  }
  if (!InitializeSecurityDescriptor(*descriptor, SECURITY_DESCRIPTOR_REVISION)
      || !SetSecurityDescriptorOwner(*descriptor, ownerSid->data(), FALSE)
      || !SetSecurityDescriptorDacl(*descriptor, TRUE, *acl, FALSE)
      || !SetSecurityDescriptorControl(
          *descriptor,
          SE_DACL_PROTECTED,
          SE_DACL_PROTECTED)) {
    LocalFree(*descriptor);
    LocalFree(*acl);
    *descriptor = nullptr;
    *acl = nullptr;
    return false;
  }
  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = *descriptor;
  attributes->bInheritHandle = FALSE;
  return true;
}

bool BuildOwnerOnlySecurity(
    std::vector<BYTE>* ownerSid,
    PACL* acl,
    PSECURITY_DESCRIPTOR* descriptor,
    SECURITY_ATTRIBUTES* attributes) {
  return BuildOwnerOnlyObjectSecurity(
      FILE_ALL_ACCESS,
      ownerSid,
      acl,
      descriptor,
      attributes);
}

void FreeOwnerOnlySecurity(PACL acl, PSECURITY_DESCRIPTOR descriptor) {
  if (descriptor != nullptr) LocalFree(descriptor);
  if (acl != nullptr) LocalFree(acl);
}

bool SetOwnerOnlyDacl(HANDLE handle) {
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) return false;
  const DWORD result = SetSecurityInfo(
      handle,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      acl,
      nullptr);
  FreeOwnerOnlySecurity(acl, descriptor);
  return result == ERROR_SUCCESS;
}

napi_value IdentityValue(napi_env env, const HandleIdentity& identity) {
  napi_value object;
  napi_value volume;
  napi_value fileId;
  napi_value links;
  napi_create_object(env, &object);
  std::ostringstream volumeText;
  volumeText << std::hex << std::setfill('0') << std::setw(16) << identity.volumeSerialNumber;
  napi_create_string_utf8(env, volumeText.str().c_str(), NAPI_AUTO_LENGTH, &volume);
  napi_create_string_utf8(env, HexIdentity(identity).c_str(), NAPI_AUTO_LENGTH, &fileId);
  napi_create_uint32(env, identity.linkCount, &links);
  napi_set_named_property(env, object, "volumeSerialNumber", volume);
  napi_set_named_property(env, object, "fileId", fileId);
  napi_set_named_property(env, object, "linkCount", links);
  return object;
}

napi_value MetadataValue(
    napi_env env,
    const HandleIdentity& identity,
    const SecuritySnapshot& security,
    bool finalPathResolved) {
  napi_value result;
  napi_value identityValue;
  napi_value directory;
  napi_value regular;
  napi_value reparse;
  napi_value owner;
  napi_value nullDacl;
  napi_value daclProtected;
  napi_value broad;
  napi_value nonOwner;
  napi_value unrecognized;
  napi_value resolved;
  napi_create_object(env, &result);
  identityValue = IdentityValue(env, identity);
  napi_get_boolean(env, identity.directory, &directory);
  napi_get_boolean(env, !identity.directory, &regular);
  napi_get_boolean(env, false, &reparse);
  napi_get_boolean(env, security.ownerMatches, &owner);
  napi_get_boolean(env, security.nullDacl, &nullDacl);
  napi_get_boolean(env, security.daclProtected, &daclProtected);
  napi_get_boolean(env, security.broadAccess, &broad);
  napi_get_boolean(env, security.nonOwnerAllow, &nonOwner);
  napi_get_boolean(env, security.unrecognizedAce, &unrecognized);
  napi_get_boolean(env, finalPathResolved, &resolved);
  napi_set_named_property(env, result, "identity", identityValue);
  napi_set_named_property(env, result, "isDirectory", directory);
  napi_set_named_property(env, result, "isRegularFile", regular);
  napi_set_named_property(env, result, "isReparsePoint", reparse);
  napi_set_named_property(env, result, "ownerMatches", owner);
  napi_set_named_property(env, result, "nullDacl", nullDacl);
  napi_set_named_property(env, result, "daclProtected", daclProtected);
  napi_set_named_property(env, result, "broadAccess", broad);
  napi_set_named_property(env, result, "nonOwnerAllow", nonOwner);
  napi_set_named_property(env, result, "unrecognizedAce", unrecognized);
  napi_set_named_property(env, result, "finalPathResolved", resolved);
  return result;
}

bool ParseExpectedIdentity(napi_env env, napi_value value, HandleIdentity* identity) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
  std::string volumeText;
  std::string fileId;
  if (!GetNamedString(env, value, "volumeSerialNumber", &volumeText)
      || !GetNamedString(env, value, "fileId", &fileId)
      || volumeText.size() != 16
      || fileId.size() != 32) return false;
  for (char character : volumeText) {
    if (!std::isxdigit(static_cast<unsigned char>(character))) return false;
  }
  for (char character : fileId) {
    if (!std::isxdigit(static_cast<unsigned char>(character))) return false;
  }
  identity->volumeSerialNumber = std::stoull(volumeText, nullptr, 16);
  identity->linkCount = 1;
  for (std::size_t index = 0; index < identity->fileId.size(); ++index) {
    const std::string byte = fileId.substr(index * 2, 2);
    identity->fileId[index] = static_cast<BYTE>(std::stoul(byte, nullptr, 16));
  }
  return true;
}

bool GetArguments(
    napi_env env,
    napi_callback_info info,
    std::vector<napi_value>* arguments,
    std::size_t expected) {
  // The protected child replacement primitive has five fixed arguments. Keep
  // this capacity explicit so an oversized callback cannot silently truncate
  // its native inputs.
  std::array<napi_value, 5> values{};
  std::size_t count = values.size();
  if (napi_get_cb_info(env, info, &count, values.data(), nullptr, nullptr) != napi_ok
      || count != expected) {
    return false;
  }
  arguments->assign(values.begin(), values.begin() + count);
  return true;
}

bool OpenSecureExisting(
    const std::wstring& path,
    bool directory,
    DWORD access,
    DWORD shareMode,
    HANDLE* handle,
    HandleIdentity* identity,
    Failure* failure,
    SecuritySnapshot* security = nullptr) {
  ParsedPath parsed;
  if (!ParseAndValidatePath(path, false, &parsed, failure)) return false;
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = directory;
  options.access = access;
  options.shareMode = shareMode;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, options, &opened, &finalMissing, failure)
      || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return false;
  }
  if (!ValidateSecurity(opened.final, directory, failure, identity, security)) {
    return false;
  }
  if (!ResolveFinalPath(opened.final, &parsed)) {
    *failure = OperationFailed();
    return false;
  }
  *handle = opened.releaseFinal();
  return true;
}

bool ReadHandleBounded(
    HANDLE handle,
    std::size_t maximumBytes,
    std::vector<std::uint8_t>* bytes,
    Failure* failure) {
  if (maximumBytes == 0 || maximumBytes > kMaximumFileBytes) {
    *failure = InvalidConfiguration();
    return false;
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0
      || static_cast<unsigned long long>(size.QuadPart) > maximumBytes) {
    *failure = size.QuadPart > static_cast<LONGLONG>(maximumBytes)
        ? TooLarge() : OperationFailed();
    return false;
  }
  // The requested bound is checked against the handle's current size before
  // allocating the result vector. This is the native authority for protected
  // state reads; JavaScript performs only a second defensive check.
  bytes->assign(static_cast<std::size_t>(size.QuadPart), 0);
  std::size_t offset = 0;
  while (offset < bytes->size()) {
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(bytes->size() - offset, 1 << 20));
    DWORD read = 0;
    if (!ReadFile(handle, bytes->data() + offset, requested, &read, nullptr)) {
      *failure = FromLastError();
      return false;
    }
    if (read == 0) {
      *failure = OperationFailed();
      return false;
    }
    offset += read;
  }
  return true;
}

bool VerifyHandleBytes(
    HANDLE handle,
    const std::uint8_t* expected,
    std::size_t expectedBytes,
    Failure* failure) {
  if (handle == INVALID_HANDLE_VALUE
      || (expected == nullptr && expectedBytes != 0)
      || expectedBytes > kMaximumReportBytes) {
    *failure = InvalidConfiguration();
    return false;
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size)
      || size.QuadPart < 0
      || static_cast<unsigned long long>(size.QuadPart) != expectedBytes) {
    *failure = OperationFailed();
    return false;
  }
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(handle, beginning, nullptr, FILE_BEGIN)) {
    *failure = FromLastError();
    return false;
  }
  std::array<std::uint8_t, 64 * 1024> buffer{};
  std::size_t offset = 0;
  while (offset < expectedBytes) {
    const DWORD requested = static_cast<DWORD>(
        std::min<std::size_t>(expectedBytes - offset, buffer.size()));
    DWORD read = 0;
    if (!ReadFile(handle, buffer.data(), requested, &read, nullptr)) {
      *failure = FromLastError();
      return false;
    }
    if (read == 0
        || !std::equal(
            buffer.begin(),
            buffer.begin() + read,
            expected + offset)) {
      *failure = OperationFailed();
      return false;
    }
    offset += read;
  }
  return true;
}

bool ReadHandle(HANDLE handle, std::vector<std::uint8_t>* bytes, Failure* failure) {
  return ReadHandleBounded(handle, kMaximumFileBytes, bytes, failure);
}

// Open one child below an authenticated root.  The caller supplies the root
// identity it observed before starting the operation.  We resolve that root
// once, compare the identity while its handle is held, then resolve every
// child component relative to that exact handle.  Subsequent string-path
// changes cannot redirect the child operation outside this root object.
bool OpenRootBoundChild(
    const std::wstring& rootPath,
    const HandleIdentity& expectedRoot,
    const std::wstring& childPath,
    const OpenRelativeOptions& options,
    ScopedHandle* root,
    ParsedRelativePath* parsed,
    RelativeHandles* opened,
    Failure* failure) {
  if (root == nullptr || parsed == nullptr || opened == nullptr
      || root->handle != INVALID_HANDLE_VALUE) {
    *failure = InvalidConfiguration();
    return false;
  }
  if (!ParseRelativePath(childPath, parsed)) {
    *failure = InvalidPath();
    return false;
  }
  HandleIdentity observedRoot;
  if (!OpenSecureExisting(
          rootPath,
          true,
          kDirectoryTraversalAccess,
          kDirectoryShareMode,
          &root->handle,
          &observedRoot,
          failure)) {
    return false;
  }
  if (!EqualIdentity(observedRoot, expectedRoot)) {
    *failure = IdentityMismatch();
    return false;
  }
  bool finalMissing = false;
  if (!OpenRelativeComponents(
          root->handle,
          parsed->components,
          options,
          opened,
          &finalMissing,
          failure)) {
    return false;
  }
  if (finalMissing || opened->final == INVALID_HANDLE_VALUE) {
    *failure = NotFound();
    return false;
  }
  return true;
}

bool MarkHandleForDeletion(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  return SetFileInformationByHandle(
      handle,
      FileDispositionInfo,
      &disposition,
      sizeof(disposition)) != FALSE;
}

bool WriteAndFlushHandle(
    HANDLE handle,
    const std::uint8_t* bytes,
    std::size_t byteCount,
    Failure* failure) {
  std::size_t offset = 0;
  while (offset < byteCount) {
    const DWORD requested = static_cast<DWORD>(
        std::min<std::size_t>(byteCount - offset, 1 << 20));
    DWORD written = 0;
    if (!WriteFile(handle, bytes + offset, requested, &written, nullptr)
        || written == 0) {
      *failure = FromLastError();
      return false;
    }
    offset += written;
  }
  if (!FlushFileBuffers(handle)) {
    *failure = FromLastError();
    return false;
  }
  return true;
}

struct NativeFileRenameInformation {
  BOOLEAN replaceIfExists;
  HANDLE rootDirectory;
  ULONG fileNameLength;
  WCHAR fileName[1];
};

bool RenameHandleRelative(
    HANDLE handle,
    HANDLE parent,
    const std::wstring& target,
    bool replaceIfExists,
    Failure* failure) {
  if (target.empty()
      || target.size() > static_cast<std::size_t>(ULONG_MAX / sizeof(wchar_t))) {
    *failure = InvalidPath();
    return false;
  }
  const auto setInformation = ResolveNtSetInformationFile();
  if (setInformation == nullptr) {
    *failure = OperationFailed();
    return false;
  }
  const std::size_t bytes = target.size() * sizeof(wchar_t);
  const std::size_t headerBytes = offsetof(NativeFileRenameInformation, fileName);
  std::vector<BYTE> buffer(headerBytes + bytes, 0);
  auto* information = reinterpret_cast<NativeFileRenameInformation*>(buffer.data());
  information->replaceIfExists = replaceIfExists ? TRUE : FALSE;
  information->rootDirectory = parent;
  information->fileNameLength = static_cast<ULONG>(bytes);
  std::memcpy(information->fileName, target.data(), bytes);
  NativeIoStatusBlock ioStatus{};
  const NativeNtStatus status = setInformation(
      handle,
      &ioStatus,
      information,
      static_cast<ULONG>(buffer.size()),
      kFileRenameInformation);
  if (status < 0) {
    SetLastError(NativeStatusToWin32(status));
    *failure = FromLastError();
    failure->stage = "rename";
    return false;
  }
  return true;
}

std::wstring TemporaryReplacementName() {
  static std::atomic<unsigned long> sequence{0};
  const unsigned long serial = sequence.fetch_add(1, std::memory_order_relaxed);
  std::wstringstream stream;
  stream << L".usagemonitor-rotation-"
         << GetCurrentProcessId()
         << L'-'
         << GetTickCount64()
         << L'-'
         << serial
         << L".tmp";
  return stream.str();
}

// Replace an already-open file through its held parent directory.  Both the
// ordinary path API and the protected-child API use this implementation so the
// latter does not fall back to a path reopen after it has authenticated its
// root handle. `target` is cleared only when this routine closes it immediately
// before the final rename; its owner can then safely retain normal cleanup on
// every earlier failure path.
bool ReplaceOpenFile(
    HANDLE* target,
    HANDLE parent,
    const std::wstring& targetName,
    const HandleIdentity& expected,
    const std::uint8_t* bytes,
    std::size_t byteCount,
    const ParsedPath* expectedPath,
    HandleIdentity* result,
    Failure* failure) {
  if (target == nullptr || *target == INVALID_HANDLE_VALUE
      || parent == INVALID_HANDLE_VALUE || targetName.empty()
      || (bytes == nullptr && byteCount != 0) || byteCount > kMaximumFileBytes) {
    *failure = InvalidConfiguration();
    return false;
  }
  HandleIdentity current;
  if (!ValidateSecurity(*target, false, failure, &current)
      || !EqualIdentity(current, expected)) {
    if (failure->code == OperationFailed().code) *failure = IdentityMismatch();
    return false;
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    *failure = OperationFailed();
    return false;
  }
  HANDLE replacement = INVALID_HANDLE_VALUE;
  std::wstring temporaryName;
  ULONG_PTR createInformation = 0;
  for (int attempt = 0; attempt < 8; ++attempt) {
    temporaryName = TemporaryReplacementName();
    if (OpenRelativeComponent(
            parent,
            temporaryName,
            FILE_READ_DATA | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
                | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
            kFileCreate,
            kFileNonDirectoryFile,
            attributes.lpSecurityDescriptor,
            &replacement,
            &createInformation,
            failure)) {
      break;
    }
    if (failure->code != AlreadyExists().code) {
      FreeOwnerOnlySecurity(acl, descriptor);
      return false;
    }
  }
  FreeOwnerOnlySecurity(acl, descriptor);
  if (replacement == INVALID_HANDLE_VALUE) {
    *failure = AlreadyExists();
    return false;
  }

  bool renamed = false;
  bool success = WriteAndFlushHandle(replacement, bytes, byteCount, failure)
      && SetOwnerOnlyDacl(replacement);
  HandleIdentity replacementIdentity;
  if (success && !ValidateSecurity(replacement, false, failure, &replacementIdentity)) {
    success = false;
  }
  if (success) {
    // Re-open the destination relative to the still-held parent immediately
    // before rename. This closes ordinary application races; a hostile
    // same-user process can still swap the name in the final syscall window,
    // which is why this binding remains productionSafe=false.
    HANDLE check = INVALID_HANDLE_VALUE;
    ULONG_PTR checkInformation = 0;
    if (!OpenRelativeComponent(
            parent,
            targetName,
            DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            kFileOpen,
            kFileNonDirectoryFile,
            nullptr,
            &check,
            &checkInformation,
            failure)) {
      success = false;
    } else {
      HandleIdentity checkIdentity;
      success = ValidateSecurity(check, false, failure, &checkIdentity)
          && EqualIdentity(checkIdentity, expected);
      if (!success && failure->code == OperationFailed().code) *failure = IdentityMismatch();
      CloseHandle(check);
    }
  }
  if (success) {
    // Legacy FileRenameInformation rejects replacement while the destination
    // has an open handle, even when that handle shares delete access. Keep the
    // identity-bound handles through the final check, then close both before
    // rename. The residual same-user swap window is why productionSafe=false.
    CloseHandle(*target);
    *target = INVALID_HANDLE_VALUE;
    for (int attempt = 0; attempt < 8; ++attempt) {
      success = RenameHandleRelative(replacement, parent, targetName, true, failure);
      renamed = success;
      if (success) break;
      const DWORD renameError = GetLastError();
      if (renameError != ERROR_ACCESS_DENIED && renameError != ERROR_SHARING_VIOLATION) break;
      // Transient external readers can reject legacy NT rename even when
      // they share delete access. Retry only this uncommitted rename, using
      // the same flushed temporary handle, after rechecking the ORIGINAL
      // destination identity/security against the still-held parent. Never
      // replay a completed write or guess an uncertain post-rename result.
      if (attempt == 7) break;
      Sleep(static_cast<DWORD>(10 * (attempt + 1)));
      HANDLE check = INVALID_HANDLE_VALUE; ULONG_PTR information = 0;
      if (!OpenRelativeComponent(parent, targetName,
          READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen,
          kFileNonDirectoryFile, nullptr, &check, &information, failure)) break;
      HandleIdentity observed;
      const bool valid = ValidateSecurity(check, false, failure, &observed);
      CloseHandle(check);
      if (!valid) break;
      if (!EqualIdentity(observed, expected)) {
        if (EqualIdentity(observed, replacementIdentity)) {
          // Preserve potentially applied bytes; no automatic success or delete.
          renamed = true; *failure = OperationFailed(); failure->stage = "rename_result_uncertain";
        } else *failure = IdentityMismatch();
        break;
      }
    }
    if (success && !FlushFileBuffers(replacement)) {
      *failure = FromLastError();
      success = false;
    }
  }
  if (success) {
    // The replacement handle remains valid after rename. Verify both content
    // and the name-to-handle identity before exposing the new identity.
    std::vector<std::uint8_t> persisted;
    LARGE_INTEGER beginning{};
    success = SetFilePointerEx(replacement, beginning, nullptr, FILE_BEGIN) != FALSE
        && ReadHandle(replacement, &persisted, failure)
        && persisted.size() == byteCount
        && std::equal(persisted.begin(), persisted.end(), bytes);
    if (success) {
      HANDLE check = INVALID_HANDLE_VALUE;
      ULONG_PTR checkInformation = 0;
      if (!OpenRelativeComponent(
              parent,
              targetName,
              READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
              kFileOpen,
              kFileNonDirectoryFile,
              nullptr,
              &check,
              &checkInformation,
              failure)) {
        success = false;
      } else {
        HandleIdentity checkIdentity;
        success = ValidateSecurity(check, false, failure, &checkIdentity)
            && EqualIdentity(checkIdentity, replacementIdentity)
            && ResolveFinalPath(check, expectedPath);
        if (!success && failure->code == OperationFailed().code) *failure = IdentityMismatch();
        CloseHandle(check);
      }
    }
  }
  if (!success && !renamed && !MarkHandleForDeletion(replacement)) *failure = OperationFailed();
  CloseHandle(replacement);
  if (!success) return false;
  *result = replacementIdentity;
  return true;
}

napi_value ReplaceFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  HandleIdentity expected;
  if (!GetString(env, arguments[0], &path)
      || !ParseExpectedIdentity(env, arguments[1], &expected)
      || !GetBuffer(env, arguments[2], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) return ThrowFailure(env, failure);

  // Open the target and every ancestor relative to a held parent handle.  A
  // later rename therefore operates in the same directory object rather than
  // resolving the target path again from the process current namespace.
  RelativeHandles opened;
  OpenRelativeOptions targetOptions;
  targetOptions.finalDirectoryKnown = true;
  targetOptions.finalDirectory = false;
  targetOptions.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  targetOptions.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  targetOptions.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, targetOptions, &opened, &finalMissing, &failure)
      || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  if (opened.parents.empty()) return ThrowFailure(env, OperationFailed());
  HANDLE parent = opened.parents.back();
  HandleIdentity replacementIdentity;
  if (!ReplaceOpenFile(
          &opened.final,
          parent,
          parsed.components.back(),
          expected,
          bytes,
          byteCount,
          &parsed,
          &replacementIdentity,
          &failure)) return ThrowFailure(env, failure);
  return IdentityValue(env, replacementIdentity);
}

napi_value InspectPathCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) return ThrowFailure(env, failure);
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, options, &opened, &finalMissing, &failure)
      || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  bool valid = GetIdentity(opened.final, &identity)
      && ReadSecurity(opened.final, &security)
      && ResolveFinalPath(opened.final, &parsed);
  bool reparse = false;
  if (!HasReparsePoint(opened.final, &reparse)) valid = false;
  if (!valid) return ThrowFailure(env, OperationFailed());
  napi_value result = MetadataValue(env, identity, security, true);
  napi_value isReparse;
  napi_get_boolean(env, reparse, &isReparse);
  napi_set_named_property(env, result, "isReparsePoint", isReparse);
  return result;
}

napi_value ReadFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());
  Failure failure = OperationFailed();
  HANDLE handle = INVALID_HANDLE_VALUE;
  HandleIdentity identity;
  if (!OpenSecureExisting(
          path,
          false,
          GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          &handle,
          &identity,
          &failure)) return ThrowFailure(env, failure);
  std::vector<std::uint8_t> bytes;
  const bool read = ReadHandle(handle, &bytes, &failure);
  CloseHandle(handle);
  if (!read) return ThrowFailure(env, failure);
  napi_value result;
  napi_value data;
  napi_value identityValue = IdentityValue(env, identity);
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &data);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "identity", identityValue);
  return result;
}

struct OwnerOnlySecurityResources {
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};

  ~OwnerOnlySecurityResources() {
    if (descriptor != nullptr) LocalFree(descriptor);
    if (acl != nullptr) LocalFree(acl);
  }

  bool initialize() {
    return BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes);
  }
};

bool EnsureDirectoryPath(
    const ParsedPath& parsed,
    HANDLE* finalHandle,
    HandleIdentity* identity,
    Failure* failure) {
  OwnerOnlySecurityResources security;
  if (!security.initialize()) {
    *failure = OperationFailed();
    return false;
  }
  RelativeHandles opened;
  HANDLE root = INVALID_HANDLE_VALUE;
  if (!OpenRootDirectory(parsed.root, &root, failure)) return false;
  opened.parents.push_back(root);
  HANDLE current = root;

  for (std::size_t index = 0; index < parsed.components.size(); ++index) {
    const bool final = index + 1 == parsed.components.size();
    HANDLE next = INVALID_HANDLE_VALUE;
    bool created = false;
    Failure lastFailure = OperationFailed();

    // Existing ancestors always use the directory-only FILE_OPEN path.  A
    // missing component is created separately, relative to the held parent;
    // this keeps the traversal contract independent from final-object
    // dispositions and avoids applying a file access mask to directories.
    for (int attempt = 0; attempt < 2; ++attempt) {
      ULONG_PTR information = 0;
      if (OpenRelativeComponent(
              current,
              parsed.components[index],
              kDirectoryTraversalAccess,
              kDirectoryShareMode,
              kFileOpen,
              kFileDirectoryFile,
              nullptr,
              &next,
              &information,
              &lastFailure)) {
        created = false;
        break;
      }
      if (lastFailure.code != NotFound().code) {
        *failure = lastFailure;
        return false;
      }

      ULONG_PTR createInformation = 0;
      if (OpenRelativeComponent(
              current,
              parsed.components[index],
              kDirectoryTraversalAccess | WRITE_DAC | DELETE,
              kDirectoryShareMode,
              kFileCreate,
              kFileDirectoryFile,
              security.attributes.lpSecurityDescriptor,
              &next,
              &createInformation,
              &lastFailure)) {
        created = createInformation == kFileCreated;
        break;
      }
      // Another creator may have won the same parent-relative name between
      // our FILE_OPEN and FILE_CREATE calls.  Reopen it with FILE_OPEN and
      // apply the same reparse/type checks below.
      if (lastFailure.code != AlreadyExists().code) {
        *failure = lastFailure;
        return false;
      }
    }
    if (next == INVALID_HANDLE_VALUE) {
      *failure = lastFailure;
      return false;
    }

    DWORD attributes = 0;
    bool reparse = false;
    if (!GetFileAttributesFromHandle(next, &attributes)
        || !HasReparsePoint(next, &reparse)) {
      if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
      else *failure = OperationFailed();
      CloseHandle(next);
      return false;
    }
    if (reparse) {
      if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
      else *failure = ReparsePoint();
      CloseHandle(next);
      return false;
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
      else *failure = NotDirectory();
      CloseHandle(next);
      return false;
    }

    if (created) {
      // The create call requests WRITE_DAC and supplies the protected
      // descriptor.  Reapply and validate through the same handle so a
      // post-create policy failure never leaves an unmanaged directory.
      if (!SetOwnerOnlyDacl(next)) {
        *failure = SecurityPolicy("dacl_update_failed");
        if (!MarkHandleForDeletion(next)) *failure = OperationFailed();
        CloseHandle(next);
        return false;
      }
      if (!ValidateSecurity(next, true, failure, nullptr)) {
        if (!MarkHandleForDeletion(next)) *failure = OperationFailed();
        CloseHandle(next);
        return false;
      }
    }

    if (final) {
      if (!ValidateSecurity(next, true, failure, identity)
          || !ResolveFinalPath(next, &parsed)) {
        if (created && !MarkHandleForDeletion(next)) *failure = OperationFailed();
        else if (failure->code == OperationFailed().code) *failure = OperationFailed();
        CloseHandle(next);
        return false;
      }
      opened.final = next;
      *finalHandle = opened.releaseFinal();
      return *finalHandle != INVALID_HANDLE_VALUE;
    }
    opened.parents.push_back(next);
    current = next;
  }
  *failure = InvalidPath();
  return false;
}

struct ScopedReportPublicationMutex {
  HANDLE handle = nullptr;
  bool owned = false;

  ~ScopedReportPublicationMutex() {
    release();
  }

  bool release() {
    if (handle == nullptr) return true;
    bool success = true;
    if (owned) {
      success = ReleaseMutex(handle) != FALSE;
      if (success) owned = false;
    }
    CloseHandle(handle);
    handle = nullptr;
    return success;
  }
};

bool ReportPublicationMutexName(
    const HandleIdentity& parentIdentity,
    std::wstring* name) {
  std::vector<BYTE> ownerSid;
  if (!GetCurrentUserSid(&ownerSid)) return false;
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(ownerSid.data(), &sidText) || sidText == nullptr) {
    return false;
  }
  const std::string fileId = HexIdentity(parentIdentity);
  std::wstringstream stream;
  stream << L"Local\\UsageMonitor-ReportPublication-v1-"
         << sidText
         << L'-'
         << std::hex
         << parentIdentity.volumeSerialNumber
         << L'-'
         << std::wstring(fileId.begin(), fileId.end());
  *name = stream.str();
  LocalFree(sidText);
  return true;
}

bool AcquireReportPublicationMutex(
    const HandleIdentity& parentIdentity,
    ScopedReportPublicationMutex* mutex,
    Failure* failure) {
  if (mutex == nullptr || mutex->handle != nullptr) {
    *failure = InvalidConfiguration();
    return false;
  }
  std::wstring name;
  if (!ReportPublicationMutexName(parentIdentity, &name)) {
    *failure = OperationFailed();
    return false;
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(
          kReportPublicationMutexAccess,
          &ownerSid,
          &acl,
          &descriptor,
          &attributes)) {
    *failure = OperationFailed();
    return false;
  }
  HANDLE handle = CreateMutexExW(
      &attributes,
      name.c_str(),
      0,
      kReportPublicationMutexAccess);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (handle == nullptr) {
    *failure = FromLastError();
    return false;
  }

  SecuritySnapshot security;
  if (!ReadObjectSecurity(handle, SE_KERNEL_OBJECT, &security)
      || !IsOwnerOnlySecurityForAccess(security, kReportPublicationMutexAccess)) {
    CloseHandle(handle);
    *failure = SecurityPolicy("report_publication_mutex_security");
    return false;
  }

  const DWORD waitResult = WaitForSingleObject(
      handle,
      kReportPublicationMutexWaitMilliseconds);
  if (waitResult == WAIT_ABANDONED_0) {
    const bool released = ReleaseMutex(handle) != FALSE;
    CloseHandle(handle);
    *failure = released
        ? ReportPublishMutexAbandoned()
        : ReportPublishMutexReleaseFailed();
    return false;
  }
  if (waitResult != WAIT_OBJECT_0) {
    CloseHandle(handle);
    *failure = waitResult == WAIT_TIMEOUT
        ? ReportPublishMutexContended()
        : OperationFailed();
    return false;
  }
  // This mutex is specific to the held parent identity and current owner. It
  // serializes cooperating report writers to this directory only.
  mutex->handle = handle;
  mutex->owned = true;
  return true;
}

std::wstring TemporaryReportPublicationName() {
  static std::atomic<unsigned long> sequence{0};
  const unsigned long serial = sequence.fetch_add(1, std::memory_order_relaxed);
  std::wstringstream stream;
  stream << L".usagemonitor-report-"
         << GetCurrentProcessId()
         << L'-'
         << GetTickCount64()
         << L'-'
         << serial
         << L".tmp";
  return stream.str();
}

bool OpenReportParentDirectory(
    const ParsedPath& outputPath,
    ParsedPath* parentPath,
    std::wstring* outputName,
    HandleIdentity* parentIdentity,
    RelativeHandles* openedParent,
    Failure* failure) {
  if (parentPath == nullptr || outputName == nullptr || parentIdentity == nullptr
      || openedParent == nullptr
      || outputPath.components.empty()) {
    *failure = InvalidPath();
    return false;
  }
  *parentPath = outputPath;
  *outputName = parentPath->components.back();
  parentPath->components.pop_back();
  // A volume root is not an owner-private report directory. Requiring at
  // least one path component also prevents publishing directly into C:\.
  if (parentPath->components.empty()) {
    *failure = SecurityPolicy("report_parent_not_private");
    return false;
  }

  HANDLE ensured = INVALID_HANDLE_VALUE;
  HandleIdentity ensuredIdentity;
  if (!EnsureDirectoryPath(*parentPath, &ensured, &ensuredIdentity, failure)) {
    return false;
  }
  CloseHandle(ensured);

  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = true;
  options.access = kDirectoryTraversalAccess | FILE_ADD_FILE | FILE_DELETE_CHILD;
  // Keep every path component pinned through the publication so ordinary
  // rename/delete operations cannot move the selected parent mid-write.
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.protectedAncestorDepth = parentPath->components.size();
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(
          *parentPath,
          options,
          openedParent,
          &finalMissing,
          failure)
      || finalMissing
      || openedParent->final == INVALID_HANDLE_VALUE) {
    return false;
  }

  HandleIdentity observedIdentity;
  SecuritySnapshot security;
  if (!ValidateSecurity(
          openedParent->final,
          true,
          failure,
          &observedIdentity,
          &security)) {
    return false;
  }
  if (!EqualIdentity(observedIdentity, ensuredIdentity)) {
    *failure = IdentityMismatch();
    return false;
  }
  if (security.denyAce || security.ownerAllowAceCount == 0) {
    *failure = SecurityPolicy("report_parent_security");
    return false;
  }
  if (!ResolveFinalPath(openedParent->final, parentPath)) {
    *failure = OperationFailed();
    return false;
  }
  *parentIdentity = observedIdentity;
  return true;
}

enum class ReportTargetObservation {
  kMissing,
  kExpected,
  kPublished,
  kOther,
  kUninspectable,
};

ReportTargetObservation ObserveReportTarget(
    HANDLE parent,
    const std::wstring& outputName,
    bool expectedExists,
    const HandleIdentity& expectedIdentity,
    const HandleIdentity& publishedIdentity) {
  ScopedHandle observed;
  ULONG_PTR information = 0;
  Failure failure = OperationFailed();
  if (!OpenRelativeComponent(
          parent,
          outputName,
          READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          kFileOpen,
          0,
          nullptr,
          &observed.handle,
          &information,
          &failure)) {
    return failure.code == NotFound().code
        ? ReportTargetObservation::kMissing
        : ReportTargetObservation::kUninspectable;
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!GetIdentity(observed.handle, &identity)
      || !ValidateSecurity(
          observed.handle,
          identity.directory,
          &failure,
          &identity,
          &security)
      || security.denyAce
      || security.ownerAllowAceCount == 0) {
    return ReportTargetObservation::kUninspectable;
  }
  if (identity.directory) return ReportTargetObservation::kOther;
  if (EqualIdentity(identity, publishedIdentity)) {
    return ReportTargetObservation::kPublished;
  }
  if (expectedExists && EqualIdentity(identity, expectedIdentity)) {
    return ReportTargetObservation::kExpected;
  }
  return ReportTargetObservation::kOther;
}

bool PublishReportInParent(
    const ParsedPath& outputPath,
    const std::wstring& outputName,
    HANDLE parent,
    const std::uint8_t* bytes,
    std::size_t byteCount,
    HandleIdentity* publishedIdentity,
    Failure* failure) {
  if (publishedIdentity == nullptr
      || parent == INVALID_HANDLE_VALUE
      || (bytes == nullptr && byteCount != 0)
      || byteCount > kMaximumReportBytes) {
    *failure = byteCount > kMaximumReportBytes
        ? TooLarge()
        : InvalidConfiguration();
    return false;
  }

  // Snapshot the existing destination identity while holding the dedicated
  // parent-specific report mutex. If absent, the later rename is no-clobber;
  // if present, its identity and security are rechecked before replacement.
  ScopedHandle target;
  HandleIdentity expectedIdentity;
  bool expectedExists = false;
  ULONG_PTR targetInformation = 0;
  if (OpenRelativeComponent(
          parent,
          outputName,
          DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          kFileOpen,
          kFileNonDirectoryFile,
          nullptr,
          &target.handle,
          &targetInformation,
          failure)) {
    SecuritySnapshot targetSecurity;
    if (!ValidateSecurity(
            target.handle,
            false,
            failure,
            &expectedIdentity,
            &targetSecurity)) {
      return false;
    }
    if (targetSecurity.denyAce || targetSecurity.ownerAllowAceCount == 0) {
      *failure = SecurityPolicy("report_target_security");
      return false;
    }
    expectedExists = true;
  } else if (failure->code != NotFound().code) {
    return false;
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    *failure = OperationFailed();
    return false;
  }

  ScopedHandle stage;
  for (int attempt = 0; attempt < 8; ++attempt) {
    const std::wstring stageName = TemporaryReportPublicationName();
    ULONG_PTR createInformation = 0;
    if (OpenRelativeComponent(
            parent,
            stageName,
            FILE_READ_DATA | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
                | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
            kFileCreate,
            kFileNonDirectoryFile,
            attributes.lpSecurityDescriptor,
            &stage.handle,
            &createInformation,
            failure)) {
      if (createInformation != kFileCreated) {
        CloseHandle(stage.handle);
        stage.handle = INVALID_HANDLE_VALUE;
        FreeOwnerOnlySecurity(acl, descriptor);
        *failure = OperationFailed();
        return false;
      }
      break;
    }
    if (failure->code != AlreadyExists().code) {
      FreeOwnerOnlySecurity(acl, descriptor);
      return false;
    }
  }
  FreeOwnerOnlySecurity(acl, descriptor);
  if (stage.handle == INVALID_HANDLE_VALUE) {
    *failure = AlreadyExists();
    return false;
  }

  auto cleanupStage = [&]() {
    if (!MarkHandleForDeletion(stage.handle)) {
      *failure = ReportPublishStageCleanupFailed();
    }
    return false;
  };

  if (!SetOwnerOnlyDacl(stage.handle)) {
    *failure = SecurityPolicy("report_stage_dacl");
    return cleanupStage();
  }
  HandleIdentity stageIdentity;
  SecuritySnapshot stageSecurity;
  if (!ValidateSecurity(
          stage.handle,
          false,
          failure,
          &stageIdentity,
          &stageSecurity)) {
    return cleanupStage();
  }
  if (stageSecurity.denyAce || stageSecurity.ownerAllowAceCount == 0) {
    *failure = SecurityPolicy("report_stage_security");
    return cleanupStage();
  }
  if (!WriteAndFlushHandle(stage.handle, bytes, byteCount, failure)) {
    return cleanupStage();
  }
  HandleIdentity writtenIdentity;
  SecuritySnapshot writtenSecurity;
  if (!ValidateSecurity(
          stage.handle,
          false,
          failure,
          &writtenIdentity,
          &writtenSecurity)) {
    return cleanupStage();
  }
  if (!EqualIdentity(stageIdentity, writtenIdentity)
      || writtenSecurity.denyAce
      || writtenSecurity.ownerAllowAceCount == 0) {
    *failure = IdentityMismatch();
    return cleanupStage();
  }
  *publishedIdentity = stageIdentity;

  if (expectedExists) {
    ScopedHandle finalCheck;
    ULONG_PTR checkInformation = 0;
    if (!OpenRelativeComponent(
            parent,
            outputName,
            READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            kFileOpen,
            kFileNonDirectoryFile,
            nullptr,
            &finalCheck.handle,
            &checkInformation,
            failure)) {
      *failure = failure->code == NotFound().code
          ? IdentityMismatch()
          : *failure;
      return cleanupStage();
    }
    HandleIdentity currentIdentity;
    SecuritySnapshot currentSecurity;
    if (!ValidateSecurity(
            finalCheck.handle,
            false,
            failure,
            &currentIdentity,
            &currentSecurity)) {
      return cleanupStage();
    }
    if (currentSecurity.denyAce || currentSecurity.ownerAllowAceCount == 0) {
      *failure = SecurityPolicy("report_target_security");
      return cleanupStage();
    }
    if (!EqualIdentity(currentIdentity, expectedIdentity)) {
      *failure = IdentityMismatch();
      return cleanupStage();
    }
    CloseHandle(finalCheck.handle);
    finalCheck.handle = INVALID_HANDLE_VALUE;
    CloseHandle(target.handle);
    target.handle = INVALID_HANDLE_VALUE;
  }

  bool committed = false;
  for (int attempt = 0; attempt < 8; ++attempt) {
    if (RenameHandleRelative(
            stage.handle,
            parent,
            outputName,
            expectedExists,
            failure)) {
      committed = true;
      break;
    }

    const DWORD renameError = GetLastError();
    const ReportTargetObservation observed = ObserveReportTarget(
        parent,
        outputName,
        expectedExists,
        expectedIdentity,
        *publishedIdentity);
    if (observed == ReportTargetObservation::kPublished) {
      committed = true;
      *failure = ReportPublishUncertain();
      return false;
    }
    const bool expectedStillNamed = expectedExists
        ? observed == ReportTargetObservation::kExpected
        : observed == ReportTargetObservation::kMissing;
    if (!expectedStillNamed) {
      if (observed == ReportTargetObservation::kOther) {
        const bool definiteNoClobberCollision = !expectedExists
            && (renameError == ERROR_ALREADY_EXISTS
                || renameError == ERROR_FILE_EXISTS);
        if (definiteNoClobberCollision) {
          *failure = AlreadyExists();
          return cleanupStage();
        }
        // A changed destination after an attempted rename could be a hostile
        // same-owner swap after commit. Preserve the stage rather than risk
        // deleting a file that may already have been published.
        *failure = ReportPublishUncertain();
        return false;
      }
      // If the final name cannot be inspected, the rename's commit state is
      // unknowable. Keep the held stage handle intact: it may now be the
      // published destination, and deleting it would risk deleting the report.
      *failure = ReportPublishUncertain();
      return false;
    }

    if ((renameError != ERROR_ACCESS_DENIED
            && renameError != ERROR_SHARING_VIOLATION)
        || attempt == 7) {
      return cleanupStage();
    }
    Sleep(static_cast<DWORD>(10 * (attempt + 1)));
  }

  if (!committed) {
    return cleanupStage();
  }

  // The rename has committed. Any subsequent failure is uncertain from the
  // caller's perspective, but the replacement handle must never be marked for
  // deletion because it now identifies the published file.
  if (!FlushFileBuffers(stage.handle)) {
    *failure = ReportPublishUncertain();
    return false;
  }
  if (!VerifyHandleBytes(stage.handle, bytes, byteCount, failure)) {
    *failure = ReportPublishUncertain();
    return false;
  }

  ScopedHandle publishedName;
  ULONG_PTR publishedInformation = 0;
  if (!OpenRelativeComponent(
          parent,
          outputName,
          READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          kFileOpen,
          kFileNonDirectoryFile,
          nullptr,
          &publishedName.handle,
          &publishedInformation,
          failure)) {
    *failure = ReportPublishUncertain();
    return false;
  }
  HandleIdentity finalIdentity;
  SecuritySnapshot finalSecurity;
  if (!ValidateSecurity(
          publishedName.handle,
          false,
          failure,
          &finalIdentity,
          &finalSecurity)
      || finalSecurity.denyAce
      || finalSecurity.ownerAllowAceCount == 0
      || !EqualIdentity(finalIdentity, *publishedIdentity)
      || !ResolveFinalPath(publishedName.handle, &outputPath)) {
    *failure = ReportPublishUncertain();
    return false;
  }
  return true;
}

bool PublishReportFile(
    const ParsedPath& outputPath,
    const std::uint8_t* bytes,
    std::size_t byteCount,
    HandleIdentity* publishedIdentity,
    Failure* failure) {
  if (publishedIdentity == nullptr
      || (bytes == nullptr && byteCount != 0)
      || byteCount > kMaximumReportBytes) {
    *failure = byteCount > kMaximumReportBytes
        ? TooLarge()
        : InvalidConfiguration();
    return false;
  }
  ParsedPath parentPath;
  std::wstring outputName;
  HandleIdentity parentIdentity;
  RelativeHandles openedParent;
  if (!OpenReportParentDirectory(
          outputPath,
          &parentPath,
          &outputName,
          &parentIdentity,
          &openedParent,
          failure)) {
    return false;
  }

  ScopedReportPublicationMutex mutex;
  if (!AcquireReportPublicationMutex(parentIdentity, &mutex, failure)) {
    return false;
  }
  const bool published = PublishReportInParent(
      outputPath,
      outputName,
      openedParent.final,
      bytes,
      byteCount,
      publishedIdentity,
      failure);
  if (!mutex.release() && published) {
    *failure = ReportPublishMutexReleaseFailed();
    return false;
  }
  return published;
}

napi_value PublishReportCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 2)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype pathType = napi_undefined;
  std::size_t pathLength = 0;
  if (napi_typeof(env, arguments[0], &pathType) != napi_ok
      || pathType != napi_string
      || napi_get_value_string_utf16(
          env,
          arguments[0],
          nullptr,
          0,
          &pathLength) != napi_ok) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  if (pathLength > 32767) return ThrowFailure(env, InvalidPath());

  std::wstring path;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!GetString(env, arguments[0], &path)
      || path.empty()
      || path.back() == L'\\'
      || path.back() == L'/'
      || !GetBuffer(env, arguments[1], &bytes, &byteCount)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  if (byteCount > kMaximumReportBytes) return ThrowFailure(env, TooLarge());

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) {
    return ThrowFailure(env, failure);
  }
  std::wstring driveRoot = parsed.root;
  if (driveRoot.rfind(L"\\\\?\\", 0) == 0) driveRoot.erase(0, 4);
  if (GetDriveTypeW(driveRoot.c_str()) != DRIVE_FIXED) {
    return ThrowFailure(env, SecurityPolicy("report_volume_not_fixed"));
  }
  if (parsed.components.size() > kMaximumReportPathComponents) {
    return ThrowFailure(env, InvalidPath());
  }

  HandleIdentity identity;
  const bool published = PublishReportFile(
      parsed,
      bytes,
      byteCount,
      &identity,
      &failure);
  if (!published) return ThrowFailure(env, failure);
  return IdentityValue(env, identity);
}

napi_value EnsureDirectoryCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());
  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParsePath(path, &parsed)) return ThrowFailure(env, InvalidPath());
  HANDLE finalHandle = INVALID_HANDLE_VALUE;
  HandleIdentity identity;
  if (!EnsureDirectoryPath(parsed, &finalHandle, &identity, &failure)) {
    return ThrowFailure(env, failure);
  }
  CloseHandle(finalHandle);
  return IdentityValue(env, identity);
}

napi_value CreateFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 2)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!GetString(env, arguments[0], &path)
      || !GetBuffer(env, arguments[1], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) return ThrowFailure(env, InvalidConfiguration());

  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, true, &parsed, &failure)) return ThrowFailure(env, failure);
  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlySecurity(&ownerSid, &acl, &descriptor, &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
      | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.disposition = kFileCreate;
  options.ownerOnlyOnCreate = true;
  options.securityDescriptor = attributes.lpSecurityDescriptor;
  bool finalMissing = false;
  const bool openedOk = OpenRelativePath(parsed, options, &opened, &finalMissing, &failure);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (!openedOk || finalMissing || opened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HANDLE handle = opened.releaseFinal();
  if (handle == INVALID_HANDLE_VALUE) return ThrowFailure(env, OperationFailed());
  bool success = true;
  std::size_t offset = 0;
  while (offset < byteCount) {
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(byteCount - offset, 1 << 20));
    DWORD written = 0;
    if (!WriteFile(handle, bytes + offset, requested, &written, nullptr) || written == 0) {
      success = false;
      failure = FromLastError();
      break;
    }
    offset += written;
  }
  HandleIdentity identity;
  if (success && !FlushFileBuffers(handle)) {
    success = false;
    failure = FromLastError();
  }
  if (success && !SetOwnerOnlyDacl(handle)) {
    success = false;
    failure = SecurityPolicy("dacl_update_failed");
  }
  if (success && !ValidateSecurity(handle, false, &failure, &identity)) success = false;
  if (!success && !MarkHandleForDeletion(handle)) {
    failure = OperationFailed();
  }
  CloseHandle(handle);
  if (!success) return ThrowFailure(env, failure);

  HANDLE reopened = INVALID_HANDLE_VALUE;
  HandleIdentity reopenedIdentity;
  if (!OpenSecureExisting(
          path,
          false,
          GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          &reopened,
          &reopenedIdentity,
          &failure)) return ThrowFailure(env, failure);
  CloseHandle(reopened);
  if (!EqualIdentity(identity, reopenedIdentity)) return ThrowFailure(env, IdentityMismatch());
  return IdentityValue(env, reopenedIdentity);
}

napi_value DeleteFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 2)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring path;
  HandleIdentity expected;
  if (!GetString(env, arguments[0], &path)
      || !ParseExpectedIdentity(env, arguments[1], &expected)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  Failure failure = OperationFailed();
  HANDLE handle = INVALID_HANDLE_VALUE;
  HandleIdentity current;
  if (!OpenSecureExisting(
          path,
          false,
          DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          &handle,
          &current,
          &failure)) return ThrowFailure(env, failure);
  if (!EqualIdentity(expected, current)) {
    CloseHandle(handle);
    return ThrowFailure(env, IdentityMismatch());
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition))) {
    failure = FromLastError();
    CloseHandle(handle);
    return ThrowFailure(env, failure);
  }
  CloseHandle(handle);
  napi_value result;
  napi_value deleted;
  napi_value identityValue = IdentityValue(env, current);
  napi_create_object(env, &result);
  napi_get_boolean(env, true, &deleted);
  napi_set_named_property(env, result, "deleted", deleted);
  napi_set_named_property(env, result, "identity", identityValue);
  return result;
}

// These root-bound child callbacks are used by the protected state store.
// They deliberately receive the root identity on every operation rather than
// caching a path-derived decision in JavaScript.  OpenRootBoundChild validates
// that identity and then walks only below the held root handle.
napi_value InspectProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 3)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &childPath)) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  options.disposition = kFileOpen;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &root,
          &parsed,
          &opened,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!ValidateSecurity(opened.final, false, &failure, &identity, &security)
      || !ResolveFinalPath(opened.final)) {
    return ThrowFailure(env, failure);
  }
  return MetadataValue(env, identity, security, true);
}

napi_value ReadProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  std::uint32_t maximumBytes = 0;
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &childPath)
      || !GetUint32(env, arguments[3], &maximumBytes)
      || maximumBytes == 0
      || maximumBytes > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.disposition = kFileOpen;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &root,
          &parsed,
          &opened,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  if (!ValidateSecurity(opened.final, false, &failure, &identity)) {
    return ThrowFailure(env, failure);
  }
  std::vector<std::uint8_t> bytes;
  if (!ReadHandleBounded(opened.final, maximumBytes, &bytes, &failure)) {
    return ThrowFailure(env, failure);
  }
  napi_value result;
  napi_value data;
  napi_create_object(env, &result);
  napi_create_buffer_copy(
      env,
      bytes.size(),
      bytes.empty() ? nullptr : bytes.data(),
      nullptr,
      &data);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value CreateProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &childPath)
      || !GetBuffer(env, arguments[3], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  OwnerOnlySecurityResources security;
  if (!security.initialize()) return ThrowFailure(env, OperationFailed());
  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC
      | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.disposition = kFileCreate;
  options.ownerOnlyOnCreate = true;
  options.securityDescriptor = security.attributes.lpSecurityDescriptor;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &root,
          &parsed,
          &opened,
          &failure)) {
    return ThrowFailure(env, failure);
  }

  HANDLE created = opened.releaseFinal();
  if (created == INVALID_HANDLE_VALUE) return ThrowFailure(env, OperationFailed());
  HandleIdentity createdIdentity;
  bool success = WriteAndFlushHandle(created, bytes, byteCount, &failure)
      && SetOwnerOnlyDacl(created)
      && ValidateSecurity(created, false, &failure, &createdIdentity);
  if (!success && !MarkHandleForDeletion(created)) failure = OperationFailed();
  CloseHandle(created);
  if (!success) return ThrowFailure(env, failure);

  // Confirm that the newly-created identity is still the child of the same
  // held root.  This never re-resolves rootPath after the authenticated root
  // handle has been acquired.
  RelativeHandles reopened;
  OpenRelativeOptions verifyOptions;
  verifyOptions.finalDirectoryKnown = true;
  verifyOptions.finalDirectory = false;
  verifyOptions.access = GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  verifyOptions.shareMode = FILE_SHARE_READ;
  verifyOptions.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativeComponents(
          root.handle,
          parsed.components,
          verifyOptions,
          &reopened,
          &finalMissing,
          &failure)
      || finalMissing
      || reopened.final == INVALID_HANDLE_VALUE) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity reopenedIdentity;
  if (!ValidateSecurity(reopened.final, false, &failure, &reopenedIdentity)
      || !ResolveFinalPath(reopened.final)) {
    return ThrowFailure(env, failure);
  }
  if (!EqualIdentity(createdIdentity, reopenedIdentity)) {
    return ThrowFailure(env, IdentityMismatch());
  }
  return IdentityValue(env, reopenedIdentity);
}

napi_value DeleteProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 4)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  HandleIdentity expectedChild;
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &childPath)
      || !ParseExpectedIdentity(env, arguments[3], &expectedChild)) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.disposition = kFileOpen;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &root,
          &parsed,
          &opened,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity current;
  if (!ValidateSecurity(opened.final, false, &failure, &current)) {
    return ThrowFailure(env, failure);
  }
  if (!EqualIdentity(current, expectedChild)) {
    return ThrowFailure(env, IdentityMismatch());
  }
  if (!MarkHandleForDeletion(opened.final)) {
    return ThrowFailure(env, FromLastError());
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_value deleted;
  napi_get_boolean(env, true, &deleted);
  napi_set_named_property(env, result, "deleted", deleted);
  napi_set_named_property(env, result, "identity", IdentityValue(env, current));
  return result;
}

napi_value ReplaceProtectedChildCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 5)) return ThrowFailure(env, InvalidConfiguration());
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  HandleIdentity expectedChild;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
  if (!GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &childPath)
      || !ParseExpectedIdentity(env, arguments[3], &expectedChild)
      || !GetBuffer(env, arguments[4], &bytes, &byteCount)
      || byteCount > kMaximumFileBytes) {
    return ThrowFailure(env, InvalidConfiguration());
  }

  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  options.disposition = kFileOpen;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(
          rootPath,
          expectedRoot,
          childPath,
          options,
          &root,
          &parsed,
          &opened,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  const HANDLE parent = opened.parents.empty() ? root.handle : opened.parents.back();
  HandleIdentity replacementIdentity;
  if (!ReplaceOpenFile(
          &opened.final,
          parent,
          parsed.components.back(),
          expectedChild,
          bytes,
          byteCount,
          nullptr,
          &replacementIdentity,
          &failure)) {
    return ThrowFailure(env, failure);
  }
  return IdentityValue(env, replacementIdentity);
}

struct CredentialAuditFileGuard {
  std::vector<HANDLE> handles;
  bool active = false;
  bool sourceFile = false;
  bool directoryGuard = false;
  bool legacyDirectory = false;
  bool frozenSource = false;
};

std::array<CredentialAuditFileGuard*, 64> gCredentialAuditFileGuards{};
std::mutex gCredentialAuditFileGuardsMutex;

bool IsIssuedCredentialAuditFileGuard(CredentialAuditFileGuard* guard) {
  return std::find(
      gCredentialAuditFileGuards.begin(),
      gCredentialAuditFileGuards.end(),
      guard) != gCredentialAuditFileGuards.end();
}

bool RegisterCredentialAuditFileGuard(CredentialAuditFileGuard* guard) {
  const auto available = std::find(
      gCredentialAuditFileGuards.begin(),
      gCredentialAuditFileGuards.end(),
      nullptr);
  if (available == gCredentialAuditFileGuards.end()) return false;
  *available = guard;
  return true;
}

bool UnregisterCredentialAuditFileGuard(CredentialAuditFileGuard* guard) {
  const auto existing = std::find(
      gCredentialAuditFileGuards.begin(),
      gCredentialAuditFileGuards.end(),
      guard);
  if (existing == gCredentialAuditFileGuards.end()) return false;
  *existing = nullptr;
  return true;
}

void FinalizeCredentialAuditFileGuard(napi_env, void* data, void*) {
  auto* guard = static_cast<CredentialAuditFileGuard*>(data);
  if (guard == nullptr) return;
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  const bool issued = UnregisterCredentialAuditFileGuard(guard);
  if (issued && guard->active) {
    for (auto iterator = guard->handles.rbegin(); iterator != guard->handles.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
    }
    guard->handles.clear();
    guard->active = false;
  }
  delete guard;
}

napi_value AcquireCredentialAuditFileGuardCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring path;
  if (!GetString(env, arguments[0], &path)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  Failure failure = OperationFailed();
  ParsedPath parsed;
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) {
    return ThrowFailure(env, failure);
  }
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = FILE_READ_DATA | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.protectedAncestorDepth = 2;
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.disposition = kFileOpen;
  bool finalMissing = false;
  if (!OpenRelativePath(parsed, options, &opened, &finalMissing, &failure)
      || finalMissing
      || opened.final == INVALID_HANDLE_VALUE
      || opened.parents.size() < 2) {
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!ValidateSecurity(opened.final, false, &failure, &identity, &security)
      || !ResolveFinalPath(opened.final, &parsed)) {
    return ThrowFailure(env, failure);
  }
  if (security.denyAce
      || security.ownerAllowAceCount != 1
      || security.ownerAllowMask != FILE_ALL_ACCESS) {
    return ThrowFailure(env, SecurityPolicy("credential_audit_guard_security"));
  }
  for (std::size_t offset = 0; offset < 2; ++offset) {
    SecuritySnapshot directorySecurity;
    HANDLE directory = opened.parents[opened.parents.size() - 1 - offset];
    if (!ValidateSecurity(directory, true, &failure, nullptr, &directorySecurity)
        || directorySecurity.denyAce
        || directorySecurity.ownerAllowAceCount != 1
        || directorySecurity.ownerAllowMask != FILE_ALL_ACCESS) {
      return ThrowFailure(env, SecurityPolicy("credential_audit_directory_security"));
    }
  }
  std::vector<HANDLE> guardedHandles;
  guardedHandles.reserve(3);
  for (std::size_t offset = 0; offset < 2; ++offset) {
    const std::size_t index = opened.parents.size() - 1 - offset;
    guardedHandles.push_back(opened.parents[index]);
    opened.parents[index] = INVALID_HANDLE_VALUE;
  }
  guardedHandles.push_back(opened.releaseFinal());
  auto* guard = new (std::nothrow) CredentialAuditFileGuard{
      std::move(guardedHandles),
      true,
  };
  if (guard == nullptr) {
    for (HANDLE guarded : guardedHandles) {
      if (guarded != INVALID_HANDLE_VALUE) CloseHandle(guarded);
    }
    return ThrowFailure(env, OperationFailed());
  }
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    if (!RegisterCredentialAuditFileGuard(guard)) {
      for (HANDLE guarded : guard->handles) {
        if (guarded != INVALID_HANDLE_VALUE) CloseHandle(guarded);
      }
      delete guard;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(
          env,
          guard,
          FinalizeCredentialAuditFileGuard,
          nullptr,
          &external) != napi_ok) {
    FinalizeCredentialAuditFileGuard(env, guard, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "guard", external);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value ReleaseCredentialAuditFileGuardCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_external) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  auto* guard = static_cast<CredentialAuditFileGuard*>(data);
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  if (!IsIssuedCredentialAuditFileGuard(guard)
      || !guard->active
      || guard->handles.empty()) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  UnregisterCredentialAuditFileGuard(guard);
  bool closed = true;
  for (auto iterator = guard->handles.rbegin(); iterator != guard->handles.rend(); ++iterator) {
    if (*iterator != INVALID_HANDLE_VALUE && !CloseHandle(*iterator)) closed = false;
  }
  guard->handles.clear();
  guard->active = false;
  if (!closed) return ThrowFailure(env, CredentialAuditGuardReleaseFailed());
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// Pin the authenticated operation root and its entire resolved ancestor chain.
// No held component permits delete sharing, so later path-based SQLite opens
// and root-bound child operations cannot be redirected by a directory rename.
// Ordinary inherited ancestor ACLs are accepted; only the private root must
// have the exact current-owner protected DACL.
napi_value AcquireDirectoryGuard(napi_env env, napi_callback_info info, bool legacyRead) {
  std::vector<napi_value> arguments;
  std::wstring path;
  if (!GetArguments(env, info, &arguments, 1)
      || !GetString(env, arguments[0], &path)) return ThrowFailure(env, InvalidConfiguration());
  Failure failure = OperationFailed();
  ParsedPath parsed;
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) return ThrowFailure(env, failure);
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = true;
  options.access = kDirectoryTraversalAccess;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.protectedAncestorDepth = parsed.components.size();
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  bool missing = false;
  if (!OpenRelativePath(parsed, options, &opened, &missing, &failure)
      || missing || opened.final == INVALID_HANDLE_VALUE) return ThrowFailure(env, failure);
  HandleIdentity identity;
  SecuritySnapshot security;
  if (legacyRead) {
    if (!GetIdentity(opened.final, &identity) || !ReadSecurity(opened.final, &security)
        || !identity.directory || identity.linkCount != 1 || !security.ownerMatches
        || security.nullDacl) return ThrowFailure(env, SecurityPolicy("legacy_state_root_security"));
  } else if (!ValidateSecurity(opened.final, true, &failure, &identity, &security)) {
    return ThrowFailure(env, failure);
  }
  if (!ResolveFinalPath(opened.final, &parsed)) return ThrowFailure(env, OperationFailed());
  if (!legacyRead && (security.denyAce || security.ownerAllowAceCount != 1
      || security.ownerAllowMask != FILE_ALL_ACCESS)) {
    return ThrowFailure(env, SecurityPolicy("protected_directory_guard_security"));
  }
  auto* guard = new (std::nothrow) CredentialAuditFileGuard;
  if (guard == nullptr) return ThrowFailure(env, OperationFailed());
  guard->handles = std::move(opened.parents);
  opened.parents.clear();
  guard->handles.push_back(opened.final);
  opened.final = INVALID_HANDLE_VALUE;
  guard->active = true;
  guard->directoryGuard = true;
  guard->legacyDirectory = legacyRead;
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    if (!RegisterCredentialAuditFileGuard(guard)) {
      for (HANDLE handle : guard->handles) CloseHandle(handle);
      delete guard;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(env, guard, FinalizeCredentialAuditFileGuard, nullptr, &external) != napi_ok) {
    FinalizeCredentialAuditFileGuard(env, guard, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "guard", external);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

napi_value AcquireProtectedDirectoryGuardCallback(napi_env env, napi_callback_info info) {
  return AcquireDirectoryGuard(env, info, false);
}

napi_value AcquireLegacyStateDirectoryGuardCallback(napi_env env, napi_callback_info info) {
  return AcquireDirectoryGuard(env, info, true);
}

// Compare held native identities rather than path spelling (including 8.3
// aliases). Neither root may contain the other; no absolute path is returned.
napi_value LegacyStateRootsDisjointCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  void *sourceData = nullptr, *destinationData = nullptr;
  if (!GetArguments(env, info, &arguments, 2)
      || napi_get_value_external(env, arguments[0], &sourceData) != napi_ok
      || napi_get_value_external(env, arguments[1], &destinationData) != napi_ok
      || sourceData == nullptr || destinationData == nullptr) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  auto* source = static_cast<CredentialAuditFileGuard*>(sourceData);
  auto* destination = static_cast<CredentialAuditFileGuard*>(destinationData);
  if (!IsIssuedCredentialAuditFileGuard(source) || !IsIssuedCredentialAuditFileGuard(destination)
      || !source->active || !destination->active || !source->directoryGuard
      || !source->legacyDirectory || !destination->directoryGuard || destination->legacyDirectory
      || source->handles.empty() || destination->handles.empty()) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  HandleIdentity sourceIdentity, destinationIdentity;
  if (!GetIdentity(source->handles.back(), &sourceIdentity)
      || !GetIdentity(destination->handles.back(), &destinationIdentity)) return ThrowFailure(env, OperationFailed());
  bool disjoint = true;
  for (HANDLE handle : destination->handles) {
    HandleIdentity current;
    if (!GetIdentity(handle, &current)) return ThrowFailure(env, OperationFailed());
    if (EqualIdentity(current, sourceIdentity)) disjoint = false;
  }
  for (HANDLE handle : source->handles) {
    HandleIdentity current;
    if (!GetIdentity(handle, &current)) return ThrowFailure(env, OperationFailed());
    if (EqualIdentity(current, destinationIdentity)) disjoint = false;
  }
  napi_value result;
  napi_get_boolean(env, disjoint, &result);
  return result;
}

napi_value ReleaseProtectedDirectoryGuardCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  void* data = nullptr;
  if (!GetArguments(env, info, &arguments, 1)
      || napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    auto* guard = static_cast<CredentialAuditFileGuard*>(data);
    if (!IsIssuedCredentialAuditFileGuard(guard) || !guard->active || !guard->directoryGuard) {
      return ThrowFailure(env, CredentialAuditGuardForeign());
    }
  }
  return ReleaseCredentialAuditFileGuardCallback(env, info);
}

// Unlike the legacy audit guard this root-bound form requires one authenticated
// private root, not an additional owner-protected artifact parent. The caller
// retains a directory guard while SQLite holds this file guard.
napi_value AcquireProtectedChildGuardCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  std::wstring rootPath;
  std::wstring childPath;
  HandleIdentity expectedRoot;
  if (!GetArguments(env, info, &arguments, 3)
      || !GetString(env, arguments[0], &rootPath)
      || !ParseExpectedIdentity(env, arguments[1], &expectedRoot)
      || !GetString(env, arguments[2], &childPath)) return ThrowFailure(env, InvalidConfiguration());
  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = FILE_READ_DATA | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.protectedAncestorDepth = 4096;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(rootPath, expectedRoot, childPath, options, &root, &parsed, &opened, &failure)) {
    return ThrowFailure(env, failure);
  }
  SecuritySnapshot rootSecurity;
  if (!ValidateSecurity(root.handle, true, &failure, nullptr, &rootSecurity)
      || rootSecurity.denyAce || rootSecurity.ownerAllowAceCount != 1
      || rootSecurity.ownerAllowMask != FILE_ALL_ACCESS) {
    if (failure.code == OperationFailed().code) failure = SecurityPolicy("protected_child_root_security");
    return ThrowFailure(env, failure);
  }
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!ValidateSecurity(opened.final, false, &failure, &identity, &security)
      || security.denyAce || security.ownerAllowAceCount != 1
      || security.ownerAllowMask != FILE_ALL_ACCESS) {
    if (failure.code == OperationFailed().code) failure = SecurityPolicy("protected_child_guard_security");
    return ThrowFailure(env, failure);
  }
  auto* guard = new (std::nothrow) CredentialAuditFileGuard;
  if (guard == nullptr) return ThrowFailure(env, OperationFailed());
  guard->handles = std::move(opened.parents);
  opened.parents.clear();
  guard->handles.push_back(root.release());
  guard->handles.push_back(opened.final);
  opened.final = INVALID_HANDLE_VALUE;
  guard->active = true;
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    if (!RegisterCredentialAuditFileGuard(guard)) {
      for (HANDLE handle : guard->handles) CloseHandle(handle);
      delete guard;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(env, guard, FinalizeCredentialAuditFileGuard, nullptr, &external) != napi_ok) {
    FinalizeCredentialAuditFileGuard(env, guard, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "guard", external);
  napi_set_named_property(env, result, "identity", IdentityValue(env, identity));
  return result;
}

// Source logs belong to Codex: authenticate the owner without changing their
// inherited ACLs. Keep every ancestor and the file open without delete sharing
// until the lease closes. Reads use this handle, never a path-based reopen.
napi_value OpenSourceFile(napi_env env, napi_callback_info info, bool frozen) {
  std::vector<napi_value> arguments;
  std::wstring path;
  if (!GetArguments(env, info, &arguments, 1) || !GetString(env, arguments[0], &path))
    return ThrowFailure(env, InvalidConfiguration());
  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParseAndValidatePath(path, false, &parsed, &failure)) return ThrowFailure(env, failure);
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = frozen ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE;
  options.protectedAncestorDepth = (std::numeric_limits<std::size_t>::max)();
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  RelativeHandles opened;
  bool missing = false;
  if (!OpenRelativePath(parsed, options, &opened, &missing, &failure) || missing)
    return ThrowFailure(env, failure);
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!GetIdentity(opened.final, &identity) || !ReadSecurity(opened.final, &security)
      || !ResolveFinalPath(opened.final, &parsed)) return ThrowFailure(env, OperationFailed());
  if (identity.directory || identity.linkCount != 1 || !security.ownerMatches
      || (frozen && security.nullDacl))
    return ThrowFailure(env, SecurityPolicy("source_file_security"));
  auto* guard = new (std::nothrow) CredentialAuditFileGuard;
  if (guard == nullptr) return ThrowFailure(env, OperationFailed());
  guard->handles = std::move(opened.parents);
  guard->handles.push_back(opened.releaseFinal());
  guard->active = true;
  guard->sourceFile = true;
  guard->frozenSource = frozen;
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    if (!RegisterCredentialAuditFileGuard(guard)) {
      for (HANDLE handle : guard->handles) CloseHandle(handle);
      delete guard;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(env, guard, FinalizeCredentialAuditFileGuard, nullptr, &external) != napi_ok) {
    FinalizeCredentialAuditFileGuard(env, guard, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  return external;
}

napi_value OpenSourceFileCallback(napi_env env, napi_callback_info info) {
  return OpenSourceFile(env, info, false);
}

// Explicit legacy-state copy only: an existing writer makes acquisition fail;
// later writers, deletion and replacement are refused until this lease closes.
napi_value OpenLegacyStateFileCallback(napi_env env, napi_callback_info info) {
  return OpenSourceFile(env, info, true);
}

// Callers hold gCredentialAuditFileGuardsMutex while using the returned handle.
CredentialAuditFileGuard* SourceFileGuard(napi_env env, napi_value value) {
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || data == nullptr) return nullptr;
  auto* guard = static_cast<CredentialAuditFileGuard*>(data);
  if (!IsIssuedCredentialAuditFileGuard(guard) || !guard->active
      || !guard->sourceFile || guard->handles.empty()) return nullptr;
  return guard;
}

napi_value StatSourceFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  auto* guard = SourceFileGuard(env, arguments[0]);
  if (guard == nullptr) return ThrowFailure(env, CredentialAuditGuardForeign());
  HANDLE handle = guard->handles.back();
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
  HandleIdentity identity;
  SecuritySnapshot security;
  if (!GetIdentity(handle, &identity) || !ReadSecurity(handle, &security)
      || !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))
      || !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)))
    return ThrowFailure(env, OperationFailed());
  if (!security.ownerMatches || identity.directory || identity.linkCount != 1
      || standard.EndOfFile.QuadPart < 0 || standard.EndOfFile.QuadPart > 9007199254740991LL)
    return ThrowFailure(env, SecurityPolicy("source_file_security"));
  napi_value result, value, id = IdentityValue(env, identity);
  napi_create_object(env, &result);
  napi_get_named_property(env, id, "volumeSerialNumber", &value);
  napi_set_named_property(env, result, "dev", value);
  napi_get_named_property(env, id, "fileId", &value);
  napi_set_named_property(env, result, "ino", value);
  const auto number = [&](const char* name, double n) {
    napi_value v; napi_create_double(env, n, &v); napi_set_named_property(env, result, name, v);
  };
  const auto millis = [](LARGE_INTEGER t) { return static_cast<double>(t.QuadPart / 10000) - 11644473600000.0; };
  number("size", static_cast<double>(standard.EndOfFile.QuadPart));
  number("nlink", identity.linkCount);
  number("birthtimeMs", millis(basic.CreationTime));
  number("mtimeMs", millis(basic.LastWriteTime));
  number("ctimeMs", millis(basic.ChangeTime));
  return result;
}

napi_value ReadSourceFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  double position = -1, length = -1;
  if (!GetArguments(env, info, &arguments, 3)
      || napi_get_value_double(env, arguments[1], &position) != napi_ok
      || napi_get_value_double(env, arguments[2], &length) != napi_ok
      || !std::isfinite(position) || position < 0 || position > 9007199254740991.0
      || std::floor(position) != position || !std::isfinite(length)
      || length < 0 || length > 65536 || std::floor(length) != length)
    return ThrowFailure(env, InvalidConfiguration());
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  auto* guard = SourceFileGuard(env, arguments[0]);
  if (guard == nullptr) return ThrowFailure(env, CredentialAuditGuardForeign());
  LARGE_INTEGER offset; offset.QuadPart = static_cast<LONGLONG>(position);
  HANDLE handle = guard->handles.back();
  if (!SetFilePointerEx(handle, offset, nullptr, FILE_BEGIN)) return ThrowFailure(env, OperationFailed());
  std::array<BYTE, 65536> bytes{};
  DWORD count = 0;
  if (length > 0 && !ReadFile(handle, bytes.data(), static_cast<DWORD>(length), &count, nullptr))
    return ThrowFailure(env, OperationFailed());
  napi_value result;
  if (napi_create_buffer_copy(env, count, bytes.data(), nullptr, &result) != napi_ok)
    return ThrowFailure(env, OperationFailed());
  return result;
}

napi_value CloseSourceFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) return ThrowFailure(env, InvalidConfiguration());
  {
    const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
    if (SourceFileGuard(env, arguments[0]) == nullptr) return ThrowFailure(env, CredentialAuditGuardForeign());
  }
  return ReleaseCredentialAuditFileGuardCallback(env, info);
}

// Copy only a frozen, current-owner source. All I/O is bounded to two 64 KiB
// buffers. An incomplete new destination is delete-pending on the exact handle,
// so process death removes it; success clears that flag only after readback.
napi_value CopyLegacyStateFileCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  std::wstring rootPath, childPath;
  HandleIdentity expectedRoot;
  if (!GetArguments(env, info, &arguments, 4)
      || !GetString(env, arguments[1], &rootPath)
      || !ParseExpectedIdentity(env, arguments[2], &expectedRoot)
      || !GetString(env, arguments[3], &childPath)) return ThrowFailure(env, InvalidConfiguration());
  const std::lock_guard<std::mutex> lock(gCredentialAuditFileGuardsMutex);
  auto* sourceGuard = SourceFileGuard(env, arguments[0]);
  if (sourceGuard == nullptr || !sourceGuard->frozenSource) return ThrowFailure(env, CredentialAuditGuardForeign());
  HANDLE source = sourceGuard->handles.back();
  FILE_STANDARD_INFO sourceInfo{};
  if (!GetFileInformationByHandleEx(source, FileStandardInfo, &sourceInfo, sizeof(sourceInfo))) {
    return ThrowFailure(env, OperationFailed());
  }
  if (sourceInfo.EndOfFile.QuadPart < 0 || sourceInfo.EndOfFile.QuadPart > 1073741824LL) {
    return ThrowFailure(env, TooLarge());
  }
  OwnerOnlySecurityResources security;
  if (!security.initialize()) return ThrowFailure(env, OperationFailed());
  Failure failure = OperationFailed();
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = false;
  options.access = GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  options.shareMode = FILE_SHARE_READ;
  options.disposition = kFileCreate;
  options.extraOptions = 0x00001000; // FILE_DELETE_ON_CLOSE, from initial creation.
  options.ownerOnlyOnCreate = true;
  options.securityDescriptor = security.attributes.lpSecurityDescriptor;
  ScopedHandle root;
  ParsedRelativePath parsed;
  RelativeHandles opened;
  if (!OpenRootBoundChild(rootPath, expectedRoot, childPath, options, &root, &parsed, &opened, &failure)) {
    return ThrowFailure(env, failure);
  }
  HANDLE destination = opened.final;
  HandleIdentity targetIdentity;
  if (!SetOwnerOnlyDacl(destination) || !ValidateSecurity(destination, false, &failure, &targetIdentity)) {
    return ThrowFailure(env, OperationFailed());
  }
  std::array<BYTE, 65536> bytes{}, verify{};
  const auto finish = [&](const Failure& category) {
    SecureZeroMemory(bytes.data(), bytes.size());
    SecureZeroMemory(verify.data(), verify.size());
    return ThrowFailure(env, category);
  };
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(source, zero, nullptr, FILE_BEGIN)) return finish(OperationFailed());
  LONGLONG copied = 0;
  while (copied < sourceInfo.EndOfFile.QuadPart) {
    DWORD count = 0, written = 0;
    const DWORD requested = static_cast<DWORD>(std::min<LONGLONG>(bytes.size(), sourceInfo.EndOfFile.QuadPart - copied));
    if (!ReadFile(source, bytes.data(), requested, &count, nullptr) || count != requested
        || !WriteFile(destination, bytes.data(), count, &written, nullptr) || written != count) {
      return finish(OperationFailed());
    }
    copied += count;
  }
  if (!FlushFileBuffers(destination)
      || !SetFilePointerEx(source, zero, nullptr, FILE_BEGIN)
      || !SetFilePointerEx(destination, zero, nullptr, FILE_BEGIN)) return finish(OperationFailed());
  copied = 0;
  while (copied < sourceInfo.EndOfFile.QuadPart) {
    DWORD count = 0, checked = 0;
    const DWORD requested = static_cast<DWORD>(std::min<LONGLONG>(bytes.size(), sourceInfo.EndOfFile.QuadPart - copied));
    if (!ReadFile(source, bytes.data(), requested, &count, nullptr) || count != requested
        || !ReadFile(destination, verify.data(), requested, &checked, nullptr) || checked != count
        || std::memcmp(bytes.data(), verify.data(), count) != 0) return finish(OperationFailed());
    copied += count;
  }
  FILE_DISPOSITION_INFO_EX retain{};
  // These Windows 10 ABI constants are hidden by the binding's older generic
  // SDK target. An older kernel refuses this narrow copy operation safely.
  retain.Flags = 0x00000008; // FILE_DISPOSITION_ON_CLOSE, without DELETE.
  if (!SetFileInformationByHandle(destination, static_cast<FILE_INFO_BY_HANDLE_CLASS>(21), &retain, sizeof(retain))
      || !ValidateSecurity(destination, false, &failure, &targetIdentity)
      || !FlushFileBuffers(destination)) {
    MarkHandleForDeletion(destination);
    return finish(OperationFailed());
  }
  SecureZeroMemory(bytes.data(), bytes.size());
  SecureZeroMemory(verify.data(), verify.size());
  return IdentityValue(env, targetIdentity);
}

enum class CredentialMutexLeaseKind {
  kLegacyCapability,
  kAccountlessInstallationCredential,
};

struct CredentialMutexLease {
  HANDLE handle = nullptr;
  DWORD ownerThreadId = 0;
  bool active = false;
  CredentialMutexLeaseKind kind = CredentialMutexLeaseKind::kLegacyCapability;
};

std::array<CredentialMutexLease*, 256> gCredentialMutexLeases{};
std::mutex gCredentialMutexLeasesMutex;

// Callers must hold gCredentialMutexLeasesMutex while reading or mutating the
// issued-token registry and the state of a registered lease.
bool IsIssuedCredentialMutexLease(CredentialMutexLease* lease) {
  return std::find(
      gCredentialMutexLeases.begin(),
      gCredentialMutexLeases.end(),
      lease) != gCredentialMutexLeases.end();
}

bool RegisterCredentialMutexLease(CredentialMutexLease* lease) {
  const auto available = std::find(
      gCredentialMutexLeases.begin(),
      gCredentialMutexLeases.end(),
      nullptr);
  if (available == gCredentialMutexLeases.end()) return false;
  *available = lease;
  return true;
}

bool UnregisterCredentialMutexLease(CredentialMutexLease* lease) {
  const auto existing = std::find(
      gCredentialMutexLeases.begin(),
      gCredentialMutexLeases.end(),
      lease);
  if (existing == gCredentialMutexLeases.end()) return false;
  *existing = nullptr;
  return true;
}

void FinalizeCredentialMutexLease(
    napi_env,
    void* data,
    void*) {
  auto* lease = static_cast<CredentialMutexLease*>(data);
  if (lease == nullptr) return;
  const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
  const bool issued = UnregisterCredentialMutexLease(lease);
  if (issued && lease->active && lease->handle != nullptr) {
    if (lease->ownerThreadId == GetCurrentThreadId()) {
      ReleaseMutex(lease->handle);
    }
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
  }
  delete lease;
}

bool CredentialMutexName(std::uint32_t capabilityId, std::wstring* name) {
  const wchar_t* label = nullptr;
  switch (capabilityId) {
    case 0:
      label = L"export-identity";
      break;
    case 1:
      label = L"account-observation";
      break;
    case 2:
      label = L"claude-callback";
      break;
    case 3:
      label = L"contribution-device";
      break;
    default:
      return false;
  }
  std::vector<BYTE> ownerSid;
  if (!GetCurrentUserSid(&ownerSid)) return false;
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(ownerSid.data(), &sidText) || sidText == nullptr) {
    return false;
  }
  *name = L"Local\\UsageMonitor-CredentialMutation-v1-";
  name->append(sidText);
  name->push_back(L'-');
  name->append(label);
  LocalFree(sidText);
  return true;
}

// This fixed name deliberately does not accept a caller capability ID. It
// protects only the separately-owned accountless installation credential and
// must never become a fifth route through the legacy FD4 capability map.
bool AccountlessInstallationCredentialMutexName(std::wstring* name) {
  std::vector<BYTE> ownerSid;
  if (!GetCurrentUserSid(&ownerSid)) return false;
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(ownerSid.data(), &sidText) || sidText == nullptr) {
    return false;
  }
  *name = L"Local\\UsageMonitor-AccountlessInstallationCredential-v1-";
  name->append(sidText);
  LocalFree(sidText);
  return true;
}

napi_value AcquireCredentialMutexCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::uint32_t capabilityId = 0;
  std::wstring name;
  if (!GetUint32(env, arguments[0], &capabilityId)
      || !CredentialMutexName(capabilityId, &name)) {
    return ThrowFailure(env, CredentialMutexInvalidCapability());
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(
          kCredentialMutexAccess,
          &ownerSid,
          &acl,
          &descriptor,
          &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE handle = CreateMutexExW(
      &attributes,
      name.c_str(),
      0,
      kCredentialMutexAccess);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (handle == nullptr) return ThrowFailure(env, FromLastError());

  SecuritySnapshot security;
  if (!ReadObjectSecurity(handle, SE_KERNEL_OBJECT, &security)
      || !IsOwnerOnlySecurity(security)) {
    CloseHandle(handle);
    return ThrowFailure(env, SecurityPolicy("credential_mutex_security"));
  }

  const DWORD waitResult = WaitForSingleObject(handle, 0);
  if (waitResult == WAIT_TIMEOUT) {
    CloseHandle(handle);
    return ThrowFailure(env, CredentialMutexContended());
  }
  if (waitResult == WAIT_ABANDONED_0) {
    ReleaseMutex(handle);
    CloseHandle(handle);
    return ThrowFailure(env, CredentialMutexAbandoned());
  }
  if (waitResult != WAIT_OBJECT_0) {
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }

  auto* lease = new (std::nothrow) CredentialMutexLease{
      handle,
      GetCurrentThreadId(),
      true,
      CredentialMutexLeaseKind::kLegacyCapability,
  };
  if (lease == nullptr) {
    ReleaseMutex(handle);
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }
  {
    const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
    if (!RegisterCredentialMutexLease(lease)) {
      ReleaseMutex(handle);
      CloseHandle(handle);
      delete lease;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(
          env,
          lease,
          FinalizeCredentialMutexLease,
          nullptr,
          &external) != napi_ok) {
    FinalizeCredentialMutexLease(env, lease, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_value abandoned;
  napi_create_object(env, &result);
  napi_get_boolean(env, false, &abandoned);
  napi_set_named_property(env, result, "lease", external);
  napi_set_named_property(env, result, "abandoned", abandoned);
  return result;
}

napi_value ReleaseCredentialMutexCallback(napi_env env, napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_external) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  auto* lease = static_cast<CredentialMutexLease*>(data);
  const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
  if (!IsIssuedCredentialMutexLease(lease)) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  if (lease->kind != CredentialMutexLeaseKind::kLegacyCapability
      || !lease->active
      || lease->handle == nullptr
      || lease->ownerThreadId != GetCurrentThreadId()) {
    return ThrowFailure(env, CredentialMutexForeign());
  }
  if (!ReleaseMutex(lease->handle)) {
    UnregisterCredentialMutexLease(lease);
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
    return ThrowFailure(env, CredentialMutexReleaseFailed());
  }
  UnregisterCredentialMutexLease(lease);
  CloseHandle(lease->handle);
  lease->handle = nullptr;
  lease->active = false;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value AcquireAccountlessInstallationCredentialMutexCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 0)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  std::wstring name;
  if (!AccountlessInstallationCredentialMutexName(&name)) {
    return ThrowFailure(env, OperationFailed());
  }

  std::vector<BYTE> ownerSid;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(
          kCredentialMutexAccess,
          &ownerSid,
          &acl,
          &descriptor,
          &attributes)) {
    return ThrowFailure(env, OperationFailed());
  }
  HANDLE handle = CreateMutexExW(
      &attributes,
      name.c_str(),
      0,
      kCredentialMutexAccess);
  FreeOwnerOnlySecurity(acl, descriptor);
  if (handle == nullptr) return ThrowFailure(env, FromLastError());

  SecuritySnapshot security;
  if (!ReadObjectSecurity(handle, SE_KERNEL_OBJECT, &security)
      || !IsOwnerOnlySecurity(security)) {
    CloseHandle(handle);
    return ThrowFailure(env, SecurityPolicy("accountless_installation_mutex_security"));
  }

  const DWORD waitResult = WaitForSingleObject(handle, 0);
  if (waitResult == WAIT_TIMEOUT) {
    CloseHandle(handle);
    return ThrowFailure(env, AccountlessInstallationCredentialMutexContended());
  }
  const bool abandoned = waitResult == WAIT_ABANDONED_0;
  if (!abandoned && waitResult != WAIT_OBJECT_0) {
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }

  auto* lease = new (std::nothrow) CredentialMutexLease{
      handle,
      GetCurrentThreadId(),
      true,
      CredentialMutexLeaseKind::kAccountlessInstallationCredential,
  };
  if (lease == nullptr) {
    ReleaseMutex(handle);
    CloseHandle(handle);
    return ThrowFailure(env, OperationFailed());
  }
  {
    const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
    if (!RegisterCredentialMutexLease(lease)) {
      ReleaseMutex(handle);
      CloseHandle(handle);
      delete lease;
      return ThrowFailure(env, OperationFailed());
    }
  }
  napi_value external;
  if (napi_create_external(
          env,
          lease,
          FinalizeCredentialMutexLease,
          nullptr,
          &external) != napi_ok) {
    FinalizeCredentialMutexLease(env, lease, nullptr);
    return ThrowFailure(env, OperationFailed());
  }
  napi_value result;
  napi_value abandonedValue;
  napi_create_object(env, &result);
  napi_get_boolean(env, abandoned, &abandonedValue);
  napi_set_named_property(env, result, "lease", external);
  napi_set_named_property(env, result, "abandoned", abandonedValue);
  return result;
}

napi_value ReleaseAccountlessInstallationCredentialMutexCallback(
    napi_env env,
    napi_callback_info info) {
  std::vector<napi_value> arguments;
  if (!GetArguments(env, info, &arguments, 1)) {
    return ThrowFailure(env, InvalidConfiguration());
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_external) {
    return ThrowFailure(env, AccountlessInstallationCredentialMutexForeign());
  }
  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    return ThrowFailure(env, AccountlessInstallationCredentialMutexForeign());
  }
  auto* lease = static_cast<CredentialMutexLease*>(data);
  const std::lock_guard<std::mutex> lock(gCredentialMutexLeasesMutex);
  if (!IsIssuedCredentialMutexLease(lease)
      || lease->kind != CredentialMutexLeaseKind::kAccountlessInstallationCredential
      || !lease->active
      || lease->handle == nullptr
      || lease->ownerThreadId != GetCurrentThreadId()) {
    return ThrowFailure(env, AccountlessInstallationCredentialMutexForeign());
  }
  if (!ReleaseMutex(lease->handle)) {
    UnregisterCredentialMutexLease(lease);
    CloseHandle(lease->handle);
    lease->handle = nullptr;
    lease->active = false;
    return ThrowFailure(env, AccountlessInstallationCredentialMutexReleaseFailed());
  }
  UnregisterCredentialMutexLease(lease);
  CloseHandle(lease->handle);
  lease->handle = nullptr;
  lease->active = false;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// Chromium owns profile descendants and grants its network sandbox a capability
// SID. Unlike protected records, browser directories must propagate the current
// owner's access to files Chromium creates. This boundary is deliberately
// separate from SetOwnerOnlyDacl/ensureDirectory and never returns file content.
constexpr std::size_t kBrowserProfileMaximumEntries = 4096;
constexpr std::size_t kBrowserProfileMaximumDepth = 32;
// Overflow recovery is a bounded, resumable deletion pass over fixed disposable
// cache names only. Durable browser state still uses the unchanged tree bound.
constexpr std::size_t kBrowserProfileCacheMaximumOperations = 8192;

bool IsCurrentLogonSid(PSID sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD length = 0;
  GetTokenInformation(token, TokenGroups, nullptr, 0, &length);
  std::vector<BYTE> bytes(length);
  const bool read = length > 0 && GetTokenInformation(token, TokenGroups, bytes.data(), length, &length);
  CloseHandle(token);
  if (!read) return false;
  const auto* groups = reinterpret_cast<TOKEN_GROUPS*>(bytes.data());
  for (DWORD i = 0; i < groups->GroupCount; ++i) {
    if ((groups->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID
        && IsSidEqual(sid, groups->Groups[i].Sid)) return true;
  }
  return false;
}

bool IsBrowserCapabilitySid(PSID sid) {
  const SID_IDENTIFIER_AUTHORITY appAuthority = SECURITY_APP_PACKAGE_AUTHORITY;
  // Chromium's named sandbox capabilities contain the named-capability RID
  // and eight hash DWORDs. Do not accept shared well-known capabilities such
  // as InternetClient as a substitute for that application-specific principal.
  return IsValidSid(sid) && *GetSidSubAuthorityCount(sid) == 10
      && std::memcmp(GetSidIdentifierAuthority(sid), &appAuthority, sizeof(appAuthority)) == 0
      && *GetSidSubAuthority(sid, 0) == SECURITY_CAPABILITY_BASE_RID
      && *GetSidSubAuthority(sid, 1) == 1024;
}

bool ValidateBrowserProfileSecurity(HANDLE handle, bool migration, bool directory, Failure* failure,
    bool kernelRejectedReparse = false) {
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))) {
    *failure = FromLastError(); failure->stage = "browser_profile_standard_metadata"; return false;
  }
  // Owner-only READ_CONTROL/WRITE_DAC repair opens use OBJ_DONT_REPARSE;
  // ordinary opens validate attributes through this same held handle.
  bool reparse = false;
  if (!kernelRejectedReparse && !HasReparsePoint(handle, &reparse)) { *failure = FromLastError(); return false; }
  if (reparse) { *failure = ReparsePoint(); return false; }
  if ((standard.Directory != FALSE) != directory) {
    *failure = directory ? NotDirectory() : NotRegularFile(); return false;
  }
  if (!directory && standard.NumberOfLinks != 1) { *failure = HardLink(); return false; }
  std::vector<BYTE> user;
  if (!GetCurrentUserSid(&user)) { *failure = OperationFailed(); return false; }
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS) { SetLastError(status); *failure = FromLastError(); return false; }
  bool valid = owner && IsSidEqual(owner, user.data()) && acl != nullptr;
  DWORD ownerMask = 0;
  bool ownerInheritance = false;
  ACL_SIZE_INFORMATION size{};
  valid = valid && GetAclInformation(acl, &size, sizeof(size), AclSizeInformation);
  for (DWORD i = 0; valid && i < size.AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(acl, i, &raw)) { valid = false; break; }
    const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    const DWORD offset = FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceSize < offset + 8) {
      valid = false; break;
    }
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(sid) || GetLengthSid(sid) > ace->Header.AceSize - offset) { valid = false; break; }
    if (IsSidEqual(sid, user.data())) {
      if ((ace->Header.AceFlags & INHERIT_ONLY_ACE) == 0) ownerMask |= ace->Mask;
      if ((ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE))
          == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
          && (ace->Header.AceFlags & (INHERIT_ONLY_ACE | NO_PROPAGATE_INHERIT_ACE)) == 0) ownerInheritance = true;
    } else if (!IsBrowserCapabilitySid(sid)
        && !(migration && (IsWellKnownSid(sid, WinLocalSystemSid) || IsCurrentLogonSid(sid)))) {
      valid = false;
    }
  }
  if (!migration) valid = valid && (ownerMask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS
      && (!directory || ownerInheritance);
  LocalFree(descriptor);
  if (!valid) *failure = SecurityPolicy("browser_profile_acl");
  return valid;
}

bool SetBrowserProfileDacl(HANDLE handle, bool directory, bool propagate = true) {
  std::vector<BYTE> user;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  if (!BuildOwnerOnlyObjectSecurity(FILE_ALL_ACCESS, &user, &acl, &descriptor, &attributes,
      directory ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE)) return false;
  // The open handle, not a second path lookup, is the mutation authority.
  const DWORD status = propagate
      ? SetSecurityInfo(handle, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr)
      : SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        descriptor) ? ERROR_SUCCESS : GetLastError();
  FreeOwnerOnlySecurity(acl, descriptor);
  SetLastError(status);
  return status == ERROR_SUCCESS;
}

struct BrowserProfileEntry {
  HANDLE handle = INVALID_HANDLE_VALUE;
  bool directory = false;
  bool cookies = false;
  std::size_t depth = 0;
};
struct BrowserProfileHandles {
  std::vector<BrowserProfileEntry> entries;
  ~BrowserProfileHandles() { for (auto& entry : entries) CloseHandle(entry.handle); }
};

struct BrowserCacheBudget {
  std::size_t operations = 0;
  bool spend(Failure* failure) {
    if (operations >= kBrowserProfileCacheMaximumOperations) {
      *failure = {"BROWSER_PROFILE_CACHE_CLEANUP_PENDING"};
      failure->stage = "browser_profile_cache_budget";
      return false;
    }
    ++operations;
    return true;
  }
};

// This helper is private to the three constant cache roots below. The caller
// holds every ancestor without delete sharing. Legacy ACL repair is local to
// the validated handle and never propagates to unvalidated descendants.
bool OpenBrowserCacheChild(HANDLE parent, const std::wstring& name, bool directory,
    bool deletion, ScopedHandle* child, BrowserCacheBudget* budget, Failure* failure) {
  const DWORD access = READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE | WRITE_DAC
      | (directory ? FILE_LIST_DIRECTORY : 0) | (deletion ? DELETE : 0);
  const ULONG kind = directory ? kFileDirectoryFile : kFileNonDirectoryFile;
  if (!budget->spend(failure)) return false;
  if (!OpenRelativeComponent(parent, name, access, FILE_SHARE_READ, kFileOpen,
      kind, nullptr, &child->handle, nullptr, failure)) {
    if (failure->code != AccessDenied().code || !budget->spend(failure)
        || !OpenRelativeComponent(parent, name, READ_CONTROL | WRITE_DAC,
          FILE_SHARE_READ, kFileOpen, kind, nullptr, &child->handle, nullptr, failure, false)) {
      failure->stage = "browser_profile_cache_open"; return false;
    }
    if (!ValidateBrowserProfileSecurity(child->handle, true, directory, failure, true)) return false;
    FILE_ID_INFO expected{};
    if (!GetFileInformationByHandleEx(child->handle, FileIdInfo, &expected, sizeof(expected))
        || !SetBrowserProfileDacl(child->handle, false, false)) {
      *failure = FromLastError(); failure->stage = "browser_profile_cache_repair"; return false;
    }
    ScopedHandle reopened;
    if (!budget->spend(failure)) return false;
    if (!OpenRelativeComponent(parent, name, access, FILE_SHARE_READ, kFileOpen,
        kind, nullptr, &reopened.handle, nullptr, failure)) {
      failure->stage = "browser_profile_cache_reopen"; return false;
    }
    FILE_ID_INFO observed{};
    if (!GetFileInformationByHandleEx(reopened.handle, FileIdInfo, &observed, sizeof(observed))
        || expected.VolumeSerialNumber != observed.VolumeSerialNumber
        || std::memcmp(expected.FileId.Identifier, observed.FileId.Identifier, sizeof(expected.FileId.Identifier)) != 0) {
      *failure = IdentityMismatch(); return false;
    }
    CloseHandle(child->handle);
    child->handle = reopened.release();
  }
  if (!ValidateBrowserProfileSecurity(child->handle, true, directory, failure)) {
    failure->stage = "browser_profile_cache_validation"; return false;
  }
  return true;
}

bool PruneBrowserCache(HANDLE directory, std::size_t depth, BrowserCacheBudget* budget,
    std::vector<BYTE>* buffer, Failure* failure) {
  for (;;) {
    if (!budget->spend(failure)) return false;
    bool restart = true;
    bool found = false;
    std::wstring name;
    DWORD attributes = 0;
    // Restart after each deletion: directory enumeration is not a durable
    // cursor under mutation. One fixed buffer and the depth bound limit memory.
    for (;;) {
      if (!GetFileInformationByHandleEx(directory,
          restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
          buffer->data(), static_cast<DWORD>(buffer->size()))) {
        if (GetLastError() == ERROR_NO_MORE_FILES) break;
        *failure = FromLastError(); failure->stage = "browser_profile_cache_enumeration"; return false;
      }
      restart = false;
      std::size_t offset = 0;
      for (;;) {
        if (offset + FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName) > buffer->size()) {
          *failure = OperationFailed(); return false;
        }
        const auto* item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer->data() + offset);
        if ((item->FileNameLength % sizeof(wchar_t)) != 0
            || item->FileNameLength > buffer->size() - offset - FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName)) {
          *failure = OperationFailed(); return false;
        }
        name.assign(item->FileName, item->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") { attributes = item->FileAttributes; found = true; break; }
        if (item->NextEntryOffset == 0) break;
        if (item->NextEntryOffset < FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName)
            || item->NextEntryOffset > buffer->size() - offset) { *failure = OperationFailed(); return false; }
        offset += item->NextEntryOffset;
      }
      if (found) break;
      if (!budget->spend(failure)) return false;
    }
    if (!found) return true;
    if (depth >= kBrowserProfileMaximumDepth) { *failure = {"BROWSER_PROFILE_BOUND_EXCEEDED"}; return false; }
    if (name.empty() || name.find_first_of(L"\\/:") != std::wstring::npos || name.find(L'\0') != std::wstring::npos) {
      *failure = InvalidPath(); return false;
    }
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { *failure = ReparsePoint(); return false; }
    const bool isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    ScopedHandle child;
    if (!OpenBrowserCacheChild(directory, name, isDirectory, true, &child, budget, failure)) return false;
    if (isDirectory && !PruneBrowserCache(child.handle, depth + 1, budget, buffer, failure)) return false;
    if (!budget->spend(failure)) return false;
    if (!MarkHandleForDeletion(child.handle)) {
      *failure = FromLastError(); failure->stage = "browser_profile_cache_delete"; return false;
    }
    // The destructor closes the exact validated handle and completes deletion.
  }
}

bool PruneDisposableBrowserCaches(HANDLE root, Failure* failure) {
  BrowserCacheBudget budget;
  std::vector<BYTE> buffer(64 * 1024);
  for (const auto* name : { L"Cache", L"Code Cache" }) {
    ScopedHandle cache;
    if (!OpenBrowserCacheChild(root, name, true, false, &cache, &budget, failure)) {
      if (failure->code == NotFound().code) continue;
      return false;
    }
    // Retain the cache root itself; only validated disposable descendants go.
    if (!PruneBrowserCache(cache.handle, 1, &budget, &buffer, failure)) return false;
  }
  ScopedHandle serviceWorker;
  if (!OpenBrowserCacheChild(root, L"Service Worker", true, false, &serviceWorker, &budget, failure))
    return failure->code == NotFound().code;
  ScopedHandle cacheStorage;
  if (!OpenBrowserCacheChild(serviceWorker.handle, L"CacheStorage", true, false, &cacheStorage, &budget, failure))
    return failure->code == NotFound().code;
  return PruneBrowserCache(cacheStorage.handle, 2, &budget, &buffer, failure);
}

bool EnumerateBrowserProfile(
    BrowserProfileHandles* held, bool migration, Failure* failure, std::size_t* cookieBytes) {
  std::vector<BYTE> buffer(64 * 1024);
  for (std::size_t parentIndex = 0; parentIndex < held->entries.size(); ++parentIndex) {
    const auto parent = held->entries[parentIndex];
    if (!parent.directory) continue;
    bool restart = true;
    for (;;) {
      if (!GetFileInformationByHandleEx(parent.handle,
          restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
          buffer.data(), static_cast<DWORD>(buffer.size()))) {
        if (GetLastError() == ERROR_NO_MORE_FILES) break;
        *failure = FromLastError(); failure->stage = "browser_profile_enumeration"; return false;
      }
      restart = false;
      std::size_t offset = 0;
      for (;;) {
        if (offset + FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName) > buffer.size()) {
          *failure = OperationFailed(); return false;
        }
        const auto* item = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
        if ((item->FileNameLength % sizeof(wchar_t)) != 0
            || item->FileNameLength > buffer.size() - offset - FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName)) {
          *failure = OperationFailed(); return false;
        }
        const std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          if (held->entries.size() >= kBrowserProfileMaximumEntries || parent.depth >= kBrowserProfileMaximumDepth) {
            *failure = {"BROWSER_PROFILE_BOUND_EXCEEDED"}; return false;
          }
          if (name.empty() || name.find_first_of(L"\\/:") != std::wstring::npos
              || name.find(L'\0') != std::wstring::npos) { *failure = InvalidPath(); return false; }
          if ((item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            *failure = ReparsePoint(); return false;
          }
          const bool directory = (item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          HANDLE child = INVALID_HANDLE_VALUE;
          const DWORD access = READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE
              | (directory ? FILE_LIST_DIRECTORY : (migration ? 0 : FILE_READ_DATA | FILE_WRITE_DATA))
              | (migration ? WRITE_DAC : 0);
          if (!OpenRelativeComponent(parent.handle, name, access,
              FILE_SHARE_READ | (migration ? 0 : FILE_SHARE_WRITE), kFileOpen,
              directory ? kFileDirectoryFile : kFileNonDirectoryFile,
              nullptr, &child, nullptr, failure)) {
            if (!migration || failure->code != AccessDenied().code
                || !OpenRelativeComponent(parent.handle, name,
                  READ_CONTROL | WRITE_DAC,
                  FILE_SHARE_READ, kFileOpen, directory ? kFileDirectoryFile : kFileNonDirectoryFile,
                  nullptr, &child, nullptr, failure, false)) { failure->stage = "browser_profile_owner_open"; return false; }
            // Legacy capability-only directories cannot be enumerated first.
            // Verify the owner/closed ACL, then repair only this pinned object.
            if (!ValidateBrowserProfileSecurity(child, true, directory, failure, true)) { CloseHandle(child); return false; }
            // Traversal-only repair MUST NOT propagate an ACE into descendants
            // which have not yet passed owner/link/ACL validation.
            if (!SetBrowserProfileDacl(child, false, false)) { CloseHandle(child); *failure = FromLastError(); failure->stage = "browser_profile_traversal_repair"; return false; }
            HANDLE traversable = INVALID_HANDLE_VALUE;
            // Both the parent and exact child remain held without delete
            // sharing. Reopen relative to that pinned parent and compare IDs;
            // never resolve the absolute path again after the DACL update.
            if (!OpenRelativeComponent(parent.handle, name, access, FILE_SHARE_READ, kFileOpen,
                directory ? kFileDirectoryFile : kFileNonDirectoryFile, nullptr, &traversable, nullptr, failure)) {
              CloseHandle(child); failure->stage = "browser_profile_handle_reopen"; return false;
            }
            FILE_ID_INFO before{}, after{};
            const bool same = GetFileInformationByHandleEx(child, FileIdInfo, &before, sizeof(before))
                && GetFileInformationByHandleEx(traversable, FileIdInfo, &after, sizeof(after))
                && before.VolumeSerialNumber == after.VolumeSerialNumber
                && std::memcmp(before.FileId.Identifier, after.FileId.Identifier, sizeof(before.FileId.Identifier)) == 0;
            CloseHandle(child);
            child = traversable;
            if (!same) { CloseHandle(child); *failure = IdentityMismatch(); return false; }
          }
          // Keep each accepted name pinned until the bounded traversal and ACL
          // update finish; refuse links/foreign principals before its mutation.
          held->entries.push_back({child, directory, parent.depth == 1 && name == L"Cookies", parent.depth + 1});
          if (!ValidateBrowserProfileSecurity(child, migration, directory, failure)) { failure->stage = "browser_profile_child_validation"; return false; }
          if (held->entries.back().cookies) {
            LARGE_INTEGER bytes{};
            if (!GetFileSizeEx(child, &bytes) || bytes.QuadPart < 0) { *failure = OperationFailed(); failure->stage = "browser_profile_cookie_metadata"; return false; }
            *cookieBytes = static_cast<std::size_t>(bytes.QuadPart);
          }
        }
        if (item->NextEntryOffset == 0) break;
        if (item->NextEntryOffset < FIELD_OFFSET(FILE_ID_BOTH_DIR_INFO, FileName)
            || item->NextEntryOffset > buffer.size() - offset) { *failure = OperationFailed(); return false; }
        offset += item->NextEntryOffset;
      }
    }
  }
  return true;
}

bool InspectBrowserCookieStorage(BrowserProfileHandles* held, Failure* failure,
    bool* cookiePresent, std::size_t* cookieBytes, bool* cookieBusy) {
  HANDLE network = INVALID_HANDLE_VALUE;
  if (!OpenRelativeComponent(held->entries[0].handle, L"Network",
      FILE_TRAVERSE | FILE_ADD_FILE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, kFileOpen, kFileDirectoryFile,
      nullptr, &network, nullptr, failure)) {
    if (failure->code == NotFound().code) return true;
    failure->stage = "browser_profile_network_read"; return false;
  }
  held->entries.push_back({network, true, false, 1});
  if (!ValidateBrowserProfileSecurity(network, false, true, failure)) return false;
  for (const auto* name : { L"Cookies", L"Cookies-journal", L"Cookies-wal", L"Cookies-shm" }) {
    HANDLE file = INVALID_HANDLE_VALUE;
    bool sharingLocked = false;
    if (!OpenRelativeComponent(network, name, FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen, kFileNonDirectoryFile,
        nullptr, &file, nullptr, failure)) {
      if (failure->code == NotFound().code) continue;
      if (GetLastError() != ERROR_SHARING_VIOLATION
          || !OpenRelativeComponent(network, name, FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen, kFileNonDirectoryFile,
            nullptr, &file, nullptr, failure)) {
        failure->stage = "browser_profile_cookie_read"; return false;
      }
      sharingLocked = true;
      *cookieBusy = true;
    }
    held->entries.push_back({file, false, name == std::wstring(L"Cookies"), 2});
    if (!ValidateBrowserProfileSecurity(file, false, false, failure)) return false;
    DWORD attributes = 0;
    if (!GetFileAttributesFromHandle(file, &attributes)) { *failure = FromLastError(); return false; }
    if ((attributes & FILE_ATTRIBUTE_READONLY) != 0) {
      *failure = AccessDenied(); failure->stage = "browser_profile_cookie_write"; return false;
    }
    // Health checks coexist with Chromium's delete-sharing SQLite handles.
    // Bind metadata to the held handles and reject a changed identity between
    // the independent read/write opens; no payloads or DACLs are mutated here.
    HANDLE writer = INVALID_HANDLE_VALUE;
    if (!sharingLocked && !OpenRelativeComponent(network, name, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen, kFileNonDirectoryFile,
        nullptr, &writer, nullptr, failure)) {
      if (GetLastError() != ERROR_SHARING_VIOLATION) {
        failure->stage = "browser_profile_cookie_write"; return false;
      }
      *cookieBusy = true;
    }
    if (writer != INVALID_HANDLE_VALUE) {
      HandleIdentity left, right;
      const bool same = GetIdentity(file, &left) && GetIdentity(writer, &right) && EqualIdentity(left, right);
      CloseHandle(writer);
      if (!same) { *failure = IdentityMismatch(); return false; }
    }
    if (held->entries.back().cookies) {
      LARGE_INTEGER bytes{};
      if (!GetFileSizeEx(file, &bytes) || bytes.QuadPart < 0) { *failure = OperationFailed(); return false; }
      *cookiePresent = true;
      *cookieBytes = static_cast<std::size_t>(bytes.QuadPart);
    }
  }
  return true;
}

napi_value BrowserProfileCallback(napi_env env, napi_callback_info info, bool migration) {
  std::vector<napi_value> arguments;
  std::wstring path;
  if (!GetArguments(env, info, &arguments, 1) || !GetString(env, arguments[0], &path))
    return ThrowFailure(env, InvalidConfiguration());
  ParsedPath parsed;
  Failure failure = OperationFailed();
  if (!ParsePath(path, &parsed)) return ThrowFailure(env, InvalidPath());
  RelativeHandles prepared;
  HandleIdentity preparedIdentity;
  if (migration) {
    if (!EnsureDirectoryPath(parsed, &prepared.final, &preparedIdentity, &failure)) return ThrowFailure(env, failure);
    // Newly-created directory handles carry DELETE for failure cleanup; close
    // that handle before acquiring the non-delete-sharing migration handle.
    // Its recorded identity must still match before any profile mutation.
    CloseHandle(prepared.final);
    prepared.final = INVALID_HANDLE_VALUE;
  }
  RelativeHandles opened;
  OpenRelativeOptions options;
  options.finalDirectoryKnown = true;
  options.finalDirectory = true;
  options.access = kDirectoryTraversalAccess | (migration ? WRITE_DAC : FILE_ADD_FILE);
  options.shareMode = FILE_SHARE_READ | (migration ? 0 : FILE_SHARE_WRITE);
  options.protectedAncestorDepth = parsed.components.size();
  options.protectedAncestorShareMode = FILE_SHARE_READ | FILE_SHARE_WRITE;
  bool missing = false;
  if (!OpenRelativePath(parsed, options, &opened, &missing, &failure)
      || missing || !ResolveFinalPath(opened.final, &parsed)) return ThrowFailure(env, failure);
  if (migration) {
    HandleIdentity observed;
    if (!GetIdentity(opened.final, &observed) || !EqualIdentity(preparedIdentity, observed))
      return ThrowFailure(env, IdentityMismatch());
  }
  SecuritySnapshot rootSecurity;
  if (!ReadSecurity(opened.final, &rootSecurity) || !rootSecurity.daclProtected)
    return ThrowFailure(env, SecurityPolicy("browser_profile_root_protection"));
  if (!ValidateBrowserProfileSecurity(opened.final, migration, true, &failure)) return ThrowFailure(env, failure);
  BrowserProfileHandles held;
  held.entries.push_back({opened.releaseFinal(), true, false, 0});
  std::size_t cookieBytes = 0;
  bool cookiePresent = false;
  bool cookieBusy = false;
  if (migration) {
    if (!EnumerateBrowserProfile(&held, true, &failure, &cookieBytes)) {
      if (failure.code != "BROWSER_PROFILE_BOUND_EXCEEDED") return ThrowFailure(env, failure);
      // Release traversal children before requesting cache DELETE handles, but
      // retain the authenticated root and all its already-held ancestors.
      for (std::size_t i = 1; i < held.entries.size(); ++i) CloseHandle(held.entries[i].handle);
      held.entries.resize(1);
      const bool cleanupComplete = PruneDisposableBrowserCaches(held.entries[0].handle, &failure);
      if (!cleanupComplete && failure.code != "BROWSER_PROFILE_CACHE_CLEANUP_PENDING") return ThrowFailure(env, failure);
      cookieBytes = 0;
      failure = OperationFailed();
      if (!EnumerateBrowserProfile(&held, true, &failure, &cookieBytes)) {
        if (!cleanupComplete && failure.code == "BROWSER_PROFILE_BOUND_EXCEEDED") {
          failure = {"BROWSER_PROFILE_CACHE_CLEANUP_PENDING"};
          failure.stage = "browser_profile_cache_budget";
        }
        return ThrowFailure(env, failure);
      }
    }
    cookiePresent = std::any_of(held.entries.begin(), held.entries.end(), [](const auto& entry) { return entry.cookies; });
  } else if (!InspectBrowserCookieStorage(&held, &failure, &cookiePresent, &cookieBytes, &cookieBusy)) return ThrowFailure(env, failure);
  if (migration) {
    // Each object is preflighted before its mutation. Legacy directories may
    // already have needed owner-only repair to permit bounded enumeration.
    // A partial OS failure retains owner-only ACLs and is explicitly retriable.
    // Child names cannot be replaced while their non-delete-sharing handles live.
    for (auto& entry : held.entries) {
      if (!SetBrowserProfileDacl(entry.handle, entry.directory)
          || !ValidateBrowserProfileSecurity(entry.handle, false, entry.directory, &failure)) {
        if (failure.code == OperationFailed().code) failure = FromLastError();
        return ThrowFailure(env, failure);
      }
    }
  }
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_uint32(env, static_cast<uint32_t>(held.entries.size()), &value);
  napi_set_named_property(env, result, "entries", value);
  napi_get_boolean(env, cookiePresent, &value);
  napi_set_named_property(env, result, "cookieDatabasePresent", value);
  napi_get_boolean(env, cookieBusy, &value);
  napi_set_named_property(env, result, "cookieDatabaseBusy", value);
  napi_create_double(env, static_cast<double>(cookieBytes), &value);
  napi_set_named_property(env, result, "cookieDatabaseBytes", value);
  return result;
}
napi_value PrepareBrowserProfileCallback(napi_env env, napi_callback_info info) {
  return BrowserProfileCallback(env, info, true);
}
napi_value InspectBrowserProfileCallback(napi_env env, napi_callback_info info) {
  return BrowserProfileCallback(env, info, false);
}

void DefineMethod(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function);
  napi_set_named_property(env, exports, name, function);
}

#include "usage-freeze.inc"

} // namespace

NAPI_MODULE_INIT() {
  DefineMethod(env, exports, "openUsageFreezeDirectory", OpenUsageDirectoryCallback);
  DefineMethod(env, exports, "reopenUsageFreezeDirectory", ReopenUsageDirectoryCallback);
  DefineMethod(env, exports, "openUsageFreezeParentDirectory", OpenUsageParentCallback);
  DefineMethod(env, exports, "reopenUsageFreezeParentDirectory", ReopenUsageParentCallback);
  DefineMethod(env, exports, "openLegacyUsageFreezeParentDirectory", OpenLegacyUsageParentCallback);
  DefineMethod(env, exports, "reopenLegacyUsageFreezeParentDirectory", ReopenLegacyUsageParentCallback);
  DefineMethod(env, exports, "readUsageFreezeDirectorySecurity", ReadUsageDirectorySecurityCallback);
  DefineMethod(env, exports, "inspectUsageFreezeSourcePolicy", InspectUsageSourcePolicyCallback);
  DefineMethod(env, exports, "sealUsageFreezeParentDirectory", SealUsageParentCallback);
  DefineMethod(env, exports, "applyUsageDirectoryFreeze", ApplyUsageFreezeCallback);
  DefineMethod(env, exports, "restoreUsageDirectoryFreeze", RestoreUsageFreezeCallback);
  DefineMethod(env, exports, "closeUsageFreezeDirectory", CloseUsageDirectoryCallback);
  DefineMethod(env, exports, "readUsageChildSecurity", ReadUsageChildSecurityCallback);
  DefineMethod(env, exports, "openUsageFreezeChildDirectory", OpenUsageChildDirectoryCallback);
  DefineMethod(env, exports, "reopenUsageFreezeChildDirectory", ReopenUsageChildDirectoryCallback);
  DefineMethod(env, exports, "listUsageFreezeChildren", ListUsageChildrenCallback);
  DefineMethod(env, exports, "openUsageFreezeChildFile", OpenUsageChildFileCallback);
  DefineMethod(env, exports, "reopenUsageFreezeChildFile", ReopenUsageChildFileCallback);
  DefineMethod(env, exports, "openUsageFreezeSnapshotFile", OpenUsageSnapshotFileCallback);
  DefineMethod(env, exports, "reopenUsageFreezeSnapshotFile", ReopenUsageSnapshotFileCallback);
  DefineMethod(env, exports, "borrowUsageFrozenObjectFile", BorrowUsageObjectFileCallback);
  DefineMethod(env, exports, "borrowUsageFrozenDirectory", BorrowUsageDirectoryCallback);
  DefineMethod(env, exports, "usageFreezeObjectState", UsageFreezeStateCallback);
  napi_value usageFreezeVersion;
  napi_create_string_utf8(env, "windows-usage-directory-freeze-qualification-v1", NAPI_AUTO_LENGTH, &usageFreezeVersion);
  napi_set_named_property(env, exports, "usageFreezeQualificationContractVersion", usageFreezeVersion);
  DefineMethod(env, exports, "inspectPath", InspectPathCallback);
  DefineMethod(env, exports, "ensureDirectory", EnsureDirectoryCallback);
  DefineMethod(env, exports, "prepareBrowserProfile", PrepareBrowserProfileCallback);
  DefineMethod(env, exports, "inspectBrowserProfile", InspectBrowserProfileCallback);
  napi_value browserProfileVersion;
  napi_create_string_utf8(env, "windows-browser-profile-v2", NAPI_AUTO_LENGTH, &browserProfileVersion);
  napi_set_named_property(env, exports, "browserProfileContractVersion", browserProfileVersion);
  DefineMethod(env, exports, "readFile", ReadFileCallback);
  DefineMethod(env, exports, "createFile", CreateFileCallback);
  DefineMethod(env, exports, "deleteFile", DeleteFileCallback);
  DefineMethod(env, exports, "replaceFile", ReplaceFileCallback);
  DefineMethod(env, exports, "publishReport", PublishReportCallback);
  napi_value reportPublicationVersion;
  napi_create_string_utf8(
      env,
      "windows-report-publication-v1",
      NAPI_AUTO_LENGTH,
      &reportPublicationVersion);
  napi_set_named_property(
      env,
      exports,
      "reportPublicationContractVersion",
      reportPublicationVersion);
  DefineMethod(env, exports, "inspectProtectedChild", InspectProtectedChildCallback);
  DefineMethod(env, exports, "readProtectedChild", ReadProtectedChildCallback);
  DefineMethod(env, exports, "createProtectedChild", CreateProtectedChildCallback);
  DefineMethod(env, exports, "deleteProtectedChild", DeleteProtectedChildCallback);
  DefineMethod(env, exports, "replaceProtectedChild", ReplaceProtectedChildCallback);
  DefineMethod(
      env,
      exports,
      "acquireCredentialAuditFileGuard",
      AcquireCredentialAuditFileGuardCallback);
  DefineMethod(
      env,
      exports,
      "releaseCredentialAuditFileGuard",
      ReleaseCredentialAuditFileGuardCallback);
  DefineMethod(env, exports, "acquireCredentialMutex", AcquireCredentialMutexCallback);
  DefineMethod(env, exports, "releaseCredentialMutex", ReleaseCredentialMutexCallback);
  DefineMethod(
      env,
      exports,
      "acquireAccountlessInstallationCredentialMutex",
      AcquireAccountlessInstallationCredentialMutexCallback);
  DefineMethod(
      env,
      exports,
      "releaseAccountlessInstallationCredentialMutex",
      ReleaseAccountlessInstallationCredentialMutexCallback);
  DefineMethod(env, exports, "openSourceFile", OpenSourceFileCallback);
  DefineMethod(env, exports, "openLegacyStateFile", OpenLegacyStateFileCallback);
  DefineMethod(env, exports, "copyLegacyStateFile", CopyLegacyStateFileCallback);
  DefineMethod(env, exports, "acquireLegacyStateDirectoryGuard", AcquireLegacyStateDirectoryGuardCallback);
  DefineMethod(env, exports, "legacyStateRootsDisjoint", LegacyStateRootsDisjointCallback);
  napi_value legacyStateVersion;
  napi_create_string_utf8(env, "windows-legacy-state-read-v1", NAPI_AUTO_LENGTH, &legacyStateVersion);
  napi_set_named_property(env, exports, "legacyStateReadContractVersion", legacyStateVersion);
  DefineMethod(env, exports, "statSourceFile", StatSourceFileCallback);
  DefineMethod(env, exports, "readSourceFile", ReadSourceFileCallback);
  DefineMethod(env, exports, "closeSourceFile", CloseSourceFileCallback);
  DefineMethod(env, exports, "acquireProtectedDirectoryGuard", AcquireProtectedDirectoryGuardCallback);
  DefineMethod(env, exports, "releaseProtectedDirectoryGuard", ReleaseProtectedDirectoryGuardCallback);
  DefineMethod(env, exports, "acquireProtectedChildGuard", AcquireProtectedChildGuardCallback);
  napi_value directoryGuardVersion;
  napi_create_string_utf8(env, "windows-protected-directory-guard-v1", NAPI_AUTO_LENGTH, &directoryGuardVersion);
  napi_set_named_property(env, exports, "protectedDirectoryGuardContractVersion", directoryGuardVersion);
  napi_value sourceVersion;
  napi_create_string_utf8(env, "windows-source-read-v1", NAPI_AUTO_LENGTH, &sourceVersion);
  napi_set_named_property(env, exports, "sourceReadContractVersion", sourceVersion);
  napi_value version;
  napi_create_string_utf8(env, "windows-filesystem-v1", NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "contractVersion", version);
  napi_value securityVersion;
  napi_create_string_utf8(env, "windows-filesystem-security-v1", NAPI_AUTO_LENGTH, &securityVersion);
  napi_set_named_property(env, exports, "securityContractVersion", securityVersion);
  napi_value credentialMutexVersion;
  napi_create_string_utf8(
      env,
      "windows-credential-mutex-v1",
      NAPI_AUTO_LENGTH,
      &credentialMutexVersion);
  napi_set_named_property(
      env,
      exports,
      "credentialMutexContractVersion",
      credentialMutexVersion);
  napi_value credentialAuditGuardVersion;
  napi_create_string_utf8(
      env,
      "windows-credential-audit-file-guard-v1",
      NAPI_AUTO_LENGTH,
      &credentialAuditGuardVersion);
  napi_set_named_property(
      env,
      exports,
      "credentialAuditFileGuardContractVersion",
      credentialAuditGuardVersion);
  napi_value productionSafe;
  napi_value pathWalkRaceSafe;
  napi_value credentialMutexSafe;
  napi_get_boolean(env, false, &productionSafe);
  napi_get_boolean(env, false, &pathWalkRaceSafe);
  napi_get_boolean(env, true, &credentialMutexSafe);
  napi_set_named_property(env, exports, "productionSafe", productionSafe);
  napi_set_named_property(env, exports, "pathWalkRaceSafe", pathWalkRaceSafe);
  napi_set_named_property(env, exports, "credentialMutexSafe", credentialMutexSafe);
  napi_value credentialAuditFileGuardSafe;
  napi_get_boolean(env, true, &credentialAuditFileGuardSafe);
  napi_set_named_property(
      env,
      exports,
      "credentialAuditFileGuardSafe",
      credentialAuditFileGuardSafe);
  return exports;
}
