#include "runtime_status.hpp"

#include <cstdio>

#include "esp_timer.h"

namespace runtime {

const char* boot_state_name(BootState state) {
    switch (state) {
        case BootState::kBoot:
            return "boot";
        case BootState::kDiagnostics:
            return "diagnostics";
        case BootState::kIdentity:
            return "identity";
        case BootState::kConfig:
            return "config";
        case BootState::kCapability:
            return "capability";
        case BootState::kSafePins:
            return "safe_pins";
        case BootState::kNetwork:
            return "network";
        case BootState::kProvisioning:
            return "provisioning";
        case BootState::kManagement:
            return "management";
        case BootState::kMqtt:
            return "mqtt";
        case BootState::kComponents:
            return "components";
        case BootState::kHealthy:
            return "healthy";
        case BootState::kSafeMode:
            return "safe_mode";
        default:
            return "unknown";
    }
}

RuntimeStatus& RuntimeStatus::instance() {
    static RuntimeStatus s;
    return s;
}

RuntimeStatus::RuntimeStatus()
    : mu_(xSemaphoreCreateMutex()),
      boot_state_(BootState::kBoot),
      safe_mode_(false),
      healthy_(false),
      boot_count_(0),
      live_viewers_(0),
      live_mqtt_(false),
      live_serial_(false),
      live_rules_(false) {
    reason_[0] = '\0';
}

void RuntimeStatus::set_boot_state(BootState state) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    boot_state_ = state;
    xSemaphoreGive(mu_);
}

BootState RuntimeStatus::boot_state() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    BootState s = boot_state_;
    xSemaphoreGive(mu_);
    return s;
}

void RuntimeStatus::set_safe_mode(bool enabled, const char* reason) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    safe_mode_ = enabled;
    if (enabled) {
        boot_state_ = BootState::kSafeMode;
        if (reason) {
            snprintf(reason_, sizeof(reason_), "%s", reason);
        }
    } else {
        reason_[0] = '\0';
    }
    xSemaphoreGive(mu_);
}

bool RuntimeStatus::safe_mode() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    bool v = safe_mode_;
    xSemaphoreGive(mu_);
    return v;
}

const char* RuntimeStatus::safe_mode_reason() const {
    return reason_;
}

void RuntimeStatus::mark_healthy() {
    xSemaphoreTake(mu_, portMAX_DELAY);
    healthy_ = true;
    if (!safe_mode_) {
        boot_state_ = BootState::kHealthy;
    }
    xSemaphoreGive(mu_);
}

bool RuntimeStatus::healthy() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    bool v = healthy_;
    xSemaphoreGive(mu_);
    return v;
}

uint32_t RuntimeStatus::boot_count() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    uint32_t v = boot_count_;
    xSemaphoreGive(mu_);
    return v;
}

void RuntimeStatus::set_boot_count(uint32_t count) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    boot_count_ = count;
    xSemaphoreGive(mu_);
}

uint32_t RuntimeStatus::uptime_s() const {
    return static_cast<uint32_t>(esp_timer_get_time() / 1000000ULL);
}

void RuntimeStatus::set_live_viewers(int n) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    live_viewers_ = n < 0 ? 0 : n;
    xSemaphoreGive(mu_);
}

int RuntimeStatus::live_viewers() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    int v = live_viewers_;
    xSemaphoreGive(mu_);
    return v;
}

void RuntimeStatus::set_live_mqtt(bool on) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    live_mqtt_ = on;
    xSemaphoreGive(mu_);
}

bool RuntimeStatus::live_mqtt() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    bool v = live_mqtt_;
    xSemaphoreGive(mu_);
    return v;
}

void RuntimeStatus::set_live_serial(bool on) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    live_serial_ = on;
    xSemaphoreGive(mu_);
}

bool RuntimeStatus::live_serial() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    bool v = live_serial_;
    xSemaphoreGive(mu_);
    return v;
}

void RuntimeStatus::set_live_rules(bool on) {
    xSemaphoreTake(mu_, portMAX_DELAY);
    live_rules_ = on;
    xSemaphoreGive(mu_);
}

bool RuntimeStatus::live_rules() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    bool v = live_rules_;
    xSemaphoreGive(mu_);
    return v;
}

int RuntimeStatus::live_sinks() const {
    xSemaphoreTake(mu_, portMAX_DELAY);
    int n = live_viewers_;
    if (live_mqtt_) {
        n++;
    }
    if (live_serial_) {
        n++;
    }
    if (live_rules_) {
        n++;
    }
    xSemaphoreGive(mu_);
    return n;
}

}  // namespace runtime
