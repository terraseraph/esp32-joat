#pragma once

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

struct BoardProfile {
    const char* id;
    const char* name;
    int status_led_gpio;
    bool status_led_active_high;
    int boot_gpio;
};

esp_err_t board_profiles_init();
const BoardProfile& board_profile();
/** Header pads, default buses, LED/BOOT. Caller deletes. */
cJSON* board_profile_json();

}  // namespace runtime
