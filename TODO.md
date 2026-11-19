# Cr-PDF 남은 작업 (TODO)

## 완료
- CEF 150 + 스톡 PDF 뷰어(Ink2) 실행 확인 (Linux/xvfb)
- `patch_pak.py` (resources.pak 패치, 단위 테스트 16/16)
- 백엔드: 노트 생성/가져오기/저장/설정/폴더 선택 API
- 홈 시작화면 재디자인 (`web/home.css`, `web/home_extra.js`)
- 소개 페이지 GitHub Pages 배포: https://hijiwho.github.io/Cr-PDF/

## 1. Ink2 패치 (최우선)
- [ ] 주석 모드 DOM 조사 (`#annotate` 클릭 후 사이드패널/하단툴바 요소, 브러시 설정 호출 경로)
- [ ] `patches/pdf/` 작성: `crpdf_main.js`, `crpdf_plugin_wrapper.js`, `crpdf_style.css` → `patch_pak.py`에 연결
- [ ] 초미니 1줄 툴바 (펜/형광펜/지우개/굵기 1~5/색/undo/저장/화면공유/홈) + 우측 1열 도킹 토글(localStorage)
- [ ] 펜·형광펜 프리셋 슬롯 + `+` 추가 (슬롯별 굵기·색, 크롬 기본 팔레트/커스텀 색)
- [ ] 손바닥 거부 (`pointerType` pen만 그리기, touch는 스크롤/핀치만)
- [ ] 가짜 필압: 0/20/40/60/80 → 1~5단계, `min(최대굵기, 단계)`, 지우개 선택 시 호출 금지, 1~16 클램프
- [ ] 저장 오버라이드: `POST /api/save` (Ctrl+S, 다이얼로그 없음, 주기 자동저장 15/30/60초/끔, 원자적 쓰기)

## 2. 화면공유 듀얼 윈도우
- [ ] `window.open` 제목 "[화면공유용] 판서 화면", 툴바 숨김(`crpdf_role=presenter`)
- [ ] BroadcastChannel로 페이지/줌/스크롤 동기화
- [ ] `getScreenDetails()` 외부 모니터 전체화면 (단일 화면은 일반 팝업)
- [ ] 빨간 레이저 포인터 (페이지 영역 기준 상대좌표, 양방향)
- [ ] C++: 팝업 처리(`OnPopupBrowserViewCreated`), WINDOW_MANAGEMENT 권한 자동 허용
- 한계: Ink2는 획 export API가 없어 서브창 잉크는 캔버스 미러 방식

## 3. 홈 화면 기능 (백엔드 + UI)
- [ ] 페이지 추가 `POST /api/notebooks/<name>/add-page` (Ink2 주석 보존)
- [ ] 내보내기: PDF / PNG / 선택 페이지만 (저장 전 `save(ANNOTATION)`로 최신화)
- [ ] PPT/PPTX → PDF → 노트 (Windows PowerPoint COM, Office 설치 기종만, 없으면 비활성/안내)
- [ ] 노트 카드 메뉴에 내보내기/페이지추가/PPT 가져오기 배치

## 4. Windows 빌드/배포
- [ ] `.github/workflows/build-windows.yml` (CEF windows64_minimal 받기 → CMake/MSVC → `patch_pak.py` → zip → artifact + Release)
- [ ] `main_win.cc` 컴파일 검증 (VM에서 불가, Actions에서 확인)
- [ ] `site/index.html` 다운로드 링크를 릴리스 에셋명에 맞추기

## 5. 검증/정리
- [ ] `tests/e2e/` 실행 (CDP로 펜 입력, 저장, 팔레트 등)
- [ ] 실기기 확인: 스타일러스, 듀얼 모니터, Windows
- [ ] README 갱신, 임시 파일 정리

## 참고
- 웹 에셋 수정 후 Linux 테스트: `cp web/* build/Release/web/`
- 실행: `cd build/Release && xvfb-run -a ./cr-pdf --no-sandbox --disable-gpu --remote-debugging-port=9222 --port=18080 --save-dir=/tmp/crsave`
- 서브에이전트 사용 안 함 (사용자 요청)
