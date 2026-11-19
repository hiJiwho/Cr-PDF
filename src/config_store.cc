#include "config_store.h"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h>
#include <shlobj.h>
#include <shobjidl.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace crpdf {

namespace {

int HexDigitValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

void AppendUtf8CodePoint(uint32_t cp, std::string* out) {
  if (cp <= 0x7F) {
    out->push_back(static_cast<char>(cp));
  } else if (cp <= 0x7FF) {
    out->push_back(static_cast<char>(0xC0 | ((cp >> 6) & 0x1F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
    out->push_back(static_cast<char>(0xE0 | ((cp >> 12) & 0x0F)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0x10FFFF) {
    out->push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

bool IsWindowsReservedName(const std::string& name) {
  size_t dot = name.find('.');
  std::string stem = (dot == std::string::npos) ? name : name.substr(0, dot);
  std::string upper;
  upper.reserve(stem.size());
  for (unsigned char c : stem) {
    upper.push_back(static_cast<char>(std::toupper(c)));
  }
  if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL") {
    return true;
  }
  if (upper.size() == 4 &&
      (upper.compare(0, 3, "COM") == 0 || upper.compare(0, 3, "LPT") == 0) &&
      upper[3] >= '1' && upper[3] <= '9') {
    return true;
  }
  return false;
}

#ifdef _WIN32
std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return "";
  int needed = WideCharToMultiByte(CP_UTF8, 0, w.data(),
                                   static_cast<int>(w.size()), nullptr, 0,
                                   nullptr, nullptr);
  if (needed <= 0) return "";
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()),
                      out.data(), needed, nullptr, nullptr);
  return out;
}

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(),
                                   static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) return L"";
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                      out.data(), needed);
  return out;
}
#endif

}  // namespace

std::filesystem::path PathFromUtf8(const std::string& utf8) {
#ifdef _WIN32
  return std::filesystem::path(Utf8ToWide(utf8));
#else
  return std::filesystem::path(utf8);
#endif
}

std::string PathToUtf8(const std::filesystem::path& path) {
#ifdef _WIN32
  return WideToUtf8(path.wstring());
#else
  return path.string();
#endif
}

std::string GetDefaultSaveDir() {
#ifdef _WIN32
  PWSTR pwstr = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &pwstr)) &&
      pwstr != nullptr) {
    std::filesystem::path p(pwstr);
    CoTaskMemFree(pwstr);
    p /= L"Cr-PDF";
    p /= L"notes";
    return PathToUtf8(p);
  }
  return "Cr-PDF-Notes";
#else
  const char* home = std::getenv("HOME");
  if (home && *home) {
    return PathToUtf8(std::filesystem::path(home) / ".config" / "cr-pdf" / "notes");
  }
  return "/tmp/Cr-PDF-Notes";
#endif
}

std::string GetDefaultConfigPath() {
#ifdef _WIN32
  PWSTR pwstr = nullptr;
  if (SUCCEEDED(
          SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &pwstr)) &&
      pwstr != nullptr) {
    std::filesystem::path p(pwstr);
    CoTaskMemFree(pwstr);
    p /= L"Cr-PDF";
    p /= L"config.json";
    return PathToUtf8(p);
  }
  return "crpdf_config.json";
#else
  const char* xdg = std::getenv("XDG_CONFIG_HOME");
  if (xdg && *xdg) {
    return PathToUtf8(std::filesystem::path(xdg) / "cr-pdf" / "config.json");
  }
  const char* home = std::getenv("HOME");
  if (home && *home) {
    return PathToUtf8(std::filesystem::path(home) / ".config" / "cr-pdf" /
                      "config.json");
  }
  return "/tmp/cr-pdf/config.json";
#endif
}

std::string UrlEncodePathSegment(const std::string& s) {
  static const char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(s.size() * 3);
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' ||
        c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(kHex[(c >> 4) & 0x0F]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

bool UrlDecode(const std::string& in, std::string* out, bool plus_as_space) {
  if (!out) return false;
  out->clear();
  out->reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    char c = in[i];
    if (c == '%') {
      if (i + 2 >= in.size()) return false;
      int hi = HexDigitValue(in[i + 1]);
      int lo = HexDigitValue(in[i + 2]);
      if (hi < 0 || lo < 0) return false;
      out->push_back(static_cast<char>((hi << 4) | lo));
      i += 2;
    } else if (plus_as_space && c == '+') {
      out->push_back(' ');
    } else {
      out->push_back(c);
    }
  }
  return true;
}

bool AtomicWriteFile(const std::filesystem::path& target_path,
                     const void* data,
                     size_t size,
                     std::string* error_out) {
  std::error_code ec;
  if (target_path.has_parent_path()) {
    std::filesystem::create_directories(target_path.parent_path(), ec);
  }

  std::filesystem::path tmp_path = target_path;
  tmp_path += ".tmp";

#ifdef _WIN32
  std::wstring tmp_w = tmp_path.wstring();
  std::wstring target_w = target_path.wstring();

  HANDLE h = CreateFileW(tmp_w.c_str(), GENERIC_WRITE, 0, nullptr,
                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    if (error_out) *error_out = "CreateFileW failed for temp file";
    return false;
  }

  const unsigned char* bytes = static_cast<const unsigned char*>(data);
  size_t remaining = size;
  while (remaining > 0) {
    DWORD chunk =
        (remaining > 0x40000000U) ? 0x40000000U : static_cast<DWORD>(remaining);
    DWORD written = 0;
    if (!WriteFile(h, bytes, chunk, &written, nullptr) || written == 0) {
      CloseHandle(h);
      DeleteFileW(tmp_w.c_str());
      if (error_out) *error_out = "WriteFile failed";
      return false;
    }
    bytes += written;
    remaining -= written;
  }

  if (!FlushFileBuffers(h)) {
    CloseHandle(h);
    DeleteFileW(tmp_w.c_str());
    if (error_out) *error_out = "FlushFileBuffers failed";
    return false;
  }
  CloseHandle(h);

  if (!MoveFileExW(tmp_w.c_str(), target_w.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(tmp_w.c_str());
    if (error_out) *error_out = "MoveFileExW failed";
    return false;
  }
  return true;
#else
  std::string tmp_s = tmp_path.string();
  std::string target_s = target_path.string();

  int fd = ::open(tmp_s.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    if (error_out) *error_out = std::string("open failed: ") + std::strerror(errno);
    return false;
  }

  const unsigned char* bytes = static_cast<const unsigned char*>(data);
  size_t remaining = size;
  while (remaining > 0) {
    ssize_t n = ::write(fd, bytes, remaining);
    if (n < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      ::close(fd);
      ::unlink(tmp_s.c_str());
      if (error_out) *error_out = std::string("write failed: ") + std::strerror(err);
      return false;
    }
    bytes += static_cast<size_t>(n);
    remaining -= static_cast<size_t>(n);
  }

  if (::fsync(fd) != 0) {
    int err = errno;
    ::close(fd);
    ::unlink(tmp_s.c_str());
    if (error_out) *error_out = std::string("fsync failed: ") + std::strerror(err);
    return false;
  }

  if (::close(fd) != 0) {
    int err = errno;
    ::unlink(tmp_s.c_str());
    if (error_out) *error_out = std::string("close failed: ") + std::strerror(err);
    return false;
  }

  if (::rename(tmp_s.c_str(), target_s.c_str()) != 0) {
    int err = errno;
    ::unlink(tmp_s.c_str());
    if (error_out) *error_out = std::string("rename failed: ") + std::strerror(err);
    return false;
  }
  return true;
#endif
}

bool IsSafeFilename(const std::string& name) {
  if (name.empty() || name.size() > 200) return false;
  if (name == "." || name == "..") return false;
  if (name.find("..") != std::string::npos) return false;

  unsigned char first = static_cast<unsigned char>(name.front());
  unsigned char last = static_cast<unsigned char>(name.back());
  if (std::isspace(first) || std::isspace(last) || last == '.') return false;

  for (unsigned char c : name) {
    if (c < 0x20 || c == 0x7F) return false;
    switch (c) {
      case '/':
      case '\\':
      case ':':
      case '*':
      case '?':
      case '"':
      case '<':
      case '>':
      case '|':
        return false;
      default:
        break;
    }
  }

  if (IsWindowsReservedName(name)) return false;
  return true;
}

std::string SanitizeNotebookTitle(const std::string& title) {
  std::string out;
  out.reserve(title.size());
  for (unsigned char c : title) {
    if (c < 0x20 || c == 0x7F) continue;
    switch (c) {
      case '/':
      case '\\':
      case ':':
      case '*':
      case '?':
      case '"':
      case '<':
      case '>':
      case '|':
        out.push_back('_');
        break;
      default:
        out.push_back(static_cast<char>(c));
        break;
    }
  }

  // Collapse consecutive dots ("..") into a single "." in one pass.
  std::string collapsed;
  collapsed.reserve(out.size());
  for (char c : out) {
    if (c == '.' && !collapsed.empty() && collapsed.back() == '.') continue;
    collapsed.push_back(c);
  }
  out = std::move(collapsed);

  // Trim leading/trailing whitespace and trailing dots.
  size_t start = 0;
  while (start < out.size() &&
         std::isspace(static_cast<unsigned char>(out[start]))) {
    ++start;
  }
  size_t end = out.size();
  while (end > start &&
         (std::isspace(static_cast<unsigned char>(out[end - 1])) ||
          out[end - 1] == '.')) {
    --end;
  }
  out = out.substr(start, end - start);

  if (out.size() > 160) {
    out.resize(160);
    while (!out.empty() && (static_cast<unsigned char>(out.back()) & 0xC0) == 0x80) {
      out.pop_back();
    }
  }

  if (out.empty() || IsWindowsReservedName(out)) {
    out = "Untitled";
  }
  return out;
}

bool IsPathWithinDir(const std::filesystem::path& base_dir,
                     const std::filesystem::path& candidate) {
  std::error_code ec1;
  std::error_code ec2;
  std::filesystem::path base = std::filesystem::weakly_canonical(base_dir, ec1);
  std::filesystem::path cand = std::filesystem::weakly_canonical(candidate, ec2);
  if (ec1 || ec2) return false;

  auto bit = base.begin();
  auto cit = cand.begin();
  for (; bit != base.end(); ++bit, ++cit) {
    if (cit == cand.end() || *bit != *cit) {
      return false;
    }
  }
  return true;
}

std::string JsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned int>(c));
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  return out;
}

namespace {

class JsonParser {
 public:
  explicit JsonParser(const std::string& input) : s_(input), pos_(0) {}

  bool ParseObject(JsonObject* out) {
    out->clear();
    SkipWs();
    if (!Consume('{')) return false;
    SkipWs();
    if (Peek() == '}') {
      ++pos_;
      SkipWs();
      return pos_ == s_.size();
    }
    while (true) {
      SkipWs();
      std::string key;
      if (!ParseString(&key)) return false;
      SkipWs();
      if (!Consume(':')) return false;
      SkipWs();
      JsonValue val;
      if (!ParseValue(&val)) return false;
      (*out)[key] = std::move(val);
      SkipWs();
      if (Consume(',')) continue;
      if (Consume('}')) break;
      return false;
    }
    SkipWs();
    return pos_ == s_.size();
  }

 private:
  void SkipWs() {
    while (pos_ < s_.size()) {
      char c = s_[pos_];
      if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
        ++pos_;
      } else {
        break;
      }
    }
  }

  char Peek() const { return (pos_ < s_.size()) ? s_[pos_] : '\0'; }

  bool Consume(char expected) {
    if (pos_ < s_.size() && s_[pos_] == expected) {
      ++pos_;
      return true;
    }
    return false;
  }

  bool ParseString(std::string* out) {
    out->clear();
    if (!Consume('"')) return false;
    while (pos_ < s_.size()) {
      char c = s_[pos_++];
      if (c == '"') return true;
      if (static_cast<unsigned char>(c) < 0x20) return false;
      if (c == '\\') {
        if (pos_ >= s_.size()) return false;
        char esc = s_[pos_++];
        switch (esc) {
          case '"':
            out->push_back('"');
            break;
          case '\\':
            out->push_back('\\');
            break;
          case '/':
            out->push_back('/');
            break;
          case 'b':
            out->push_back('\b');
            break;
          case 'f':
            out->push_back('\f');
            break;
          case 'n':
            out->push_back('\n');
            break;
          case 'r':
            out->push_back('\r');
            break;
          case 't':
            out->push_back('\t');
            break;
          case 'u': {
            if (pos_ + 4 > s_.size()) return false;
            uint32_t cp = 0;
            for (int i = 0; i < 4; ++i) {
              int d = HexDigitValue(s_[pos_++]);
              if (d < 0) return false;
              cp = (cp << 4) | static_cast<uint32_t>(d);
            }
            if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 6 <= s_.size() &&
                s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
              uint32_t low = 0;
              bool ok = true;
              for (int i = 0; i < 4; ++i) {
                int d = HexDigitValue(s_[pos_ + 2 + i]);
                if (d < 0) {
                  ok = false;
                  break;
                }
                low = (low << 4) | static_cast<uint32_t>(d);
              }
              if (ok && low >= 0xDC00 && low <= 0xDFFF) {
                pos_ += 6;
                cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
              }
            }
            AppendUtf8CodePoint(cp, out);
            break;
          }
          default:
            return false;
        }
      } else {
        out->push_back(c);
      }
    }
    return false;
  }

  bool ParseValue(JsonValue* out) {
    char c = Peek();
    if (c == '"') {
      out->type = JsonValue::Type::kString;
      return ParseString(&out->str_val);
    }
    if (c == 't' && s_.compare(pos_, 4, "true") == 0) {
      pos_ += 4;
      out->type = JsonValue::Type::kBool;
      out->bool_val = true;
      return true;
    }
    if (c == 'f' && s_.compare(pos_, 5, "false") == 0) {
      pos_ += 5;
      out->type = JsonValue::Type::kBool;
      out->bool_val = false;
      return true;
    }
    if (c == 'n' && s_.compare(pos_, 4, "null") == 0) {
      pos_ += 4;
      out->type = JsonValue::Type::kNull;
      return true;
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
      const char* start = s_.c_str() + pos_;
      char* end = nullptr;
      double v = std::strtod(start, &end);
      if (end == start) return false;
      pos_ = static_cast<size_t>(end - s_.c_str());
      out->type = JsonValue::Type::kNumber;
      out->num_val = v;
      return true;
    }
    return false;
  }

  const std::string& s_;
  size_t pos_;
};

}  // namespace

bool ParseFlatJsonObject(const std::string& json, JsonObject* out) {
  if (!out) return false;
  JsonParser parser(json);
  return parser.ParseObject(out);
}

PickFolderResult PickFolderDialog(const std::string& initial_dir) {
  PickFolderResult result;
#ifdef _WIN32
  HRESULT init_hr =
      CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  bool should_uninit = SUCCEEDED(init_hr);

  IFileOpenDialog* dialog = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                                CLSCTX_ALL, IID_PPV_ARGS(&dialog));
  if (SUCCEEDED(hr) && dialog) {
    DWORD options = 0;
    if (SUCCEEDED(dialog->GetOptions(&options))) {
      dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
                         FOS_PATHMUSTEXIST);
    }
    if (!initial_dir.empty()) {
      std::wstring wdir = Utf8ToWide(initial_dir);
      IShellItem* init_item = nullptr;
      if (SUCCEEDED(SHCreateItemFromParsingName(wdir.c_str(), nullptr,
                                                IID_PPV_ARGS(&init_item))) &&
          init_item) {
        dialog->SetFolder(init_item);
        init_item->Release();
      }
    }
    if (SUCCEEDED(dialog->Show(nullptr))) {
      IShellItem* item = nullptr;
      if (SUCCEEDED(dialog->GetResult(&item)) && item) {
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
          result.save_dir = WideToUtf8(std::wstring(path));
          result.cancelled = false;
          CoTaskMemFree(path);
        }
        item->Release();
      }
    }
    dialog->Release();
  }

  if (should_uninit) {
    CoUninitialize();
  }
  return result;
#else
  const char* display = std::getenv("DISPLAY");
  const char* wayland = std::getenv("WAYLAND_DISPLAY");
  if ((!display || !*display) && (!wayland || !*wayland)) {
    return result;
  }

  const char* tool = nullptr;
  bool is_zenity = false;
  if (::access("/usr/bin/zenity", X_OK) == 0) {
    tool = "/usr/bin/zenity";
    is_zenity = true;
  } else if (::access("/usr/bin/kdialog", X_OK) == 0) {
    tool = "/usr/bin/kdialog";
  } else {
    return result;
  }

  int pipefd[2];
  if (::pipe(pipefd) != 0) return result;

  pid_t pid = ::fork();
  if (pid < 0) {
    ::close(pipefd[0]);
    ::close(pipefd[1]);
    return result;
  }

  if (pid == 0) {
    ::close(pipefd[0]);
    ::dup2(pipefd[1], STDOUT_FILENO);
    ::close(pipefd[1]);

    std::vector<char*> argv;
    std::string init_arg;
    argv.push_back(const_cast<char*>(tool));
    if (is_zenity) {
      argv.push_back(const_cast<char*>("--file-selection"));
      argv.push_back(const_cast<char*>("--directory"));
      argv.push_back(const_cast<char*>("--title=Select Cr-PDF Save Folder"));
      if (!initial_dir.empty()) {
        init_arg = "--filename=" + initial_dir + "/";
        argv.push_back(const_cast<char*>(init_arg.c_str()));
      }
    } else {
      argv.push_back(const_cast<char*>("--getexistingdirectory"));
      if (!initial_dir.empty()) {
        init_arg = initial_dir;
        argv.push_back(const_cast<char*>(init_arg.c_str()));
      }
    }
    argv.push_back(nullptr);
    ::execv(tool, argv.data());
    _exit(127);
  }

  ::close(pipefd[1]);
  std::string output;
  char buf[512];
  ssize_t n = 0;
  while ((n = ::read(pipefd[0], buf, sizeof(buf))) > 0) {
    output.append(buf, static_cast<size_t>(n));
  }
  ::close(pipefd[0]);

  int status = 0;
  ::waitpid(pid, &status, 0);
  if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
    while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) {
      output.pop_back();
    }
    if (!output.empty()) {
      result.save_dir = output;
      result.cancelled = false;
    }
  }
  return result;
#endif
}

ConfigStore::ConfigStore(std::string config_path)
    : config_path_(std::move(config_path)) {
  config_.save_dir = GetDefaultSaveDir();
}

bool ConfigStore::Load() {
  std::lock_guard<std::mutex> lock(mu_);
  std::filesystem::path cfg_path = PathFromUtf8(config_path_);
  std::ifstream ifs(cfg_path, std::ios::binary);
  if (ifs.is_open()) {
    std::ostringstream oss;
    oss << ifs.rdbuf();
    JsonObject obj;
    if (ParseFlatJsonObject(oss.str(), &obj)) {
      auto it = obj.find("saveDir");
      if (it != obj.end() && it->second.type == JsonValue::Type::kString &&
          !it->second.str_val.empty()) {
        config_.save_dir = it->second.str_val;
      }
      it = obj.find("autosaveIntervalSec");
      if (it != obj.end() && it->second.type == JsonValue::Type::kNumber) {
        int v = static_cast<int>(it->second.num_val);
        config_.autosave_interval_sec = std::clamp(v, 0, 3600);
      }
      it = obj.find("autosaveEnabled");
      if (it != obj.end() && it->second.type == JsonValue::Type::kBool) {
        config_.autosave_enabled = it->second.bool_val;
      }
      it = obj.find("palmRejection");
      if (it != obj.end() && it->second.type == JsonValue::Type::kBool) {
        config_.palm_rejection = it->second.bool_val;
      }
      it = obj.find("pseudoPressure");
      if (it != obj.end() && it->second.type == JsonValue::Type::kBool) {
        config_.pseudo_pressure = it->second.bool_val;
      }
    }
  }

  if (config_.save_dir.empty()) {
    config_.save_dir = GetDefaultSaveDir();
  }
  std::error_code ec;
  std::filesystem::create_directories(PathFromUtf8(config_.save_dir), ec);
  return true;
}

bool ConfigStore::Save() const {
  std::lock_guard<std::mutex> lock(mu_);
  return SaveLocked();
}

bool ConfigStore::SaveLocked() const {
  std::string json = SerializeConfig(config_);
  return AtomicWriteFile(PathFromUtf8(config_path_), json.data(), json.size(),
                         nullptr);
}

AppConfig ConfigStore::Get() const {
  std::lock_guard<std::mutex> lock(mu_);
  return config_;
}

std::string ConfigStore::GetSaveDir() const {
  std::lock_guard<std::mutex> lock(mu_);
  return config_.save_dir;
}

std::filesystem::path ConfigStore::GetConfigDir() const {
  std::filesystem::path p = PathFromUtf8(config_path_);
  if (p.has_parent_path()) return p.parent_path();
  return std::filesystem::current_path();
}

std::string ConfigStore::SerializeConfig(const AppConfig& cfg) {
  std::ostringstream oss;
  oss << "{\"saveDir\":\"" << JsonEscape(cfg.save_dir) << "\","
      << "\"autosaveIntervalSec\":" << cfg.autosave_interval_sec << ","
      << "\"autosaveEnabled\":" << (cfg.autosave_enabled ? "true" : "false")
      << ","
      << "\"palmRejection\":" << (cfg.palm_rejection ? "true" : "false") << ","
      << "\"pseudoPressure\":" << (cfg.pseudo_pressure ? "true" : "false")
      << "}";
  return oss.str();
}

std::string ConfigStore::ToJson() const {
  std::lock_guard<std::mutex> lock(mu_);
  return SerializeConfig(config_);
}

bool ConfigStore::UpdateFromJson(const std::string& json_body,
                                 AppConfig* updated_out,
                                 std::string* err_out) {
  JsonObject obj;
  if (!ParseFlatJsonObject(json_body, &obj)) {
    if (err_out) *err_out = "Invalid JSON object";
    return false;
  }

  std::lock_guard<std::mutex> lock(mu_);
  AppConfig next = config_;

  auto it = obj.find("saveDir");
  if (it != obj.end()) {
    if (it->second.type != JsonValue::Type::kString ||
        it->second.str_val.empty()) {
      if (err_out) *err_out = "saveDir must be a non-empty string";
      return false;
    }
    next.save_dir = it->second.str_val;
  }

  it = obj.find("autosaveIntervalSec");
  if (it != obj.end()) {
    if (it->second.type != JsonValue::Type::kNumber) {
      if (err_out) *err_out = "autosaveIntervalSec must be a number";
      return false;
    }
    int v = static_cast<int>(it->second.num_val);
    next.autosave_interval_sec = std::clamp(v, 0, 3600);
  }

  it = obj.find("autosaveEnabled");
  if (it != obj.end()) {
    if (it->second.type != JsonValue::Type::kBool) {
      if (err_out) *err_out = "autosaveEnabled must be a boolean";
      return false;
    }
    next.autosave_enabled = it->second.bool_val;
  }

  it = obj.find("palmRejection");
  if (it != obj.end()) {
    if (it->second.type != JsonValue::Type::kBool) {
      if (err_out) *err_out = "palmRejection must be a boolean";
      return false;
    }
    next.palm_rejection = it->second.bool_val;
  }

  it = obj.find("pseudoPressure");
  if (it != obj.end()) {
    if (it->second.type != JsonValue::Type::kBool) {
      if (err_out) *err_out = "pseudoPressure must be a boolean";
      return false;
    }
    next.pseudo_pressure = it->second.bool_val;
  }

  std::error_code ec;
  std::filesystem::create_directories(PathFromUtf8(next.save_dir), ec);
  if (ec) {
    if (err_out) *err_out = "Failed to create saveDir: " + ec.message();
    return false;
  }

  config_ = next;
  SaveLocked();
  if (updated_out) *updated_out = config_;
  return true;
}

void ConfigStore::SetSaveDir(const std::string& new_dir) {
  if (new_dir.empty()) return;
  std::lock_guard<std::mutex> lock(mu_);
  config_.save_dir = new_dir;
  std::error_code ec;
  std::filesystem::create_directories(PathFromUtf8(config_.save_dir), ec);
  SaveLocked();
}

void ConfigStore::SetAutosaveIntervalSec(int sec) {
  std::lock_guard<std::mutex> lock(mu_);
  config_.autosave_interval_sec = std::clamp(sec, 0, 3600);
  config_.autosave_enabled = (config_.autosave_interval_sec > 0);
}

void ConfigStore::ApplyCliOverrides(const std::string& save_dir_override,
                                    int autosave_interval_override) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!save_dir_override.empty()) {
    config_.save_dir = save_dir_override;
    std::error_code ec;
    std::filesystem::create_directories(PathFromUtf8(config_.save_dir), ec);
  }
  if (autosave_interval_override >= 0) {
    config_.autosave_interval_sec =
        std::clamp(autosave_interval_override, 0, 3600);
    config_.autosave_enabled = (config_.autosave_interval_sec > 0);
  }
}

}  // namespace crpdf
