# Cr-PDF

CEF 150(Chromium 150) 기반 네이티브 **PDFium + Ink2** 필기 노트 및 듀얼 스크린 발표 데스크톱 앱입니다.

## 주요 기능
- **초미니멀 한 줄 툴바 + 우측 도킹 전환**: 펜 · 형광펜 · 지우개 · 프리셋 슬롯 · 굵기(1~5) · 실행 취소 · 페이지 추가(`+`) · 저장 · 화면공유 · 홈
- **팜 리젝션**: 스타일러스(`pen`)만 필기, 한 손가락 터치(`touch`)는 스크롤, 두 손가락은 핀치 줌
- **단계형 유사 필압**: 필압 `0/20/40/60/80%` 구간을 선택한 최대 굵기(`1~5`) 상한으로 매핑
- **듀얼 스크린 발표**: `[화면공유용] 판서 화면` 팝업(`?crpdf_role=presenter`), `BroadcastChannel` 실시간 뷰포트/잉크 미러링 및 양방향 빨간 레이저 포인터
- **지정 폴더 자동 저장**: 다이얼로그 없는 `POST /api/save` 원자적 덮어쓰기 및 주기적 자동 저장

## 빌드 및 패치 (로컬 / CI)

```bash
# 1. CEF 150 minimal 바이너리 다운로드 (linux64 또는 windows64)
python3 scripts/fetch_cef.py --platform linux64

# 2. CMake 빌드
cmake -B build -G Ninja -DCRPDF_BUILD_CEF=ON -DCRPDF_BUILD_TESTS=ON
cmake --build build --parallel

# 3. resources.pak 패치 및 검증
python3 scripts/patch_pak.py \
  --input build/Release/resources.pak \
  --output build/Release/resources.pak \
  --patches patches/pdf \
  --verify
```

Windows 릴리스 빌드는 `.github/workflows/build-windows.yml`을 통해 GitHub Actions(`windows-latest`)에서 자동 실행됩니다.