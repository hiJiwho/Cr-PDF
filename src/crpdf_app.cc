#include "crpdf_app.h"

#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/cef_request_context.h"
#include "include/cef_values.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_browser_view_delegate.h"
#include "include/views/cef_window.h"
#include "include/views/cef_window_delegate.h"
#include "include/wrapper/cef_helpers.h"

#include "crpdf_client.h"

namespace crpdf {

namespace {

void SetBoolPref(CefRefPtr<CefRequestContext> ctx,
                 const char* name,
                 bool val) {
  if (!ctx || !ctx->CanSetPreference(name)) return;
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetBool(val);
  CefString err;
  ctx->SetPreference(name, v, err);
}

void SetStringPref(CefRefPtr<CefRequestContext> ctx,
                   const char* name,
                   const std::string& val) {
  if (!ctx || !ctx->CanSetPreference(name)) return;
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetString(val);
  CefString err;
  ctx->SetPreference(name, v, err);
}

void SetIntPref(CefRefPtr<CefRequestContext> ctx, const char* name, int val) {
  if (!ctx || !ctx->CanSetPreference(name)) return;
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetInt(val);
  CefString err;
  ctx->SetPreference(name, v, err);
}

class CrPdfWindowDelegate : public CefWindowDelegate {
 public:
  CrPdfWindowDelegate(CefRefPtr<CefBrowserView> browser_view,
                      bool is_popup,
                      bool is_devtools)
      : browser_view_(browser_view),
        is_popup_(is_popup),
        is_devtools_(is_devtools) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->AddChildView(browser_view_);
    if (is_devtools_) {
      window->SetTitle("DevTools");
    } else if (is_popup_) {
      window->SetTitle(CefString(L"[화면공유용] 판서 화면"));
    } else {
      window->SetTitle("Cr-PDF");
    }
    window->Show();
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    (void)window;
    browser_view_ = nullptr;
  }

  bool CanClose(CefRefPtr<CefWindow> window) override {
    (void)window;
    if (browser_view_) {
      CefRefPtr<CefBrowser> browser = browser_view_->GetBrowser();
      if (browser) {
        return browser->GetHost()->TryCloseBrowser();
      }
    }
    return true;
  }

  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    (void)view;
    return is_popup_ ? CefSize(1024, 768) : CefSize(1280, 800);
  }

  bool IsFrameless(CefRefPtr<CefWindow> window) override {
    (void)window;
    return false;
  }

  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

 private:
  CefRefPtr<CefBrowserView> browser_view_;
  bool is_popup_;
  bool is_devtools_;

  IMPLEMENT_REFCOUNTING(CrPdfWindowDelegate);
};

class CrPdfBrowserViewDelegate : public CefBrowserViewDelegate {
 public:
  CrPdfBrowserViewDelegate() = default;

  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

  ChromeToolbarType GetChromeToolbarType(
      CefRefPtr<CefBrowserView> browser_view) override {
    (void)browser_view;
    return CEF_CTT_NONE;
  }

  CefRefPtr<CefBrowserViewDelegate> GetDelegateForPopupBrowserView(
      CefRefPtr<CefBrowserView> browser_view,
      const CefBrowserSettings& settings,
      CefRefPtr<CefClient> client,
      bool is_devtools) override {
    (void)browser_view;
    (void)settings;
    (void)client;
    (void)is_devtools;
    return new CrPdfBrowserViewDelegate();
  }

  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowserView> popup_browser_view,
                                 bool is_devtools) override {
    (void)browser_view;
    CefWindow::CreateTopLevelWindow(new CrPdfWindowDelegate(
        popup_browser_view, /*is_popup=*/true, is_devtools));
    return true;
  }

 private:
  IMPLEMENT_REFCOUNTING(CrPdfBrowserViewDelegate);
};

}  // namespace

CrPdfApp::CrPdfApp(CrPdfAppOptions options, ConfigStore* config_store)
    : options_(std::move(options)), config_store_(config_store) {}

void CrPdfApp::OnBeforeCommandLineProcessing(
    const CefString& process_type,
    CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) return;

  // Always enable PdfInk2 without clobbering any existing --enable-features.
  if (command_line->HasSwitch("enable-features")) {
    std::string existing = command_line->GetSwitchValue("enable-features");
    if (existing.find("PdfInk2") == std::string::npos) {
      if (!existing.empty()) existing += ",";
      existing += "PdfInk2";
      command_line->AppendSwitchWithValue("enable-features", existing);
    }
  } else {
    command_line->AppendSwitchWithValue("enable-features", "PdfInk2");
  }

  // Prevent Windows Surface GPU process crash (exit_code=-2147483645 / virtualization failure)
#ifdef _WIN32
  if (!command_line->HasSwitch("enable-gpu") && !command_line->HasSwitch("disable-gpu")) {
    command_line->AppendSwitch("disable-gpu");
  }
#endif
  if (!command_line->HasSwitch("disable-gpu-sandbox")) {
    command_line->AppendSwitch("disable-gpu-sandbox");
  }
  if (command_line->HasSwitch("disable-features")) {
    std::string df = command_line->GetSwitchValue("disable-features");
    if (df.find("SkiaGraphite") == std::string::npos) {
      if (!df.empty()) df += ",";
      df += "SkiaGraphite";
      command_line->AppendSwitchWithValue("disable-features", df);
    }
  } else {
    command_line->AppendSwitchWithValue("disable-features", "SkiaGraphite");
  }

  if (!command_line->HasSwitch("overscroll-history-navigation")) {
    command_line->AppendSwitchWithValue("overscroll-history-navigation", "0");
  }

  if (options_.no_sandbox && !command_line->HasSwitch("no-sandbox")) {
    command_line->AppendSwitch("no-sandbox");
  }
  if (options_.disable_gpu && !command_line->HasSwitch("disable-gpu")) {
    command_line->AppendSwitch("disable-gpu");
  }
  if (options_.remote_debugging_port > 0 &&
      !command_line->HasSwitch("remote-debugging-port")) {
    command_line->AppendSwitchWithValue(
        "remote-debugging-port",
        std::to_string(options_.remote_debugging_port));
  }
}

void CrPdfApp::ConfigureRequestContextPreferences(
    CefRefPtr<CefRequestContext> context) {
  SetBoolPref(context, "download.prompt_for_download", false);
  if (!options_.save_dir.empty()) {
    SetStringPref(context, "download.default_directory", options_.save_dir);
  }
  SetBoolPref(context, "download_bubble.partial_view_enabled", false);
  SetBoolPref(context, "download_bubble_enabled", false);
  SetBoolPref(context, "plugins.always_open_pdf_externally", false);
  SetIntPref(context, "profile.default_content_setting_values.automatic_downloads",
             1);
  SetIntPref(context, "profile.default_content_setting_values.popups", 1);
}

void CrPdfApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();

  ConfigureRequestContextPreferences(CefRequestContext::GetGlobalContext());

  CefRefPtr<CrPdfClient> client(new CrPdfClient(config_store_));
  CefBrowserSettings browser_settings;

  CefRefPtr<CefBrowserView> browser_view = CefBrowserView::CreateBrowserView(
      client, options_.initial_url, browser_settings, nullptr, nullptr,
      new CrPdfBrowserViewDelegate());

  CefWindow::CreateTopLevelWindow(new CrPdfWindowDelegate(
      browser_view, /*is_popup=*/false, /*is_devtools=*/false));
}

CefRefPtr<CefClient> CrPdfApp::GetDefaultClient() {
  return CrPdfClient::GetInstance();
}

}  // namespace crpdf
