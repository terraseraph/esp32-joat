idf_component_register(
    SRCS "src/ota_manager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json app_update esp_partition esp_http_client mbedtls runtime_core event_bus esp_system
    PRIV_REQUIRES bootloader_support
)
