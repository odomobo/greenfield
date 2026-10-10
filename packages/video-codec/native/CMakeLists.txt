cmake_minimum_required(VERSION 3.13)

# The video codec's addon: the GStreamer H.264 encoder (src/gst_frame_encoder.c, on its own GLib main loop thread:
# src/gst_main_loop.c), which encodes frames (@nebula/frames), and the EGL and dmabuf helpers of its own GPU context.
project(nebula-video-codec C)

if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Release")
endif ()
set(THREADS_PREFER_PTHREAD_FLAG ON)

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

# The frame library of @nebula/frames (a static library): the codec reads frames with it.
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../frames/native ${CMAKE_BINARY_DIR}/frames)

add_library(nebula-video-codec-addon SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/src/video_codec_addon.c
        ${CMAKE_CURRENT_SOURCE_DIR}/src/gst_frame_encoder.c
        ${CMAKE_CURRENT_SOURCE_DIR}/src/gst_main_loop.c
        ${CMAKE_CURRENT_SOURCE_DIR}/src/westfield-egl.c
        ${CMAKE_CURRENT_SOURCE_DIR}/src/westfield-dmabuf.c
        ${CMAKE_CURRENT_SOURCE_DIR}/src/drm_format_set.c
)
set_target_properties(nebula-video-codec-addon PROPERTIES PREFIX "" SUFFIX ".node" C_STANDARD 11)
target_include_directories(nebula-video-codec-addon PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(nebula-video-codec-addon PRIVATE
        nebula-frames
        PkgConfig::GLIB2
        PkgConfig::GSTREAMER
        PkgConfig::GRAPHENE
        PkgConfig::EGL
        PkgConfig::OPENGL
        PkgConfig::GBM
        PkgConfig::LIBDRM
        Threads::Threads
        m
)
install(TARGETS nebula-video-codec-addon DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/../dist/addons)

# For the unit tests only: frames over plain memory, made by the frame library's test addon (its source, from the
# frames package) built into a separate addon, so the codec reads frames another copy of the library created.
add_library(nebula-video-codec-test-frames SHARED ${CMAKE_CURRENT_SOURCE_DIR}/../../frames/native/test/frames_test_addon.c)
set_target_properties(nebula-video-codec-test-frames PROPERTIES PREFIX "" SUFFIX ".node" C_STANDARD 11)
target_link_libraries(nebula-video-codec-test-frames PRIVATE nebula-frames)
install(TARGETS nebula-video-codec-test-frames DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/../dist/addons)
