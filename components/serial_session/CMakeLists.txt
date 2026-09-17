idf_component_register(
    SRCS "src/serial_session.cpp"
    INCLUDE_DIRS "include"
    REQUIRES driver json command_router event_bus runtime_core console freertos
)
