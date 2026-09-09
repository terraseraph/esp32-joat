#include "event_bus.hpp"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* TAG = "event_bus";

namespace runtime {
namespace {

constexpr int kMaxSubs = 12;

struct Sub {
    char prefix[48];
    event_cb_t cb;
    void* ctx;
};

SemaphoreHandle_t s_mu;
Sub s_subs[kMaxSubs];
int s_count;

}  // namespace

esp_err_t event_bus_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    s_count = 0;
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t event_bus_subscribe(const char* topic_prefix, event_cb_t cb, void* ctx) {
    if (!topic_prefix || !cb) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (s_count >= kMaxSubs) {
        xSemaphoreGive(s_mu);
        return ESP_ERR_NO_MEM;
    }
    Sub& s = s_subs[s_count++];
    snprintf(s.prefix, sizeof(s.prefix), "%s", topic_prefix);
    s.cb = cb;
    s.ctx = ctx;
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

esp_err_t event_bus_publish(const char* topic, cJSON* payload) {
    if (!topic) {
        return ESP_ERR_INVALID_ARG;
    }
    Sub local[kMaxSubs];
    int n = 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    n = s_count;
    memcpy(local, s_subs, sizeof(Sub) * n);
    xSemaphoreGive(s_mu);
    for (int i = 0; i < n; ++i) {
        if (strncmp(topic, local[i].prefix, strlen(local[i].prefix)) == 0) {
            local[i].cb(topic, payload, local[i].ctx);
        }
    }
    return ESP_OK;
}

}  // namespace runtime
