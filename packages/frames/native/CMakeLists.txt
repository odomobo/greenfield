cmake_minimum_required(VERSION 3.13)

# The frame library (include/nebula_frame.h): a static library, linked into every addon that creates or reads frames.
# Addons of other packages use it with add_subdirectory(<path to packages/frames/native> frames) and
# target_link_libraries(<addon> PRIVATE nebula-frames).
project(nebula-frames C)

find_package(Threads REQUIRED)

add_library(nebula-frames STATIC
        ${CMAKE_CURRENT_SOURCE_DIR}/src/nebula_frame.c
        ${CMAKE_CURRENT_SOURCE_DIR}/src/nebula_frame_napi.c
)
set_target_properties(nebula-frames PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED TRUE POSITION_INDEPENDENT_CODE ON)
target_compile_options(nebula-frames PRIVATE -Wall -Wextra -Werror)
target_include_directories(nebula-frames PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/node-api
)
target_link_libraries(nebula-frames PUBLIC Threads::Threads)

# Built only by the frames package itself (npm run build:native), not when another package adds this directory: the
# test addon creates frames over plain memory for the unit tests.
if (CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    if (NOT CMAKE_BUILD_TYPE)
        set(CMAKE_BUILD_TYPE "Release")
    endif ()
    add_library(nebula-frames-test-addon SHARED ${CMAKE_CURRENT_SOURCE_DIR}/test/frames_test_addon.c)
    set_target_properties(nebula-frames-test-addon PROPERTIES PREFIX "" SUFFIX ".node" C_STANDARD 11)
    target_compile_options(nebula-frames-test-addon PRIVATE -Wall -Wextra -Werror)
    target_link_libraries(nebula-frames-test-addon PRIVATE nebula-frames)
    install(TARGETS nebula-frames-test-addon DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/../dist/addons)
endif ()
