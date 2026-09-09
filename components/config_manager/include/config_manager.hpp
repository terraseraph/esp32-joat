#pragma once

#include <cstddef>
#include <cstdint>
#include "esp_err.h"

namespace runtime {

esp_err_t config_init();
uint32_t config_generation();
int config_schema_version();

esp_err_t config_get_blob(const char* ns, const char* key, void* out, size_t* inout_len);
esp_err_t config_set_blob(const char* ns, const char* key, const void* data, size_t len);
esp_err_t config_get_str(const char* ns, const char* key, char* out, size_t* inout_len);
esp_err_t config_set_str(const char* ns, const char* key, const char* value);
esp_err_t config_get_u8(const char* ns, const char* key, uint8_t* out);
esp_err_t config_set_u8(const char* ns, const char* key, uint8_t value);
esp_err_t config_get_u32(const char* ns, const char* key, uint32_t* out);
esp_err_t config_set_u32(const char* ns, const char* key, uint32_t value);
esp_err_t config_erase_key(const char* ns, const char* key);

/** Erase all non-identity namespaces. Identity is MAC-derived and is not stored here. */
esp_err_t config_factory_reset();

bool config_has_wifi();

}  // namespace runtime
