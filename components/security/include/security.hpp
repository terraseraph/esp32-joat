#pragma once

#include "esp_err.h"

namespace runtime {

esp_err_t security_init();
const char* ap_password();  // empty string means the recovery AP is open
bool ap_is_open();
// Empty / blank = open AP. Otherwise 8-63 ASCII chars (WPA2). Persisted in NVS;
// factory reset clears it.
esp_err_t set_ap_password(const char* pass);

}  // namespace runtime
