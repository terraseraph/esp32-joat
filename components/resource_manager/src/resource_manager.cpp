#include "resource_manager.hpp"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* TAG = "resource";

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;
char s_owner[kMaxGpio][24];
SemaphoreHandle_t s_mu;

}  // namespace

esp_err_t resource_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    memset(s_owner, 0, sizeof(s_owner));
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t resource_claim(int gpio, const char* owner, char* err, size_t err_len) {
    if (gpio < 0 || gpio >= kMaxGpio || !owner) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (s_owner[gpio][0] && strcmp(s_owner[gpio], owner) != 0) {
        if (err && err_len) {
            snprintf(err, err_len, "gpio %d owned by %s", gpio, s_owner[gpio]);
        }
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_STATE;
    }
    snprintf(s_owner[gpio], sizeof(s_owner[gpio]), "%s", owner);
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

esp_err_t resource_release(int gpio, const char* owner) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (s_owner[gpio][0] && owner && strcmp(s_owner[gpio], owner) != 0) {
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_STATE;
    }
    s_owner[gpio][0] = '\0';
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

const char* resource_owner(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return "";
    }
    return s_owner[gpio];
}

void resource_release_all() {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    memset(s_owner, 0, sizeof(s_owner));
    xSemaphoreGive(s_mu);
}

}  // namespace runtime
