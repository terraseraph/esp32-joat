idf_component_register(
    SRCS "src/module_manager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES json config_manager capability_manager runtime_core state_registry freertos
)
