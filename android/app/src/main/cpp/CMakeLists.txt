cmake_minimum_required(VERSION 3.22.1)
project(padengine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(oboe REQUIRED CONFIG)

add_library(padengine SHARED engine.cpp midi.cpp jni.cpp)
target_compile_options(padengine PRIVATE -Wall -Wextra -O2 -ffast-math)
target_link_libraries(padengine oboe::oboe amidi android log)
