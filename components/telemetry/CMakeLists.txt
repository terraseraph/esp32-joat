idf_component_register(
    SRCS "src/telemetry.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json mqtt_manager network_manager device_identity runtime_core state_registry event_bus
             ota_manager esp_system
)
