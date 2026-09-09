#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t logging_init();
void logging_capture(const char* line);
cJSON* logging_dump();  // array of recent lines, caller deletes
int logging_count();

}  // namespace runtime
