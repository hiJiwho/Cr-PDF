#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
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
#include <unistd.h>
#endif

#include "config_store.h"
#include "http_server.h"
#include "pdf_generator.h"

namespace {

int g_failures = 0;

#define EXPECT_TRUE(cond)                                                     \
  do {                                                                        \
    if (!(cond)) {                                                            \
      std::cerr << "[FAIL] " << __FILE__ << ":" << __LINE__ << ": " #cond     \
                << "\n";                                                      \
      ++g_failures;                                                           \
    }                                                                         \
  } while (0)

#define EXPECT_EQ(a, b)                                                       \
  do {                                                                        \
    auto _a = (a);                                                            \
    auto _b = (b);                                                            \
    if (!(_a == _b)) {                                                        \
      std::cerr << "[FAIL] " << __FILE__ << ":" << __LINE__ << ": " #a        \
                << " (" << _a << ") != " #b << " (" << _b << ")\n";           \
      ++g_failures;                                                           \
    }                                                                         \
  } while (0)

struct TempDir {
  std::filesystem::path path;
  TempDir() {
    std::error_code ec;
    auto base = std::filesystem::temp_directory_path(ec);
    for (int i = 0; i < 1000; ++i) {
      auto cand = base / ("crpdf_unit_test_" + std::to_string(std::rand()) +
                          "_" + std::to_string(i));
      if (!std::filesystem::exists(cand, ec)) {
        std::filesystem::create_directories(cand, ec);
        path = cand;
        break;
      }
    }
  }
  ~TempDir() {
    std::error_code ec;
    if (!path.empty()) {
      std::filesystem::remove_all(path, ec);
    }
  }
};

struct RawHttpResponse {
  int status = 0;
  std::map<std::string, std::string> headers;  // lowercase keys
  std::string body;
};

RawHttpResponse SendHttpRequest(uint16_t port,
                                const std::string& method,
                                const std::string& target,
                                const std::map<std::string, std::string>& hdrs = {},
                                const std::string& body = "") {
  RawHttpResponse resp;
#ifdef _WIN32
  SOCKET sock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock == INVALID_SOCKET) return resp;
#else
  int sock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock < 0) return resp;
#endif

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(port);

  if (::connect(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
#ifdef _WIN32
    ::closesocket(sock);
#else
    ::close(sock);
#endif
    return resp;
  }

  std::ostringstream req;
  req << method << " " << target << " HTTP/1.1\r\n";
  req << "Host: 127.0.0.1:" << port << "\r\n";
  bool has_ua = false;
  for (const auto& kv : hdrs) {
    if (kv.first == "User-Agent" || kv.first == "user-agent") has_ua = true;
  }
  if (!has_ua) {
    req << "User-Agent: Mozilla/5.0 Chrome/150.0.0.0 CR-pdf v1.0\r\n";
  }
  req << "Connection: close\r\n";
  for (const auto& kv : hdrs) {
    req << kv.first << ": " << kv.second << "\r\n";
  }
  if (!body.empty() || method == "POST") {
    req << "Content-Length: " << body.size() << "\r\n";
  }
  req << "\r\n";
  std::string wire = req.str() + body;

  const char* p = wire.data();
  size_t rem = wire.size();
  while (rem > 0) {
#ifdef _WIN32
    int n = ::send(sock, p, static_cast<int>(rem), 0);
#else
    ssize_t n = ::send(sock, p, rem, 0);
#endif
    if (n <= 0) break;
    p += n;
    rem -= static_cast<size_t>(n);
  }

  std::string raw;
  char buf[4096];
  while (true) {
#ifdef _WIN32
    int n = ::recv(sock, buf, sizeof(buf), 0);
#else
    ssize_t n = ::recv(sock, buf, sizeof(buf), 0);
#endif
    if (n <= 0) break;
    raw.append(buf, static_cast<size_t>(n));
  }

#ifdef _WIN32
  ::closesocket(sock);
#else
  ::close(sock);
#endif

  size_t hend = raw.find("\r\n\r\n");
  if (hend == std::string::npos) return resp;

  std::string hblock = raw.substr(0, hend);
  resp.body = raw.substr(hend + 4);

  size_t first_end = hblock.find("\r\n");
  std::string status_line =
      (first_end == std::string::npos) ? hblock : hblock.substr(0, first_end);
  {
    std::istringstream iss(status_line);
    std::string ver;
    iss >> ver >> resp.status;
  }

  size_t pos = (first_end == std::string::npos) ? hblock.size() : first_end + 2;
  while (pos < hblock.size()) {
    size_t next = hblock.find("\r\n", pos);
    std::string line = (next == std::string::npos)
                           ? hblock.substr(pos)
                           : hblock.substr(pos, next - pos);
    size_t colon = line.find(':');
    if (colon != std::string::npos) {
      std::string k = line.substr(0, colon);
      for (char& c : k) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      std::string v = line.substr(colon + 1);
      while (!v.empty() && v.front() == ' ') v.erase(v.begin());
      resp.headers[k] = v;
    }
    if (next == std::string::npos) break;
    pos = next + 2;
  }

  return resp;
}

void VerifyPdfXrefByteOffsets(const std::string& pdf, int expected_objs) {
  EXPECT_TRUE(pdf.compare(0, 9, "%PDF-1.4\n") == 0);
  size_t sxref = pdf.rfind("startxref\n");
  EXPECT_TRUE(sxref != std::string::npos);
  size_t eof = pdf.rfind("%%EOF");
  EXPECT_TRUE(eof != std::string::npos && eof > sxref);

  long long xref_off = std::strtoll(pdf.c_str() + sxref + 10, nullptr, 10);
  EXPECT_TRUE(xref_off > 0 && static_cast<size_t>(xref_off) < pdf.size());
  EXPECT_TRUE(pdf.compare(static_cast<size_t>(xref_off), 5, "xref\n") == 0);

  // Verify every object entry 1..expected_objs points to "<id> 0 obj\n".
  size_t table_start = pdf.find('\n', static_cast<size_t>(xref_off) + 5);
  EXPECT_TRUE(table_start != std::string::npos);
  ++table_start;
  // Skip entry 0 (20 bytes: "0000000000 65535 f \r\n" -> 21 bytes? Wait:
  // "0000000000 65535 f \r\n" is 10+1+5+1+1+1+2 = 21 bytes or 20? Let's check
  // line by line.)
  size_t line_pos = table_start;
  size_t next_nl = pdf.find('\n', line_pos);
  EXPECT_TRUE(next_nl != std::string::npos);
  line_pos = next_nl + 1;  // past entry 0

  for (int id = 1; id <= expected_objs; ++id) {
    next_nl = pdf.find('\n', line_pos);
    EXPECT_TRUE(next_nl != std::string::npos);
    std::string entry = pdf.substr(line_pos, next_nl - line_pos);
    long long obj_off = std::strtoll(entry.c_str(), nullptr, 10);
    std::string expected_hdr = std::to_string(id) + " 0 obj\n";
    EXPECT_TRUE(obj_off > 0 &&
                static_cast<size_t>(obj_off) + expected_hdr.size() < pdf.size());
    EXPECT_EQ(pdf.substr(static_cast<size_t>(obj_off), expected_hdr.size()),
              expected_hdr);
    line_pos = next_nl + 1;
  }
}

void TestFilenameValidation() {
  std::cout << "[TEST] TestFilenameValidation\n";
  EXPECT_TRUE(crpdf::IsSafeFilename("note.pdf"));
  EXPECT_TRUE(crpdf::IsSafeFilename("My Lecture 01.pdf"));
  EXPECT_TRUE(crpdf::IsSafeFilename("수학노트_2026.pdf"));

  EXPECT_TRUE(!crpdf::IsSafeFilename(""));
  EXPECT_TRUE(!crpdf::IsSafeFilename("."));
  EXPECT_TRUE(!crpdf::IsSafeFilename(".."));
  EXPECT_TRUE(!crpdf::IsSafeFilename("../secret.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("a/b.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("a\\b.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("a..b.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename(std::string("a\0b.pdf", 7)));
  EXPECT_TRUE(!crpdf::IsSafeFilename("lead.pdf "));
  EXPECT_TRUE(!crpdf::IsSafeFilename(" lead.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("trail."));
  EXPECT_TRUE(!crpdf::IsSafeFilename("CON"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("nul.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("LPT1.pdf"));
  EXPECT_TRUE(!crpdf::IsSafeFilename("COM9.pdf"));

  EXPECT_EQ(crpdf::SanitizeNotebookTitle("  My:Note/1  "), "My_Note_1");
  EXPECT_EQ(crpdf::SanitizeNotebookTitle("CON"), "Untitled");
  EXPECT_EQ(crpdf::SanitizeNotebookTitle("..."), "Untitled");
}

void TestAtomicWriteFile() {
  std::cout << "[TEST] TestAtomicWriteFile\n";
  TempDir tmp;
  auto target = tmp.path / "atomic.pdf";
  auto tmp_file = tmp.path / "atomic.pdf.tmp";

  std::string v1 = "%PDF-1.4\nversion1\n";
  std::string err;
  EXPECT_TRUE(crpdf::AtomicWriteFile(target, v1.data(), v1.size(), &err));
  EXPECT_TRUE(std::filesystem::exists(target));
  EXPECT_TRUE(!std::filesystem::exists(tmp_file));

  std::string v2 = "%PDF-1.4\nversion2_longer_payload\n";
  EXPECT_TRUE(crpdf::AtomicWriteFile(target, v2.data(), v2.size(), &err));
  EXPECT_TRUE(!std::filesystem::exists(tmp_file));

  std::ifstream ifs(target, std::ios::binary);
  std::ostringstream oss;
  oss << ifs.rdbuf();
  EXPECT_EQ(oss.str(), v2);
}

void TestConfigStore() {
  std::cout << "[TEST] TestConfigStore\n";
  TempDir tmp;
  auto cfg_file = tmp.path / "config.json";
  auto custom_dir = tmp.path / "notes_dir";

  {
    crpdf::ConfigStore store(crpdf::PathToUtf8(cfg_file));
    EXPECT_TRUE(store.Load());
    std::string body = "{\"saveDir\":\"" +
                       crpdf::JsonEscape(crpdf::PathToUtf8(custom_dir)) +
                       "\",\"autosaveIntervalSec\":9999,\"autosaveEnabled\":false,"
                       "\"palmRejection\":true,\"pseudoPressure\":false}";
    crpdf::AppConfig updated;
    std::string err;
    EXPECT_TRUE(store.UpdateFromJson(body, &updated, &err));
    EXPECT_EQ(updated.autosave_interval_sec, 3600);  // clamped
    EXPECT_EQ(updated.autosave_enabled, false);
    EXPECT_EQ(updated.pseudo_pressure, false);
    EXPECT_TRUE(std::filesystem::is_directory(custom_dir));
  }

  // Reload from disk.
  {
    crpdf::ConfigStore store2(crpdf::PathToUtf8(cfg_file));
    EXPECT_TRUE(store2.Load());
    auto loaded = store2.Get();
    EXPECT_EQ(loaded.save_dir, crpdf::PathToUtf8(custom_dir));
    EXPECT_EQ(loaded.autosave_interval_sec, 3600);
    EXPECT_EQ(loaded.autosave_enabled, false);
    EXPECT_EQ(loaded.pseudo_pressure, false);
  }
}

void TestPdfGenerator() {
  std::cout << "[TEST] TestPdfGenerator\n";
  const std::vector<std::string> templates = {"blank", "lined", "grid", "dot"};
  const std::vector<std::string> presets = {"a4", "letter", "16x9"};

  for (const auto& t : templates) {
    for (const auto& p : presets) {
      crpdf::PdfOptions opts;
      EXPECT_TRUE(crpdf::ParsePdfTemplate(t, &opts.tmpl));
      EXPECT_TRUE(crpdf::ResolvePdfPageSize(p, 0, 0, &opts.page_size));
      opts.page_count = 3;
      opts.title = "Test " + t + " " + p;

      std::string pdf;
      std::string err;
      EXPECT_TRUE(crpdf::GeneratePdf(opts, &pdf, &err));
      VerifyPdfXrefByteOffsets(pdf, 4 + 3);
      EXPECT_TRUE(pdf.find("/Count 3") != std::string::npos);
    }
  }

  // Custom mm dimensions (A5 = 148x210 mm) & clamping [50, 1000].
  {
    crpdf::PdfPageSize sz;
    EXPECT_TRUE(crpdf::ResolvePdfPageSize("custom", 148.0, 210.0, &sz));
    EXPECT_TRUE(std::abs(sz.width_mm - 148.0) < 0.01);
    EXPECT_TRUE(std::abs(sz.height_mm - 210.0) < 0.01);
    EXPECT_TRUE(std::abs(sz.width_pt - 148.0 * crpdf::kPtPerMm) < 0.05);

    crpdf::PdfPageSize clamped;
    EXPECT_TRUE(crpdf::ResolvePdfPageSize("custom", 10.0, 2500.0, &clamped));
    EXPECT_TRUE(std::abs(clamped.width_mm - 50.0) < 0.01);
    EXPECT_TRUE(std::abs(clamped.height_mm - 1000.0) < 0.01);

    crpdf::PdfPageSize invalid;
    EXPECT_TRUE(!crpdf::ResolvePdfPageSize("custom", 0.0, 200.0, &invalid));
    EXPECT_TRUE(!crpdf::ResolvePdfPageSize("custom", -50.0, 200.0, &invalid));
  }

  // Boundary rejection for page count.
  {
    crpdf::PdfOptions bad;
    bad.page_count = 0;
    std::string pdf;
    EXPECT_TRUE(!crpdf::GeneratePdf(bad, &pdf));
    bad.page_count = 201;
    EXPECT_TRUE(!crpdf::GeneratePdf(bad, &pdf));
  }
}

void TestAppendPageToPdf() {
  std::cout << "[TEST] TestAppendPageToPdf\n";
  crpdf::PdfOptions opts;
  opts.tmpl = crpdf::PdfTemplate::kGrid;
  EXPECT_TRUE(crpdf::ResolvePdfPageSize("custom", 180.0, 240.0, &opts.page_size));
  opts.page_count = 1;
  opts.title = "Ink Note";

  std::string pdf1;
  EXPECT_TRUE(crpdf::GeneratePdf(opts, &pdf1));
  EXPECT_TRUE(pdf1.find("/Count 1") != std::string::npos);

  // Append page 2 (auto-detecting template & custom size).
  std::string pdf2;
  int count2 = 0;
  std::string err;
  EXPECT_TRUE(crpdf::AppendPageToPdf(pdf1, std::nullopt, std::nullopt, &pdf2,
                                     &count2, &err));
  EXPECT_EQ(count2, 2);
  // Original PDF bytes must be preserved 100% verbatim as prefix.
  EXPECT_EQ(pdf2.compare(0, pdf1.size(), pdf1), 0);
  EXPECT_TRUE(pdf2.find("/Count 2") != std::string::npos);
  EXPECT_TRUE(pdf2.find("/Prev ") != std::string::npos);

  // Verify new startxref points directly to "xref\n".
  size_t sxref2 = pdf2.rfind("startxref\n");
  EXPECT_TRUE(sxref2 != std::string::npos);
  long long xoff2 = std::strtoll(pdf2.c_str() + sxref2 + 10, nullptr, 10);
  EXPECT_TRUE(pdf2.compare(static_cast<size_t>(xoff2), 5, "xref\n") == 0);

  // Append page 3 on top of incremental update pdf2.
  std::string pdf3;
  int count3 = 0;
  EXPECT_TRUE(crpdf::AppendPageToPdf(pdf2, std::nullopt, std::nullopt, &pdf3,
                                     &count3, &err));
  EXPECT_EQ(count3, 3);
  EXPECT_EQ(pdf3.compare(0, pdf2.size(), pdf2), 0);
  EXPECT_TRUE(pdf3.find("/Count 3") != std::string::npos);
}

void TestHttpServerAllEndpoints() {
  std::cout << "[TEST] TestHttpServerAllEndpoints\n";
  TempDir tmp;
  auto cfg_path = tmp.path / "config.json";
  auto notes_dir = tmp.path / "notes";
  auto web_dir = tmp.path / "web";
  auto picked_dir = tmp.path / "picked_notes";
  std::filesystem::create_directories(notes_dir);
  std::filesystem::create_directories(web_dir);
  std::filesystem::create_directories(picked_dir);

  // Write a sample static asset.
  {
    std::ofstream ofs(web_dir / "app.js");
    ofs << "console.log('crpdf');";
  }

  crpdf::ConfigStore store(crpdf::PathToUtf8(cfg_path));
  store.Load();
  store.SetSaveDir(crpdf::PathToUtf8(notes_dir));

  crpdf::HttpServer server(
      &store, crpdf::PathToUtf8(web_dir),
      [picked_dir](const std::string&) {
        crpdf::PickFolderResult r;
        r.save_dir = crpdf::PathToUtf8(picked_dir);
        r.cancelled = false;
        return r;
      });

  EXPECT_TRUE(server.Start(0));
  uint16_t port = server.port();
  EXPECT_TRUE(port > 0);

  // 1. GET / (fallback HTML when index.html absent)
  {
    auto r = SendHttpRequest(port, "GET", "/");
    EXPECT_EQ(r.status, 200);
    EXPECT_TRUE(r.body.find("Cr-PDF Backend Ready") != std::string::npos);
  }

  // 2. GET /static/app.js & traversal rejection
  {
    auto r = SendHttpRequest(port, "GET", "/static/app.js");
    EXPECT_EQ(r.status, 200);
    EXPECT_EQ(r.body, "console.log('crpdf');");

    auto bad1 = SendHttpRequest(port, "GET", "/static/../config.json");
    EXPECT_EQ(bad1.status, 400);

    auto bad2 = SendHttpRequest(port, "GET", "/static/%2e%2e/config.json");
    EXPECT_EQ(bad2.status, 400);
  }

  // 3. GET /api/health
  {
    auto r = SendHttpRequest(port, "GET", "/api/health");
    EXPECT_EQ(r.status, 200);
    EXPECT_TRUE(r.body.find("\"status\":\"ok\"") != std::string::npos);
    EXPECT_TRUE(r.body.find("\"version\":\"1.0.0\"") != std::string::npos);
  }

  // 4. GET/POST /api/config
  {
    auto r1 = SendHttpRequest(port, "GET", "/api/config");
    EXPECT_EQ(r1.status, 200);
    EXPECT_TRUE(r1.body.find("\"autosaveIntervalSec\":30") != std::string::npos);

    auto r2 = SendHttpRequest(port, "POST", "/api/config",
                              {{"Content-Type", "application/json"}},
                              "{\"autosaveIntervalSec\":45,\"palmRejection\":true}");
    EXPECT_EQ(r2.status, 200);
    EXPECT_TRUE(r2.body.find("\"autosaveIntervalSec\":45") != std::string::npos);
  }

  // 5. POST /api/notebooks/create (custom mm)
  {
    auto r = SendHttpRequest(
        port, "POST", "/api/notebooks/create",
        {{"Content-Type", "application/json"}},
        "{\"title\":\"Custom Note\",\"template\":\"lined\",\"pageSize\":\"custom\","
        "\"widthMm\":148,\"heightMm\":210,\"pages\":2}");
    EXPECT_EQ(r.status, 201);
    EXPECT_TRUE(r.body.find("\"name\":\"Custom Note.pdf\"") != std::string::npos);
    EXPECT_TRUE(r.body.find("\"widthMm\":148.00") != std::string::npos);
    EXPECT_TRUE(r.body.find("\"heightMm\":210.00") != std::string::npos);
    EXPECT_TRUE(r.body.find("\"pages\":2") != std::string::npos);
  }

  // 6. GET /api/notebooks
  {
    auto r = SendHttpRequest(port, "GET", "/api/notebooks");
    EXPECT_EQ(r.status, 200);
    EXPECT_TRUE(r.body.find("Custom Note.pdf") != std::string::npos);
  }

  // 7. GET /pdf/<name> full, Range 206, Cache-Control: no-store, traversal
  std::string orig_pdf;
  {
    auto r = SendHttpRequest(port, "GET", "/pdf/Custom%20Note.pdf");
    EXPECT_EQ(r.status, 200);
    EXPECT_EQ(r.headers["content-type"], "application/pdf");
    EXPECT_EQ(r.headers["cache-control"], "no-store");
    EXPECT_TRUE(r.body.compare(0, 5, "%PDF-") == 0);
    orig_pdf = r.body;

    auto rng = SendHttpRequest(port, "GET", "/pdf/Custom%20Note.pdf",
                               {{"Range", "bytes=0-15"}});
    EXPECT_EQ(rng.status, 206);
    EXPECT_EQ(rng.body.size(), 16U);
    EXPECT_EQ(rng.body, orig_pdf.substr(0, 16));

    auto trav = SendHttpRequest(port, "GET", "/pdf/%2e%2e%2fconfig.json");
    EXPECT_EQ(trav.status, 400);
  }

  // 8. POST /api/notebooks/<name>/add-page
  {
    auto r = SendHttpRequest(port, "POST",
                             "/api/notebooks/Custom%20Note.pdf/add-page",
                             {{"Content-Type", "application/json"}}, "{}");
    EXPECT_EQ(r.status, 200);
    EXPECT_TRUE(r.body.find("\"pages\":3") != std::string::npos);

    auto r2 = SendHttpRequest(port, "GET", "/pdf/Custom%20Note.pdf");
    EXPECT_EQ(r2.status, 200);
    EXPECT_TRUE(r2.body.size() > orig_pdf.size());
    EXPECT_EQ(r2.body.compare(0, orig_pdf.size(), orig_pdf), 0);
    EXPECT_TRUE(r2.body.find("/Count 3") != std::string::npos);
  }

  // 9. POST /api/save?name=... (valid overwrite + invalid non-PDF rejection)
  {
    auto bad = SendHttpRequest(port, "POST", "/api/save?name=Custom%20Note.pdf",
                               {{"Content-Type", "application/pdf"}},
                               "NOT_A_PDF_BYTES");
    EXPECT_EQ(bad.status, 400);

    std::string updated_pdf = "%PDF-1.4\n%saved-by-ink2\n%%EOF\n";
    auto ok = SendHttpRequest(port, "POST", "/api/save?name=Custom%20Note.pdf",
                              {{"Content-Type", "application/pdf"}},
                              updated_pdf);
    EXPECT_EQ(ok.status, 200);
    EXPECT_TRUE(ok.body.find("\"saved\":true") != std::string::npos);

    auto check = SendHttpRequest(port, "GET", "/pdf/Custom%20Note.pdf");
    EXPECT_EQ(check.status, 200);
    EXPECT_EQ(check.body, updated_pdf);

    auto bad_name =
        SendHttpRequest(port, "POST", "/api/save?name=..%2Fevil.pdf",
                        {{"Content-Type", "application/pdf"}}, updated_pdf);
    EXPECT_EQ(bad_name.status, 400);
  }

  // 10. POST /api/notebooks/import & DELETE /api/notebooks/<name>
  {
    std::string imp_pdf = "%PDF-1.4\n%imported\n%%EOF\n";
    auto imp = SendHttpRequest(port, "POST",
                               "/api/notebooks/import?name=Imported.pdf",
                               {{"Content-Type", "application/pdf"}}, imp_pdf);
    EXPECT_EQ(imp.status, 201);

    auto del1 = SendHttpRequest(port, "DELETE", "/api/notebooks/Imported.pdf");
    EXPECT_EQ(del1.status, 200);
    EXPECT_TRUE(del1.body.find("\"deleted\":true") != std::string::npos);

    auto del2 = SendHttpRequest(port, "DELETE", "/api/notebooks/Imported.pdf");
    EXPECT_EQ(del2.status, 404);
  }

  // 11. CORS: Chrome PDF viewer extension, loopback, and disallowed origin
  {
    const std::string ext_origin =
        "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";
    auto preflight = SendHttpRequest(port, "OPTIONS", "/api/save?name=a.pdf",
                                     {{"Origin", ext_origin}});
    EXPECT_EQ(preflight.status, 204);
    EXPECT_EQ(preflight.headers["access-control-allow-origin"], ext_origin);

    auto local_ok = SendHttpRequest(
        port, "GET", "/api/health",
        {{"Origin", "http://127.0.0.1:" + std::to_string(port)}});
    EXPECT_EQ(local_ok.status, 200);
    EXPECT_EQ(local_ok.headers["access-control-allow-origin"],
              "http://127.0.0.1:" + std::to_string(port));

    auto evil = SendHttpRequest(port, "GET", "/api/health",
                                {{"Origin", "https://evil.example"}});
    EXPECT_EQ(evil.status, 200);
    EXPECT_TRUE(evil.headers.find("access-control-allow-origin") ==
                evil.headers.end());
  }

  // 12. POST /api/pick-folder locked to AppData & non-CR-pdf UA rejected
  {
    auto pick = SendHttpRequest(port, "POST", "/api/pick-folder");
    EXPECT_EQ(pick.status, 403);
    auto no_ua = SendHttpRequest(port, "GET", "/", {{"User-Agent", "Mozilla/5.0 Chrome/150.0.0.0"}});
    EXPECT_EQ(no_ua.status, 403);
  }

  server.Stop();
  EXPECT_TRUE(!server.is_running());
}

}  // namespace

int main() {
  TestFilenameValidation();
  TestAtomicWriteFile();
  TestConfigStore();
  TestPdfGenerator();
  TestAppendPageToPdf();
  TestHttpServerAllEndpoints();

  if (g_failures > 0) {
    std::cerr << "\nFAILED: " << g_failures << " assertion(s) failed.\n";
    return 1;
  }
  std::cout << "\nALL M1 BACKEND UNIT TESTS PASSED.\n";
  return 0;
}
