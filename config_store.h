#ifndef CRPDF_CONFIG_STORE_H_
#define CRPDF_CONFIG_STORE_H_

#include <cstddef>
#include <filesystem>
#include <map>
#include <mutex>
#include <string>

namespace crpdf {

struct AppConfig {
  std::string save_dir;
  int autosave_interval_sec = 30;
  bool autosave_enabled = true;
  bool palm_rejection = true;
  bool pseudo_pressure = true;
};

struct PickFolderResult {
  std::string save_dir;
  bool cancelled = true;
};

// Cross-platform UTF-8 <-> std::filesystem::path helpers (C++20 char8_t-safe &
// Windows CP949-safe).
std::filesystem::path PathFromUtf8(const std::string& utf8);
std::string PathToUtf8(const std::filesystem::path& path);

std::string GetDefaultSaveDir();
std::string GetDefaultConfigPath();

// Percent-encoding / decoding for URL path segments and query parameters.
std::string UrlEncodePathSegment(const std::string& s);
bool UrlDecode(const std::string& in, std::string* out, bool plus_as_space = false);

// Atomic file write: writes <target>.tmp, flushes to disk, and atomically
// renames to <target>.
bool AtomicWriteFile(const std::filesystem::path& target_path,
                     const void* data,
                     size_t size,
                     std::string* error_out = nullptr);

// Strict filename validation and notebook title sanitization.
bool IsSafeFilename(const std::string& name);
std::string SanitizeNotebookTitle(const std::string& title);
bool IsPathWithinDir(const std::filesystem::path& base_dir,
                     const std::filesystem::path& candidate);

// Minimal zero-dependency JSON helpers (exception-free).
std::string JsonEscape(const std::string& s);

struct JsonValue {
  enum class Type { kNull, kBool, kNumber, kString };
  Type type = Type::kNull;
  bool bool_val = false;
  double num_val = 0.0;
  std::string str_val;
};

using JsonObject = std::map<std::string, JsonValue>;
bool ParseFlatJsonObject(const std::string& json, JsonObject* out);

// Native OS folder picker dialog.
PickFolderResult PickFolderDialog(const std::string& initial_dir = "");

class ConfigStore {
 public:
  explicit ConfigStore(std::string config_path = GetDefaultConfigPath());

  bool Load();
  bool Save() const;

  AppConfig Get() const;
  std::string GetSaveDir() const;
  std::filesystem::path GetConfigDir() const;

  std::string ToJson() const;
  bool UpdateFromJson(const std::string& json_body,
                      AppConfig* updated_out = nullptr,
                      std::string* err_out = nullptr);

  void SetSaveDir(const std::string& new_dir);
  void SetAutosaveIntervalSec(int sec);
  void ApplyCliOverrides(const std::string& save_dir_override,
                         int autosave_interval_override);

 private:
  bool SaveLocked() const;
  static std::string SerializeConfig(const AppConfig& cfg);

  std::string config_path_;
  mutable std::mutex mu_;
  AppConfig config_;
};

}  // namespace crpdf

#endif  // CRPDF_CONFIG_STORE_H_
