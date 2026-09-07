// Each invocation owns one process tree. No privileges or filesystem access are granted here.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <vector>

class Handle {
public:
  HANDLE value = nullptr;
  explicit Handle(HANDLE handle = nullptr) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

// Windows CRT argv quoting; the executable is passed separately to CreateProcessW.
static std::wstring quote(const wchar_t* argument) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const wchar_t* cursor = argument; *cursor; ++cursor) {
    if (*cursor == L'\\') { ++slashes; continue; }
    if (*cursor == L'"') result.append(slashes * 2 + 1, L'\\');
    else result.append(slashes, L'\\');
    result += *cursor;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L"\"";
}

static int failure(const char* operation) {
  const DWORD error = GetLastError();
  std::fprintf(stderr, "VELAROS_PROCESS_HOST: %s failed (%lu)\n", operation, error);
  return 125;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--version") {
    std::puts("velaros-process-host 1");
    return 0;
  }
  if (argc < 5 || std::wstring(argv[1]) != L"--parent-pid") return 125;
  const bool verbatim = std::wstring(argv[3]) == L"--verbatim-arguments";
  const int executableIndex = verbatim ? 5 : 4;
  if (argc <= executableIndex || std::wstring(argv[executableIndex - 1]) != L"--") return 125;
  wchar_t* end = nullptr;
  const unsigned long parentId = std::wcstoul(argv[2], &end, 10);
  if (!parentId || !end || *end || parentId == GetCurrentProcessId()) return 125;
  Handle parent(OpenProcess(SYNCHRONIZE, FALSE, parentId));
  if (!parent.value) return failure("open parent");
  if (WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT) return 125;

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.value) return failure("create job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                              &limits, sizeof(limits))) return failure("configure job");

  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
  std::vector<unsigned char> storage(attributeBytes);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &attributeBytes))
    return failure("initialize attributes");
  struct AttributeCleanup {
    LPPROC_THREAD_ATTRIBUTE_LIST value;
    ~AttributeCleanup() { DeleteProcThreadAttributeList(value); }
  } cleanup{attributes};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job.value, sizeof(job.value), nullptr, nullptr))
    return failure("assign job at creation");

  // Inherit only stdio. In particular, the child must never inherit the Job handle.
  HANDLE standardHandles[3]{};
  const DWORD identifiers[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int index = 0; index < 3; ++index) {
    HANDLE original = GetStdHandle(identifiers[index]);
    if (!original || original == INVALID_HANDLE_VALUE ||
        !DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(),
                         &standardHandles[index], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      for (auto handle : standardHandles) if (handle) CloseHandle(handle);
      return failure("duplicate stdio");
    }
  }
  Handle input(standardHandles[0]), output(standardHandles[1]), error(standardHandles[2]);
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 standardHandles, sizeof(standardHandles), nullptr, nullptr))
    return failure("restrict inherited handles");

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = output.value;
  startup.StartupInfo.hStdError = error.value;
  startup.lpAttributeList = attributes;
  // lpApplicationName does not search PATH. Resolve native tool names before creating them.
  const DWORD executableLength = SearchPathW(nullptr, argv[executableIndex], L".exe", 0, nullptr, nullptr);
  if (!executableLength) return failure("resolve executable");
  std::vector<wchar_t> executable(executableLength + 1);
  if (!SearchPathW(nullptr, argv[executableIndex], L".exe", static_cast<DWORD>(executable.size()), executable.data(), nullptr))
    return failure("resolve executable");
  std::wstring command;
  for (int index = executableIndex; index < argc; ++index) {
    if (index > executableIndex) command += L' ';
    command += verbatim && index > executableIndex ? std::wstring(argv[index]) : quote(argv[index]);
  }
  PROCESS_INFORMATION information{};
  if (!CreateProcessW(executable.data(), command.data(), nullptr, nullptr, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE,
                      nullptr, nullptr, &startup.StartupInfo, &information))
    return failure("create child");
  Handle child(information.hProcess), thread(information.hThread);
  HANDLE watched[] = {parent.value, child.value};
  const DWORD completed = WaitForMultipleObjects(2, watched, FALSE, INFINITE);
  DWORD exitCode = 125;
  if (completed == WAIT_OBJECT_0 + 1) GetExitCodeProcess(child.value, &exitCode);
  // The root's lifetime defines its tree's lifetime. Surviving descendants are reaped.
  if (!TerminateJobObject(job.value, exitCode)) return failure("terminate job");
  WaitForSingleObject(child.value, 5000);
  return static_cast<int>(exitCode);
}
