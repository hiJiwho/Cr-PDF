#include "http_server.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <vector>

#include "pdf_generator.h"

#ifdef _WIN32
#include <objbase.h>
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace crpdf {

namespace {

constexpr size_t kMaxHeaderBytes = 64 * 1024;
constexpr size_t kMaxBodyBytes = 128 * 1024 * 1024;
constexpr int kMaxConcurrentWorkers = 64;

#ifdef _WIN32
using NativeSocket = SOCKET;
constexpr NativeSocket kInvalidSocket = INVALID_SOCKET;

void CloseSocket(intptr_t fd) {
  if (fd >= 0 && static_cast<NativeSocket>(fd) != INVALID_SOCKET) {
    ::closesocket(static_cast<NativeSocket>(fd));
  }
}

void ShutdownSocket(intptr_t fd) {
  if (fd >= 0 && static_cast<NativeSocket>(fd) != INVALID_SOCKET) {
    ::shutdown(static_cast<NativeSocket>(fd), SD_BOTH);
  }
}

struct WinsockInit {
  WinsockInit() {
    WSADATA data{};
    WSAStartup(MAKEWORD(2, 2), &data);
  }
  ~WinsockInit() { WSACleanup(); }
};

void EnsureWinsockInitialized() {
  static WinsockInit init;
  (void)init;
}
#else
using NativeSocket = int;
constexpr NativeSocket kInvalidSocket = -1;

void CloseSocket(intptr_t fd) {
  if (fd >= 0) {
    ::close(static_cast<int>(fd));
  }
}

void ShutdownSocket(intptr_t fd) {
  if (fd >= 0) {
    ::shutdown(static_cast<int>(fd), SHUT_RDWR);
  }
}

void EnsureWinsockInitialized() {}
#endif

std::string ToLowerAscii(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (unsigned char c : s) {
    out.push_back(static_cast<char>(std::tolower(c)));
  }
  return out;
}

std::string TrimWhitespace(const std::string& s) {
  size_t b = 0;
  while (b < s.size() && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
  size_t e = s.size();
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
  return s.substr(b, e - b);
}

bool EndsWithCaseInsensitive(const std::string& s, const std::string& suffix) {
  if (s.size() < suffix.size()) return false;
  size_t off = s.size() - suffix.size();
  for (size_t i = 0; i < suffix.size(); ++i) {
    if (std::tolower(static_cast<unsigned char>(s[off + i])) !=
        std::tolower(static_cast<unsigned char>(suffix[i]))) {
      return false;
    }
  }
  return true;
}

bool ContainsEncodedTraversal(const std::string& raw) {
  std::string lower = ToLowerAscii(raw);
  if (lower.find("%2f") != std::string::npos) return true;
  if (lower.find("%5c") != std::string::npos) return true;
  if (lower.find("%00") != std::string::npos) return true;
  if (lower.find("%2e%2e") != std::string::npos) return true;
  if (lower.find("..") != std::string::npos) return true;
  return false;
}

int64_t GetFileMtimeEpoch(const std::filesystem::path& p) {
  std::error_code ec;
  auto ftime = std::filesystem::last_write_time(p, ec);
  if (ec) return 0;
  auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
      ftime - std::filesystem::file_time_type::clock::now() +
      std::chrono::system_clock::now());
  return std::chrono::duration_cast<std::chrono::seconds>(
             sctp.time_since_epoch())
      .count();
}

bool ReadWholeFile(const std::filesystem::path& p, std::string* out) {
  std::ifstream ifs(p, std::ios::binary);
  if (!ifs.is_open()) return false;
  std::ostringstream oss;
  oss << ifs.rdbuf();
  *out = oss.str();
  return true;
}

std::string GuessMimeType(const std::string& path) {
  std::string lower = ToLowerAscii(path);
  if (EndsWithCaseInsensitive(lower, ".html") ||
      EndsWithCaseInsensitive(lower, ".htm")) {
    return "text/html; charset=utf-8";
  }
  if (EndsWithCaseInsensitive(lower, ".js") ||
      EndsWithCaseInsensitive(lower, ".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (EndsWithCaseInsensitive(lower, ".css")) {
    return "text/css; charset=utf-8";
  }
  if (EndsWithCaseInsensitive(lower, ".json")) {
    return "application/json; charset=utf-8";
  }
  if (EndsWithCaseInsensitive(lower, ".svg")) {
    return "image/svg+xml";
  }
  if (EndsWithCaseInsensitive(lower, ".png")) {
    return "image/png";
  }
  if (EndsWithCaseInsensitive(lower, ".ico")) {
    return "image/x-icon";
  }
  if (EndsWithCaseInsensitive(lower, ".woff2")) {
    return "font/woff2";
  }
  if (EndsWithCaseInsensitive(lower, ".pdf")) {
    return "application/pdf";
  }
  return "application/octet-stream";
}

struct HttpRequest {
  std::string method;
  std::string raw_target;
  std::string path;
  std::string query;
  std::map<std::string, std::string> headers;  // lowercase keys
  std::string body;
};

struct HttpResponse {
  int status = 200;
  std::string status_text = "OK";
  std::string content_type = "application/json; charset=utf-8";
  std::map<std::string, std::string> extra_headers;
  std::string body;
  bool head_only = false;
  size_t explicit_content_length = 0;
  bool has_explicit_content_length = false;
};

bool IsPowerPointAvailable() {
#ifdef _WIN32
  CLSID clsid;
  HRESULT hr_init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  HRESULT hr = CLSIDFromProgID(L"PowerPoint.Application", &clsid);
  if (SUCCEEDED(hr_init)) CoUninitialize();
  return SUCCEEDED(hr);
#else
  return false;
#endif
}

std::string StatusTextFor(int code) {
  switch (code) {
    case 200:
      return "OK";
    case 201:
      return "Created";
    case 204:
      return "No Content";
    case 206:
      return "Partial Content";
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 413:
      return "Payload Too Large";
    case 416:
      return "Range Not Satisfiable";
    case 500:
      return "Internal Server Error";
    default:
      return "OK";
  }
}

bool SendAll(NativeSocket sock, const void* data, size_t len) {
  const char* p = static_cast<const char*>(data);
  size_t remaining = len;
  while (remaining > 0) {
#ifdef _WIN32
    int chunk =
        (remaining > 0x40000000U) ? 0x40000000 : static_cast<int>(remaining);
    int n = ::send(sock, p, chunk, 0);
#else
    ssize_t n = ::send(sock, p, remaining, MSG_NOSIGNAL);
#endif
    if (n <= 0) return false;
    p += n;
    remaining -= static_cast<size_t>(n);
  }
  return true;
}

bool GetQueryParam(const std::string& query,
                   const std::string& key,
                   std::string* raw_val_out) {
  size_t start = 0;
  while (start <= query.size()) {
    size_t amp = query.find('&', start);
    std::string pair = (amp == std::string::npos)
                           ? query.substr(start)
                           : query.substr(start, amp - start);
    size_t eq = pair.find('=');
    std::string k = (eq == std::string::npos) ? pair : pair.substr(0, eq);
    if (k == key) {
      *raw_val_out = (eq == std::string::npos) ? "" : pair.substr(eq + 1);
      return true;
    }
    if (amp == std::string::npos) break;
    start = amp + 1;
  }
  return false;
}

bool IsAllowedOrigin(const std::string& origin, uint16_t bound_port) {
  if (origin == "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai") {
    return true;
  }
  if (origin == "http://127.0.0.1:" + std::to_string(bound_port)) {
    return true;
  }
  if (origin == "http://localhost:" + std::to_string(bound_port)) {
    return true;
  }
  return false;
}

void ApplyCorsHeaders(const HttpRequest& req,
                      uint16_t bound_port,
                      HttpResponse* resp) {
  auto it = req.headers.find("origin");
  if (it != req.headers.end() && IsAllowedOrigin(it->second, bound_port)) {
    resp->extra_headers["Access-Control-Allow-Origin"] = it->second;
    resp->extra_headers["Vary"] = "Origin";
    resp->extra_headers["Access-Control-Allow-Methods"] =
        "GET, POST, DELETE, OPTIONS";
    resp->extra_headers["Access-Control-Allow-Headers"] =
        "Content-Type, Range";
    resp->extra_headers["Access-Control-Expose-Headers"] =
        "Content-Length, Content-Range, Accept-Ranges";
    resp->extra_headers["Access-Control-Max-Age"] = "600";
  }
}

void SetJsonError(HttpResponse* resp, int status, const std::string& message) {
  resp->status = status;
  resp->status_text = StatusTextFor(status);
  resp->content_type = "application/json; charset=utf-8";
  resp->body = "{\"error\":\"" + JsonEscape(message) + "\"}";
}

bool ParseHttpRange(const std::string& header,
                    size_t file_size,
                    size_t* start_out,
                    size_t* end_out) {
  if (file_size == 0) return false;
  if (header.compare(0, 6, "bytes=") != 0) return false;
  std::string spec = header.substr(6);
  if (spec.find(',') != std::string::npos) return false;  // single range only
  size_t dash = spec.find('-');
  if (dash == std::string::npos) return false;

  std::string s_part = TrimWhitespace(spec.substr(0, dash));
  std::string e_part = TrimWhitespace(spec.substr(dash + 1));

  if (s_part.empty() && e_part.empty()) return false;

  size_t start = 0;
  size_t end = file_size - 1;

  if (s_part.empty()) {
    // Suffix range: bytes=-N
    char* endp = nullptr;
    unsigned long long suffix = std::strtoull(e_part.c_str(), &endp, 10);
    if (endp == e_part.c_str() || *endp != '\0' || suffix == 0) return false;
    start = (suffix >= file_size) ? 0 : (file_size - static_cast<size_t>(suffix));
    end = file_size - 1;
  } else {
    char* endp = nullptr;
    unsigned long long s_val = std::strtoull(s_part.c_str(), &endp, 10);
    if (endp == s_part.c_str() || *endp != '\0') return false;
    if (s_val >= file_size) return false;
    start = static_cast<size_t>(s_val);
    if (!e_part.empty()) {
      char* endp2 = nullptr;
      unsigned long long e_val = std::strtoull(e_part.c_str(), &endp2, 10);
      if (endp2 == e_part.c_str() || *endp2 != '\0') return false;
      end = std::min(static_cast<size_t>(e_val), file_size - 1);
      if (end < start) return false;
    }
  }

  *start_out = start;
  *end_out = end;
  return true;
}

std::string BuildFallbackIndexHtml(uint16_t port, const std::string& save_dir) {
  std::ostringstream oss;
  oss << "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
      << "<title>Cr-PDF</title>"
      << "<style>body{font-family:system-ui,sans-serif;margin:40px;color:#222;}"
      << "code{background:#f2f2f2;padding:2px 6px;border-radius:4px;}</style>"
      << "</head><body><h1>Cr-PDF Backend Ready</h1>"
      << "<p>Loopback API running on <code>http://127.0.0.1:" << port
      << "</code></p><p>Save folder: <code>" << JsonEscape(save_dir)
      << "</code></p></body></html>";
  return oss.str();
}

struct NoteMeta {
  std::string id;      // e.g. "n_1732000123_1" (stored on disk as <id>.pdf)
  std::string title;   // display name (without .pdf)
  std::string color;   // e.g. "#14B8A6"
  std::string folder;  // e.g. "" or "수학"
};

struct NotesDb {
  std::vector<std::string> folders;
  std::vector<NoteMeta> notes;
};

std::string MintNoteId() {
  static std::atomic<uint64_t> seq{1};
  auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch())
                    .count();
  uint64_t s = seq.fetch_add(1);
  return "n_" + std::to_string(now_ms) + "_" + std::to_string(s);
}

void SaveNotesDb(const std::filesystem::path& save_dir, const NotesDb& db) {
  std::error_code ec;
  std::filesystem::create_directories(save_dir, ec);
  std::ostringstream oss;
  oss << "{\n  \"folders\": [";
  for (size_t i = 0; i < db.folders.size(); ++i) {
    if (i > 0) oss << ", ";
    oss << "\"" << JsonEscape(db.folders[i]) << "\"";
  }
  oss << "],\n  \"notes\": [\n";
  for (size_t i = 0; i < db.notes.size(); ++i) {
    if (i > 0) oss << ",\n";
    const auto& n = db.notes[i];
    oss << "    {\"id\":\"" << JsonEscape(n.id) << "\",\"title\":\""
        << JsonEscape(n.title) << "\",\"color\":\"" << JsonEscape(n.color)
        << "\",\"folder\":\"" << JsonEscape(n.folder) << "\"}";
  }
  oss << "\n  ]\n}\n";
  std::string data = oss.str();
  std::string err;
  AtomicWriteFile(save_dir / PathFromUtf8("notes.json"), data.data(),
                  data.size(), &err);
}

NotesDb LoadAndSyncNotesDb(const std::filesystem::path& save_dir) {
  NotesDb db;
  std::filesystem::path json_path = save_dir / PathFromUtf8("notes.json");
  std::string raw;
  bool dirty = false;

  if (ReadWholeFile(json_path, &raw)) {
    // Parse "folders": [ ... ]
    size_t fkey = raw.find("\"folders\"");
    if (fkey != std::string::npos) {
      size_t lb = raw.find('[', fkey);
      size_t rb = (lb != std::string::npos) ? raw.find(']', lb) : std::string::npos;
      if (lb != std::string::npos && rb != std::string::npos) {
        std::string arr = raw.substr(lb + 1, rb - lb - 1);
        size_t pos = 0;
        while (pos < arr.size()) {
          size_t q1 = arr.find('"', pos);
          if (q1 == std::string::npos) break;
          std::string val;
          size_t i = q1 + 1;
          while (i < arr.size()) {
            if (arr[i] == '\\' && i + 1 < arr.size()) {
              val.push_back(arr[i + 1]);
              i += 2;
            } else if (arr[i] == '"') {
              break;
            } else {
              val.push_back(arr[i]);
              ++i;
            }
          }
          if (!val.empty()) db.folders.push_back(val);
          pos = i + 1;
        }
      }
    }
    // Parse "notes": [ { ... }, ... ]
    size_t nkey = raw.find("\"notes\"");
    if (nkey != std::string::npos) {
      size_t lb = raw.find('[', nkey);
      size_t rb = (lb != std::string::npos) ? raw.rfind(']') : std::string::npos;
      if (lb != std::string::npos && rb != std::string::npos && rb > lb) {
        std::string arr = raw.substr(lb + 1, rb - lb - 1);
        size_t pos = 0;
        while (pos < arr.size()) {
          size_t ob = arr.find('{', pos);
          if (ob == std::string::npos) break;
          size_t cb = arr.find('}', ob);
          if (cb == std::string::npos) break;
          std::string obj_str = arr.substr(ob, cb - ob + 1);
          JsonObject obj;
          if (ParseFlatJsonObject(obj_str, &obj)) {
            NoteMeta m;
            if (auto it = obj.find("id"); it != obj.end()) m.id = it->second.str_val;
            if (auto it = obj.find("title"); it != obj.end()) m.title = it->second.str_val;
            if (auto it = obj.find("color"); it != obj.end()) m.color = it->second.str_val;
            if (auto it = obj.find("folder"); it != obj.end()) m.folder = it->second.str_val;
            if (!m.id.empty()) {
              if (m.color.empty()) m.color = "#14B8A6";
              if (m.title.empty()) m.title = m.id;
              db.notes.push_back(std::move(m));
            }
          }
          pos = cb + 1;
        }
      }
    }
  }

  // Ensure any .pdf files on disk are registered in notes.json
  std::error_code ec;
  if (std::filesystem::exists(save_dir, ec) &&
      std::filesystem::is_directory(save_dir, ec)) {
    std::vector<NoteMeta> valid_notes;
    for (const auto& m : db.notes) {
      std::string fname = EndsWithCaseInsensitive(m.id, ".pdf") ? m.id : (m.id + ".pdf");
      if (std::filesystem::is_regular_file(save_dir / PathFromUtf8(fname), ec)) {
        NoteMeta clean = m;
        if (EndsWithCaseInsensitive(clean.id, ".pdf")) {
          clean.id.resize(clean.id.size() - 4);
          dirty = true;
        }
        valid_notes.push_back(std::move(clean));
      } else {
        dirty = true;
      }
    }
    db.notes = std::move(valid_notes);

    for (const auto& de : std::filesystem::directory_iterator(save_dir, ec)) {
      if (ec) break;
      std::error_code fec;
      if (!de.is_regular_file(fec)) continue;
      std::string fname = PathToUtf8(de.path().filename());
      if (!EndsWithCaseInsensitive(fname, ".pdf")) continue;
      std::string stem = fname.substr(0, fname.size() - 4);

      bool found = false;
      for (const auto& m : db.notes) {
        if (m.id == stem) {
          found = true;
          break;
        }
      }
      if (!found) {
        NoteMeta m;
        m.id = stem;
        m.title = stem;
        m.color = "#14B8A6";
        m.folder = "";
        db.notes.push_back(std::move(m));
        dirty = true;
      }
    }
  }

  if (dirty) {
    SaveNotesDb(save_dir, db);
  }
  return db;
}

// Resolves a request identifier (can be "<id>", "<id>.pdf", "<title>", or "<title>.pdf")
// to the actual disk filename "<id>.pdf" and NoteMeta* in db.
bool ResolveNotebookTarget(const std::filesystem::path& save_dir,
                           const std::string& req_name,
                           NotesDb* db,
                           std::string* disk_filename_out,
                           NoteMeta** meta_out) {
  std::string stem = req_name;
  if (EndsWithCaseInsensitive(stem, ".pdf")) {
    stem.resize(stem.size() - 4);
  }
  for (auto& m : db->notes) {
    if (m.id == stem || m.title == stem || (m.title + ".pdf") == req_name) {
      std::string fname = m.id + ".pdf";
      std::error_code ec;
      if (std::filesystem::is_regular_file(save_dir / PathFromUtf8(fname), ec)) {
        if (disk_filename_out) *disk_filename_out = fname;
        if (meta_out) *meta_out = &m;
        return true;
      }
    }
  }
  // Fallback direct check on disk
  std::string direct = EndsWithCaseInsensitive(req_name, ".pdf") ? req_name : (req_name + ".pdf");
  std::error_code ec;
  if (IsSafeFilename(direct) &&
      std::filesystem::is_regular_file(save_dir / PathFromUtf8(direct), ec)) {
    if (disk_filename_out) *disk_filename_out = direct;
    if (meta_out) *meta_out = nullptr;
    return true;
  }
  return false;
}

}  // namespace

HttpServer::HttpServer(ConfigStore* config_store,
                       std::string web_dir,
                       PickFolderCallback pick_folder_cb)
    : config_store_(config_store),
      web_dir_(std::move(web_dir)),
      pick_folder_cb_(std::move(pick_folder_cb)) {
  if (!pick_folder_cb_) {
    pick_folder_cb_ = [](const std::string& initial_dir) {
      return PickFolderDialog(initial_dir);
    };
  }
}

HttpServer::~HttpServer() { Stop(); }

bool HttpServer::Start(uint16_t port) {
  if (running_.load()) return true;
  EnsureWinsockInitialized();

  NativeSocket sock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock == kInvalidSocket) return false;

#ifdef _WIN32
  if (port != 0) {
    BOOL exclusive = TRUE;
    ::setsockopt(sock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                 reinterpret_cast<const char*>(&exclusive),
                 sizeof(exclusive));
  }
#else
  int reuse = 1;
  ::setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
#endif

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(port);

  if (::bind(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    CloseSocket(static_cast<intptr_t>(sock));
    return false;
  }

  sockaddr_in actual{};
  socklen_t actual_len = sizeof(actual);
  if (::getsockname(sock, reinterpret_cast<sockaddr*>(&actual), &actual_len) !=
      0) {
    CloseSocket(static_cast<intptr_t>(sock));
    return false;
  }

  if (::listen(sock, 32) != 0) {
    CloseSocket(static_cast<intptr_t>(sock));
    return false;
  }

  listen_fd_ = static_cast<intptr_t>(sock);
  bound_port_.store(ntohs(actual.sin_port));
  running_.store(true);
  accept_thread_ = std::thread(&HttpServer::AcceptLoop, this);
  return true;
}

void HttpServer::Stop() {
  bool expected = true;
  if (!running_.compare_exchange_strong(expected, false)) {
    return;
  }

  intptr_t fd = listen_fd_;
  listen_fd_ = -1;
  ShutdownSocket(fd);
  CloseSocket(fd);

  if (accept_thread_.joinable()) {
    accept_thread_.join();
  }

  std::unique_lock<std::mutex> lock(workers_mu_);
  workers_cv_.wait(lock, [this]() { return active_workers_ == 0; });
}

void HttpServer::AcceptLoop() {
  while (running_.load()) {
    sockaddr_in client_addr{};
    socklen_t client_len = sizeof(client_addr);
    NativeSocket client = ::accept(static_cast<NativeSocket>(listen_fd_),
                                   reinterpret_cast<sockaddr*>(&client_addr),
                                   &client_len);
    if (client == kInvalidSocket) {
      if (!running_.load()) break;
      continue;
    }

    {
      std::unique_lock<std::mutex> lock(workers_mu_);
      if (active_workers_ >= kMaxConcurrentWorkers) {
        CloseSocket(static_cast<intptr_t>(client));
        continue;
      }
      ++active_workers_;
    }

    intptr_t client_fd = static_cast<intptr_t>(client);
    std::thread([this, client_fd]() {
      HandleClient(client_fd);
      CloseSocket(client_fd);
      std::lock_guard<std::mutex> lock(workers_mu_);
      --active_workers_;
      workers_cv_.notify_all();
    }).detach();
  }
}

void HttpServer::HandleClient(intptr_t client_fd) {
  NativeSocket sock = static_cast<NativeSocket>(client_fd);

#ifdef _WIN32
  DWORD timeout_ms = 15000;
  ::setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO,
               reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));
  ::setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO,
               reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));
#else
  timeval tv{};
  tv.tv_sec = 15;
  tv.tv_usec = 0;
  ::setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  ::setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif

  // 1. Read request headers.
  std::string raw;
  raw.reserve(4096);
  size_t header_end = std::string::npos;
  char buf[8192];
  while (header_end == std::string::npos) {
#ifdef _WIN32
    int n = ::recv(sock, buf, sizeof(buf), 0);
#else
    ssize_t n = ::recv(sock, buf, sizeof(buf), 0);
#endif
    if (n <= 0) return;
    raw.append(buf, static_cast<size_t>(n));
    header_end = raw.find("\r\n\r\n");
    if (raw.size() > kMaxHeaderBytes && header_end == std::string::npos) {
      HttpResponse err;
      SetJsonError(&err, 400, "Request headers too large");
      std::string out = "HTTP/1.1 400 Bad Request\r\nContent-Length: " +
                        std::to_string(err.body.size()) +
                        "\r\nConnection: close\r\n\r\n" + err.body;
      SendAll(sock, out.data(), out.size());
      return;
    }
  }

  HttpRequest req;
  std::string header_block = raw.substr(0, header_end);
  std::string initial_body = raw.substr(header_end + 4);

  size_t line_end = header_block.find("\r\n");
  std::string req_line = (line_end == std::string::npos)
                             ? header_block
                             : header_block.substr(0, line_end);
  {
    std::istringstream iss(req_line);
    std::string http_ver;
    if (!(iss >> req.method >> req.raw_target >> http_ver)) {
      return;
    }
  }

  size_t qpos = req.raw_target.find('?');
  if (qpos == std::string::npos) {
    req.path = req.raw_target;
  } else {
    req.path = req.raw_target.substr(0, qpos);
    req.query = req.raw_target.substr(qpos + 1);
  }

  // Parse header lines.
  size_t pos = (line_end == std::string::npos) ? header_block.size() : line_end + 2;
  while (pos < header_block.size()) {
    size_t next = header_block.find("\r\n", pos);
    std::string line = (next == std::string::npos)
                           ? header_block.substr(pos)
                           : header_block.substr(pos, next - pos);
    size_t colon = line.find(':');
    if (colon != std::string::npos) {
      std::string k = ToLowerAscii(TrimWhitespace(line.substr(0, colon)));
      std::string v = TrimWhitespace(line.substr(colon + 1));
      req.headers[k] = v;
    }
    if (next == std::string::npos) break;
    pos = next + 2;
  }

  // Handle Expect: 100-continue.
  auto exp_it = req.headers.find("expect");
  if (exp_it != req.headers.end() &&
      ToLowerAscii(exp_it->second).find("100-continue") != std::string::npos) {
    const char kCont[] = "HTTP/1.1 100 Continue\r\n\r\n";
    SendAll(sock, kCont, sizeof(kCont) - 1);
  }

  // Read request body if Content-Length is specified.
  size_t content_length = 0;
  auto cl_it = req.headers.find("content-length");
  if (cl_it != req.headers.end()) {
    char* endp = nullptr;
    unsigned long long parsed =
        std::strtoull(cl_it->second.c_str(), &endp, 10);
    if (endp == cl_it->second.c_str()) {
      HttpResponse err;
      SetJsonError(&err, 400, "Invalid Content-Length");
      std::string out = "HTTP/1.1 400 Bad Request\r\nContent-Length: " +
                        std::to_string(err.body.size()) +
                        "\r\nConnection: close\r\n\r\n" + err.body;
      SendAll(sock, out.data(), out.size());
      return;
    }
    if (parsed > kMaxBodyBytes) {
      HttpResponse err;
      SetJsonError(&err, 413, "Payload too large");
      std::string out = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: " +
                        std::to_string(err.body.size()) +
                        "\r\nConnection: close\r\n\r\n" + err.body;
      SendAll(sock, out.data(), out.size());
      return;
    }
    content_length = static_cast<size_t>(parsed);
  }

  req.body = std::move(initial_body);
  if (req.body.size() > content_length) {
    req.body.resize(content_length);
  } else {
    req.body.reserve(content_length);
    while (req.body.size() < content_length) {
      size_t want = std::min(sizeof(buf), content_length - req.body.size());
#ifdef _WIN32
      int n = ::recv(sock, buf, static_cast<int>(want), 0);
#else
      ssize_t n = ::recv(sock, buf, want, 0);
#endif
      if (n <= 0) return;
      req.body.append(buf, static_cast<size_t>(n));
    }
  }

  // 2. Route request.
  HttpResponse resp;
  uint16_t port_val = bound_port_.load();
  ApplyCorsHeaders(req, port_val, &resp);

  auto ua_it = req.headers.find("user-agent");
  const bool valid_crpdf_ua =
      (ua_it != req.headers.end() &&
       ua_it->second.find("CR-pdf v1.0") != std::string::npos);

  if (req.method == "OPTIONS") {
    resp.status = 204;
    resp.status_text = StatusTextFor(204);
    resp.content_type.clear();
  } else if (!valid_crpdf_ua) {
    resp.status = 403;
    resp.status_text = StatusTextFor(403);
    resp.content_type = "text/plain; charset=utf-8";
    resp.body = "Forbidden: Cr-PDF desktop client (CR-pdf v1.0) required.";
  } else if (req.method == "GET" && req.path == "/") {
    resp.content_type = "text/html; charset=utf-8";
    resp.extra_headers["Cache-Control"] = "no-cache";
    std::string html;
    if (!web_dir_.empty() &&
        ReadWholeFile(PathFromUtf8(web_dir_) / "index.html", &html)) {
      resp.body = std::move(html);
    } else {
      resp.body = BuildFallbackIndexHtml(port_val, config_store_->GetSaveDir());
    }
  } else if (req.method == "GET" && req.path.compare(0, 8, "/static/") == 0) {
    std::string raw_rel = req.path.substr(8);
    std::string rel;
    if (web_dir_.empty() || raw_rel.empty() ||
        ContainsEncodedTraversal(raw_rel) || !UrlDecode(raw_rel, &rel) ||
        rel.find('\0') != std::string::npos ||
        rel.find("..") != std::string::npos ||
        rel.find('\\') != std::string::npos || rel.front() == '/') {
      SetJsonError(&resp, 400, "Invalid static file path");
    } else {
      std::filesystem::path base = PathFromUtf8(web_dir_);
      std::filesystem::path target = base / PathFromUtf8(rel);
      std::error_code ec;
      if (!IsPathWithinDir(base, target) ||
          !std::filesystem::is_regular_file(target, ec)) {
        SetJsonError(&resp, 404, "Static file not found");
      } else {
        std::string content;
        if (!ReadWholeFile(target, &content)) {
          SetJsonError(&resp, 500, "Failed to read static file");
        } else {
          resp.content_type = GuessMimeType(rel);
          resp.extra_headers["Cache-Control"] = "no-cache";
          resp.body = std::move(content);
        }
      }
    }
  } else if (req.method == "POST" && req.path == "/api/go-home") {
    if (navigate_cb_) {
      navigate_cb_(base_url() + "/");
    }
    resp.body = "{\"ok\":true}";
  } else if (req.method == "POST" && req.path == "/api/open-pdf") {
    std::string raw_name, name, page_str;
    if (!GetQueryParam(req.query, "name", &raw_name) ||
        ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name, true) || !IsSafeFilename(name)) {
      SetJsonError(&resp, 400, "Invalid name");
    } else {
      GetQueryParam(req.query, "page", &page_str);
      std::string url = base_url() + "/pdf/" + UrlEncodePathSegment(name) +
                        "?t=" + std::to_string(std::time(nullptr));
      if (!page_str.empty()) url += "#page=" + page_str;
      if (navigate_cb_) navigate_cb_(url);
      resp.body = "{\"ok\":true}";
    }
  } else if (req.method == "POST" && req.path == "/api/open-presenter") {
    std::string url = base_url() + "/presenter";
    if (presenter_cb_) presenter_cb_(url);
    resp.body = "{\"ok\":true}";
  } else if (req.method == "POST" && req.path == "/api/canvas-crop") {
    std::string top_str, right_str;
    int top_px = 56;
    int right_px = 300;
    if (GetQueryParam(req.query, "top", &top_str) && !top_str.empty()) {
      top_px = std::max(0, std::atoi(top_str.c_str()));
    }
    if (GetQueryParam(req.query, "right", &right_str) && !right_str.empty()) {
      right_px = std::max(0, std::atoi(right_str.c_str()));
    }
    if (crop_cb_) crop_cb_(top_px, right_px);
    resp.body = "{\"ok\":true}";
  } else if (req.method == "GET" && req.path == "/api/live-frame.bmp") {
    std::string bmp = capture_cb_ ? capture_cb_() : "";
    if (bmp.empty()) {
      resp.status = 204;
      resp.status_text = StatusTextFor(204);
      resp.content_type.clear();
    } else {
      resp.content_type = "image/bmp";
      resp.extra_headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
      resp.body = std::move(bmp);
    }
  } else if (req.method == "GET" && req.path == "/presenter") {
    resp.content_type = "text/html; charset=utf-8";
    resp.extra_headers["Cache-Control"] = "no-store";
    resp.body = R"HTML(<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>[화면공유용] 판서 화면</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #525659;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #mirror-canvas {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
  }
  #laser-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    cursor: none;
  }
  #laser-dot {
    position: absolute;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #ef4444;
    border: 2.5px solid #ffffff;
    box-shadow: 0 0 14px 4px rgba(239, 68, 68, 0.85);
    transform: translate(-50%, -50%);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.08s ease;
  }
  #laser-dot.visible {
    opacity: 1;
  }
</style>
</head>
<body>
  <canvas id="mirror-canvas"></canvas>
  <div id="laser-overlay"><div id="laser-dot"></div></div>
  <script>
    'use strict';
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    const canvas = document.getElementById('mirror-canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const overlay = document.getElementById('laser-overlay');
    const dot = document.getElementById('laser-dot');

    overlay.addEventListener('pointermove', (ev) => {
      dot.classList.add('visible');
      dot.style.left = ev.clientX + 'px';
      dot.style.top = ev.clientY + 'px';
    });
    overlay.addEventListener('pointerdown', (ev) => {
      dot.classList.add('visible');
      dot.style.left = ev.clientX + 'px';
      dot.style.top = ev.clientY + 'px';
    });
    overlay.addEventListener('pointerleave', () => {
      dot.classList.remove('visible');
    });

    function drawContain(bmp) {
      const cw = window.innerWidth;
      const ch = window.innerHeight;
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.fillStyle = '#525659';
      ctx.fillRect(0, 0, cw, ch);
      const iw = bmp.width;
      const ih = bmp.height;
      if (!iw || !ih) return;
      const scale = Math.min(cw / iw, ch / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (cw - dw) * 0.5;
      const dy = (ch - dh) * 0.5;
      ctx.drawImage(bmp, dx, dy, dw, dh);
    }

    let running = true;
    async function loop() {
      while (running) {
        const t0 = performance.now();
        try {
          const res = await fetch('/api/live-frame.bmp?t=' + Date.now(), { cache: 'no-store' });
          if (res.status === 200) {
            const blob = await res.blob();
            const bmp = await createImageBitmap(blob);
            drawContain(bmp);
            bmp.close();
          }
        } catch {}
        const elapsed = performance.now() - t0;
        const wait = Math.max(16, 40 - elapsed);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    loop();
  </script>
</body>
</html>)HTML";
  } else if (req.method == "POST" && req.path == "/api/presenter-page") {
    std::string page_str;
    if (GetQueryParam(req.query, "page", &page_str) && !page_str.empty()) {
      int pg = std::atoi(page_str.c_str());
      if (pg >= 1 && presenter_page_cb_) presenter_page_cb_(pg);
    }
    resp.body = "{\"ok\":true}";
  } else if (req.method == "GET" && req.path == "/api/health") {
    std::ostringstream oss;
    oss << "{\"status\":\"ok\",\"officeAvailable\":" << (IsPowerPointAvailable() ? "true" : "false") << ",\"port\":" << port_val << ",\"saveDir\":\""
        << JsonEscape(config_store_->GetSaveDir())
        << "\",\"version\":\"1.0.0\"}";
    resp.body = oss.str();
  } else if (req.method == "GET" && req.path == "/api/config") {
    resp.body = config_store_->ToJson();
  } else if (req.method == "POST" && req.path == "/api/config") {
    std::string locked_dir = config_store_->GetSaveDir();
    std::string err;
    if (!config_store_->UpdateFromJson(req.body, nullptr, &err)) {
      SetJsonError(&resp, 400, err);
    } else {
      config_store_->ApplyCliOverrides(locked_dir, -1);
      resp.body = config_store_->ToJson();
    }
  } else if (req.method == "POST" && req.path == "/api/pick-folder") {
    SetJsonError(&resp, 403, "Storage folder is managed automatically in AppData");
  } else if (req.method == "GET" && req.path == "/api/notebooks") {
    std::lock_guard<std::mutex> fslock(fs_mu_);
    std::filesystem::path save_dir = PathFromUtf8(config_store_->GetSaveDir());
    NotesDb db = LoadAndSyncNotesDb(save_dir);

    struct Entry {
      std::string id;
      std::string title;
      std::string color;
      std::string folder;
      std::string filename;
      uint64_t size = 0;
      int64_t mtime = 0;
    };
    std::vector<Entry> items;
    std::error_code ec;
    for (const auto& m : db.notes) {
      std::string fname = m.id + ".pdf";
      std::filesystem::path p = save_dir / PathFromUtf8(fname);
      if (!std::filesystem::is_regular_file(p, ec)) continue;
      Entry e;
      e.id = m.id;
      e.title = m.title;
      e.color = m.color;
      e.folder = m.folder;
      e.filename = fname;
      e.size = std::filesystem::file_size(p, ec);
      e.mtime = GetFileMtimeEpoch(p);
      items.push_back(std::move(e));
    }

    std::sort(items.begin(), items.end(), [](const Entry& a, const Entry& b) {
      if (a.mtime != b.mtime) return a.mtime > b.mtime;
      return a.title < b.title;
    });

    std::ostringstream oss;
    oss << "{\"folders\":[";
    for (size_t i = 0; i < db.folders.size(); ++i) {
      if (i > 0) oss << ",";
      oss << "\"" << JsonEscape(db.folders[i]) << "\"";
    }
    oss << "],\"notebooks\":[";
    for (size_t i = 0; i < items.size(); ++i) {
      if (i > 0) oss << ",";
      oss << "{\"id\":\"" << JsonEscape(items[i].id)
          << "\",\"title\":\"" << JsonEscape(items[i].title)
          << "\",\"name\":\"" << JsonEscape(items[i].title + ".pdf")
          << "\",\"color\":\"" << JsonEscape(items[i].color)
          << "\",\"folder\":\"" << JsonEscape(items[i].folder)
          << "\",\"size\":" << items[i].size
          << ",\"mtime\":" << items[i].mtime << ",\"url\":\"/pdf/"
          << UrlEncodePathSegment(items[i].filename) << "\"}";
    }
    oss << "]}";
    resp.body = oss.str();
  } else if (req.method == "POST" && req.path == "/api/folders") {
    JsonObject obj;
    if (req.body.empty() || !ParseFlatJsonObject(req.body, &obj)) {
      SetJsonError(&resp, 400, "Invalid JSON body");
    } else {
      std::string folder_name;
      if (auto it = obj.find("name");
          it != obj.end() && it->second.type == JsonValue::Type::kString) {
        folder_name = TrimWhitespace(it->second.str_val);
      }
      if (folder_name.empty()) {
        SetJsonError(&resp, 400, "Folder name required");
      } else {
        std::lock_guard<std::mutex> fslock(fs_mu_);
        std::filesystem::path save_dir = PathFromUtf8(config_store_->GetSaveDir());
        NotesDb db = LoadAndSyncNotesDb(save_dir);
        if (std::find(db.folders.begin(), db.folders.end(), folder_name) ==
            db.folders.end()) {
          db.folders.push_back(folder_name);
          SaveNotesDb(save_dir, db);
        }
        resp.body = "{\"ok\":true,\"name\":\"" + JsonEscape(folder_name) + "\"}";
      }
    }
  } else if (req.method == "DELETE" &&
             req.path.compare(0, 13, "/api/folders/") == 0) {
    std::string raw_name = req.path.substr(13);
    std::string folder_name;
    if (raw_name.empty() || !UrlDecode(raw_name, &folder_name)) {
      SetJsonError(&resp, 400, "Invalid folder name");
    } else {
      std::lock_guard<std::mutex> fslock(fs_mu_);
      std::filesystem::path save_dir = PathFromUtf8(config_store_->GetSaveDir());
      NotesDb db = LoadAndSyncNotesDb(save_dir);
      db.folders.erase(
          std::remove(db.folders.begin(), db.folders.end(), folder_name),
          db.folders.end());
      for (auto& n : db.notes) {
        if (n.folder == folder_name) n.folder.clear();
      }
      SaveNotesDb(save_dir, db);
      resp.body = "{\"deleted\":true}";
    }
  } else if (req.method == "POST" && req.path == "/api/notebooks/create") {
    JsonObject obj;
    if (!req.body.empty() && !ParseFlatJsonObject(req.body, &obj)) {
      SetJsonError(&resp, 400, "Invalid JSON body");
    } else {
      std::string title = "Untitled";
      std::string tmpl_str = "blank";
      std::string size_str = "a4";
      std::string color_str = "#14B8A6";
      std::string folder_str = "";
      double width_mm = 0.0;
      double height_mm = 0.0;
      int pages = 1;

      if (auto it = obj.find("title");
          it != obj.end() && it->second.type == JsonValue::Type::kString) {
        title = it->second.str_val;
      }
      if (auto it = obj.find("template");
          it != obj.end() && it->second.type == JsonValue::Type::kString) {
        tmpl_str = it->second.str_val;
      }
      if (auto it = obj.find("pageSize");
          it != obj.end() && it->second.type == JsonValue::Type::kString) {
        size_str = it->second.str_val;
      }
      if (auto it = obj.find("color");
          it != obj.end() && it->second.type == JsonValue::Type::kString &&
          !it->second.str_val.empty()) {
        color_str = it->second.str_val;
      }
      if (auto it = obj.find("folder");
          it != obj.end() && it->second.type == JsonValue::Type::kString) {
        folder_str = it->second.str_val;
      }
      if (auto it = obj.find("widthMm");
          it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
        width_mm = it->second.num_val;
      }
      if (auto it = obj.find("heightMm");
          it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
        height_mm = it->second.num_val;
      }
      if (auto it = obj.find("pages");
          it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
        pages = static_cast<int>(it->second.num_val);
      }

      PdfOptions opts;
      if (!ParsePdfTemplate(tmpl_str, &opts.tmpl)) {
        SetJsonError(&resp, 400, "Invalid template");
      } else if (!ResolvePdfPageSize(size_str, width_mm, height_mm,
                                     &opts.page_size)) {
        SetJsonError(&resp, 400, "Invalid pageSize or custom dimensions");
      } else if (pages < 1 || pages > 200) {
        SetJsonError(&resp, 400, "pages must be between 1 and 200");
      } else {
        opts.page_count = pages;
        std::string safe_title = SanitizeNotebookTitle(title);
        if (EndsWithCaseInsensitive(safe_title, ".pdf")) {
          safe_title.resize(safe_title.size() - 4);
          safe_title = SanitizeNotebookTitle(safe_title);
        }
        opts.title = safe_title;

        std::string pdf_bytes;
        std::string gen_err;
        if (!GeneratePdf(opts, &pdf_bytes, &gen_err)) {
          SetJsonError(&resp, 400, gen_err);
        } else {
          std::lock_guard<std::mutex> fslock(fs_mu_);
          std::filesystem::path save_dir =
              PathFromUtf8(config_store_->GetSaveDir());
          std::error_code ec;
          std::filesystem::create_directories(save_dir, ec);
          NotesDb db = LoadAndSyncNotesDb(save_dir);

          std::string note_id = MintNoteId();
          std::string disk_fname = note_id + ".pdf";
          std::filesystem::path target = save_dir / PathFromUtf8(disk_fname);

          std::string write_err;
          if (!AtomicWriteFile(target, pdf_bytes.data(), pdf_bytes.size(),
                               &write_err)) {
            SetJsonError(&resp, 500, write_err);
          } else {
            NoteMeta meta;
            meta.id = note_id;
            meta.title = safe_title;
            meta.color = color_str;
            meta.folder = folder_str;
            db.notes.push_back(meta);
            SaveNotesDb(save_dir, db);

            char wbuf[32];
            char hbuf[32];
            std::snprintf(wbuf, sizeof(wbuf), "%.2f", opts.page_size.width_mm);
            std::snprintf(hbuf, sizeof(hbuf), "%.2f", opts.page_size.height_mm);
            resp.status = 201;
            resp.status_text = StatusTextFor(201);
            std::ostringstream oss;
            oss << "{\"id\":\"" << JsonEscape(note_id)
                << "\",\"title\":\"" << JsonEscape(safe_title)
                << "\",\"name\":\"" << JsonEscape(safe_title + ".pdf")
                << "\",\"color\":\"" << JsonEscape(color_str)
                << "\",\"folder\":\"" << JsonEscape(folder_str)
                << "\",\"url\":\"/pdf/" << UrlEncodePathSegment(disk_fname)
                << "\",\"widthMm\":" << wbuf << ",\"heightMm\":" << hbuf
                << ",\"pages\":" << opts.page_count << "}";
            resp.body = oss.str();
          }
        }
      }
    }
  } else if (req.method == "POST" && req.path == "/api/notebooks/import-ppt") {
    std::string raw_name;
    std::string name;
    if (!GetQueryParam(req.query, "name", &raw_name) ||
        ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name, true)) {
      SetJsonError(&resp, 400, "Missing or invalid name parameter");
    } else {
#ifdef _WIN32
      std::string ext = ".pptx";
      if (EndsWithCaseInsensitive(name, ".ppt")) ext = ".ppt";
      std::string stem = name;
      if (EndsWithCaseInsensitive(stem, ".pptx")) stem.resize(stem.size() - 5);
      else if (EndsWithCaseInsensitive(stem, ".ppt")) stem.resize(stem.size() - 4);
      std::string base = SanitizeNotebookTitle(stem);
      if (base.empty()) base = "presentation";

      std::string note_id = MintNoteId();
      std::string disk_fname = note_id + ".pdf";

      std::filesystem::path save_dir = PathFromUtf8(config_store_->GetSaveDir());
      std::filesystem::path target_pdf = save_dir / PathFromUtf8(disk_fname);
      std::filesystem::path tmp_dir = std::filesystem::temp_directory_path();
      std::filesystem::path tmp_ppt = tmp_dir / PathFromUtf8("crpdf_import" + ext);
      std::filesystem::path tmp_pdf = tmp_dir / PathFromUtf8("crpdf_import.pdf");
      std::filesystem::path tmp_ps1 = tmp_dir / PathFromUtf8("crpdf_convert_ppt.ps1");

      std::error_code ec;
      std::filesystem::remove(tmp_ppt, ec);
      std::filesystem::remove(tmp_pdf, ec);
      std::filesystem::remove(tmp_ps1, ec);

      std::string write_err;
      if (!AtomicWriteFile(tmp_ppt, req.body.data(), req.body.size(), &write_err)) {
        SetJsonError(&resp, 500, write_err);
      } else {
        auto escape_ps = [](const std::string& s) {
          std::string out;
          for (char c : s) {
            if (c == '\'') out += "''";
            else out += c;
          }
          return out;
        };
        std::string ps_script =
            "$ErrorActionPreference = 'Stop'\r\n"
            "$inPath = '" + escape_ps(PathToUtf8(tmp_ppt)) + "'\r\n"
            "$outPath = '" + escape_ps(PathToUtf8(tmp_pdf)) + "'\r\n"
            "try {\r\n"
            "  $pp = New-Object -ComObject PowerPoint.Application\r\n"
            "  try {\r\n"
            "    $pres = $pp.Presentations.Open($inPath, 1, 0, 0)\r\n"
            "    $pres.SaveAs($outPath, 32)\r\n"
            "    $pres.Close()\r\n"
            "  } finally {\r\n"
            "    $pp.Quit()\r\n"
            "  }\r\n"
            "  exit 0\r\n"
            "} catch {\r\n"
            "  $soffice = @('C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1\r\n"
            "  if ($soffice) {\r\n"
            "    & $soffice --headless --convert-to pdf --outdir (Split-Path $outPath) $inPath | Out-Null\r\n"
            "    exit $LASTEXITCODE\r\n"
            "  }\r\n"
            "  exit 2\r\n"
            "}\r\n";
        std::string bom_script = "\xEF\xBB\xBF" + ps_script;
        if (!AtomicWriteFile(tmp_ps1, bom_script.data(), bom_script.size(), &write_err)) {
          SetJsonError(&resp, 500, write_err);
        } else {
          std::string cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + PathToUtf8(tmp_ps1) + "\"";
          int rc = std::system(cmd.c_str());
          std::filesystem::remove(tmp_ppt, ec);
          std::filesystem::remove(tmp_ps1, ec);
          if (rc != 0 || !std::filesystem::exists(tmp_pdf, ec)) {
            std::filesystem::remove(tmp_pdf, ec);
            SetJsonError(&resp, 501, "PPTX conversion failed: PowerPoint or LibreOffice is required.");
          } else {
            std::lock_guard<std::mutex> fslock(fs_mu_);
            std::filesystem::copy_file(tmp_pdf, target_pdf, std::filesystem::copy_options::overwrite_existing, ec);
            std::filesystem::remove(tmp_pdf, ec);
            if (ec) {
              SetJsonError(&resp, 500, "Failed to finalize converted PDF");
            } else {
              NotesDb db = LoadAndSyncNotesDb(save_dir);
              NoteMeta meta;
              meta.id = note_id;
              meta.title = base;
              meta.color = "#14B8A6";
              meta.folder = "";
              db.notes.push_back(meta);
              SaveNotesDb(save_dir, db);

              resp.status = 201;
              resp.status_text = StatusTextFor(201);
              std::ostringstream oss;
              oss << "{\"id\":\"" << JsonEscape(note_id)
                  << "\",\"title\":\"" << JsonEscape(base)
                  << "\",\"name\":\"" << JsonEscape(base + ".pdf")
                  << "\",\"url\":\"/pdf/" << UrlEncodePathSegment(disk_fname) << "\"}";
              resp.body = oss.str();
            }
          }
        }
      }
#else
      SetJsonError(&resp, 501, "PowerPoint conversion is supported on Windows");
#endif
    }
  } else if (req.method == "POST" && req.path == "/api/notebooks/import") {
    std::string raw_name;
    std::string name;
    if (!GetQueryParam(req.query, "name", &raw_name) ||
        ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name, true)) {
      SetJsonError(&resp, 400, "Missing or invalid name parameter");
    } else {
      if (!EndsWithCaseInsensitive(name, ".pdf")) {
        name += ".pdf";
      }
      if (!IsSafeFilename(name)) {
        SetJsonError(&resp, 400, "Unsafe filename");
      } else if (req.body.size() < 5 ||
                 req.body.compare(0, 5, "%PDF-") != 0) {
        SetJsonError(&resp, 400, "Body must be a valid PDF (%PDF- header)");
      } else {
        std::string title_stem = name.substr(0, name.size() - 4);
        std::lock_guard<std::mutex> fslock(fs_mu_);
        std::filesystem::path save_dir =
            PathFromUtf8(config_store_->GetSaveDir());
        std::error_code ec;
        std::filesystem::create_directories(save_dir, ec);
        NotesDb db = LoadAndSyncNotesDb(save_dir);

        std::string note_id = MintNoteId();
        std::string disk_fname = note_id + ".pdf";
        std::filesystem::path target = save_dir / PathFromUtf8(disk_fname);

        std::string write_err;
        if (!AtomicWriteFile(target, req.body.data(), req.body.size(),
                             &write_err)) {
          SetJsonError(&resp, 500, write_err);
        } else {
          NoteMeta meta;
          meta.id = note_id;
          meta.title = title_stem;
          meta.color = "#14B8A6";
          meta.folder = "";
          db.notes.push_back(meta);
          SaveNotesDb(save_dir, db);

          resp.status = 201;
          resp.status_text = StatusTextFor(201);
          std::ostringstream oss;
          oss << "{\"id\":\"" << JsonEscape(note_id)
              << "\",\"title\":\"" << JsonEscape(title_stem)
              << "\",\"name\":\"" << JsonEscape(name) << "\",\"url\":\"/pdf/"
              << UrlEncodePathSegment(disk_fname) << "\"}";
          resp.body = oss.str();
        }
      }
    }
  } else if (req.method == "POST" &&
             req.path.compare(0, 15, "/api/notebooks/") == 0 &&
             EndsWithCaseInsensitive(req.path, "/meta")) {
    std::string raw_name =
        req.path.substr(15, req.path.size() - 15 - 5);  // strip /meta
    std::string name;
    if (raw_name.empty() || ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name)) {
      SetJsonError(&resp, 400, "Invalid notebook ID");
    } else {
      JsonObject obj;
      if (req.body.empty() || !ParseFlatJsonObject(req.body, &obj)) {
        SetJsonError(&resp, 400, "Invalid JSON body");
      } else {
        std::lock_guard<std::mutex> fslock(fs_mu_);
        std::filesystem::path save_dir =
            PathFromUtf8(config_store_->GetSaveDir());
        NotesDb db = LoadAndSyncNotesDb(save_dir);
        std::string disk_fname;
        NoteMeta* meta = nullptr;
        if (!ResolveNotebookTarget(save_dir, name, &db, &disk_fname, &meta) ||
            !meta) {
          SetJsonError(&resp, 404, "Notebook not found");
        } else {
          if (auto it = obj.find("title");
              it != obj.end() && it->second.type == JsonValue::Type::kString) {
            std::string t = SanitizeNotebookTitle(it->second.str_val);
            if (!t.empty()) meta->title = t;
          }
          if (auto it = obj.find("color");
              it != obj.end() && it->second.type == JsonValue::Type::kString &&
              !it->second.str_val.empty()) {
            meta->color = it->second.str_val;
          }
          if (auto it = obj.find("folder");
              it != obj.end() && it->second.type == JsonValue::Type::kString) {
            meta->folder = TrimWhitespace(it->second.str_val);
            if (!meta->folder.empty() &&
                std::find(db.folders.begin(), db.folders.end(), meta->folder) ==
                    db.folders.end()) {
              db.folders.push_back(meta->folder);
            }
          }
          SaveNotesDb(save_dir, db);
          std::ostringstream oss;
          oss << "{\"ok\":true,\"id\":\"" << JsonEscape(meta->id)
              << "\",\"title\":\"" << JsonEscape(meta->title)
              << "\",\"color\":\"" << JsonEscape(meta->color)
              << "\",\"folder\":\"" << JsonEscape(meta->folder) << "\"}";
          resp.body = oss.str();
        }
      }
    }
  } else if (req.method == "POST" &&
             req.path.compare(0, 15, "/api/notebooks/") == 0 &&
             EndsWithCaseInsensitive(req.path, "/add-page")) {
    std::string raw_name =
        req.path.substr(15, req.path.size() - 15 - 9);  // strip /add-page
    std::string name;
    if (raw_name.empty() || ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name) || !IsSafeFilename(name)) {
      SetJsonError(&resp, 400, "Invalid notebook name");
    } else {
      std::optional<PdfTemplate> override_tmpl;
      std::optional<PdfPageSize> override_size;
      int insert_page = -1;
      bool bad_json = false;
      std::string json_err;

      if (!req.body.empty()) {
        JsonObject obj;
        if (!ParseFlatJsonObject(req.body, &obj)) {
          bad_json = true;
          json_err = "Invalid JSON body";
        } else {
          if (auto it = obj.find("insertPage");
              it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
            insert_page = static_cast<int>(it->second.num_val);
          }
          if (auto it = obj.find("template");
              it != obj.end() && it->second.type == JsonValue::Type::kString &&
              !it->second.str_val.empty()) {
            PdfTemplate t;
            if (!ParsePdfTemplate(it->second.str_val, &t)) {
              bad_json = true;
              json_err = "Invalid template";
            } else {
              override_tmpl = t;
            }
          }
          std::string preset;
          double w_mm = 0.0;
          double h_mm = 0.0;
          bool has_size_override = false;
          if (auto it = obj.find("pageSize");
              it != obj.end() && it->second.type == JsonValue::Type::kString &&
              !it->second.str_val.empty()) {
            preset = it->second.str_val;
            has_size_override = true;
          }
          if (auto it = obj.find("widthMm");
              it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
            w_mm = it->second.num_val;
            has_size_override = true;
          }
          if (auto it = obj.find("heightMm");
              it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
            h_mm = it->second.num_val;
            has_size_override = true;
          }
          if (!bad_json && has_size_override) {
            PdfPageSize sz;
            if (!ResolvePdfPageSize(preset, w_mm, h_mm, &sz)) {
              bad_json = true;
              json_err = "Invalid page size override";
            } else {
              override_size = sz;
            }
          }
        }
      }

      if (bad_json) {
        SetJsonError(&resp, 400, json_err);
      } else {
        std::lock_guard<std::mutex> fslock(fs_mu_);
        std::filesystem::path save_dir =
            PathFromUtf8(config_store_->GetSaveDir());
        NotesDb db = LoadAndSyncNotesDb(save_dir);
        std::string disk_fname;
        NoteMeta* meta = nullptr;
        if (!ResolveNotebookTarget(save_dir, name, &db, &disk_fname, &meta)) {
          SetJsonError(&resp, 404, "Notebook not found");
        } else {
          std::filesystem::path target = save_dir / PathFromUtf8(disk_fname);
          std::string existing_pdf;
          if (!ReadWholeFile(target, &existing_pdf)) {
            SetJsonError(&resp, 500, "Failed to read notebook");
          } else {
            std::string updated_pdf;
            int new_pages = 0;
            std::string append_err;
            if (!AppendPageToPdf(existing_pdf, override_tmpl, override_size,
                                 &updated_pdf, &new_pages, &append_err,
                                 insert_page)) {
              SetJsonError(&resp, 400, append_err);
            } else {
              std::string write_err;
              if (!AtomicWriteFile(target, updated_pdf.data(),
                                   updated_pdf.size(), &write_err)) {
                SetJsonError(&resp, 500, write_err);
              } else {
                int64_t mtime = GetFileMtimeEpoch(target);
                std::ostringstream oss;
                oss << "{\"added\":true,\"name\":\"" << JsonEscape(disk_fname)
                    << "\",\"pages\":" << new_pages
                    << ",\"size\":" << updated_pdf.size()
                    << ",\"mtime\":" << mtime << "}";
                resp.body = oss.str();
              }
            }
          }
        }
      }
    }
  } else if (req.method == "DELETE" &&
             req.path.compare(0, 15, "/api/notebooks/") == 0) {
    std::string raw_name = req.path.substr(15);
    std::string name;
    if (raw_name.empty() || ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name) || !IsSafeFilename(name)) {
      SetJsonError(&resp, 400, "Invalid notebook name");
    } else {
      std::lock_guard<std::mutex> fslock(fs_mu_);
      std::filesystem::path save_dir =
          PathFromUtf8(config_store_->GetSaveDir());
      NotesDb db = LoadAndSyncNotesDb(save_dir);
      std::string disk_fname;
      NoteMeta* meta = nullptr;
      if (!ResolveNotebookTarget(save_dir, name, &db, &disk_fname, &meta)) {
        SetJsonError(&resp, 404, "Notebook not found");
      } else {
        std::filesystem::path target = save_dir / PathFromUtf8(disk_fname);
        std::error_code ec;
        std::filesystem::remove(target, ec);
        if (ec) {
          SetJsonError(&resp, 500, "Failed to delete notebook");
        } else {
          if (meta) {
            std::string del_id = meta->id;
            db.notes.erase(
                std::remove_if(db.notes.begin(), db.notes.end(),
                               [&](const NoteMeta& m) { return m.id == del_id; }),
                db.notes.end());
            SaveNotesDb(save_dir, db);
          }
          resp.body = "{\"deleted\":true}";
        }
      }
    }
  } else if ((req.method == "GET" || req.method == "HEAD") &&
             req.path.compare(0, 5, "/pdf/") == 0) {
    std::string raw_name = req.path.substr(5);
    std::string name;
    if (raw_name.empty() || ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name) || !IsSafeFilename(name)) {
      SetJsonError(&resp, 400, "Invalid PDF filename");
    } else {
      std::filesystem::path save_dir =
          PathFromUtf8(config_store_->GetSaveDir());
      std::string disk_fname;
      {
        std::lock_guard<std::mutex> fslock(fs_mu_);
        NotesDb db = LoadAndSyncNotesDb(save_dir);
        NoteMeta* meta = nullptr;
        if (!ResolveNotebookTarget(save_dir, name, &db, &disk_fname, &meta)) {
          disk_fname.clear();
        }
      }
      std::filesystem::path target =
          disk_fname.empty() ? (save_dir / PathFromUtf8(name))
                             : (save_dir / PathFromUtf8(disk_fname));
      std::error_code ec;
      if (!IsPathWithinDir(save_dir, target) ||
          !std::filesystem::is_regular_file(target, ec)) {
        SetJsonError(&resp, 404, "PDF not found");
      } else {
        std::string content;
        if (!ReadWholeFile(target, &content)) {
          SetJsonError(&resp, 500, "Failed to read PDF");
        } else {
          resp.content_type = "application/pdf";
          resp.extra_headers["Cache-Control"] = "no-store";
          resp.extra_headers["Accept-Ranges"] = "bytes";
          resp.head_only = (req.method == "HEAD");

          auto range_it = req.headers.find("range");
          if (range_it != req.headers.end()) {
            size_t r_start = 0;
            size_t r_end = 0;
            if (!ParseHttpRange(range_it->second, content.size(), &r_start,
                                &r_end)) {
              resp.status = 416;
              resp.status_text = StatusTextFor(416);
              resp.extra_headers["Content-Range"] =
                  "bytes */" + std::to_string(content.size());
              resp.body.clear();
            } else {
              size_t len = r_end - r_start + 1;
              resp.status = 206;
              resp.status_text = StatusTextFor(206);
              resp.extra_headers["Content-Range"] =
                  "bytes " + std::to_string(r_start) + "-" +
                  std::to_string(r_end) + "/" + std::to_string(content.size());
              if (resp.head_only) {
                resp.has_explicit_content_length = true;
                resp.explicit_content_length = len;
              } else {
                resp.body = content.substr(r_start, len);
              }
            }
          } else {
            if (resp.head_only) {
              resp.has_explicit_content_length = true;
              resp.explicit_content_length = content.size();
            } else {
              resp.body = std::move(content);
            }
          }
        }
      }
    }
  } else if (req.method == "POST" && req.path == "/api/save") {
    std::string raw_name;
    std::string name;
    if (!GetQueryParam(req.query, "name", &raw_name) ||
        ContainsEncodedTraversal(raw_name) ||
        !UrlDecode(raw_name, &name, true) || !IsSafeFilename(name)) {
      SetJsonError(&resp, 400, "Invalid or unsafe filename");
    } else if (req.body.size() < 5 || req.body.compare(0, 5, "%PDF-") != 0) {
      SetJsonError(&resp, 400, "Payload is not a valid PDF (%PDF- header)");
    } else {
      std::lock_guard<std::mutex> fslock(fs_mu_);
      std::filesystem::path save_dir =
          PathFromUtf8(config_store_->GetSaveDir());
      NotesDb db = LoadAndSyncNotesDb(save_dir);
      std::string disk_fname;
      NoteMeta* meta = nullptr;
      if (!ResolveNotebookTarget(save_dir, name, &db, &disk_fname, &meta)) {
        disk_fname = name;
      }
      std::filesystem::path target = save_dir / PathFromUtf8(disk_fname);
      if (!IsPathWithinDir(save_dir, target)) {
        SetJsonError(&resp, 400, "Path escapes saveDir");
      } else {
        std::string write_err;
        if (!AtomicWriteFile(target, req.body.data(), req.body.size(),
                             &write_err)) {
          SetJsonError(&resp, 500, write_err);
        } else {
          int64_t mtime = GetFileMtimeEpoch(target);
          std::ostringstream oss;
          oss << "{\"saved\":true,\"name\":\"" << JsonEscape(disk_fname)
              << "\",\"size\":" << req.body.size() << ",\"mtime\":" << mtime
              << "}";
          resp.body = oss.str();
        }
      }
    }
  } else {
    SetJsonError(&resp, 404, "Endpoint not found");
  }

  // 3. Serialize & send HTTP response.
  size_t out_len = resp.has_explicit_content_length ? resp.explicit_content_length
                                                    : resp.body.size();
  std::ostringstream hdr;
  hdr << "HTTP/1.1 " << resp.status << " " << resp.status_text << "\r\n";
  if (!resp.content_type.empty()) {
    hdr << "Content-Type: " << resp.content_type << "\r\n";
  }
  for (const auto& kv : resp.extra_headers) {
    hdr << kv.first << ": " << kv.second << "\r\n";
  }
  hdr << "Content-Length: " << out_len << "\r\n";
  hdr << "Connection: close\r\n\r\n";

  std::string header_str = hdr.str();
  if (!SendAll(sock, header_str.data(), header_str.size())) return;
  if (!resp.head_only && !resp.body.empty()) {
    SendAll(sock, resp.body.data(), resp.body.size());
  }
}

}  // namespace crpdf
