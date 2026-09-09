#include "capability_manager.hpp"

#include <cstdio>
#include <cstring>

#include "esp_log.h"

static const char* TAG = "capability";

namespace runtime {
namespace {

// Classic ESP32 pin truth. ADC2 is unusable while Wi-Fi is on.
constexpr int kMaxGpio = 40;

PinInfo s_pins[kMaxGpio];

void set_pin(int gpio, uint32_t flags, int adc_ch, int touch_ch, const char* role,
             const char* notes) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return;
    }
    s_pins[gpio].gpio = gpio;
    s_pins[gpio].flags = flags | PIN_PRESENT;
    s_pins[gpio].adc_channel = adc_ch;
    s_pins[gpio].touch_channel = touch_ch;
    s_pins[gpio].role = role;
    s_pins[gpio].notes = notes;
}

void add_flag_bool(cJSON* o, const char* key, uint32_t flags, uint32_t bit) {
    cJSON_AddBoolToObject(o, key, flags & bit);
}

}  // namespace

esp_err_t capability_init() {
    memset(s_pins, 0, sizeof(s_pins));
    for (int i = 0; i < kMaxGpio; ++i) {
        s_pins[i].gpio = i;
        s_pins[i].adc_channel = -1;
        s_pins[i].touch_channel = -1;
        s_pins[i].role = "";
        s_pins[i].notes = "not bonded / do not use";
    }

    const uint32_t io = PIN_INPUT | PIN_OUTPUT | PIN_PULL | PIN_PWM;
    const uint32_t in_only = PIN_INPUT | PIN_INPUT_ONLY;

    set_pin(0, io | PIN_STRAP | PIN_TOUCH | PIN_ADC2 | PIN_BOOT_BTN, 1, 1, "BOOT",
            "strapping BOOT; held at reset enters download mode");
    set_pin(1, io, -1, -1, "TX0", "UART0 TX — serial console, avoid as GPIO");
    set_pin(2, io | PIN_STRAP | PIN_TOUCH | PIN_ADC2 | PIN_STATUS_LED, 2, 2, "LED",
            "strapping; onboard LED on most DevKitC boards");
    set_pin(3, io, -1, -1, "RX0", "UART0 RX — serial console, avoid as GPIO");
    set_pin(4, io | PIN_TOUCH | PIN_ADC2, 0, 0, "", "general I/O");
    set_pin(5, io | PIN_STRAP, -1, -1, "VSPI SS", "strapping (timing); default VSPI chip-select");
    set_pin(6, PIN_FLASH, -1, -1, "CLK", "SPI flash SCK — reserved");
    set_pin(7, PIN_FLASH, -1, -1, "D0", "SPI flash SDO — reserved");
    set_pin(8, PIN_FLASH, -1, -1, "D1", "SPI flash SDI — reserved");
    set_pin(9, PIN_FLASH, -1, -1, "D2", "SPI flash SHD — reserved");
    set_pin(10, PIN_FLASH, -1, -1, "D3", "SPI flash SWP — reserved");
    set_pin(11, PIN_FLASH, -1, -1, "CMD", "SPI flash SCS — reserved");
    set_pin(12, io | PIN_STRAP | PIN_TOUCH | PIN_ADC2, 5, 5, "HSPI MISO",
            "MTDI strapping; HIGH at reset can select 1.8V flash and prevent boot");
    set_pin(13, io | PIN_TOUCH | PIN_ADC2, 4, 4, "HSPI MOSI", "general I/O");
    set_pin(14, io | PIN_TOUCH | PIN_ADC2, 6, 6, "HSPI SCK", "general I/O");
    set_pin(15, io | PIN_STRAP | PIN_TOUCH | PIN_ADC2, 3, 3, "HSPI SS", "strapping MTDO");
    set_pin(16, io, -1, -1, "U2RXD", "general I/O (U2RXD default)");
    set_pin(17, io, -1, -1, "U2TXD", "general I/O (U2TXD default)");
    set_pin(18, io, -1, -1, "VSPI SCK", "VSPI SCK default");
    set_pin(19, io, -1, -1, "VSPI MISO", "VSPI MISO default");
    set_pin(21, io, -1, -1, "I2C SDA", "default I2C SDA");
    set_pin(22, io, -1, -1, "I2C SCL", "default I2C SCL");
    set_pin(23, io, -1, -1, "VSPI MOSI", "VSPI MOSI default");
    set_pin(25, io | PIN_ADC2 | PIN_DAC, 8, -1, "DAC1", "DAC1 / ADC2");
    set_pin(26, io | PIN_ADC2 | PIN_DAC, 9, -1, "DAC2", "DAC2 / ADC2");
    set_pin(27, io | PIN_TOUCH | PIN_ADC2, 7, 7, "", "general I/O");
    set_pin(32, io | PIN_TOUCH | PIN_ADC1, 4, 9, "", "ADC1_CH4");
    set_pin(33, io | PIN_TOUCH | PIN_ADC1, 5, 8, "", "ADC1_CH5");
    set_pin(34, in_only | PIN_ADC1, 6, -1, "", "input-only, no internal pull, ADC1_CH6");
    set_pin(35, in_only | PIN_ADC1, 7, -1, "", "input-only, no internal pull, ADC1_CH7");
    set_pin(36, in_only | PIN_ADC1, 0, -1, "SVP", "input-only SVP, ADC1_CH0");
    set_pin(37, in_only | PIN_ADC1, 1, -1, "", "input-only, ADC1_CH1 (often not routed)");
    set_pin(38, in_only | PIN_ADC1, 2, -1, "", "input-only, ADC1_CH2 (often not routed)");
    set_pin(39, in_only | PIN_ADC1, 3, -1, "SVN", "input-only SVN, ADC1_CH3");

    ESP_LOGI(TAG, "ESP32 pin database loaded");
    return ESP_OK;
}

const PinInfo* capability_pin(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return nullptr;
    }
    if ((s_pins[gpio].flags & PIN_PRESENT) == 0) {
        return nullptr;
    }
    return &s_pins[gpio];
}

bool capability_allows(int gpio, const char* mode, char* err, size_t err_len) {
    auto fail = [&](const char* msg) {
        if (err && err_len) {
            snprintf(err, err_len, "%s", msg);
        }
        return false;
    };
    const PinInfo* p = capability_pin(gpio);
    if (!p || (p->flags & PIN_PRESENT) == 0) {
        return fail("gpio not present on this SoC");
    }
    if (!mode) {
        return fail("mode required");
    }
    if (p->flags & PIN_FLASH) {
        return fail("gpio reserved for SPI flash");
    }
    if (strcmp(mode, "disabled") == 0) {
        return true;
    }
    if (strcmp(mode, "out") == 0 || strcmp(mode, "pwm") == 0) {
        if (p->flags & PIN_INPUT_ONLY) {
            return fail("gpio is input-only");
        }
        if ((p->flags & PIN_OUTPUT) == 0) {
            return fail("gpio cannot output");
        }
        if (strcmp(mode, "pwm") == 0 && (p->flags & PIN_PWM) == 0) {
            return fail("gpio not suitable for PWM");
        }
        return true;
    }
    if (strcmp(mode, "in") == 0) {
        if ((p->flags & PIN_INPUT) == 0) {
            return fail("gpio cannot input");
        }
        return true;
    }
    if (strcmp(mode, "adc") == 0) {
        if (p->flags & PIN_ADC2) {
            return fail("ADC2 cannot be used while Wi-Fi is on");
        }
        if ((p->flags & PIN_ADC1) == 0) {
            return fail("gpio has no ADC1 channel");
        }
        return true;
    }
    return fail("unknown mode");
}

cJSON* capability_dump() {
    cJSON* arr = cJSON_CreateArray();
    for (int i = 0; i < kMaxGpio; ++i) {
        const PinInfo& p = s_pins[i];
        if ((p.flags & PIN_PRESENT) == 0) {
            continue;
        }
        cJSON* o = cJSON_CreateObject();
        cJSON_AddNumberToObject(o, "gpio", p.gpio);
        cJSON_AddNumberToObject(o, "flags", static_cast<double>(p.flags));
        add_flag_bool(o, "input", p.flags, PIN_INPUT);
        add_flag_bool(o, "output", p.flags, PIN_OUTPUT);
        add_flag_bool(o, "pull", p.flags, PIN_PULL);
        add_flag_bool(o, "pwm", p.flags, PIN_PWM);
        add_flag_bool(o, "adc1", p.flags, PIN_ADC1);
        add_flag_bool(o, "adc2", p.flags, PIN_ADC2);
        add_flag_bool(o, "touch", p.flags, PIN_TOUCH);
        add_flag_bool(o, "dac", p.flags, PIN_DAC);
        add_flag_bool(o, "strap", p.flags, PIN_STRAP);
        add_flag_bool(o, "flash", p.flags, PIN_FLASH);
        add_flag_bool(o, "input_only", p.flags, PIN_INPUT_ONLY);
        add_flag_bool(o, "status_led", p.flags, PIN_STATUS_LED);
        add_flag_bool(o, "boot_btn", p.flags, PIN_BOOT_BTN);
        cJSON_AddNumberToObject(o, "adc_channel", p.adc_channel);
        cJSON_AddNumberToObject(o, "touch_channel", p.touch_channel);
        cJSON_AddStringToObject(o, "role", p.role ? p.role : "");
        cJSON_AddStringToObject(o, "notes", p.notes ? p.notes : "");
        cJSON_AddItemToArray(arr, o);
    }
    return arr;
}

int capability_status_led_gpio() { return 2; }
int capability_boot_gpio() { return 0; }

}  // namespace runtime
