idf_component_register(
    SRCS "app_main.cpp"
    INCLUDE_DIRS "."
    REQUIRES runtime_core logging config_manager device_identity security event_bus state_registry
             capability_manager resource_manager board_profiles io_gpio io_pwm io_adc io_servo
             io_rules command_router network_manager provisioning web_server mqtt_manager telemetry
             ota_manager serial_session module_manager mod_mfrc522 driver console nvs_flash
             esp_netif esp_event esp_wifi
)
