cmake_minimum_required(VERSION 3.13)

project(nebula-patch-codec C)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED TRUE)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Werror -pedantic")

set(CMAKE_BUILD_TYPE "Release")

find_package(PkgConfig REQUIRED)
# libjpeg-turbo (Ubuntu: libjpeg-dev), for lossy patches
pkg_check_modules(JPEG REQUIRED libjpeg IMPORTED_TARGET)

# The patch encoder (QOI + LZ4, vendored in native/vendor with their licences, and JPEG from the system's
# libjpeg-turbo), loaded by the patch encoding worker threads.
add_library(nebula-patch-addon SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/native/src/patch_encode.c
        ${CMAKE_CURRENT_SOURCE_DIR}/native/vendor/lz4.c
)
target_include_directories(nebula-patch-addon PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/native/vendor
        ${CMAKE_CURRENT_SOURCE_DIR}/native/node-api
)
target_compile_options(nebula-patch-addon PRIVATE -O3)
target_link_libraries(nebula-patch-addon PRIVATE PkgConfig::JPEG)
set_target_properties(nebula-patch-addon PROPERTIES PREFIX "" SUFFIX ".node")

install(TARGETS nebula-patch-addon DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/dist/addons)
