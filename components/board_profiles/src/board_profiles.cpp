#include "board_profiles.hpp"

#include "esp_log.h"

static const char* TAG = "board";

namespace runtime {
namespace {

BoardProfile s_profile = {
    "esp32-devkitc",
    "ESP32-WROOM-32 DevKitC",
    2,
    true,
    0,
};

// USB at bottom, antenna/module at top. Matches DevKitC V4 38-pin silkscreen.
struct Pad {
    const char* silk;
    int gpio;  // -1 = not a GPIO
    const char* kind;  // gpio | power | gnd | en
};

const Pad kLeft[] = {
    {"3V3", -1, "power"}, {"EN", -1, "en"},     {"VP", 36, "gpio"},  {"VN", 39, "gpio"},
    {"34", 34, "gpio"},   {"35", 35, "gpio"},   {"32", 32, "gpio"},  {"33", 33, "gpio"},
    {"25", 25, "gpio"},   {"26", 26, "gpio"},   {"27", 27, "gpio"},  {"14", 14, "gpio"},
    {"12", 12, "gpio"},   {"GND", -1, "gnd"},   {"13", 13, "gpio"},  {"D2", 9, "gpio"},
    {"D3", 10, "gpio"},   {"CMD", 11, "gpio"},  {"5V", -1, "power"},
};

const Pad kRight[] = {
    {"GND", -1, "gnd"},   {"23", 23, "gpio"},   {"22", 22, "gpio"},  {"TXD", 1, "gpio"},
    {"RXD", 3, "gpio"},   {"21", 21, "gpio"},   {"GND", -1, "gnd"},  {"19", 19, "gpio"},
    {"18", 18, "gpio"},   {"5", 5, "gpio"},     {"17", 17, "gpio"},  {"16", 16, "gpio"},
    {"4", 4, "gpio"},     {"0", 0, "gpio"},     {"2", 2, "gpio"},    {"15", 15, "gpio"},
    {"D1", 8, "gpio"},    {"D0", 7, "gpio"},    {"CLK", 6, "gpio"},
};

struct BusPin {
    const char* name;
    int gpio;
};

struct Bus {
    const char* id;
    const char* kind;
    const char* label;
    const char* hint;
    const BusPin* pins;
    int n;
};

const BusPin kVspi[] = {{"sck", 18}, {"miso", 19}, {"mosi", 23}, {"ss", 5}};
const BusPin kHspi[] = {{"sck", 14}, {"miso", 12}, {"mosi", 13}, {"ss", 15}};
const BusPin kI2c[] = {{"sda", 21}, {"scl", 22}};
const BusPin kUart0[] = {{"tx", 1}, {"rx", 3}};
const BusPin kUart2[] = {{"tx", 17}, {"rx", 16}};

const Bus kBuses[] = {
    {"vspi", "spi", "VSPI",
     "Default HSPI-named VSPI. RFID RC522: SDA is SPI chip-select (SS), not I2C. Wire SCK/MOSI/MISO/SS, then any free GPIO as RST.",
     kVspi, 4},
    {"hspi", "spi", "HSPI", "Alternate SPI. GPIO 12 is a boot strap — keep it low at reset.", kHspi,
     4},
    {"i2c0", "i2c", "I2C", "Default SDA/SCL. Any GPIO pair can be I2C; these are the usual ones.",
     kI2c, 2},
    {"uart0", "uart", "UART0", "Serial console. Avoid reclaiming while using USB-UART.", kUart0, 2},
    {"uart2", "uart", "UART2", "Free UART if you need a second serial device.", kUart2, 2},
};

cJSON* pads_json(const Pad* pads, int n) {
    cJSON* arr = cJSON_CreateArray();
    for (int i = 0; i < n; ++i) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddNumberToObject(o, "i", i);
        cJSON_AddStringToObject(o, "silk", pads[i].silk);
        cJSON_AddStringToObject(o, "kind", pads[i].kind);
        if (pads[i].gpio >= 0) {
            cJSON_AddNumberToObject(o, "gpio", pads[i].gpio);
        } else {
            cJSON_AddNullToObject(o, "gpio");
        }
        cJSON_AddItemToArray(arr, o);
    }
    return arr;
}

}  // namespace

esp_err_t board_profiles_init() {
    ESP_LOGI(TAG, "profile %s (%s)", s_profile.id, s_profile.name);
    return ESP_OK;
}

const BoardProfile& board_profile() { return s_profile; }

cJSON* board_profile_json() {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "board_id", s_profile.id);
    cJSON_AddStringToObject(o, "board_name", s_profile.name);
    cJSON_AddNumberToObject(o, "status_led_gpio", s_profile.status_led_gpio);
    cJSON_AddBoolToObject(o, "status_led_active_high", s_profile.status_led_active_high);
    cJSON_AddNumberToObject(o, "boot_gpio", s_profile.boot_gpio);

    cJSON* header = cJSON_AddObjectToObject(o, "header");
    cJSON_AddStringToObject(header, "usb", "bottom");
    cJSON_AddItemToObject(header, "left", pads_json(kLeft, sizeof(kLeft) / sizeof(kLeft[0])));
    cJSON_AddItemToObject(header, "right", pads_json(kRight, sizeof(kRight) / sizeof(kRight[0])));

    cJSON* buses = cJSON_AddArrayToObject(o, "buses");
    for (const Bus& b : kBuses) {
        cJSON* bo = cJSON_CreateObject();
        cJSON_AddStringToObject(bo, "id", b.id);
        cJSON_AddStringToObject(bo, "kind", b.kind);
        cJSON_AddStringToObject(bo, "label", b.label);
        cJSON_AddStringToObject(bo, "hint", b.hint);
        cJSON* pins = cJSON_AddObjectToObject(bo, "pins");
        for (int i = 0; i < b.n; ++i) {
            cJSON_AddNumberToObject(pins, b.pins[i].name, b.pins[i].gpio);
        }
        cJSON_AddItemToArray(buses, bo);
    }
    return o;
}

}  // namespace runtime
