#ifndef CRPDF_CRPDF_APP_H_
#define CRPDF_CRPDF_APP_H_

#include <string>

#include "include/cef_app.h"
#include "include/cef_browser_process_handler.h"

#include "config_store.h"

namespace crpdf {

struct CrPdfAppOptions {
  std::string initial_url;
  std::string save_dir;
  int remote_debugging_port = 0;
  bool no_sandbox = false;
  bool disable_gpu = false;
};

class CrPdfApp : public CefApp, public CefBrowserProcessHandler {
 public:
  CrPdfApp(CrPdfAppOptions options, ConfigStore* config_store);

  // CefApp
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }
  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override;

  // CefBrowserProcessHandler
  void OnContextInitialized() override;
  CefRefPtr<CefClient> GetDefaultClient() override;

 private:
  void ConfigureRequestContextPreferences(
      CefRefPtr<CefRequestContext> context);

  CrPdfAppOptions options_;
  ConfigStore* config_store_;

  IMPLEMENT_REFCOUNTING(CrPdfApp);
};

}  // namespace crpdf

#endif  // CRPDF_CRPDF_APP_H_
