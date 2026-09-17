#include "io_servo.hpp"

#include <cstdio>
#include <cstring>

#include "capability_manager.hpp"
#include "driver/ledc.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "resource_manager.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_servo";

namespace runtime {
namespace {

constexpr int kChannels = 8;
constexpr int kMaxGpio = 40;
constexpr int kHz = 50;
constexpr int kPeriodUs = 20000;
constexpr int kDutyMax = 8191;  // 13-bit
constexpr int kAngleMax = 180;
constexpr int kMinUsLo = 500;
constexpr int kMinUsHi = 1500;
constexpr int kMaxUsLo = 1500;
constexpr int kMaxUsHi = 2500;
constexpr int kMinUsDefault = 1000;
constexpr int kMaxUsDefault = 2000;

struct ServoSlot {
    bool used;
    int gpio;
    int angle;
    int min_us;
    int max_us;
    int pulse_us;
    int channel;
};

ServoSlot s_by_gpio[kMaxGpio];
bool s_ch_used[kChannels];
bool s_timer;

int clamp_int(int v, int lo, int hi) {
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

int alloc_channel() {
    for (int i = 0; i < kChannels; ++i) {
        if (!s_ch_used[i]) {
            s_ch_used[i] = true;
            return i;
        }
    }
    return -1;
}

int pulse_from_angle(int angle, int min_us, int max_us) {
    return min_us + (angle * (max_us - min_us)) / kAngleMax;
}

uint32_t duty_from_pulse(int pulse_us) {
    return static_cast<uint32_t>((pulse_us * kDutyMax) / kPeriodUs);
}

void owner_name(char* out, size_t n, int gpio) { snprintf(out, n, "servo_%d", gpio); }

void key_name(char* out, size_t n, int gpio) { snprintf(out, n, "servo_%d", gpio); }

esp_err_t ensure_timer() {
    if (s_timer) {
        return ESP_OK;
    }
    ledc_timer_config_t timer{};
    timer.speed_mode = LEDC_LOW_SPEED_MODE;
    timer.timer_num = LEDC_TIMER_0;
    timer.duty_resolution = LEDC_TIMER_13_BIT;
    timer.freq_hz = kHz;
    timer.clk_cfg = LEDC_AUTO_CLK;
    esp_err_t rc = ledc_timer_config(&timer);
    if (rc == ESP_OK) {
        s_timer = true;
    }
    return rc;
}

void publish(int gpio) {
    char key[16];
    key_name(key, sizeof(key), gpio);
    const ServoSlot& s = s_by_gpio[gpio];
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", key);
    cJSON_AddStringToObject(st, "mode", "servo");
    cJSON_AddNumberToObject(st, "gpio", gpio);
    cJSON_AddNumberToObject(st, "angle", s.angle);
    cJSON_AddNumberToObject(st, "pulse_us", s.pulse_us);
    cJSON_AddNumberToObject(st, "min_us", s.min_us);
    cJSON_AddNumberToObject(st, "max_us", s.max_us);
    cJSON_AddNumberToObject(st, "hz", kHz);
    state_set(key, st);
    event_bus_publish("io/servo", st);
    cJSON_Delete(st);
}

esp_err_t write_pulse(ServoSlot& s) {
    uint32_t duty = duty_from_pulse(s.pulse_us);
    ledc_channel_t ch = static_cast<ledc_channel_t>(s.channel);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, ch, duty);
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, ch);
}

}  // namespace

esp_err_t io_servo_init() {
    memset(s_by_gpio, 0, sizeof(s_by_gpio));
    memset(s_ch_used, 0, sizeof(s_ch_used));
    s_timer = false;
    ESP_LOGI(TAG, "init (8 ch, 50 Hz, independent of PWM)");
    return ESP_OK;
}

esp_err_t io_servo_configure(int gpio, int angle, int min_us, int max_us, char* err, size_t err_len) {
    if (!capability_allows(gpio, "servo", err, err_len)) {
        return ESP_ERR_INVALID_ARG;
    }
    min_us = clamp_int(min_us, kMinUsLo, kMinUsHi);
    max_us = clamp_int(max_us, kMaxUsLo, kMaxUsHi);
    if (max_us <= min_us) {
        min_us = kMinUsDefault;
        max_us = kMaxUsDefault;
    }
    angle = clamp_int(angle, 0, kAngleMax);
    char owner[16];
    owner_name(owner, sizeof(owner), gpio);
    esp_err_t errc = resource_claim(gpio, owner, err, err_len);
    if (errc != ESP_OK) {
        return errc;
    }
    int ch = s_by_gpio[gpio].used ? s_by_gpio[gpio].channel : alloc_channel();
    if (ch < 0) {
        if (err && err_len) {
            snprintf(err, err_len, "no servo channel free (max %d)", kChannels);
        }
        resource_release(gpio, owner);
        return ESP_ERR_NO_MEM;
    }
    errc = ensure_timer();
    if (errc != ESP_OK) {
        if (err && err_len) {
            snprintf(err, err_len, "servo timer %s", esp_err_to_name(errc));
        }
        if (!s_by_gpio[gpio].used) {
            s_ch_used[ch] = false;
            resource_release(gpio, owner);
        }
        return errc;
    }
    int pulse = pulse_from_angle(angle, min_us, max_us);
    ledc_channel_config_t chan{};
    chan.gpio_num = gpio;
    chan.speed_mode = LEDC_LOW_SPEED_MODE;
    chan.channel = static_cast<ledc_channel_t>(ch);
    chan.timer_sel = LEDC_TIMER_0;
    chan.duty = duty_from_pulse(pulse);
    chan.hpoint = 0;
    errc = ledc_channel_config(&chan);
    if (errc != ESP_OK) {
        if (err && err_len) {
            snprintf(err, err_len, "servo channel %s", esp_err_to_name(errc));
        }
        if (!s_by_gpio[gpio].used) {
            s_ch_used[ch] = false;
            resource_release(gpio, owner);
        }
        return errc;
    }
    s_by_gpio[gpio].used = true;
    s_by_gpio[gpio].gpio = gpio;
    s_by_gpio[gpio].angle = angle;
    s_by_gpio[gpio].min_us = min_us;
    s_by_gpio[gpio].max_us = max_us;
    s_by_gpio[gpio].pulse_us = pulse;
    s_by_gpio[gpio].channel = ch;
    publish(gpio);
    return ESP_OK;
}

esp_err_t io_servo_set(int gpio, int angle) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_by_gpio[gpio].used) {
        return ESP_ERR_INVALID_STATE;
    }
    ServoSlot& s = s_by_gpio[gpio];
    s.angle = clamp_int(angle, 0, kAngleMax);
    s.pulse_us = pulse_from_angle(s.angle, s.min_us, s.max_us);
    esp_err_t rc = write_pulse(s);
    if (rc != ESP_OK) {
        return rc;
    }
    publish(gpio);
    return ESP_OK;
}

int io_servo_get(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_by_gpio[gpio].used) {
        return -1;
    }
    return s_by_gpio[gpio].angle;
}

esp_err_t io_servo_release(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio || !s_by_gpio[gpio].used) {
        return ESP_OK;
    }
    ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s_by_gpio[gpio].channel), 0);
    s_ch_used[s_by_gpio[gpio].channel] = false;
    s_by_gpio[gpio] = {};
    char owner[16];
    owner_name(owner, sizeof(owner), gpio);
    resource_release(gpio, owner);
    char key[16];
    key_name(key, sizeof(key), gpio);
    state_clear(key);
    return ESP_OK;
}

}  // namespace runtime
