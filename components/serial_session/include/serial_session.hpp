#pragma once

#include "esp_err.h"

namespace runtime {

esp_err_t serial_session_init();
esp_err_t serial_session_start();

}  // namespace runtime
