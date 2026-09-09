#pragma once

#include <cstddef>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t io_pwm_init();
esp_err_t io_pwm_configure(int gpio, int hz, int duty_permille, char* err, size_t err_len);
esp_err_t io_pwm_set(int gpio, int duty_permille);
esp_err_t io_pwm_release(int gpio);
int io_pwm_get(int gpio);

}  // namespace runtime
