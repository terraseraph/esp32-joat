#include "io_adc.hpp"

#include <cstdio>
#include <cstring>

#include "capability_manager.hpp"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "resource_manager.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_adc";

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;
adc_oneshot_unit_handle_t s_adc1;
adc_cali_handle_t s_cali;
bool s_used[kMaxGpio];

adc_channel_t channel_for(int gpio) {
    const PinInfo* p = capability_pin(gpio);
    if (!p || (p->flags & PIN_ADC1) == 0) {
        return static_cast<adc_channel_t>(-1);
    }
    return static_cast<adc_channel_t>(p->adc_channel);
}

void publish(int gpio, int mv) {
    char key[16];
    snprintf(key, sizeof(key), "adc_%d", gpio);
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", key);
    cJSON_AddStringToObject(st, "mode", "adc");
    cJSON_AddNumberToObject(st, "gpio", gpio);
    cJSON_AddNumberToObject(st, "mv", mv);
    state_set(key, st);
    cJSON_Delete(st);
}

}  // namespace

esp_err_t io_adc_init() {
    memset(s_used, 0, sizeof(s_used));
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
    ESP_LOGI(TAG, "ADC1 oneshot ready");
    return ESP_OK;
}

esp_err_t io_adc_configure(int gpio, char* err, size_t err_len) {
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
    publish(gpio, io_adc_read(gpio));
    return ESP_OK;
}

int io_adc_read(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_used[gpio] || !s_adc1) {
        return -1;
    }
    int raw = 0;
    if (adc_oneshot_read(s_adc1, channel_for(gpio), &raw) != ESP_OK) {
        return -1;
    }
    if (s_cali) {
        int mv = 0;
        if (adc_cali_raw_to_voltage(s_cali, raw, &mv) == ESP_OK) {
            publish(gpio, mv);
            return mv;
        }
    }
    publish(gpio, raw);
    return raw;
}

esp_err_t io_adc_release(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_used[gpio]) {
        return ESP_OK;
    }
    s_used[gpio] = false;
    char owner[16];
    snprintf(owner, sizeof(owner), "adc_%d", gpio);
    resource_release(gpio, owner);
    return ESP_OK;
}

}  // namespace runtime
