cmake_minimum_required(VERSION 3.13)

project(nebula-transport C)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED TRUE)

set(CMAKE_BUILD_TYPE "Release")

# Socket tuning for the viewer connection (TCP_NOTSENT_LOWAT, SO_SNDBUF), loaded by src/socket-options.ts.
add_library(nebula-socket-addon SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/native/src/socket_options.c
)
target_include_directories(nebula-socket-addon PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/native/node-api
)
target_compile_options(nebula-socket-addon PRIVATE -Wall -Wextra -Werror -pedantic)
set_target_properties(nebula-socket-addon PROPERTIES PREFIX "" SUFFIX ".node")

install(TARGETS nebula-socket-addon DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/dist/addons)
