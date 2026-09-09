#include "security.hpp"

#include <cstdio>
#include <cstring>

#include "config_manager.hpp"
#include "esp_log.h"

static const char* TAG = "security";

namespace runtime {
namespace {

char s_ap_pass[65];

void trim_copy(char* dst, size_t dst_len, const char* src) {
    dst[0] = '\0';
    if (!src || dst_len == 0) {
        return;
    }
    while (*src == ' ' || *src == '\t') {
        src++;
    }
    size_t n = strlen(src);
    while (n > 0 && (src[n - 1] == ' ' || src[n - 1] == '\t')) {
        n--;
    }
    if (n >= dst_len) {
        n = dst_len - 1;
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
}

}  // namespace

esp_err_t security_init() {
    s_ap_pass[0] = '\0';
    size_t n = sizeof(s_ap_pass);
    if (config_get_str("security", "ap_password", s_ap_pass, &n) != ESP_OK) {
        s_ap_pass[0] = '\0';
    }
    ESP_LOGI(TAG, "recovery AP auth=%s", s_ap_pass[0] ? "WPA2" : "open");
    return ESP_OK;
}

const char* ap_password() { return s_ap_pass; }

bool ap_is_open() { return s_ap_pass[0] == '\0'; }

esp_err_t set_ap_password(const char* pass) {
    char next[65];
    trim_copy(next, sizeof(next), pass);
    const size_t n = strlen(next);
    if (n == 0) {
        s_ap_pass[0] = '\0';
        esp_err_t err = config_erase_key("security", "ap_password");
        ESP_LOGI(TAG, "recovery AP set to open");
        return err;
    }
    if (n < 8 || n > 63) {
        return ESP_ERR_INVALID_ARG;
    }
    memcpy(s_ap_pass, next, n + 1);
    esp_err_t err = config_set_str("security", "ap_password", s_ap_pass);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "recovery AP set to WPA2");
    }
    return err;
}

}  // namespace runtime
