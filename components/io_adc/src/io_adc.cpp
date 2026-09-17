#include "io_adc.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "capability_manager.hpp"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "resource_manager.hpp"
#include "runtime_status.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_adc";

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;
constexpr int kSampleMsMin = 20;
constexpr int kSampleMsMax = 1000;
constexpr int kSampleMsDefault = 50;
constexpr int kHystMin = 5;
constexpr int kHystMax = 500;
constexpr int kHystDefault = 20;
constexpr int kSmoothMin = 0;
constexpr int kSmoothMax = 90;
constexpr int kSmoothDefault = 70;
constexpr int kOversample = 4;

adc_oneshot_unit_handle_t s_adc1;
adc_cali_handle_t s_cali;
bool s_used[kMaxGpio];
int s_filt[kMaxGpio];
int s_sent[kMaxGpio];
int s_sample_ms[kMaxGpio];
int s_hyst_mv[kMaxGpio];
int s_smooth[kMaxGpio];
TickType_t s_next[kMaxGpio];

int clamp_int(int v, int lo, int hi) {
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

adc_channel_t channel_for(int gpio) {
    const PinInfo* p = capability_pin(gpio);
    if (!p || (p->flags & PIN_ADC1) == 0) {
        return static_cast<adc_channel_t>(-1);
    }
    return static_cast<adc_channel_t>(p->adc_channel);
}

void publish(int gpio, int mv, int raw, bool to_bus) {
    char key[16];
    snprintf(key, sizeof(key), "adc_%d", gpio);
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", key);
    cJSON_AddStringToObject(st, "mode", "adc");
    cJSON_AddNumberToObject(st, "gpio", gpio);
    cJSON_AddNumberToObject(st, "mv", mv);
    cJSON_AddNumberToObject(st, "raw", raw);
    cJSON_AddNumberToObject(st, "sample_ms", s_sample_ms[gpio]);
    cJSON_AddNumberToObject(st, "hysteresis_mv", s_hyst_mv[gpio]);
    cJSON_AddNumberToObject(st, "smooth", s_smooth[gpio]);
    state_set(key, st);
    if (to_bus) {
        event_bus_publish("io/adc", st);
    }
    cJSON_Delete(st);
}

int convert(int raw) {
    if (s_cali) {
        int mv = 0;
        if (adc_cali_raw_to_voltage(s_cali, raw, &mv) == ESP_OK) {
            return mv;
        }
    }
    return raw;
}

int sample(int gpio, bool allow_bus) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_used[gpio] || !s_adc1) {
        return -1;
    }
    int64_t acc = 0;
    int n = 0;
    int raw = 0;
    for (int i = 0; i < kOversample; ++i) {
        int one = 0;
        if (adc_oneshot_read(s_adc1, channel_for(gpio), &one) != ESP_OK) {
            continue;
        }
        acc += one;
        raw = one;
        n++;
    }
    if (n == 0) {
        return -1;
    }
    raw = static_cast<int>(acc / n);
    const int mv = convert(raw);
    const int sm = s_smooth[gpio];
    int filt;
    if (s_filt[gpio] < 0 || sm <= 0) {
        filt = mv;
    } else {
        filt = (sm * s_filt[gpio] + (100 - sm) * mv) / 100;
    }
    s_filt[gpio] = filt;
    const int hyst = s_hyst_mv[gpio] > 0 ? s_hyst_mv[gpio] : kHystDefault;
    const bool first = s_sent[gpio] < 0;
    const bool changed = first || abs(filt - s_sent[gpio]) >= hyst;
    if (allow_bus && changed) {
        s_sent[gpio] = filt;
    }
    publish(gpio, filt, raw, allow_bus && changed);
    return filt;
}

bool any_used() {
    for (int i = 0; i < kMaxGpio; ++i) {
        if (s_used[i]) {
            return true;
        }
    }
    return false;
}

int min_sample_ms() {
    int ms = kSampleMsMax;
    bool any = false;
    for (int i = 0; i < kMaxGpio; ++i) {
        if (!s_used[i]) {
            continue;
        }
        any = true;
        if (s_sample_ms[i] < ms) {
            ms = s_sample_ms[i];
        }
    }
    if (!any) {
        return kSampleMsDefault;
    }
    return clamp_int(ms, kSampleMsMin, kSampleMsMax);
}

void live_task(void*) {
    while (true) {
        const int wait = RuntimeStatus::instance().live_sinks() > 0 ? min_sample_ms() : 250;
        vTaskDelay(pdMS_TO_TICKS(wait));
        if (RuntimeStatus::instance().live_sinks() <= 0 || !any_used()) {
            continue;
        }
        const TickType_t now = xTaskGetTickCount();
        for (int i = 0; i < kMaxGpio; ++i) {
            if (!s_used[i]) {
                continue;
            }
            if (now < s_next[i]) {
                continue;
            }
            s_next[i] = now + pdMS_TO_TICKS(s_sample_ms[i]);
            sample(i, true);
        }
    }
}

}  // namespace

esp_err_t io_adc_init() {
    memset(s_used, 0, sizeof(s_used));
    for (int i = 0; i < kMaxGpio; ++i) {
        s_filt[i] = -1;
        s_sent[i] = -1;
        s_sample_ms[i] = kSampleMsDefault;
        s_hyst_mv[i] = kHystDefault;
        s_smooth[i] = kSmoothDefault;
        s_next[i] = 0;
    }
    adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id = ADC_UNIT_1,
        .clk_src = ADC_RTC_CLK_SRC_DEFAULT,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    esp_err_t err = adc_oneshot_new_unit(&unit_cfg, &s_adc1);
    if (err != ESP_OK) {
        return err;
    }
#if ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cali_cfg = {
        .unit_id = ADC_UNIT_1,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .default_vref = 1100,
    };
    if (adc_cali_create_scheme_line_fitting(&cali_cfg, &s_cali) != ESP_OK) {
        s_cali = nullptr;
        ESP_LOGW(TAG, "ADC calibration unavailable, returning raw");
    }
#else
    s_cali = nullptr;
#endif
    xTaskCreate(live_task, "adc_live", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "ADC1 oneshot ready");
    return ESP_OK;
}

esp_err_t io_adc_configure(int gpio, int sample_ms, int hysteresis_mv, int smooth, char* err,
                           size_t err_len) {
    if (!capability_allows(gpio, "adc", err, err_len)) {
        return ESP_ERR_INVALID_ARG;
    }
    char owner[16];
    snprintf(owner, sizeof(owner), "adc_%d", gpio);
    esp_err_t errc = resource_claim(gpio, owner, err, err_len);
    if (errc != ESP_OK) {
        return errc;
    }
    adc_oneshot_chan_cfg_t cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    errc = adc_oneshot_config_channel(s_adc1, channel_for(gpio), &cfg);
    if (errc != ESP_OK) {
        resource_release(gpio, owner);
        return errc;
    }
    s_used[gpio] = true;
    s_filt[gpio] = -1;
    s_sent[gpio] = -1;
    s_sample_ms[gpio] = clamp_int(sample_ms, kSampleMsMin, kSampleMsMax);
    s_hyst_mv[gpio] = clamp_int(hysteresis_mv, kHystMin, kHystMax);
    s_smooth[gpio] = clamp_int(smooth, kSmoothMin, kSmoothMax);
    s_next[gpio] = 0;
    sample(gpio, true);
    return ESP_OK;
}

int io_adc_read(int gpio) { return sample(gpio, RuntimeStatus::instance().live_sinks() > 0); }

void io_adc_refresh() {
    for (int i = 0; i < kMaxGpio; ++i) {
        if (s_used[i]) {
            sample(i, false);
        }
    }
}

esp_err_t io_adc_release(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_used[gpio]) {
        return ESP_OK;
    }
    s_used[gpio] = false;
    s_filt[gpio] = -1;
    s_sent[gpio] = -1;
    s_sample_ms[gpio] = kSampleMsDefault;
    s_hyst_mv[gpio] = kHystDefault;
    s_smooth[gpio] = kSmoothDefault;
    s_next[gpio] = 0;
    char owner[16];
    snprintf(owner, sizeof(owner), "adc_%d", gpio);
    resource_release(gpio, owner);
    state_clear(owner);
    return ESP_OK;
}

}  // namespace runtime
