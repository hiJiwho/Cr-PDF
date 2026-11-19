#include "crpdf_client.h"

#include <chrono>
#include <filesystem>

#include "include/cef_app.h"
#include "include/cef_base.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/views/cef_browser_view_delegate.h"
#include "include/views/cef_window_delegate.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/base/cef_callback.h"

namespace crpdf {

namespace {

CrPdfClient* g_client_instance = nullptr;

bool IsTrustedOrigin(const std::string& origin) {
  if (origin.compare(0, 16, "http://127.0.0.1") == 0) return true;
  if (origin.compare(0, 16, "http://localhost") == 0) return true;
  if (origin.compare(0, 51,
                     "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai") ==
      0) {
    return true;
  }
  return false;
}

}  // namespace

CrPdfClient::CrPdfClient(ConfigStore* config_store)
    : config_store_(config_store) {
  g_client_instance = this;
}

CrPdfClient::~CrPdfClient() {
  if (g_client_instance == this) {
    g_client_instance = nullptr;
  }
}

CrPdfClient* CrPdfClient::GetInstance() { return g_client_instance; }

void CrPdfClient::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser || browser->GetIdentifier() != main_browser_id_) {
    return;
  }
  if (auto browser_view = CefBrowserView::GetForBrowser(browser)) {
    if (auto window = browser_view->GetWindow()) {
      window->SetTitle(title);
    }
  }
}

void CrPdfClient::OnFullscreenModeChange(CefRefPtr<CefBrowser> browser,
                                         bool fullscreen) {
  CEF_REQUIRE_UI_THREAD();
  if (auto browser_view = CefBrowserView::GetForBrowser(browser)) {
    if (auto window = browser_view->GetWindow()) {
      window->SetFullscreen(fullscreen);
    }
  }
}

bool CrPdfClient::OnBeforePopup(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                int popup_id,
                                const CefString& target_url,
                                const CefString& target_frame_name,
                                WindowOpenDisposition target_disposition,
                                bool user_gesture,
                                const CefPopupFeatures& popupFeatures,
                                CefWindowInfo& windowInfo,
                                CefRefPtr<CefClient>& client,
                                CefBrowserSettings& settings,
                                CefRefPtr<CefDictionaryValue>& extra_info,
                                bool* no_javascript_access) {
  (void)browser;
  (void)frame;
  (void)popup_id;
  (void)target_url;
  (void)target_frame_name;
  (void)target_disposition;
  (void)user_gesture;
  (void)popupFeatures;
  (void)windowInfo;
  (void)settings;
  (void)extra_info;
  (void)no_javascript_access;

  client = this;
  return false;  // Allow popup creation via Views delegate.
}

void CrPdfClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (main_browser_id_ == -1 && !browser->IsPopup()) {
    main_browser_id_ = browser->GetIdentifier();
  }
  browser_list_.push_back(browser);
}

bool CrPdfClient::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (browser && browser->GetIdentifier() == main_browser_id_) {
    if (!closing_with_save_) {
      std::string main_url;
      if (auto mf = browser->GetMainFrame()) {
        main_url = mf->GetURL().ToString();
      }
      if (main_url.find("/pdf/") != std::string::npos) {
        closing_with_save_ = true;
        if (pdf_extension_frame_ && pdf_extension_frame_->IsValid()) {
          pdf_extension_frame_->ExecuteJavaScript(
              "window.dispatchEvent(new CustomEvent('crpdf:save-now'));",
              pdf_extension_frame_->GetURL(), 0);
        }
        // Fallback timeout in case no download is triggered (e.g. PDF still loading)
        CefPostDelayedTask(
            TID_UI,
            base::BindOnce(
                [](CefRefPtr<CefBrowser> b) {
                  if (b && b->GetHost()) {
                    b->GetHost()->CloseBrowser(/*force_close=*/true);
                  }
                },
                browser),
            1200);
        return true;  // Cancel immediate close so async Ink2 save finishes
      }
    }
    // Close any open presenter popup windows when the main window closes.
    std::vector<CefRefPtr<CefBrowser>> popups;
    for (const auto& b : browser_list_) {
      if (b && b->GetIdentifier() != main_browser_id_) {
        popups.push_back(b);
      }
    }
    for (const auto& p : popups) {
      p->GetHost()->CloseBrowser(/*force_close=*/true);
    }
  }
  return false;
}

void CrPdfClient::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (browser && browser->GetIdentifier() == main_browser_id_) {
    pdf_extension_frame_ = nullptr;
  }
  for (auto it = browser_list_.begin(); it != browser_list_.end(); ++it) {
    if (*it && browser && (*it)->IsSame(browser)) {
      browser_list_.erase(it);
      break;
    }
  }
  if (browser_list_.empty()) {
    CefQuitMessageLoop();
  }
}

bool CrPdfClient::OnShowPermissionPrompt(
    CefRefPtr<CefBrowser> browser,
    uint64_t prompt_id,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefPermissionPromptCallback> callback) {
  (void)browser;
  (void)prompt_id;

  uint32_t auto_grant = CEF_PERMISSION_TYPE_WINDOW_MANAGEMENT |
                        CEF_PERMISSION_TYPE_FILE_SYSTEM_ACCESS |
                        CEF_PERMISSION_TYPE_MULTIPLE_DOWNLOADS;
#if CEF_API_ADDED(14500)
  auto_grant |= CEF_PERMISSION_TYPE_LOCAL_NETWORK |
                CEF_PERMISSION_TYPE_LOOPBACK_NETWORK;
#endif

  if (IsTrustedOrigin(requesting_origin.ToString()) &&
      (requested_permissions & auto_grant) != 0) {
    callback->Continue(CEF_PERMISSION_RESULT_ACCEPT);
    return true;
  }
  return false;
}

bool CrPdfClient::OnFileDialog(
    CefRefPtr<CefBrowser> browser,
    FileDialogMode mode,
    const CefString& title,
    const CefString& default_file_path,
    const std::vector<CefString>& accept_filters,
    const std::vector<CefString>& accept_extensions,
    const std::vector<CefString>& accept_descriptions,
    CefRefPtr<CefFileDialogCallback> callback) {
  (void)browser;
  (void)title;
  (void)accept_filters;
  (void)accept_extensions;
  (void)accept_descriptions;

  if (mode == FILE_DIALOG_SAVE) {
    std::string target = ResolveSafeSavePath(default_file_path.ToString());
    std::vector<CefString> files;
    files.emplace_back(target);
    callback->Continue(files);
    return true;
  }
  return false;
}

bool CrPdfClient::OnBeforeDownload(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefDownloadItem> download_item,
    const CefString& suggested_name,
    CefRefPtr<CefBeforeDownloadCallback> callback) {
  (void)browser;
  (void)download_item;

  std::string target = ResolveSafeSavePath(suggested_name.ToString());
  callback->Continue(CefString(target), /*show_dialog=*/false);
  return true;
}

void CrPdfClient::OnDownloadUpdated(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefDownloadItem> download_item,
    CefRefPtr<CefDownloadItemCallback> callback) {
  (void)callback;
  if (!download_item) return;
  if (download_item->IsComplete()) {
    if (!closing_with_save_) {
      if (pdf_extension_frame_ && pdf_extension_frame_->IsValid()) {
        pdf_extension_frame_->ExecuteJavaScript(
            "window.dispatchEvent(new CustomEvent('crpdf:save-completed'));",
            pdf_extension_frame_->GetURL(), 0);
      }
      ReloadPresenterWindows();
    }
  }
  if (closing_with_save_ &&
      (download_item->IsComplete() || download_item->IsCanceled())) {
    if (browser && browser->GetHost()) {
      browser->GetHost()->CloseBrowser(/*force_close=*/true);
    }
  }
}


void CrPdfClient::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            int httpStatusCode) {
  (void)httpStatusCode;
  if (!browser || !frame) return;
  std::string frame_url = frame->GetURL().ToString();
  if (frame_url.compare(0, 51,
                        "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai") != 0) {
    return;
  }
  if (browser->GetIdentifier() == main_browser_id_) {
    pdf_extension_frame_ = frame;
  }
  CefRefPtr<CefFrame> main_frame = browser->GetMainFrame();
  if (!main_frame) return;
  std::string main_url = main_frame->GetURL().ToString();
  if (main_url.compare(0, 16, "http://127.0.0.1") != 0) return;

  std::string js =
      "window.__CRPDF_HOST_URL__ = \"" + JsonEscape(main_url) + "\";"
      "window.dispatchEvent(new CustomEvent('crpdf:host-url', { detail: window.__CRPDF_HOST_URL__ }));";
  frame->ExecuteJavaScript(js, frame->GetURL(), 0);
}

void CrPdfClient::NavigateMainTo(const std::string& url) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI,
                base::BindOnce(&CrPdfClient::NavigateMainTo,
                               CefRefPtr<CrPdfClient>(this), url));
    return;
  }
  for (const auto& b : browser_list_) {
    if (b && b->GetIdentifier() == main_browser_id_) {
      if (auto mf = b->GetMainFrame()) {
        mf->LoadURL(url);
      }
      return;
    }
  }
}


namespace {
class PresenterWindowDelegate : public CefWindowDelegate {
 public:
  explicit PresenterWindowDelegate(CefRefPtr<CefBrowserView> view) : view_(view) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->AddChildView(view_);
    window->SetTitle(CefString(L"[화면공유용] 판서 화면"));
    window->Show();
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    (void)window;
    view_ = nullptr;
  }
  bool CanClose(CefRefPtr<CefWindow> window) override {
    (void)window;
    if (view_) {
      CefRefPtr<CefBrowser> browser = view_->GetBrowser();
      if (browser) {
        return browser->GetHost()->TryCloseBrowser();
      }
    }
    return true;
  }
  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    (void)view;
    return CefSize(1280, 800);
  }
  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }
 private:
  CefRefPtr<CefBrowserView> view_;
  IMPLEMENT_REFCOUNTING(PresenterWindowDelegate);
};

class PresenterBrowserViewDelegate : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }
  ChromeToolbarType GetChromeToolbarType(CefRefPtr<CefBrowserView> view) override {
    (void)view;
    return CEF_CTT_NONE;
  }
 private:
  IMPLEMENT_REFCOUNTING(PresenterBrowserViewDelegate);
};
}  // namespace

void CrPdfClient::OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                                      CefRefPtr<CefFrame> frame,
                                      CefRefPtr<CefContextMenuParams> params,
                                      CefRefPtr<CefMenuModel> model) {
  (void)browser;
  (void)frame;
  (void)params;
  if (model) model->Clear();
}

bool CrPdfClient::OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                                const CefKeyEvent& event,
                                CefEventHandle os_event,
                                bool* is_keyboard_shortcut) {
  (void)browser;
  (void)os_event;
  (void)is_keyboard_shortcut;
  // VK_BROWSER_BACK = 0xA6, VK_BROWSER_FORWARD = 0xA7
  if (event.windows_key_code == 0xA6 || event.windows_key_code == 0xA7) {
    return true;
  }
  // Alt + Left (0x25) or Alt + Right (0x27)
  if ((event.modifiers & EVENTFLAG_ALT_DOWN) != 0 &&
      (event.windows_key_code == 0x25 || event.windows_key_code == 0x27)) {
    return true;
  }
  return false;
}

void CrPdfClient::SetPresenterPage(int page) {
  if (page >= 1) {
    presenter_page_ = page;
  }
}

void CrPdfClient::OpenPresenterWindow(const std::string& url) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI,
                base::BindOnce(&CrPdfClient::OpenPresenterWindow,
                               CefRefPtr<CrPdfClient>(this), url));
    return;
  }
  // Strip any fragment or trailing &t= parameter from base presenter_url_
  std::string base = url;
  size_t hash_pos = base.find('#');
  if (hash_pos != std::string::npos) {
    base.resize(hash_pos);
  }
  presenter_url_ = base;

  auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch())
                    .count();
  std::string sep = (presenter_url_.find('?') == std::string::npos) ? "?" : "&";
  std::string target_url = presenter_url_ + sep + "t=" + std::to_string(now_ms) +
                           "#page=" + std::to_string(presenter_page_);

  // If a presenter window is already open, refresh it instead of opening duplicates.
  for (const auto& b : browser_list_) {
    if (b && b->GetIdentifier() != main_browser_id_) {
      if (auto mf = b->GetMainFrame()) {
        mf->LoadURL(target_url);
      }
      return;
    }
  }
  CefBrowserSettings settings;
  CefRefPtr<CefBrowserView> bv = CefBrowserView::CreateBrowserView(
      this, target_url, settings, nullptr, nullptr, new PresenterBrowserViewDelegate());
  CefWindow::CreateTopLevelWindow(new PresenterWindowDelegate(bv));
}

void CrPdfClient::ReloadPresenterWindows() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI,
                base::BindOnce(&CrPdfClient::ReloadPresenterWindows,
                               CefRefPtr<CrPdfClient>(this)));
    return;
  }
  auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch())
                    .count();
  for (const auto& b : browser_list_) {
    if (b && b->GetIdentifier() != main_browser_id_) {
      if (!presenter_url_.empty()) {
        if (auto mf = b->GetMainFrame()) {
          std::string sep = (presenter_url_.find('?') == std::string::npos) ? "?" : "&";
          std::string target_url = presenter_url_ + sep + "t=" + std::to_string(now_ms) +
                                   "#page=" + std::to_string(presenter_page_);
          mf->LoadURL(target_url);
          continue;
        }
      }
      b->ReloadIgnoreCache();
    }
  }
}

std::string CrPdfClient::ResolveSafeSavePath(
    const std::string& suggested_name) const {
  std::filesystem::path p = PathFromUtf8(suggested_name);
  std::string base = PathToUtf8(p.filename());
  if (!IsSafeFilename(base)) {
    base = SanitizeNotebookTitle(base);
    if (base.empty()) base = "note";
    if (base.size() < 4 ||
        base.compare(base.size() - 4, 4, ".pdf") != 0) {
      base += ".pdf";
    }
  }

  std::string save_dir =
      config_store_ ? config_store_->GetSaveDir() : GetDefaultSaveDir();
  std::filesystem::path dir = PathFromUtf8(save_dir);
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  return PathToUtf8(dir / PathFromUtf8(base));
}

}  // namespace crpdf
