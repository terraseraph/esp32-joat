#pragma once

#include <cstdint>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace runtime {

enum class BootState : uint8_t {
    kBoot = 0,
    kDiagnostics,
    kIdentity,
    kConfig,
    kCapability,
    kSafePins,
    kNetwork,
    kProvisioning,
    kManagement,
    kMqtt,
    kComponents,
    kHealthy,
    kSafeMode,
};

const char* boot_state_name(BootState state);

class RuntimeStatus {
public:
    static RuntimeStatus& instance();

    void set_boot_state(BootState state);
    BootState boot_state() const;
    void set_safe_mode(bool enabled, const char* reason);
    bool safe_mode() const;
    const char* safe_mode_reason() const;
    void mark_healthy();
    bool healthy() const;
    uint32_t boot_count() const;
    void set_boot_count(uint32_t count);
    uint32_t uptime_s() const;
    /** Open UI WebSockets. WebSocket frames only when this is > 0. */
    void set_live_viewers(int n);
    int live_viewers() const;
    void set_live_mqtt(bool on);
    bool live_mqtt() const;
    void set_live_serial(bool on);
    bool live_serial() const;
    /** WS count + MQTT connected + serial session. ADC live-sample when > 0. */
    int live_sinks() const;

private:
    RuntimeStatus();
    mutable SemaphoreHandle_t mu_;
    BootState boot_state_;
    bool safe_mode_;
    bool healthy_;
    uint32_t boot_count_;
    int live_viewers_;
    bool live_mqtt_;
    bool live_serial_;
    char reason_[64];
};

}  // namespace runtime
