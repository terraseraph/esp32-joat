#include "mod_bme280.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "json_util.hpp"
#include "module_manager.hpp"
#include "resource_manager.hpp"
#include "state_registry.hpp"

static const char* TAG = "bme280";

namespace runtime {
namespace {

constexpr int kMax = 2;
constexpr int kHz = 100000;
constexpr int kTimeoutMs = 50;
constexpr uint8_t kChipId = 0x60;
constexpr uint8_t kRegId = 0xD0;
constexpr uint8_t kRegReset = 0xE0;
constexpr uint8_t kRegCalib00 = 0x88;
constexpr uint8_t kRegCalibH1 = 0xA1;
constexpr uint8_t kRegCalibH2 = 0xE1;
constexpr uint8_t kRegCtrlHum = 0xF2;
constexpr uint8_t kRegStatus = 0xF3;
constexpr uint8_t kRegCtrlMeas = 0xF4;
constexpr uint8_t kRegConfig = 0xF5;
constexpr uint8_t kRegData = 0xF7;

const ModulePinRole kPins[] = {
    {"sda", true, "bus", "out"},
    {"scl", true, "bus", "out"},
};

const ModuleSettingChoice kAddr[] = {{"118", "0x76"}, {"119", "0x77"}};
const ModuleSettingChoice kOsrs[] = {
    {"1", "×1"}, {"2", "×2"}, {"4", "×4"}, {"8", "×8"}, {"16", "×16"},
};
const ModuleSettingChoice kFilter[] = {
    {"0", "Off"}, {"2", "2"}, {"4", "4"}, {"8", "8"}, {"16", "16"},
};
const ModuleSettingChoice kMode[] = {{"normal", "Normal"}, {"forced", "Forced"}};

const ModuleSettingDesc kSettings[] = {
    {"addr", "I2C address", "enum", "118", 0, 0, kAddr, 2},
    {"sample_ms", "Sample period (ms)", "int", "1000", 200, 10000, nullptr, 0},
    {"osrs_t", "Temp oversampling", "enum", "1", 0, 0, kOsrs, 5},
    {"osrs_p", "Pressure oversampling", "enum", "1", 0, 0, kOsrs, 5},
    {"osrs_h", "Humidity oversampling", "enum", "1", 0, 0, kOsrs, 5},
    {"filter", "IIR filter", "enum", "0", 0, 0, kFilter, 5},
    {"mode", "Mode", "enum", "normal", 0, 0, kMode, 2},
};

struct Calib {
    uint16_t t1;
    int16_t t2, t3;
    uint16_t p1;
    int16_t p2, p3, p4, p5, p6, p7, p8, p9;
    uint8_t h1, h3;
    int16_t h2, h4, h5;
    int8_t h6;
};

struct Slot {
    bool used;
    char id[16];
    char bus[8];
    int sda;
    int scl;
    int addr;
    int sample_ms;
    int osrs_t;
    int osrs_p;
    int osrs_h;
    int filter;
    bool forced;
    i2c_master_dev_handle_t dev;
    Calib cal;
    int32_t t_fine;
    bool ok;
    bool have_sent;
    double t_c;
    double p_hpa;
    double rh;
    TickType_t next;
};

Slot s_slots[kMax];
TaskHandle_t s_poll;
SemaphoreHandle_t s_mu;

void set_err(char* err, size_t err_len, const char* msg) {
    if (err && err_len) {
        snprintf(err, err_len, "%s", msg ? msg : "error");
    }
}

void owner_name(char* out, size_t n, const char* id) { snprintf(out, n, "mod_%s", id); }

int pin_of(cJSON* inst, const char* role, int fallback) {
    cJSON* pins = cJSON_GetObjectItemCaseSensitive(inst, "pins");
    if (!cJSON_IsObject(pins)) {
        return fallback;
    }
    cJSON* v = cJSON_GetObjectItemCaseSensitive(pins, role);
    return cJSON_IsNumber(v) ? v->valueint : fallback;
}

int osrs_bits(int x) {
    switch (x) {
        case 2:
            return 2;
        case 4:
            return 3;
        case 8:
            return 4;
        case 16:
            return 5;
        default:
            return 1;
    }
}

int filter_bits(int x) {
    switch (x) {
        case 2:
            return 1;
        case 4:
            return 2;
        case 8:
            return 3;
        case 16:
            return 4;
        default:
            return 0;
    }
}

esp_err_t wr(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t val) {
    uint8_t buf[2] = {reg, val};
    return i2c_master_transmit(dev, buf, 2, kTimeoutMs);
}

esp_err_t rd(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t* data, size_t n) {
    return i2c_master_transmit_receive(dev, &reg, 1, data, n, kTimeoutMs);
}

int16_t s16le(const uint8_t* p) { return static_cast<int16_t>(p[0] | (p[1] << 8)); }
uint16_t u16le(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

int16_t h4_from(uint8_t e4, uint8_t e5) {
    return static_cast<int16_t>((static_cast<int8_t>(e4) << 4) | (e5 & 0x0F));
}

int16_t h5_from(uint8_t e5, uint8_t e6) {
    return static_cast<int16_t>((static_cast<int8_t>(e6) << 4) | (e5 >> 4));
}

esp_err_t load_calib(Slot& s) {
    uint8_t a[26] = {};
    uint8_t h1 = 0;
    uint8_t h[7] = {};
    esp_err_t rc = rd(s.dev, kRegCalib00, a, sizeof(a));
    if (rc == ESP_OK) {
        rc = rd(s.dev, kRegCalibH1, &h1, 1);
    }
    if (rc == ESP_OK) {
        rc = rd(s.dev, kRegCalibH2, h, sizeof(h));
    }
    if (rc != ESP_OK) {
        return rc;
    }
    s.cal.t1 = u16le(a + 0);
    s.cal.t2 = s16le(a + 2);
    s.cal.t3 = s16le(a + 4);
    s.cal.p1 = u16le(a + 6);
    s.cal.p2 = s16le(a + 8);
    s.cal.p3 = s16le(a + 10);
    s.cal.p4 = s16le(a + 12);
    s.cal.p5 = s16le(a + 14);
    s.cal.p6 = s16le(a + 16);
    s.cal.p7 = s16le(a + 18);
    s.cal.p8 = s16le(a + 20);
    s.cal.p9 = s16le(a + 22);
    s.cal.h1 = h1;
    s.cal.h2 = s16le(h + 0);
    s.cal.h3 = h[2];
    s.cal.h4 = h4_from(h[3], h[4]);
    s.cal.h5 = h5_from(h[4], h[5]);
    s.cal.h6 = static_cast<int8_t>(h[6]);
    return ESP_OK;
}

int32_t compensate_t(Slot& s, int32_t adc_t) {
    int32_t var1 =
        ((((adc_t >> 3) - (static_cast<int32_t>(s.cal.t1) << 1))) * static_cast<int32_t>(s.cal.t2)) >>
        11;
    int32_t var2 = (((((adc_t >> 4) - static_cast<int32_t>(s.cal.t1)) *
                      ((adc_t >> 4) - static_cast<int32_t>(s.cal.t1))) >>
                     12) *
                    static_cast<int32_t>(s.cal.t3)) >>
                   14;
    s.t_fine = var1 + var2;
    return (s.t_fine * 5 + 128) >> 8;
}

uint32_t compensate_p(const Slot& s, int32_t adc_p) {
    int64_t var1 = static_cast<int64_t>(s.t_fine) - 128000;
    int64_t var2 = var1 * var1 * s.cal.p6;
    var2 = var2 + ((var1 * s.cal.p5) << 17);
    var2 = var2 + (static_cast<int64_t>(s.cal.p4) << 35);
    var1 = ((var1 * var1 * s.cal.p3) >> 8) + ((var1 * s.cal.p2) << 12);
    var1 = ((static_cast<int64_t>(1) << 47) + var1) * s.cal.p1 >> 33;
    if (var1 == 0) {
        return 0;
    }
    int64_t p = 1048576 - adc_p;
    p = (((p << 31) - var2) * 3125) / var1;
    var1 = (static_cast<int64_t>(s.cal.p9) * (p >> 13) * (p >> 13)) >> 25;
    var2 = (static_cast<int64_t>(s.cal.p8) * p) >> 19;
    p = ((p + var1 + var2) >> 8) + (static_cast<int64_t>(s.cal.p7) << 4);
    return static_cast<uint32_t>(p);
}

uint32_t compensate_h(const Slot& s, int32_t adc_h) {
    int32_t v = s.t_fine - 76800;
    v = ((((adc_h << 14) - (static_cast<int32_t>(s.cal.h4) << 20) -
           (static_cast<int32_t>(s.cal.h5) * v)) +
          16384) >>
         15) *
        (((((((v * static_cast<int32_t>(s.cal.h6)) >> 10) *
             (((v * static_cast<int32_t>(s.cal.h3)) >> 11) + 32768)) >>
            10) +
           2097152) *
              static_cast<int32_t>(s.cal.h2) +
          8192) >>
         14);
    v = v - (((((v >> 15) * (v >> 15)) >> 7) * static_cast<int32_t>(s.cal.h1)) >> 4);
    if (v < 0) {
        v = 0;
    }
    if (v > 419430400) {
        v = 419430400;
    }
    return static_cast<uint32_t>(v >> 12);
}

esp_err_t write_ctrl(const Slot& s) {
    uint8_t hum = static_cast<uint8_t>(osrs_bits(s.osrs_h));
    uint8_t mode = s.forced ? 1 : 3;
    uint8_t meas = static_cast<uint8_t>((osrs_bits(s.osrs_t) << 5) | (osrs_bits(s.osrs_p) << 2) | mode);
    uint8_t cfg = static_cast<uint8_t>((5 << 5) | (filter_bits(s.filter) << 2));
    esp_err_t rc = wr(s.dev, kRegCtrlHum, hum);
    if (rc == ESP_OK) {
        rc = wr(s.dev, kRegConfig, cfg);
    }
    if (rc == ESP_OK) {
        rc = wr(s.dev, kRegCtrlMeas, meas);
    }
    return rc;
}

esp_err_t trigger_forced(const Slot& s) {
    uint8_t meas =
        static_cast<uint8_t>((osrs_bits(s.osrs_t) << 5) | (osrs_bits(s.osrs_p) << 2) | 1);
    return wr(s.dev, kRegCtrlMeas, meas);
}

esp_err_t sample(Slot& s, double* t_c, double* p_hpa, double* rh) {
    if (s.forced) {
        esp_err_t rc = trigger_forced(s);
        if (rc != ESP_OK) {
            return rc;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
        uint8_t st = 0;
        rd(s.dev, kRegStatus, &st, 1);
        if (st & 0x08) {
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
    uint8_t d[8] = {};
    esp_err_t rc = rd(s.dev, kRegData, d, sizeof(d));
    if (rc != ESP_OK) {
        return rc;
    }
    int32_t adc_p = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4);
    int32_t adc_t = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4);
    int32_t adc_h = (d[6] << 8) | d[7];
    if (adc_t == 0x80000 || adc_p == 0x80000) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    int32_t T = compensate_t(s, adc_t);
    uint32_t P = compensate_p(s, adc_p);
    uint32_t H = compensate_h(s, adc_h);
    *t_c = T / 100.0;
    *p_hpa = P / 25600.0;  // Bosch Q24.8 Pa → hPa
    *rh = H / 1024.0;
    if (*rh < 0) {
        *rh = 0;
    }
    if (*rh > 100) {
        *rh = 100;
    }
    return ESP_OK;
}

void publish(Slot& s, bool to_bus) {
    char key[32];
    owner_name(key, sizeof(key), s.id);
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", s.id);
    cJSON_AddStringToObject(st, "type", "bme280");
    cJSON_AddBoolToObject(st, "ok", s.ok);
    cJSON_AddNumberToObject(st, "addr", s.addr);
    if (s.ok) {
        cJSON_AddNumberToObject(st, "t_c", std::round(s.t_c * 100.0) / 100.0);
        cJSON_AddNumberToObject(st, "p_hpa", std::round(s.p_hpa * 100.0) / 100.0);
        cJSON_AddNumberToObject(st, "rh", std::round(s.rh * 10.0) / 10.0);
    }
    state_set(key, st);
    if (to_bus) {
        event_bus_publish("io/env", st);
    }
    cJSON_Delete(st);
}

bool changed(const Slot& s, double t_c, double p_hpa, double rh) {
    if (!s.have_sent) {
        return true;
    }
    if (std::fabs(t_c - s.t_c) >= 0.10) {
        return true;
    }
    if (std::fabs(p_hpa - s.p_hpa) >= 0.50) {
        return true;
    }
    if (std::fabs(rh - s.rh) >= 0.50) {
        return true;
    }
    return false;
}

void poll_one(Slot& s) {
    if (!s.dev) {
        return;
    }
    TickType_t now = xTaskGetTickCount();
    if (s.next && now < s.next) {
        return;
    }
    s.next = now + pdMS_TO_TICKS(s.sample_ms);
    double t_c = 0, p_hpa = 0, rh = 0;
    esp_err_t rc = sample(s, &t_c, &p_hpa, &rh);
    bool ok = rc == ESP_OK;
    bool bus = false;
    if (ok != s.ok) {
        bus = true;
    }
    if (ok && changed(s, t_c, p_hpa, rh)) {
        bus = true;
        s.t_c = t_c;
        s.p_hpa = p_hpa;
        s.rh = rh;
        s.have_sent = true;
    }
    s.ok = ok;
    publish(s, bus);
}

void poll_task(void*) {
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(50));
        xSemaphoreTake(s_mu, portMAX_DELAY);
        for (int i = 0; i < kMax; ++i) {
            if (s_slots[i].used) {
                poll_one(s_slots[i]);
            }
        }
        xSemaphoreGive(s_mu);
    }
}

void ensure_poll() {
    if (!s_poll) {
        xTaskCreate(poll_task, "bme_poll", 4096, nullptr, 5, &s_poll);
    }
}

Slot* find_slot(const char* id) {
    for (int i = 0; i < kMax; ++i) {
        if (s_slots[i].used && strcmp(s_slots[i].id, id) == 0) {
            return &s_slots[i];
        }
    }
    return nullptr;
}

Slot* alloc_slot() {
    for (int i = 0; i < kMax; ++i) {
        if (!s_slots[i].used) {
            return &s_slots[i];
        }
    }
    return nullptr;
}

int used_count() {
    int n = 0;
    for (int i = 0; i < kMax; ++i) {
        if (s_slots[i].used) {
            n++;
        }
    }
    return n;
}

void release_bus(const Slot& s) {
    resource_i2c_rm_device(s.dev);
    resource_i2c_release(s.bus);
}

esp_err_t apply(cJSON* inst, char* err, size_t err_len) {
    const char* id = json_str(inst, "id", "");
    const char* bus = json_str(inst, "bus", "i2c0");
    int sda = pin_of(inst, "sda", -1);
    int scl = pin_of(inst, "scl", -1);
    cJSON* settings = cJSON_GetObjectItemCaseSensitive(inst, "settings");
    int addr = json_int(settings, "addr", 0x76);
    int sample_ms = json_int(settings, "sample_ms", 1000);
    int osrs_t = json_int(settings, "osrs_t", 1);
    int osrs_p = json_int(settings, "osrs_p", 1);
    int osrs_h = json_int(settings, "osrs_h", 1);
    int filter = json_int(settings, "filter", 0);
    const char* mode = json_str(settings, "mode", "normal");
    if (!id[0] || sda < 0 || scl < 0) {
        set_err(err, err_len, "bme280 id, sda, and scl required");
        return ESP_ERR_INVALID_ARG;
    }
    if (addr != 0x76 && addr != 0x77) {
        set_err(err, err_len, "bme280 addr must be 0x76 or 0x77");
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (find_slot(id)) {
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "bme280 already applied");
        return ESP_ERR_INVALID_STATE;
    }
    if (used_count() >= kMax) {
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "bme280 limited to 2 instances");
        return ESP_ERR_NO_MEM;
    }
    esp_err_t rc = resource_i2c_claim(bus, sda, scl, kHz, err, err_len);
    if (rc != ESP_OK) {
        xSemaphoreGive(s_mu);
        return rc;
    }
    i2c_master_dev_handle_t dev = nullptr;
    rc = resource_i2c_add_device(bus, static_cast<uint16_t>(addr), kHz, &dev, err, err_len);
    if (rc != ESP_OK) {
        resource_i2c_release(bus);
        xSemaphoreGive(s_mu);
        return rc;
    }
    Slot* slot = alloc_slot();
    memset(slot, 0, sizeof(*slot));
    slot->used = true;
    snprintf(slot->id, sizeof(slot->id), "%s", id);
    snprintf(slot->bus, sizeof(slot->bus), "%s", bus);
    slot->sda = sda;
    slot->scl = scl;
    slot->addr = addr;
    slot->sample_ms = sample_ms;
    slot->osrs_t = osrs_t;
    slot->osrs_p = osrs_p;
    slot->osrs_h = osrs_h;
    slot->filter = filter;
    slot->forced = strcmp(mode, "forced") == 0;
    slot->dev = dev;
    wr(dev, kRegReset, 0xB6);
    vTaskDelay(pdMS_TO_TICKS(10));
    uint8_t chip = 0;
    if (rd(dev, kRegId, &chip, 1) == ESP_OK) {
        ESP_LOGI(TAG, "%s chip 0x%02x", id, chip);
        slot->ok = chip == kChipId;
        if (chip != kChipId) {
            ESP_LOGW(TAG, "%s expected BME280 0x60 (got 0x%02x)", id, chip);
        }
    }
    if (slot->ok) {
        if (load_calib(*slot) != ESP_OK || write_ctrl(*slot) != ESP_OK) {
            slot->ok = false;
        }
    }
    ensure_poll();
    publish(*slot, true);
    xSemaphoreGive(s_mu);
    ESP_LOGI(TAG, "bme280 %s bus=%s addr=0x%02x sda=%d scl=%d", id, bus, addr, sda, scl);
    return ESP_OK;
}

esp_err_t teardown(const char* id) {
    if (!id || !id[0]) {
        return ESP_OK;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    Slot* slot = find_slot(id);
    if (!slot) {
        xSemaphoreGive(s_mu);
        return ESP_OK;
    }
    release_bus(*slot);
    char key[32];
    owner_name(key, sizeof(key), slot->id);
    state_clear(key);
    memset(slot, 0, sizeof(*slot));
    xSemaphoreGive(s_mu);
    ESP_LOGI(TAG, "removed %s", id);
    return ESP_OK;
}

const ModuleTypeOps kOps = {
    "bme280",
    "BME280",
    "I2C temp / pressure / humidity. Share SDA/SCL; unique address 0x76 or 0x77 (SDO).",
    "i2c",
    "i2c0",
    "env",
    kMax,
    kPins,
    static_cast<int>(sizeof(kPins) / sizeof(kPins[0])),
    apply,
    teardown,
    nullptr,
    kSettings,
    static_cast<int>(sizeof(kSettings) / sizeof(kSettings[0])),
    nullptr,
};

}  // namespace

esp_err_t mod_bme280_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    memset(s_slots, 0, sizeof(s_slots));
    return module_register_type(&kOps);
}

}  // namespace runtime
