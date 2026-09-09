idf_component_register(
    SRCS "src/runtime_status.cpp" "src/json_util.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json esp_timer freertos
)
