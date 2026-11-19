#ifndef CRPDF_HTTP_SERVER_H_
#define CRPDF_HTTP_SERVER_H_

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "config_store.h"

namespace crpdf {

using PickFolderCallback =
    std::function<PickFolderResult(const std::string& initial_dir)>;
using NavigateCallback = std::function<void(const std::string& url)>;

class HttpServer {
 public:
  HttpServer(ConfigStore* config_store,
             std::string web_dir = "",
             PickFolderCallback pick_folder_cb = nullptr);
  ~HttpServer();

  HttpServer(const HttpServer&) = delete;
  HttpServer& operator=(const HttpServer&) = delete;

  // Binds strictly to 127.0.0.1. Pass port = 0 for an ephemeral OS port.
  bool Start(uint16_t port = 0);
  void Stop();

  uint16_t port() const { return bound_port_.load(); }
  std::string base_url() const {
    return "http://127.0.0.1:" + std::to_string(bound_port_.load());
  }
  bool is_running() const { return running_.load(); }
  void SetNavigateCallback(NavigateCallback cb) { navigate_cb_ = std::move(cb); }
  void SetPresenterCallback(NavigateCallback cb) { presenter_cb_ = std::move(cb); }

 private:
  void AcceptLoop();
  void HandleClient(intptr_t client_fd);

  ConfigStore* config_store_;
  std::string web_dir_;
  PickFolderCallback pick_folder_cb_;
  NavigateCallback navigate_cb_;
  NavigateCallback presenter_cb_;

  intptr_t listen_fd_ = -1;
  std::atomic<uint16_t> bound_port_{0};
  std::atomic<bool> running_{false};
  std::thread accept_thread_;

  std::mutex workers_mu_;
  std::condition_variable workers_cv_;
  int active_workers_ = 0;

  std::mutex fs_mu_;
};

}  // namespace crpdf

#endif  // CRPDF_HTTP_SERVER_H_
