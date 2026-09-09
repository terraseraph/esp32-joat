idf_component_register(
    SRCS "src/web_server.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_server json command_router device_identity network_manager mqtt_manager
             logging telemetry ota_manager capability_manager board_profiles config_manager
             runtime_core state_registry event_bus security
    EMBED_FILES "${CMAKE_SOURCE_DIR}/web/dist/index.html"
)
