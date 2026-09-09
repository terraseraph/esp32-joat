# ESP32 managed-device runtime (native ESP-IDF, no Arduino).
cmake_minimum_required(VERSION 3.16)

set(COMPONENTS main)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(de_esp32_runtime)
