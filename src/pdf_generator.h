#ifndef CRPDF_PDF_GENERATOR_H_
#define CRPDF_PDF_GENERATOR_H_

#include <optional>
#include <string>

namespace crpdf {

enum class PdfTemplate { kBlank, kLined, kGrid, kDot };

struct PdfPageSize {
  double width_pt = 595.28;   // A4 default (210 mm)
  double height_pt = 841.89;  // A4 default (297 mm)
  double width_mm = 210.0;
  double height_mm = 297.0;
};

struct PdfOptions {
  PdfTemplate tmpl = PdfTemplate::kBlank;
  PdfPageSize page_size;
  int page_count = 1;  // Valid range: [1, 200]
  std::string title;
};

constexpr double kPtPerMm = 72.0 / 25.4;
constexpr double kMinCustomMm = 50.0;
constexpr double kMaxCustomMm = 1000.0;

bool ParsePdfTemplate(const std::string& name, PdfTemplate* out);
std::string PdfTemplateToString(PdfTemplate tmpl);

// Resolves preset ("a4", "letter", "16x9", "custom") and optional custom
// width_mm / height_mm (clamped to [50, 1000] mm).
bool ResolvePdfPageSize(const std::string& preset,
                        double width_mm,
                        double height_mm,
                        PdfPageSize* out);

// Generates a valid, byte-accurate PDF 1.4 document with vector template
// backgrounds.
bool GeneratePdf(const PdfOptions& options,
                 std::string* out_pdf,
                 std::string* err_out = nullptr);

// Appends one new page to an existing PDF (including Chromium PDFium/Ink2
// saved PDFs) via a clean PDF incremental update, preserving all existing
// pages and annotations byte-for-byte.
bool AppendPageToPdf(const std::string& existing_pdf,
                     std::optional<PdfTemplate> override_tmpl,
                     std::optional<PdfPageSize> override_size,
                     std::string* out_pdf,
                     int* new_page_count_out = nullptr,
                     std::string* err_out = nullptr,
                     int insert_page_1based = -1);

}  // namespace crpdf

#endif  // CRPDF_PDF_GENERATOR_H_
