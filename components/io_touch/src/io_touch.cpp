#include "io_touch.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "capability_manager.hpp"
#include "cJSON.h"
#include "driver/touch_pad.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "resource_manager.hpp"
#include "runtime_status.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_touch";

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;
constexpr int kSampleMsMin = 20;
constexpr int kSampleMsMax = 500;
constexpr int kSampleMsDefault = 50;
constexpr int kThreshMin = 5;
constexpr int kThreshMax = 80;
constexpr int kThreshDefault = 30;
constexpr uint32_t kFilterMs = 10;
constexpr int kBaselineReads = 8;
constexpr int kLiveMs = 250;  // raw-value updates to live viewers, at most this often

struct Pad {
    bool used;
    int channel;
    int threshold_pct;
    int sample_ms;
    int32_t base16;  // untouched baseline x16, for sub-count drift tracking
    int raw;
    int level;       // 1 = touched
    int sent_raw;    // raw value last pushed to live viewers
    TickType_t next;
    TickType_t next_live;
};

Pad s_pad[kMaxGpio];
SemaphoreHandle_t s_mu;
bool s_driver;

struct Snap {
    int gpio;
    int channel;
    int raw;
    int baseline;
    int level;
    int threshold_pct;
    int sample_ms;
};

int clamp_int(int v, int lo, int hi) {
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

Snap snap_of(int gpio) {
    const Pad& p = s_pad[gpio];
    return Snap{gpio, p.channel, p.raw, static_cast<int>(p.base16 / 16), p.level, p.threshold_pct,
                p.sample_ms};
}

void publish(const Snap& s, bool to_bus) {
    char key[16];
    snprintf(key, sizeof(key), "touch_%d", s.gpio);
    cJSON* st = cJSON_CreateObject();
    if (!st) {
        return;
    }
    cJSON_AddStringToObject(st, "id", key);
    cJSON_AddStringToObject(st, "mode", "touch");
    cJSON_AddNumberToObject(st, "gpio", s.gpio);
    cJSON_AddNumberToObject(st, "channel", s.channel);
    cJSON_AddNumberToObject(st, "level", s.level);
    cJSON_AddNumberToObject(st, "raw", s.raw);
    cJSON_AddNumberToObject(st, "baseline", s.baseline);
    cJSON_AddNumberToObject(st, "threshold_pct", s.threshold_pct);
    cJSON_AddNumberToObject(st, "sample_ms", s.sample_ms);
    state_set(key, st);
    if (to_bus) {
        event_bus_publish("io/touch", st);
    }
    cJSON_Delete(st);
}

esp_err_t ensure_driver() {
    if (s_driver) {
        return ESP_OK;
    }
    esp_err_t err = touch_pad_init();
    if (err != ESP_OK) {
        return err;
    }
    // Widest voltage swing gives the largest change per touch.
    touch_pad_set_voltage(TOUCH_HVOLT_2V7, TOUCH_LVOLT_0V5, TOUCH_HVOLT_ATTEN_1V);
    err = touch_pad_filter_start(kFilterMs);
    if (err != ESP_OK) {
        touch_pad_deinit();
        return err;
    }
    s_driver = true;
    return ESP_OK;
}

int read_pad(int channel) {
    uint16_t v = 0;
    if (touch_pad_read_filtered(static_cast<touch_pad_t>(channel), &v) != ESP_OK) {
        return -1;
    }
    return v;
}

// Update one pad from a fresh reading. Caller holds s_mu. Returns true when the touched state flipped.
bool step(Pad& p, int v) {
    p.raw = v;
    const int32_t v16 = static_cast<int32_t>(v) * 16;
    const int32_t base16 = p.base16;
    const int32_t on16 = base16 * (100 - p.threshold_pct) / 100;
    const int32_t off16 = base16 * (100 - p.threshold_pct / 2) / 100;  // release hysteresis
    const int prev = p.level;
    if (p.level == 0 && v16 < on16) {
        p.level = 1;
    } else if (p.level == 1 && v16 > off16) {
        p.level = 0;
    }
    if (p.level == 0) {
        // Follow temperature/humidity drift. Rise quickly (baseline taken while touched,
        // or the environment changed); fall slowly so a slow approach is not absorbed.
        p.base16 += v16 > base16 ? (v16 - base16) / 8 : (v16 - base16) / 256;
    }
    return p.level != prev;
}

bool any_used() {
    for (int i = 0; i < kMaxGpio; ++i) {
        if (s_pad[i].used) {
            return true;
        }
    }
    return false;
}

int min_sample_ms() {
    int ms = kSampleMsMax;
    for (int i = 0; i < kMaxGpio; ++i) {
        if (s_pad[i].used && s_pad[i].sample_ms < ms) {
            ms = s_pad[i].sample_ms;
        }
    }
    return ms;
}

void touch_task(void*) {
    while (true) {
        xSemaphoreTake(s_mu, portMAX_DELAY);
        const bool used = any_used();
        const int wait = used ? min_sample_ms() : 250;
        xSemaphoreGive(s_mu);
        vTaskDelay(pdMS_TO_TICKS(wait));
        if (!used) {
            continue;
        }
        const bool live = RuntimeStatus::instance().live_sinks() > 0;
        for (int i = 0; i < kMaxGpio; ++i) {
            Snap out{};
            bool edge = false;
            bool live_push = false;
            xSemaphoreTake(s_mu, portMAX_DELAY);
            Pad& p = s_pad[i];
            const TickType_t now = xTaskGetTickCount();
            if (p.used && now >= p.next) {
                p.next = now + pdMS_TO_TICKS(p.sample_ms);
                const int v = read_pad(p.channel);
                if (v > 0) {
                    edge = step(p, v);
                    // Raw readings help when tuning the threshold, but only while someone watches.
                    const int min_move = p.base16 / 16 / 50 > 2 ? p.base16 / 16 / 50 : 2;
                    if (!edge && live && now >= p.next_live && abs(v - p.sent_raw) >= min_move) {
                        live_push = true;
                    }
                    if (edge || live_push) {
                        p.sent_raw = v;
                        p.next_live = now + pdMS_TO_TICKS(kLiveMs);
                        out = snap_of(i);
                    }
                }
            }
            xSemaphoreGive(s_mu);
            if (edge || live_push) {
                publish(out, true);
            }
        }
    }
}

}  // namespace

esp_err_t io_touch_init() {
    memset(s_pad, 0, sizeof(s_pad));
    s_mu = xSemaphoreCreateMutex();
    if (!s_mu) {
        return ESP_ERR_NO_MEM;
    }
    // The touch driver itself starts on first use, so boards without touch pads pay nothing.
    xTaskCreate(touch_task, "touch", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "ready");
    return ESP_OK;
}

esp_err_t io_touch_configure(int gpio, int threshold_pct, int sample_ms, char* err,
                             size_t err_len) {
    if (!capability_allows(gpio, "touch", err, err_len)) {
        return ESP_ERR_INVALID_ARG;
    }
    const PinInfo* info = capability_pin(gpio);
    const int channel = info ? info->touch_channel : -1;
    if (channel < 0) {
        snprintf(err, err_len, "gpio has no touch channel");
        return ESP_ERR_INVALID_ARG;
    }
    char owner[16];
    snprintf(owner, sizeof(owner), "touch_%d", gpio);
    esp_err_t rc = resource_claim(gpio, owner, err, err_len);
    if (rc != ESP_OK) {
        return rc;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    rc = ensure_driver();
    if (rc == ESP_OK) {
        rc = touch_pad_config(static_cast<touch_pad_t>(channel), 0);
    }
    xSemaphoreGive(s_mu);
    if (rc != ESP_OK) {
        resource_release(gpio, owner);
        snprintf(err, err_len, "touch pad setup failed: %s", esp_err_to_name(rc));
        return rc;
    }
    // Let the filter settle, then take the untouched baseline.
    vTaskDelay(pdMS_TO_TICKS(kFilterMs * 6));
    int64_t acc = 0;
    int n = 0;
    for (int i = 0; i < kBaselineReads; ++i) {
        const int v = read_pad(channel);
        if (v > 0) {
            acc += v;
            n++;
        }
        vTaskDelay(pdMS_TO_TICKS(kFilterMs));
    }
    if (n == 0) {
        resource_release(gpio, owner);
        snprintf(err, err_len, "touch pad gave no reading");
        return ESP_FAIL;
    }
    const int base = static_cast<int>(acc / n);
    xSemaphoreTake(s_mu, portMAX_DELAY);
    Pad& p = s_pad[gpio];
    p.channel = channel;
    p.threshold_pct = clamp_int(threshold_pct, kThreshMin, kThreshMax);
    p.sample_ms = clamp_int(sample_ms, kSampleMsMin, kSampleMsMax);
    p.base16 = base * 16;
    p.raw = base;
    p.level = 0;
    p.sent_raw = base;
    p.next = 0;
    p.next_live = 0;
    p.used = true;
    const Snap out = snap_of(gpio);
    xSemaphoreGive(s_mu);
    ESP_LOGI(TAG, "GPIO %d (T%d) baseline %d, threshold %d%%", gpio, channel, base,
             out.threshold_pct);
    publish(out, true);
    return ESP_OK;
}

esp_err_t io_touch_release(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_mu) {
        return ESP_OK;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    const bool was = s_pad[gpio].used;
    s_pad[gpio] = Pad{};
    xSemaphoreGive(s_mu);
    if (!was) {
        return ESP_OK;
    }
    char owner[16];
    snprintf(owner, sizeof(owner), "touch_%d", gpio);
    resource_release(gpio, owner);
    state_clear(owner);
    return ESP_OK;
}

void io_touch_refresh() {
    if (!s_mu) {
        return;
    }
    for (int i = 0; i < kMaxGpio; ++i) {
        xSemaphoreTake(s_mu, portMAX_DELAY);
        const bool used = s_pad[i].used;
        const Snap out = used ? snap_of(i) : Snap{};
        xSemaphoreGive(s_mu);
        if (used) {
            publish(out, false);
        }
    }
}

}  // namespace runtime
