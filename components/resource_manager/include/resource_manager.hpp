#pragma once

#include "esp_err.h"

namespace runtime {

esp_err_t resource_init();
esp_err_t resource_claim(int gpio, const char* owner, char* err, size_t err_len);
esp_err_t resource_release(int gpio, const char* owner);
const char* resource_owner(int gpio);
void resource_release_all();

}  // namespace runtime
