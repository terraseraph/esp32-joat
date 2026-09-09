#pragma once

#include "esp_err.h"

namespace runtime {

esp_err_t provisioning_init();
esp_err_t provisioning_start_dns();
void provisioning_stop_dns();

}  // namespace runtime
