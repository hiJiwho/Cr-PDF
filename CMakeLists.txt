cmake_minimum_required(VERSION 3.21)

if(POLICY CMP0091)
  cmake_policy(SET CMP0091 NEW)
endif()

project(CrPDF LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(CRPDF_BUILD_CEF "Build the CEF 150 desktop application" ON)
option(CRPDF_BUILD_TESTS "Build C++ unit tests" ON)

# ---------------------------------------------------------------------------
# Backend static library (zero CEF dependency; shared by host & unit tests)
# ---------------------------------------------------------------------------
add_library(crpdf_backend STATIC
  src/config_store.h
  src/config_store.cc
  src/pdf_generator.h
  src/pdf_generator.cc
  src/http_server.h
  src/http_server.cc
)

target_include_directories(crpdf_backend PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_features(crpdf_backend PUBLIC cxx_std_20)

if(MSVC)
  set_target_properties(crpdf_backend PROPERTIES
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  target_compile_options(crpdf_backend PRIVATE /utf-8 /W4)
  target_compile_definitions(crpdf_backend PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(crpdf_backend PUBLIC ws2_32 shell32 ole32 uuid gdi32)
else()
  target_compile_options(crpdf_backend PRIVATE -Wall -Wextra -fno-exceptions)
  target_link_libraries(crpdf_backend PUBLIC pthread)
endif()

# ---------------------------------------------------------------------------
# CEF 150 Desktop Host Executable (CrPDF.exe on Windows, cr-pdf on Linux)
# ---------------------------------------------------------------------------
if(CRPDF_BUILD_CEF)
  set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cef" CACHE PATH
      "Path to extracted CEF binary distribution")
  # Disable CEF sandbox so Windows builds a clean standalone CrPDF.exe and
  # Linux does not require SUID chrome-sandbox permissions.
  set(USE_SANDBOX OFF CACHE BOOL "Disable CEF sandbox" FORCE)

  list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
  find_package(CEF REQUIRED)

  add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)

  # Minimal CEF distributions only contain Release/ (no Debug/).
  if(NOT EXISTS "${CEF_LIB_DEBUG}")
    set(CEF_LIB_DEBUG "${CEF_LIB_RELEASE}")
  endif()
  ADD_LOGICAL_TARGET("libcef_lib" "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

  SET_CEF_TARGET_OUT_DIR()

  set(CRPDF_HOST_SRCS
    src/crpdf_app.h
    src/crpdf_app.cc
    src/crpdf_client.h
    src/crpdf_client.cc
  )

  if(OS_WINDOWS)
    set(CRPDF_TARGET "CrPDF")
    list(APPEND CRPDF_HOST_SRCS src/main_win.cc)
    add_executable(${CRPDF_TARGET} WIN32 ${CRPDF_HOST_SRCS})
  else()
    set(CRPDF_TARGET "cr-pdf")
    list(APPEND CRPDF_HOST_SRCS src/main_linux.cc)
    add_executable(${CRPDF_TARGET} ${CRPDF_HOST_SRCS})
  endif()

  SET_EXECUTABLE_TARGET_PROPERTIES(${CRPDF_TARGET})
  add_dependencies(${CRPDF_TARGET} libcef_dll_wrapper)
  target_include_directories(${CRPDF_TARGET} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_link_libraries(${CRPDF_TARGET} PRIVATE
    crpdf_backend
    libcef_lib
    libcef_dll_wrapper
    ${CEF_STANDARD_LIBS}
  )

  if(OS_WINDOWS)
    target_compile_options(${CRPDF_TARGET} PRIVATE /utf-8 /WX-)
    target_link_libraries(${CRPDF_TARGET} PRIVATE ole32 shell32 comdlg32 ws2_32 uuid)
  else()
    target_compile_options(${CRPDF_TARGET} PRIVATE -Wno-error)
    set_target_properties(${CRPDF_TARGET} PROPERTIES
      INSTALL_RPATH "$ORIGIN"
      BUILD_WITH_INSTALL_RPATH TRUE
      RUNTIME_OUTPUT_DIRECTORY "${CEF_TARGET_OUT_DIR}"
    )
  endif()

  # Copy CEF binaries & resources alongside the executable.
  COPY_FILES("${CRPDF_TARGET}" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
  COPY_FILES("${CRPDF_TARGET}" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")
  if(OS_LINUX AND EXISTS "${CEF_BINARY_DIR}/libminigbm.so")
    COPY_FILES("${CRPDF_TARGET}" "libminigbm.so" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
  endif()

  # Copy web/ UI assets if present (populated in M2).
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/web")
    add_custom_command(TARGET ${CRPDF_TARGET} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory
              "${CMAKE_CURRENT_SOURCE_DIR}/web"
              "${CEF_TARGET_OUT_DIR}/web"
      COMMENT "Copying web/ assets to ${CEF_TARGET_OUT_DIR}/web"
    )
  endif()

  # On Linux single-config generators (Ninja/Make), place a convenience symlink
  # or copy at ${CMAKE_BINARY_DIR}/cr-pdf if CEF_TARGET_OUT_DIR is a subdir.
  if(OS_LINUX AND NOT "${CEF_TARGET_OUT_DIR}" STREQUAL "${CMAKE_BINARY_DIR}")
    add_custom_command(TARGET ${CRPDF_TARGET} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E create_symlink
              "${CEF_TARGET_OUT_DIR}/${CRPDF_TARGET}"
              "${CMAKE_BINARY_DIR}/${CRPDF_TARGET}"
      COMMENT "Linking ${CMAKE_BINARY_DIR}/${CRPDF_TARGET} -> ${CEF_TARGET_OUT_DIR}/${CRPDF_TARGET}"
    )
  endif()
endif()

# ---------------------------------------------------------------------------
# Standalone Backend Unit Tests (zero CEF dependency)
# ---------------------------------------------------------------------------
if(CRPDF_BUILD_TESTS AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/tests/unit/test_m1_backend.cc")
  enable_testing()
  add_executable(test_m1_backend tests/unit/test_m1_backend.cc)
  target_link_libraries(test_m1_backend PRIVATE crpdf_backend)
  if(MSVC)
    set_target_properties(test_m1_backend PROPERTIES
      MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    )
    target_compile_options(test_m1_backend PRIVATE /utf-8 /W4)
  else()
    target_compile_options(test_m1_backend PRIVATE -Wall -Wextra -fno-exceptions)
  endif()
  add_test(NAME test_m1_backend COMMAND test_m1_backend)
  if(UNIX AND NOT APPLE AND DEFINED CEF_TARGET_OUT_DIR AND NOT "${CEF_TARGET_OUT_DIR}" STREQUAL "${CMAKE_BINARY_DIR}")
    add_custom_command(TARGET test_m1_backend POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E create_symlink
              "$<TARGET_FILE:test_m1_backend>"
              "${CMAKE_BINARY_DIR}/test_m1_backend"
      COMMENT "Linking ${CMAKE_BINARY_DIR}/test_m1_backend -> $<TARGET_FILE:test_m1_backend>"
    )
  endif()
endif()
