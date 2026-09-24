#pragma once

#include "cJSON.h"
#include "esp_err.h"
#include "memory_budget.hpp"

namespace runtime {

esp_err_t telemetry_init();
cJSON* telemetry_snapshot();
void telemetry_start_task();

}  // namespace runtime
