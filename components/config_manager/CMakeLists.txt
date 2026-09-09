idf_component_register(
    SRCS "src/config_manager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES nvs_flash runtime_core
)
