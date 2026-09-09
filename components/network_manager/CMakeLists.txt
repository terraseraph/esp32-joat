idf_component_register(
    SRCS "src/network_manager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_netif esp_event json config_manager device_identity security event_bus runtime_core mdns
)
