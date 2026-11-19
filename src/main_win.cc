#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#include "include/cef_app.h"
#include "include/cef_command_line.h"

#include "config_store.h"
#include "crpdf_app.h"
#include "http_server.h"

namespace {

int ParseIntSwitch(CefRefPtr<CefCommandLine> cmd,
                   const char* name,
                   int default_val) {
  if (!cmd->HasSwitch(name)) return default_val;
  std::string val = cmd->GetSwitchValue(name).ToString();
  if (val.empty()) return default_val;
  char* end = nullptr;
  long parsed = std::strtol(val.c_str(), &end, 10);
  if (end == val.c_str()) return default_val;
  return static_cast<int>(parsed);
}

std::string ResolveWebDir() {
  std::error_code ec;
  wchar_t exe_buf[MAX_PATH];
  DWORD len = ::GetModuleFileNameW(nullptr, exe_buf, MAX_PATH);
  if (len > 0 && len < MAX_PATH) {
    std::filesystem::path exe_dir =
        std::filesystem::path(std::wstring(exe_buf, len)).parent_path();
    std::filesystem::path candidate = exe_dir / L"web";
    if (std::filesystem::is_directory(candidate, ec)) {
      return crpdf::PathToUtf8(candidate);
    }
  }
  std::filesystem::path cwd_web = std::filesystem::current_path(ec) / L"web";
  if (std::filesystem::is_directory(cwd_web, ec)) {
    return crpdf::PathToUtf8(cwd_web);
  }
  return "";
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE hInstance,
                      HINSTANCE hPrevInstance,
                      LPWSTR lpCmdLine,
                      int nCmdShow) {
  (void)hPrevInstance;
  (void)lpCmdLine;
  (void)nCmdShow;

  CefMainArgs main_args(hInstance);

  // Sub-processes exit immediately before starting the embedded HTTP server.
  int exit_code = CefExecuteProcess(main_args, nullptr, nullptr);
  if (exit_code >= 0) {
    return exit_code;
  }

  CefRefPtr<CefCommandLine> cmd = CefCommandLine::CreateCommandLine();
  cmd->InitFromString(::GetCommandLineW());

  std::string save_dir_override =
      cmd->HasSwitch("save-dir") ? cmd->GetSwitchValue("save-dir").ToString()
                                 : "";
  int requested_port = ParseIntSwitch(cmd, "port", 0);
  if (requested_port < 0 || requested_port > 65535) requested_port = 0;

  int autosave_override = ParseIntSwitch(cmd, "autosave-interval", -1);
  int remote_debug_port = ParseIntSwitch(cmd, "remote-debugging-port", 0);
  if (remote_debug_port < 0 || remote_debug_port > 65535) remote_debug_port = 0;

  bool no_sandbox = cmd->HasSwitch("no-sandbox");
  bool disable_gpu = cmd->HasSwitch("disable-gpu");
  std::string open_arg =
      cmd->HasSwitch("open") ? cmd->GetSwitchValue("open").ToString() : "";

  crpdf::ConfigStore config_store;
  config_store.Load();
  config_store.ApplyCliOverrides(save_dir_override, autosave_override);

  std::string save_dir = config_store.GetSaveDir();
  std::string initial_path = "/";

  if (!open_arg.empty()) {
    std::error_code ec;
    std::filesystem::path src_path = crpdf::PathFromUtf8(open_arg);
    if (std::filesystem::exists(src_path, ec) &&
        std::filesystem::is_regular_file(src_path, ec)) {
      std::string filename = crpdf::PathToUtf8(src_path.filename());
      if (!crpdf::IsSafeFilename(filename)) {
        filename = crpdf::SanitizeNotebookTitle(filename);
        if (filename.size() < 4 ||
            filename.compare(filename.size() - 4, 4, ".pdf") != 0) {
          filename += ".pdf";
        }
      }
      std::filesystem::path dest_path =
          crpdf::PathFromUtf8(save_dir) / crpdf::PathFromUtf8(filename);
      std::filesystem::path canon_src =
          std::filesystem::weakly_canonical(src_path, ec);
      std::filesystem::path canon_dest =
          std::filesystem::weakly_canonical(dest_path, ec);
      if (canon_src != canon_dest) {
        std::filesystem::copy_file(
            src_path, dest_path,
            std::filesystem::copy_options::overwrite_existing, ec);
      }
      initial_path = "/pdf/" + crpdf::UrlEncodePathSegment(filename);
    }
  }

  std::string web_dir = ResolveWebDir();
  crpdf::HttpServer server(&config_store, web_dir);
  if (!server.Start(static_cast<uint16_t>(requested_port))) {
    return 1;
  }

  crpdf::CrPdfAppOptions options;
  options.initial_url = server.base_url() + initial_path;
  options.save_dir = save_dir;
  options.remote_debugging_port = remote_debug_port;
  options.no_sandbox = no_sandbox;
  options.disable_gpu = disable_gpu;

  CefSettings settings;
  settings.no_sandbox = true;
  CefString(&settings.user_agent_product).FromASCII("Chrome/150.0.0.0 CR-pdf v1.0");
  settings.log_severity = LOGSEVERITY_WARNING;
  {
    wchar_t exe_buf[MAX_PATH];
    DWORD len = ::GetModuleFileNameW(nullptr, exe_buf, MAX_PATH);
    if (len > 0 && len < MAX_PATH) {
      std::filesystem::path log_path =
          std::filesystem::path(std::wstring(exe_buf, len)).parent_path() / L"crpdf_debug.log";
      CefString(&settings.log_file).FromString(crpdf::PathToUtf8(log_path));
    }
  }

  std::filesystem::path cache_dir =
      (options.remote_debugging_port > 0)
          ? (crpdf::PathFromUtf8(options.save_dir) / L".crpdf_cache")
          : (config_store.GetConfigDir() / L"cef_cache");
  std::error_code ec;
  std::filesystem::create_directories(cache_dir, ec);
  CefString(&settings.root_cache_path).FromString(crpdf::PathToUtf8(cache_dir));

  if (options.remote_debugging_port > 0) {
    settings.remote_debugging_port = options.remote_debugging_port;
  }

  CefRefPtr<crpdf::CrPdfApp> app(new crpdf::CrPdfApp(options, &config_store));
  if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
    server.Stop();
    return CefGetExitCode();
  }

  CefRunMessageLoop();

  CefShutdown();
  server.Stop();
  return 0;
}
