#pragma once

#include <cstddef>
#include "esp_err.h"

namespace runtime {

esp_err_t io_servo_init();
esp_err_t io_servo_configure(int gpio, int angle, int min_us, int max_us, char* err, size_t err_len);
esp_err_t io_servo_set(int gpio, int angle);
esp_err_t io_servo_release(int gpio);
int io_servo_get(int gpio);

}  // namespace runtime
