cmake_minimum_required(VERSION 3.13)

project(compositor-proxy C)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED TRUE)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Werror -pedantic")
set(THREADS_PREFER_PTHREAD_FLAG ON)

#set(CMAKE_BUILD_TYPE "Debug")
set(CMAKE_BUILD_TYPE "Release")

find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB2 REQUIRED glib-2.0 IMPORTED_TARGET)
pkg_check_modules(GSTREAMER REQUIRED
        IMPORTED_TARGET
        gstreamer-1.0>=1.18
        gstreamer-app-1.0>=1.18
        gstreamer-video-1.0>=1.18
        gstreamer-gl-1.0>=1.18
        gstreamer-allocators-1.0>=1.18
)
pkg_check_modules(GRAPHENE REQUIRED IMPORTED_TARGET graphene-1.0)
pkg_check_modules(EGL REQUIRED IMPORTED_TARGET egl>=1.5)
pkg_check_modules(OPENGL REQUIRED IMPORTED_TARGET opengl>=3.3)
pkg_check_modules(GBM REQUIRED gbm IMPORTED_TARGET)
pkg_check_modules(LIBDRM REQUIRED libdrm IMPORTED_TARGET)
# libjpeg-turbo (Ubuntu: libjpeg-dev), for lossy patches
pkg_check_modules(JPEG REQUIRED libjpeg IMPORTED_TARGET)

add_library(proxy-poll-addon SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/native/poll/src/poll.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/poll/src/fd_passing.c
)
set_property(
    TARGET proxy-poll-addon
    PROPERTY INSTALL_RPATH
    $ORIGIN/shared
)
target_include_directories(proxy-poll-addon PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/native/node-api
)
set_target_properties(proxy-poll-addon PROPERTIES PREFIX "" SUFFIX ".node")

# The patch encoder (QOI + LZ4, vendored in native/patch/vendor with their licences, and JPEG from the system's
# libjpeg-turbo), loaded by the patch encoding worker threads.
add_library(nebula-patch-addon SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/native/patch/src/patch_encode.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/patch/vendor/lz4.c
)
target_include_directories(nebula-patch-addon PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/native/patch/vendor
        ${CMAKE_CURRENT_SOURCE_DIR}/native/node-api
)
target_compile_options(nebula-patch-addon PRIVATE -O3)
target_link_libraries(nebula-patch-addon PRIVATE PkgConfig::JPEG)
set_target_properties(nebula-patch-addon PROPERTIES PREFIX "" SUFFIX ".node")


# The session's Wayland side (ROADMAP.md, Core item 1): wlroots is a submodule (`git submodule update --init`) pinned to
# 0.17.4 and built with meson as a static library against the system's libraries (libwayland, pixman, xkbcommon,
# libdrm, and the xcb libraries for XWayland). The addon links the system libwayland.
set(WLR_SOURCE ${CMAKE_CURRENT_SOURCE_DIR}/native/wlroots)
set(WLR_BUILD ${CMAKE_BINARY_DIR}/wlroots)
if (NOT EXISTS ${WLR_SOURCE}/meson.build)
    message(FATAL_ERROR "The wlroots submodule is missing: run `git submodule update --init`.")
endif ()
find_program(MESON meson)
if (NOT MESON)
    message(FATAL_ERROR "meson is needed to build wlroots (Ubuntu: apt install meson).")
endif ()
# Changing these options rebuilds wlroots from scratch (existing build directories are wiped when they differ).
set(WLR_MESON_OPTIONS
        --buildtype=release -Ddefault_library=static -Dwerror=false -Dexamples=false
        -Dbackends= -Drenderers=gles2 -Dallocators=gbm -Dsession=disabled -Dxwayland=enabled -Dxcb-errors=disabled)
string(REPLACE ";" " " WLR_MESON_OPTIONS_TEXT "${WLR_MESON_OPTIONS}")
# rewritten (and its timestamp changed) only when the options change
file(CONFIGURE OUTPUT ${CMAKE_BINARY_DIR}/wlroots-options.txt CONTENT "${WLR_MESON_OPTIONS_TEXT}\n")
add_custom_command(
        OUTPUT ${WLR_BUILD}/libwlroots.a
        COMMAND sh -c "cmp -s ${CMAKE_BINARY_DIR}/wlroots-options.txt ${WLR_BUILD}/gfld-options.txt || { rm -rf ${WLR_BUILD} && meson setup ${WLR_BUILD} ${WLR_SOURCE} ${WLR_MESON_OPTIONS_TEXT} && cp ${CMAKE_BINARY_DIR}/wlroots-options.txt ${WLR_BUILD}/gfld-options.txt; }"
        COMMAND ninja -C ${WLR_BUILD}
        DEPENDS ${CMAKE_BINARY_DIR}/wlroots-options.txt
        WORKING_DIRECTORY ${WLR_SOURCE}
        COMMENT "Building wlroots"
        VERBATIM
)
add_custom_target(wlroots-static DEPENDS ${WLR_BUILD}/libwlroots.a)

pkg_check_modules(WLR_DEPS REQUIRED IMPORTED_TARGET
        wayland-server>=1.22 pixman-1>=0.42 xkbcommon libdrm>=2.4.114 gbm egl glesv2
        xcb xcb-composite xcb-ewmh xcb-icccm xcb-render xcb-res xcb-xfixes)

add_library(wlr-core-addon SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/wlr_core.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/wlr_core_clipboard.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/wlr_core_dnd.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/wlr_core_encoder.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/wlr_core_xwayland.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/wlr_core_input.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/xwayland_sockets.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/encoding/src/gst_frame_encoder.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/encoding/src/gst_main_loop.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/westfield-egl.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/westfield-dmabuf.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src/drm_format_set.c
)
add_dependencies(wlr-core-addon wlroots-static)
set_target_properties(wlr-core-addon PROPERTIES PREFIX "" SUFFIX ".node" C_STANDARD 11)
target_compile_definitions(wlr-core-addon PRIVATE WLR_USE_UNSTABLE)
# the shim westfield.h comes first: the encoder sources against the system libwayland
target_include_directories(wlr-core-addon PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/shim
        ${CMAKE_CURRENT_SOURCE_DIR}/native/wlr-core/src
        ${CMAKE_CURRENT_SOURCE_DIR}/native/encoding/src
        ${CMAKE_CURRENT_SOURCE_DIR}/native/node-api
        ${WLR_SOURCE}/include
        ${WLR_BUILD}/include
        ${WLR_BUILD}/protocol
)
target_link_libraries(wlr-core-addon PRIVATE
        ${WLR_BUILD}/libwlroots.a
        PkgConfig::WLR_DEPS
        PkgConfig::GLIB2
        PkgConfig::GSTREAMER
        PkgConfig::GRAPHENE
        PkgConfig::OPENGL
        Threads::Threads
        rt
        m
)
install(TARGETS wlr-core-addon proxy-poll-addon nebula-patch-addon DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/dist/addons)
