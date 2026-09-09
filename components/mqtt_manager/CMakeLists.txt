idf_component_register(
    SRCS "src/mqtt_manager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES mqtt json command_router config_manager device_identity event_bus runtime_core
)
