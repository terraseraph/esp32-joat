idf_component_register(
    SRCS "src/io_pwm.cpp"
    INCLUDE_DIRS "include"
    REQUIRES driver json capability_manager resource_manager state_registry event_bus
)
