idf_component_register(
    SRCS "src/command_router.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json config_manager device_identity capability_manager io_gpio io_pwm io_adc
             network_manager provisioning event_bus runtime_core ota_manager esp_system
)
