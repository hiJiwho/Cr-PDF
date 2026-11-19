#include "pdf_generator.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace crpdf {

namespace {

std::string ToLowerAscii(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (unsigned char c : s) {
    out.push_back(static_cast<char>(std::tolower(c)));
  }
  return out;
}

std::string Fmt2(double v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.2f", v);
  return std::string(buf);
}

std::string EscapePdfLiteralString(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    if (c == '(' || c == ')' || c == '\\') {
      out.push_back('\\');
      out.push_back(static_cast<char>(c));
    } else if (c < 0x20 || c > 0x7E) {
      char oct[8];
      std::snprintf(oct, sizeof(oct), "\\%03o", static_cast<unsigned int>(c));
      out += oct;
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  return out;
}

std::string BuildTemplateContentStream(PdfTemplate tmpl,
                                       const PdfPageSize& sz) {
  const double w = sz.width_pt;
  const double h = sz.height_pt;
  std::string s;
  s.reserve(2048);

  // Opaque white page background.
  s += "q\n";
  s += "1 1 1 rg\n";
  s += "0 0 " + Fmt2(w) + " " + Fmt2(h) + " re f\n";

  if (tmpl == PdfTemplate::kLined) {
    const double step = 8.0 * kPtPerMm;         // 8 mm line spacing
    const double top_margin = 20.0 * kPtPerMm;  // 20 mm
    const double bot_margin = 15.0 * kPtPerMm;  // 15 mm
    const double side_margin = 12.7 * kPtPerMm; // 12.7 mm
    const double x0 = (w > side_margin * 2.5) ? side_margin : w * 0.08;
    const double x1 = w - x0;

    s += "0.78 0.84 0.92 RG 0.50 w\n";
    for (double y = h - top_margin; y >= bot_margin; y -= step) {
      s += Fmt2(x0) + " " + Fmt2(y) + " m " + Fmt2(x1) + " " + Fmt2(y) +
           " l S\n";
    }
    if (w > 200.0) {
      const double mx = 20.0 * kPtPerMm;  // ~56.69 pt margin line
      s += "0.94 0.72 0.72 RG 0.60 w\n";
      s += Fmt2(mx) + " 0 m " + Fmt2(mx) + " " + Fmt2(h) + " l S\n";
    }
  } else if (tmpl == PdfTemplate::kGrid) {
    const double step = 5.0 * kPtPerMm;     // 5 mm grid
    const double margin = 10.0 * kPtPerMm;  // 10 mm
    const double x0 = (w > margin * 2.5) ? margin : w * 0.05;
    const double x1 = w - x0;
    const double y0 = (h > margin * 2.5) ? margin : h * 0.05;
    const double y1 = h - y0;

    s += "0.85 0.87 0.90 RG 0.40 w\n";
    for (double x = x0; x <= x1 + 0.01; x += step) {
      s += Fmt2(x) + " " + Fmt2(y0) + " m " + Fmt2(x) + " " + Fmt2(y1) +
           " l S\n";
    }
    for (double y = y0; y <= y1 + 0.01; y += step) {
      s += Fmt2(x0) + " " + Fmt2(y) + " m " + Fmt2(x1) + " " + Fmt2(y) +
           " l S\n";
    }
  } else if (tmpl == PdfTemplate::kDot) {
    const double step = 5.0 * kPtPerMm;     // 5 mm dot grid
    const double margin = 10.0 * kPtPerMm;  // 10 mm
    const double x0 = (w > margin * 2.5) ? margin : w * 0.05;
    const double x1 = w - x0;
    const double y0 = (h > margin * 2.5) ? margin : h * 0.05;
    const double y1 = h - y0;

    // Round-cap zero-length strokes render as crisp anti-aliased dots.
    s += "1 J 1.50 w 0.68 0.70 0.74 RG\n";
    for (double y = y0; y <= y1 + 0.01; y += step) {
      for (double x = x0; x <= x1 + 0.01; x += step) {
        std::string xs = Fmt2(x);
        std::string ys = Fmt2(y);
        s += xs + " " + ys + " m " + xs + " " + ys + " l S\n";
      }
    }
  }

  s += "Q\n";
  return s;
}

bool IsPdfWhitespace(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' ||
         c == '\0';
}

bool IsPdfDelimiter(char c) {
  return IsPdfWhitespace(c) || c == '/' || c == '<' || c == '>' || c == '[' ||
         c == ']' || c == '(' || c == ')' || c == '{' || c == '}' || c == '%';
}

// Finds the last occurrence of "<obj_id> 0 obj" bounded by whitespace/SOF.
bool FindLastObjectBody(const std::string& pdf,
                        int obj_id,
                        std::string* body_out) {
  std::string needle = std::to_string(obj_id) + " 0 obj";
  size_t search_from = pdf.size();
  while (search_from > 0) {
    size_t pos = pdf.rfind(needle, search_from);
    if (pos == std::string::npos) return false;

    bool boundary_before = (pos == 0) || IsPdfWhitespace(pdf[pos - 1]);
    size_t after = pos + needle.size();
    bool boundary_after = (after < pdf.size()) && IsPdfDelimiter(pdf[after]);

    if (boundary_before && boundary_after) {
      size_t endobj = pdf.find("endobj", after);
      if (endobj != std::string::npos) {
        *body_out = pdf.substr(after, endobj - after);
        return true;
      }
    }
    if (pos == 0) break;
    search_from = pos - 1;
  }
  return false;
}

// Extracts an integer immediately following a PDF name key (e.g., "/Count 3").
bool ExtractIntAfterKey(const std::string& dict,
                        const std::string& key,
                        int* value_out) {
  size_t pos = 0;
  while ((pos = dict.find(key, pos)) != std::string::npos) {
    size_t after = pos + key.size();
    if (after < dict.size() && !IsPdfDelimiter(dict[after])) {
      pos = after;
      continue;
    }
    while (after < dict.size() && IsPdfWhitespace(dict[after])) ++after;
    if (after >= dict.size()) return false;
    const char* start = dict.c_str() + after;
    char* end = nullptr;
    long v = std::strtol(start, &end, 10);
    if (end != start) {
      *value_out = static_cast<int>(v);
      return true;
    }
    pos = after;
  }
  return false;
}

// Extracts an indirect reference "<id> <gen> R" after a key (e.g., "/Root 1 0 R").
bool ExtractRefAfterKey(const std::string& dict,
                        const std::string& key,
                        int* id_out) {
  size_t pos = 0;
  while ((pos = dict.find(key, pos)) != std::string::npos) {
    size_t after = pos + key.size();
    if (after < dict.size() && !IsPdfDelimiter(dict[after])) {
      pos = after;
      continue;
    }
    while (after < dict.size() && IsPdfWhitespace(dict[after])) ++after;
    const char* p = dict.c_str() + after;
    char* end1 = nullptr;
    long id = std::strtol(p, &end1, 10);
    if (end1 == p || id <= 0) {
      pos = after;
      continue;
    }
    while (*end1 && IsPdfWhitespace(*end1)) ++end1;
    char* end2 = nullptr;
    long gen = std::strtol(end1, &end2, 10);
    if (end2 == end1 || gen < 0) {
      pos = after;
      continue;
    }
    while (*end2 && IsPdfWhitespace(*end2)) ++end2;
    if (*end2 == 'R') {
      *id_out = static_cast<int>(id);
      return true;
    }
    pos = after;
  }
  return false;
}

bool ExtractMediaBox(const std::string& text, PdfPageSize* sz_out) {
  size_t pos = text.rfind("/MediaBox");
  if (pos == std::string::npos) return false;
  size_t lb = text.find('[', pos);
  if (lb == std::string::npos) return false;
  size_t rb = text.find(']', lb);
  if (rb == std::string::npos) return false;

  std::string inside = text.substr(lb + 1, rb - lb - 1);
  double nums[4] = {0, 0, 0, 0};
  const char* p = inside.c_str();
  for (int i = 0; i < 4; ++i) {
    while (*p && IsPdfWhitespace(*p)) ++p;
    char* end = nullptr;
    nums[i] = std::strtod(p, &end);
    if (end == p) return false;
    p = end;
  }
  double w = nums[2] - nums[0];
  double h = nums[3] - nums[1];
  if (w <= 10.0 || h <= 10.0) return false;
  sz_out->width_pt = w;
  sz_out->height_pt = h;
  sz_out->width_mm = w / kPtPerMm;
  sz_out->height_mm = h / kPtPerMm;
  return true;
}

void TryDetectMetadataFromPdf(const std::string& pdf,
                              PdfTemplate* tmpl_out,
                              PdfPageSize* size_out,
                              bool* found_size) {
  *found_size = false;
  // Look for our embedded Subject metadata:
  // crpdf:template=<tmpl>;widthPt=<W>;heightPt=<H>
  size_t pos = pdf.rfind("crpdf:template=");
  if (pos != std::string::npos) {
    size_t end = pdf.find_first_of(")\r\n", pos);
    std::string meta = (end == std::string::npos)
                           ? pdf.substr(pos)
                           : pdf.substr(pos, end - pos);
    size_t semi1 = meta.find(';');
    std::string t_str = (semi1 == std::string::npos)
                            ? meta.substr(15)
                            : meta.substr(15, semi1 - 15);
    PdfTemplate parsed;
    if (ParsePdfTemplate(t_str, &parsed)) {
      *tmpl_out = parsed;
    }
    size_t wp = meta.find("widthPt=");
    size_t hp = meta.find("heightPt=");
    if (wp != std::string::npos && hp != std::string::npos) {
      double w = std::strtod(meta.c_str() + wp + 8, nullptr);
      double h = std::strtod(meta.c_str() + hp + 9, nullptr);
      if (w > 10.0 && h > 10.0) {
        size_out->width_pt = w;
        size_out->height_pt = h;
        size_out->width_mm = w / kPtPerMm;
        size_out->height_mm = h / kPtPerMm;
        *found_size = true;
      }
    }
  }
}

}  // namespace

bool ParsePdfTemplate(const std::string& name, PdfTemplate* out) {
  if (!out) return false;
  std::string lower = ToLowerAscii(name);
  if (lower.empty() || lower == "blank") {
    *out = PdfTemplate::kBlank;
    return true;
  }
  if (lower == "lined") {
    *out = PdfTemplate::kLined;
    return true;
  }
  if (lower == "grid") {
    *out = PdfTemplate::kGrid;
    return true;
  }
  if (lower == "dot" || lower == "dotted") {
    *out = PdfTemplate::kDot;
    return true;
  }
  return false;
}

std::string PdfTemplateToString(PdfTemplate tmpl) {
  switch (tmpl) {
    case PdfTemplate::kBlank:
      return "blank";
    case PdfTemplate::kLined:
      return "lined";
    case PdfTemplate::kGrid:
      return "grid";
    case PdfTemplate::kDot:
      return "dot";
  }
  return "blank";
}

bool ResolvePdfPageSize(const std::string& preset,
                        double width_mm,
                        double height_mm,
                        PdfPageSize* out) {
  if (!out) return false;
  std::string lower = ToLowerAscii(preset);

  if (lower == "custom" || (lower.empty() && width_mm > 0.0 && height_mm > 0.0)) {
    if (!std::isfinite(width_mm) || !std::isfinite(height_mm) ||
        width_mm <= 0.0 || height_mm <= 0.0) {
      return false;
    }
    double clamped_w = std::clamp(width_mm, kMinCustomMm, kMaxCustomMm);
    double clamped_h = std::clamp(height_mm, kMinCustomMm, kMaxCustomMm);
    out->width_mm = clamped_w;
    out->height_mm = clamped_h;
    out->width_pt = clamped_w * kPtPerMm;
    out->height_pt = clamped_h * kPtPerMm;
    return true;
  }

  if (lower.empty() || lower == "a4") {
    out->width_mm = 210.0;
    out->height_mm = 297.0;
    out->width_pt = 595.28;
    out->height_pt = 841.89;
    return true;
  }
  if (lower == "letter") {
    out->width_mm = 215.9;
    out->height_mm = 279.4;
    out->width_pt = 612.0;
    out->height_pt = 792.0;
    return true;
  }
  if (lower == "16x9" || lower == "16:9") {
    out->width_mm = 960.0 / kPtPerMm;
    out->height_mm = 540.0 / kPtPerMm;
    out->width_pt = 960.0;
    out->height_pt = 540.0;
    return true;
  }
  return false;
}

bool GeneratePdf(const PdfOptions& options,
                 std::string* out_pdf,
                 std::string* err_out) {
  if (!out_pdf) return false;
  if (options.page_count < 1 || options.page_count > 200) {
    if (err_out) *err_out = "page_count must be between 1 and 200";
    return false;
  }
  if (options.page_size.width_pt < 50.0 || options.page_size.height_pt < 50.0) {
    if (err_out) *err_out = "Invalid page dimensions";
    return false;
  }

  const int n = options.page_count;
  const int total_objs = n + 4;  // 1..4 + n pages
  std::vector<size_t> offsets(static_cast<size_t>(total_objs + 1), 0);

  std::string pdf;
  pdf.reserve(4096 + static_cast<size_t>(n) * 160);

  // Header + binary marker bytes.
  pdf += "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";

  // 1 0 obj: Catalog
  offsets[1] = pdf.size();
  pdf += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";

  // 2 0 obj: Pages
  offsets[2] = pdf.size();
  pdf += "2 0 obj\n<< /Type /Pages /Kids [ ";
  for (int i = 0; i < n; ++i) {
    pdf += std::to_string(5 + i) + " 0 R ";
  }
  pdf += "] /Count " + std::to_string(n) + " >>\nendobj\n";

  // 3 0 obj: Info (stores template & dimensions for AppendPageToPdf)
  offsets[3] = pdf.size();
  std::string subject = "crpdf:template=" + PdfTemplateToString(options.tmpl) +
                        ";widthPt=" + Fmt2(options.page_size.width_pt) +
                        ";heightPt=" + Fmt2(options.page_size.height_pt);
  pdf += "3 0 obj\n<< /Producer (Cr-PDF) /Subject (" + subject + ")";
  if (!options.title.empty()) {
    pdf += " /Title (" + EscapePdfLiteralString(options.title) + ")";
  }
  pdf += " >>\nendobj\n";

  // 4 0 obj: Shared template vector content stream
  std::string stream_data =
      BuildTemplateContentStream(options.tmpl, options.page_size);
  offsets[4] = pdf.size();
  pdf += "4 0 obj\n<< /Length " + std::to_string(stream_data.size()) +
         " >>\nstream\n";
  pdf += stream_data;
  pdf += "endstream\nendobj\n";

  // 5..(4+n) 0 obj: Page objects
  std::string media_box = "[0 0 " + Fmt2(options.page_size.width_pt) + " " +
                          Fmt2(options.page_size.height_pt) + "]";
  for (int i = 0; i < n; ++i) {
    int id = 5 + i;
    offsets[static_cast<size_t>(id)] = pdf.size();
    pdf += std::to_string(id) +
           " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox " + media_box +
           " /Resources << >> /Contents 4 0 R >>\nendobj\n";
  }

  // xref table
  size_t xref_offset = pdf.size();
  pdf += "xref\n0 " + std::to_string(total_objs + 1) + "\n";
  pdf += "0000000000 65535 f \r\n";
  for (int i = 1; i <= total_objs; ++i) {
    char line[32];
    std::snprintf(line, sizeof(line), "%010zu 00000 n \r\n",
                  offsets[static_cast<size_t>(i)]);
    pdf += line;
  }

  // trailer
  pdf += "trailer\n<< /Size " + std::to_string(total_objs + 1) +
         " /Root 1 0 R /Info 3 0 R >>\n";
  pdf += "startxref\n" + std::to_string(xref_offset) + "\n%%EOF\n";

  *out_pdf = std::move(pdf);
  return true;
}

bool AppendPageToPdf(const std::string& existing_pdf,
                     std::optional<PdfTemplate> override_tmpl,
                     std::optional<PdfPageSize> override_size,
                     std::string* out_pdf,
                     int* new_page_count_out,
                     std::string* err_out) {
  if (!out_pdf) return false;
  if (existing_pdf.size() < 32 || existing_pdf.compare(0, 5, "%PDF-") != 0) {
    if (err_out) *err_out = "Input is not a valid PDF document";
    return false;
  }

  // 1. Find last startxref and parse prev_xref_offset.
  size_t sxref_pos = existing_pdf.rfind("startxref");
  if (sxref_pos == std::string::npos) {
    if (err_out) *err_out = "Missing startxref in PDF";
    return false;
  }
  size_t num_pos = sxref_pos + 9;
  while (num_pos < existing_pdf.size() && IsPdfWhitespace(existing_pdf[num_pos])) {
    ++num_pos;
  }
  char* num_end = nullptr;
  long long prev_xref_offset =
      std::strtoll(existing_pdf.c_str() + num_pos, &num_end, 10);
  if (num_end == existing_pdf.c_str() + num_pos || prev_xref_offset <= 0) {
    if (err_out) *err_out = "Invalid startxref offset in PDF";
    return false;
  }

  // 2. Locate the last trailer dict (or XRef stream dict as fallback).
  int root_id = 0;
  int prev_size = 0;
  int info_id = 0;

  size_t trailer_pos = existing_pdf.rfind("trailer", sxref_pos);
  if (trailer_pos != std::string::npos) {
    std::string trailer_region =
        existing_pdf.substr(trailer_pos, sxref_pos - trailer_pos);
    ExtractRefAfterKey(trailer_region, "/Root", &root_id);
    ExtractIntAfterKey(trailer_region, "/Size", &prev_size);
    ExtractRefAfterKey(trailer_region, "/Info", &info_id);
  }
  if (root_id <= 0 || prev_size <= 0) {
    // Fallback: XRef stream object at prev_xref_offset.
    if (static_cast<size_t>(prev_xref_offset) < existing_pdf.size()) {
      std::string xref_region = existing_pdf.substr(
          static_cast<size_t>(prev_xref_offset),
          sxref_pos - static_cast<size_t>(prev_xref_offset));
      if (root_id <= 0) ExtractRefAfterKey(xref_region, "/Root", &root_id);
      if (prev_size <= 0) ExtractIntAfterKey(xref_region, "/Size", &prev_size);
      if (info_id <= 0) ExtractRefAfterKey(xref_region, "/Info", &info_id);
    }
  }
  if (root_id <= 0 || prev_size <= 0) {
    if (err_out) *err_out = "Could not locate /Root or /Size in PDF trailer";
    return false;
  }

  // 3. Locate Catalog -> /Pages <pages_id> 0 R.
  std::string root_body;
  if (!FindLastObjectBody(existing_pdf, root_id, &root_body)) {
    if (err_out) *err_out = "Could not locate Catalog object";
    return false;
  }
  int pages_id = 0;
  if (!ExtractRefAfterKey(root_body, "/Pages", &pages_id) || pages_id <= 0) {
    if (err_out) *err_out = "Could not locate /Pages reference in Catalog";
    return false;
  }

  // 4. Locate Pages object -> /Kids [ ... ] and /Count N.
  std::string pages_body;
  if (!FindLastObjectBody(existing_pdf, pages_id, &pages_body)) {
    if (err_out) *err_out = "Could not locate /Pages object";
    return false;
  }

  int old_count = 0;
  if (!ExtractIntAfterKey(pages_body, "/Count", &old_count) || old_count < 0) {
    if (err_out) *err_out = "Could not parse /Count in /Pages object";
    return false;
  }
  if (old_count >= 200) {
    if (err_out) *err_out = "Notebook page limit (200) reached";
    return false;
  }

  size_t kids_key = pages_body.find("/Kids");
  if (kids_key == std::string::npos) {
    if (err_out) *err_out = "Could not find /Kids array in /Pages object";
    return false;
  }
  size_t kids_lb = pages_body.find('[', kids_key);
  size_t kids_rb =
      (kids_lb != std::string::npos) ? pages_body.find(']', kids_lb) : std::string::npos;
  if (kids_lb == std::string::npos || kids_rb == std::string::npos) {
    if (err_out) *err_out = "Malformed /Kids array in /Pages object";
    return false;
  }
  std::string existing_kids =
      pages_body.substr(kids_lb + 1, kids_rb - kids_lb - 1);

  // 5. Determine template & page size for the appended page.
  PdfTemplate tmpl = PdfTemplate::kBlank;
  PdfPageSize page_size;  // A4 default
  bool found_size = false;
  TryDetectMetadataFromPdf(existing_pdf, &tmpl, &page_size, &found_size);

  if (!found_size) {
    // Try extracting MediaBox from the last page or anywhere in the PDF.
    PdfPageSize mb;
    if (ExtractMediaBox(existing_pdf, &mb)) {
      page_size = mb;
    }
  }
  if (override_tmpl.has_value()) {
    tmpl = *override_tmpl;
  }
  if (override_size.has_value()) {
    page_size = *override_size;
  }

  // 6. Build incremental update preserving all existing bytes verbatim.
  std::string pdf = existing_pdf;
  if (pdf.back() != '\n' && pdf.back() != '\r') {
    pdf.push_back('\n');
  }

  const int new_content_id = prev_size;
  const int new_page_id = prev_size + 1;
  const int new_size = prev_size + 2;
  const int new_count = old_count + 1;

  // Updated /Pages object
  size_t pages_offset = pdf.size();
  pdf += std::to_string(pages_id) + " 0 obj\n<< /Type /Pages /Kids [ " +
         existing_kids + " " + std::to_string(new_page_id) +
         " 0 R ] /Count " + std::to_string(new_count) + " >>\nendobj\n";

  // New content stream
  std::string stream_data = BuildTemplateContentStream(tmpl, page_size);
  size_t content_offset = pdf.size();
  pdf += std::to_string(new_content_id) + " 0 obj\n<< /Length " +
         std::to_string(stream_data.size()) + " >>\nstream\n";
  pdf += stream_data;
  pdf += "endstream\nendobj\n";

  // New page object
  size_t page_offset = pdf.size();
  std::string media_box = "[0 0 " + Fmt2(page_size.width_pt) + " " +
                          Fmt2(page_size.height_pt) + "]";
  pdf += std::to_string(new_page_id) + " 0 obj\n<< /Type /Page /Parent " +
         std::to_string(pages_id) + " 0 R /MediaBox " + media_box +
         " /Resources << >> /Contents " + std::to_string(new_content_id) +
         " 0 R >>\nendobj\n";

  // Incremental xref table (2 subsections)
  size_t new_xref_offset = pdf.size();
  char entry_buf[32];
  pdf += "xref\n";
  pdf += std::to_string(pages_id) + " 1\n";
  std::snprintf(entry_buf, sizeof(entry_buf), "%010zu 00000 n \r\n",
                pages_offset);
  pdf += entry_buf;

  pdf += std::to_string(new_content_id) + " 2\n";
  std::snprintf(entry_buf, sizeof(entry_buf), "%010zu 00000 n \r\n",
                content_offset);
  pdf += entry_buf;
  std::snprintf(entry_buf, sizeof(entry_buf), "%010zu 00000 n \r\n",
                page_offset);
  pdf += entry_buf;

  // Incremental trailer with /Prev
  pdf += "trailer\n<< /Size " + std::to_string(new_size) + " /Root " +
         std::to_string(root_id) + " 0 R";
  if (info_id > 0) {
    pdf += " /Info " + std::to_string(info_id) + " 0 R";
  }
  pdf += " /Prev " + std::to_string(prev_xref_offset) + " >>\n";
  pdf += "startxref\n" + std::to_string(new_xref_offset) + "\n%%EOF\n";

  *out_pdf = std::move(pdf);
  if (new_page_count_out) *new_page_count_out = new_count;
  return true;
}

}  // namespace crpdf
