#pragma once

#include <cstddef>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t io_adc_init();
esp_err_t io_adc_configure(int gpio, char* err, size_t err_len);
int io_adc_read(int gpio);  // millivolts, or raw if uncalibrated; <0 on error
esp_err_t io_adc_release(int gpio);
/** Refresh all configured ADC channels into state_registry (telemetry). No event bus. */
void io_adc_refresh();

}  // namespace runtime
