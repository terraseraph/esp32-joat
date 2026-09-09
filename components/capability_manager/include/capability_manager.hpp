#pragma once

#include <cstddef>
#include <cstdint>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

enum PinFlags : uint32_t {
    PIN_PRESENT = 1u << 0,
    PIN_INPUT = 1u << 1,
    PIN_OUTPUT = 1u << 2,
    PIN_PULL = 1u << 3,
    PIN_ADC1 = 1u << 4,
    PIN_ADC2 = 1u << 5,
    PIN_TOUCH = 1u << 6,
    PIN_STRAP = 1u << 7,
    PIN_FLASH = 1u << 8,
    PIN_INPUT_ONLY = 1u << 9,
    PIN_STATUS_LED = 1u << 10,
    PIN_PWM = 1u << 11,
    PIN_BOOT_BTN = 1u << 12,
    PIN_DAC = 1u << 13,
};

struct PinInfo {
    int gpio;
    uint32_t flags;
    int adc_channel;    // ADC1 or ADC2 channel number, or -1
    int touch_channel;  // touch pad index, or -1
    const char* role;   // default mux label (VSPI MOSI, I2C SDA, …)
    const char* notes;
};

esp_err_t capability_init();
const PinInfo* capability_pin(int gpio);
bool capability_allows(int gpio, const char* mode, char* err, size_t err_len);
cJSON* capability_dump();  // caller deletes
int capability_status_led_gpio();
int capability_boot_gpio();

}  // namespace runtime
