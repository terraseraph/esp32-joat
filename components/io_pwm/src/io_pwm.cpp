#include "io_pwm.hpp"

#include <cstdio>
#include <cstring>

#include "capability_manager.hpp"
#include "driver/ledc.h"
#include "event_bus.hpp"
#include "esp_log.h"
#include "resource_manager.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_pwm";

namespace runtime {
namespace {

constexpr int kChannels = 8;
constexpr int kMaxGpio = 40;

struct PwmSlot {
    bool used;
    int gpio;
    int hz;
    int duty;  // 0-1000
    int channel;
};

PwmSlot s_by_gpio[kMaxGpio];
bool s_ch_used[kChannels];

int alloc_channel() {
    for (int i = 0; i < kChannels; ++i) {
        if (!s_ch_used[i]) {
            s_ch_used[i] = true;
            return i;
        }
    }
    return -1;
}

void publish(int gpio) {
    char key[16];
    snprintf(key, sizeof(key), "pwm_%d", gpio);
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", key);
    cJSON_AddStringToObject(st, "mode", "pwm");
    cJSON_AddNumberToObject(st, "gpio", gpio);
    cJSON_AddNumberToObject(st, "hz", s_by_gpio[gpio].hz);
    cJSON_AddNumberToObject(st, "duty", s_by_gpio[gpio].duty);
    state_set(key, st);
    event_bus_publish("io/pwm", st);
    cJSON_Delete(st);
}

}  // namespace

esp_err_t io_pwm_init() {
    memset(s_by_gpio, 0, sizeof(s_by_gpio));
    memset(s_ch_used, 0, sizeof(s_ch_used));
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t io_pwm_configure(int gpio, int hz, int duty_permille, char* err, size_t err_len) {
    if (!capability_allows(gpio, "pwm", err, err_len)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (hz < 50) {
        hz = 50;
    }
    if (hz > 20000) {
        hz = 20000;
    }
    if (duty_permille < 0) {
        duty_permille = 0;
    }
    if (duty_permille > 1000) {
        duty_permille = 1000;
    }
    char owner[16];
    snprintf(owner, sizeof(owner), "pwm_%d", gpio);
    esp_err_t errc = resource_claim(gpio, owner, err, err_len);
    if (errc != ESP_OK) {
        return errc;
    }
    int ch = s_by_gpio[gpio].used ? s_by_gpio[gpio].channel : alloc_channel();
    if (ch < 0) {
        if (err && err_len) {
            snprintf(err, err_len, "no PWM channel free");
        }
        resource_release(gpio, owner);
        return ESP_ERR_NO_MEM;
    }

    ledc_timer_config_t timer{};
    timer.speed_mode = LEDC_HIGH_SPEED_MODE;
    timer.timer_num = LEDC_TIMER_0;
    timer.duty_resolution = LEDC_TIMER_10_BIT;
    timer.freq_hz = hz;
    timer.clk_cfg = LEDC_AUTO_CLK;
    errc = ledc_timer_config(&timer);
    if (errc != ESP_OK) {
        return errc;
    }

    ledc_channel_config_t chan{};
    chan.gpio_num = gpio;
    chan.speed_mode = LEDC_HIGH_SPEED_MODE;
    chan.channel = static_cast<ledc_channel_t>(ch);
    chan.timer_sel = LEDC_TIMER_0;
    chan.duty = (duty_permille * 1023) / 1000;
    chan.hpoint = 0;
    errc = ledc_channel_config(&chan);
    if (errc != ESP_OK) {
        return errc;
    }

    s_by_gpio[gpio].used = true;
    s_by_gpio[gpio].gpio = gpio;
    s_by_gpio[gpio].hz = hz;
    s_by_gpio[gpio].duty = duty_permille;
    s_by_gpio[gpio].channel = ch;
    publish(gpio);
    return ESP_OK;
}

esp_err_t io_pwm_set(int gpio, int duty_permille) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_by_gpio[gpio].used) {
        return ESP_ERR_INVALID_STATE;
    }
    if (duty_permille < 0) {
        duty_permille = 0;
    }
    if (duty_permille > 1000) {
        duty_permille = 1000;
    }
    uint32_t duty = (duty_permille * 1023) / 1000;
    ledc_set_duty(LEDC_HIGH_SPEED_MODE, static_cast<ledc_channel_t>(s_by_gpio[gpio].channel), duty);
    ledc_update_duty(LEDC_HIGH_SPEED_MODE, static_cast<ledc_channel_t>(s_by_gpio[gpio].channel));
    s_by_gpio[gpio].duty = duty_permille;
    publish(gpio);
    return ESP_OK;
}

int io_pwm_get(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_by_gpio[gpio].used) {
        return -1;
    }
    return s_by_gpio[gpio].duty;
}

esp_err_t io_pwm_release(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_by_gpio[gpio].used) {
        return ESP_OK;
    }
    ledc_stop(LEDC_HIGH_SPEED_MODE, static_cast<ledc_channel_t>(s_by_gpio[gpio].channel), 0);
    s_ch_used[s_by_gpio[gpio].channel] = false;
    s_by_gpio[gpio] = {};
    char owner[16];
    snprintf(owner, sizeof(owner), "pwm_%d", gpio);
    resource_release(gpio, owner);
    return ESP_OK;
}

}  // namespace runtime
