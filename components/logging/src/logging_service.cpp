#include "logging_service.hpp"

#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* TAG = "logsvc";

namespace runtime {
namespace {

constexpr int kLines = 80;
constexpr int kLineLen = 160;

char s_lines[kLines][kLineLen];
int s_head;
int s_count;
SemaphoreHandle_t s_mu;
vprintf_like_t s_prev;

int ring_vprintf(const char* fmt, va_list args) {
    char buf[kLineLen];
    int n = vsnprintf(buf, sizeof(buf), fmt, args);
    logging_capture(buf);
    if (s_prev) {
        va_list copy;
        va_copy(copy, args);
        s_prev(fmt, copy);
        va_end(copy);
    }
    return n;
}

}  // namespace

esp_err_t logging_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    s_head = 0;
    s_count = 0;
    s_prev = esp_log_set_vprintf(ring_vprintf);
    ESP_LOGI(TAG, "ring buffer %d x %d", kLines, kLineLen);
    return ESP_OK;
}

void logging_capture(const char* line) {
    if (!line || !s_mu) {
        return;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    snprintf(s_lines[s_head], kLineLen, "%s", line);
    s_head = (s_head + 1) % kLines;
    if (s_count < kLines) {
        s_count++;
    }
    xSemaphoreGive(s_mu);
}

cJSON* logging_dump() {
    cJSON* arr = cJSON_CreateArray();
    if (!arr || !s_mu) {
        return arr;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    int start = (s_count == kLines) ? s_head : 0;
    int n = s_count;
    for (int i = 0; i < n; ++i) {
        int idx = (start + i) % kLines;
        cJSON_AddItemToArray(arr, cJSON_CreateString(s_lines[idx]));
    }
    xSemaphoreGive(s_mu);
    return arr;
}

int logging_count() { return s_count; }

}  // namespace runtime
