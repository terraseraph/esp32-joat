idf_component_register(
    SRCS "src/udp_sink.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json lwip esp_timer config_manager device_identity event_bus runtime_core freertos
             network_manager
)
