idf_component_register(
    SRCS "src/io_rules.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json config_manager event_bus runtime_core state_registry io_gpio io_pwm io_servo
             freertos
)
