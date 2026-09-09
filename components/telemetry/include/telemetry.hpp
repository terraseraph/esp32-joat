#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t telemetry_init();
cJSON* telemetry_snapshot();
void telemetry_start_task();

}  // namespace runtime
