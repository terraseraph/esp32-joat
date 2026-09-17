idf_component_register(
    SRCS "src/mod_mfrc522.cpp"
    INCLUDE_DIRS "include"
    REQUIRES driver json module_manager resource_manager event_bus state_registry runtime_core
             esp_timer freertos
)
