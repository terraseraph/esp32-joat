idf_component_register(
    SRCS "src/device_identity.cpp"
    INCLUDE_DIRS "include"
    REQUIRES nvs_flash esp_hw_support esp_netif json event_bus
)
