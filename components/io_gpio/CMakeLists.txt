idf_component_register(
    SRCS "src/io_gpio.cpp"
    INCLUDE_DIRS "include"
    REQUIRES driver json capability_manager resource_manager event_bus state_registry
)
