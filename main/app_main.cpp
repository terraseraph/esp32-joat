#include "esp_attr.h"
#include "cJSON.h"
#include "board_profiles.hpp"
#include "capability_manager.hpp"
#include "command_router.hpp"
#include "config_manager.hpp"
#include "device_identity.hpp"
#include "driver/gpio.h"
#include "esp_console.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_system.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "io_adc.hpp"
#include "io_gpio.hpp"
#include "io_pwm.hpp"
#include "io_rules.hpp"
#include "io_servo.hpp"
#include "logging_service.hpp"
#include "mod_bme280.hpp"
#include "mod_mfrc522.hpp"
#include "module_manager.hpp"
#include "mqtt_manager.hpp"
#include "network_manager.hpp"
#include "nvs_flash.h"
#include "ota_manager.hpp"
#include "provisioning.hpp"
#include "resource_manager.hpp"
#include "runtime_status.hpp"
#include "runtime_version.hpp"
#include "security.hpp"
#include "sdkconfig.h"
#include "serial_session.hpp"
#include "state_registry.hpp"
#include "telemetry.hpp"
#include "web_server.hpp"

#include <cstdio>
#include <cstring>

static const char* TAG = "main";

static RTC_NOINIT_ATTR uint32_t s_rtc_magic;
static RTC_NOINIT_ATTR uint32_t s_rtc_crash;
static constexpr uint32_t kRtcMagic = 0xDEE5B007;

static void status_led_task(void*) {
    const auto& board = runtime::board_profile();
    gpio_config_t io{};
    io.pin_bit_mask = 1ULL << board.status_led_gpio;
    io.mode = GPIO_MODE_OUTPUT;
    gpio_config(&io);
    uint32_t tick = 0;
    while (true) {
        auto state = runtime::RuntimeStatus::instance().boot_state();
        int on = 1;
        if (runtime::RuntimeStatus::instance().safe_mode()) {
            on = (tick / 2) % 4 < 2 ? 1 : 0;  // double-ish blink
        } else if (state == runtime::BootState::kHealthy && runtime::sta_connected()) {
            on = 1;
        } else if (state == runtime::BootState::kProvisioning ||
                   runtime::network_state() == runtime::NetState::kApOnly) {
            on = (tick / 5) % 2;  // slow
        } else {
            on = tick % 2;  // fast = connecting
        }
        gpio_set_level(static_cast<gpio_num_t>(board.status_led_gpio),
                       board.status_led_active_high ? on : !on);
        tick++;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

static void boot_button_task(void*) {
    const int pin = runtime::board_profile().boot_gpio;
    gpio_config_t io{};
    io.pin_bit_mask = 1ULL << pin;
    io.mode = GPIO_MODE_INPUT;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    gpio_config(&io);
    TickType_t pressed_at = 0;
    bool down = false;
    int last_action = 0;
    ESP_LOGW(TAG, "Hold BOOT (GPIO%d) AFTER boot for recovery — holding during reset enters download mode",
             pin);
    while (true) {
        int level = gpio_get_level(static_cast<gpio_num_t>(pin));
        if (level == 0 && !down) {
            down = true;
            pressed_at = xTaskGetTickCount();
            last_action = 0;
        } else if (level == 0 && down) {
            uint32_t ms = (xTaskGetTickCount() - pressed_at) * portTICK_PERIOD_MS;
            if (ms >= CONFIG_RUNTIME_BOOT_FACTORY_MS && last_action < 3) {
                ESP_LOGW(TAG, "BOOT hold %ums: factory reset", (unsigned)ms);
                last_action = 3;
                runtime::config_factory_reset();
                esp_restart();
            } else if (ms >= CONFIG_RUNTIME_BOOT_PROVISION_MS && last_action < 2) {
                ESP_LOGW(TAG, "BOOT hold %ums: clear Wi-Fi", (unsigned)ms);
                last_action = 2;
                runtime::network_clear_wifi();
                runtime::provisioning_start_dns();
            } else if (ms >= CONFIG_RUNTIME_BOOT_RECOVERY_MS && last_action < 1) {
                ESP_LOGW(TAG, "BOOT hold %ums: recovery AP", (unsigned)ms);
                last_action = 1;
                runtime::network_enable_recovery_ap();
                runtime::provisioning_start_dns();
            }
        } else {
            down = false;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

static void recovery_watch_task(void*) {
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(2000));
        if (!runtime::config_has_wifi()) {
            continue;
        }
        if (runtime::sta_connected()) {
            continue;
        }
        if (runtime::RuntimeStatus::instance().uptime_s() * 1000U >=
            static_cast<uint32_t>(CONFIG_RUNTIME_WIFI_FAIL_AP_MS)) {
            if (runtime::network_state() != runtime::NetState::kApOnly &&
                runtime::network_state() != runtime::NetState::kApStaRecovery) {
                ESP_LOGW(TAG, "STA unreachable — enabling recovery SoftAP");
                runtime::network_enable_recovery_ap();
                runtime::provisioning_start_dns();
            }
        }
    }
}

static void sntp_task(void*) {
    while (!runtime::sta_connected()) {
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    if (esp_netif_sntp_init(&cfg) == ESP_OK) {
        ESP_LOGI(TAG, "SNTP started");
    }
    vTaskDelete(nullptr);
}

static void healthy_clear_task(void*) {
    vTaskDelay(pdMS_TO_TICKS(CONFIG_RUNTIME_HEALTHY_CLEAR_MS));
    if (!runtime::RuntimeStatus::instance().safe_mode()) {
        s_rtc_crash = 0;
        ESP_LOGI(TAG, "crash counter cleared");
    }
    vTaskDelete(nullptr);
}

static int cmd_status(int, char**) {
    printf("name=%s id=%s host=%s ip=%s state=%s heap=%u\n", runtime::device_name(),
           runtime::device_id(), runtime::hostname(), runtime::sta_ip(),
           runtime::network_state_name(), (unsigned)esp_get_free_heap_size());
    return 0;
}

static int cmd_ota(int, char**) {
    cJSON* o = runtime::ota_status_json();
    char* printed = o ? cJSON_PrintUnformatted(o) : nullptr;
    if (printed) {
        printf("%s\n", printed);
        cJSON_free(printed);
    }
    cJSON_Delete(o);
    return 0;
}

static int cmd_reboot(int, char**) {
    esp_restart();
    return 0;
}

static int cmd_factory(int, char**) {
    runtime::config_factory_reset();
    esp_restart();
    return 0;
}

static int cmd_wifi_clear(int, char**) {
    runtime::network_clear_wifi();
    runtime::provisioning_start_dns();
    return 0;
}

static int cmd_recovery(int, char**) {
    runtime::network_enable_recovery_ap();
    runtime::provisioning_start_dns();
    return 0;
}

static int cmd_name(int argc, char** argv) {
    if (argc >= 2 && argv[1] && argv[1][0]) {
        if (strlen(argv[1]) > 31) {
            printf("name too long (max 31)\n");
            return 1;
        }
        runtime::set_device_name(argv[1]);
    }
    printf("name=%s id=%s host=%s\n", runtime::device_name(), runtime::device_id(),
           runtime::hostname());
    return 0;
}

static void start_console() {
    esp_console_config_t cfg = ESP_CONSOLE_CONFIG_DEFAULT();
    cfg.max_cmdline_length = 512;
    ESP_ERROR_CHECK(esp_console_init(&cfg));
    esp_console_register_help_command();
    const esp_console_cmd_t cmds[] = {
        {.command = "status", .help = "Print identity and network", .func = cmd_status},
        {.command = "ota", .help = "Print OTA slot status", .func = cmd_ota},
        {.command = "reboot", .help = "Reboot", .func = cmd_reboot},
        {.command = "factory_reset", .help = "Erase user config and reboot", .func = cmd_factory},
        {.command = "wifi_clear", .help = "Drop Wi-Fi creds, start AP", .func = cmd_wifi_clear},
        {.command = "recovery_ap", .help = "Enable recovery SoftAP", .func = cmd_recovery},
        {.command = "name", .help = "Show or set the human device name (NVS)", .hint = "[new_name]", .func = cmd_name},
    };
    for (const auto& c : cmds) {
        esp_console_cmd_register(&c);
    }
    ESP_ERROR_CHECK(runtime::serial_session_init());
    ESP_ERROR_CHECK(runtime::serial_session_start());
}

extern "C" void app_main(void) {
    auto& rt = runtime::RuntimeStatus::instance();
    rt.set_boot_state(runtime::BootState::kBoot);

    ESP_ERROR_CHECK(runtime::logging_init());
    ESP_LOGI(TAG, "=== %s %s (IDF pin %s) ===", RUNTIME_NAME, RUNTIME_VERSION, RUNTIME_IDF_PINNED);

    rt.set_boot_state(runtime::BootState::kDiagnostics);
    if (s_rtc_magic != kRtcMagic) {
        s_rtc_magic = kRtcMagic;
        s_rtc_crash = 0;
    }
    esp_reset_reason_t rr = esp_reset_reason();
    if (rr == ESP_RST_POWERON) {
        s_rtc_crash = 1;
    } else {
        s_rtc_crash++;
    }
    rt.set_boot_count(s_rtc_crash);
    ESP_LOGI(TAG, "reset_reason=%d boot_count=%u heap=%u", (int)rr, (unsigned)s_rtc_crash,
             (unsigned)esp_get_free_heap_size());
    if (s_rtc_crash > CONFIG_RUNTIME_CRASH_LOOP_THRESHOLD) {
        rt.set_safe_mode(true, "crash loop — I/O config skipped");
        ESP_LOGE(TAG, "SAFE MODE: crash loop (%u)", (unsigned)s_rtc_crash);
    }

    rt.set_boot_state(runtime::BootState::kConfig);
    ESP_ERROR_CHECK(runtime::config_init());

    rt.set_boot_state(runtime::BootState::kIdentity);
    ESP_ERROR_CHECK(runtime::identity_init());
    ESP_ERROR_CHECK(runtime::security_init());
    ESP_LOGI(TAG, "device_id=%s hostname=%s.local", runtime::device_id(), runtime::hostname());
    ESP_LOGI(TAG, "recovery SSID=%s  auth=%s", runtime::ap_ssid(),
             runtime::ap_is_open() ? "open" : "WPA2");
    runtime::memory_boot_mark("boot");

    ESP_ERROR_CHECK(runtime::event_bus_init());
    ESP_ERROR_CHECK(runtime::state_registry_init());

    rt.set_boot_state(runtime::BootState::kCapability);
    ESP_ERROR_CHECK(runtime::capability_init());
    ESP_ERROR_CHECK(runtime::board_profiles_init());
    ESP_ERROR_CHECK(runtime::resource_init());

    rt.set_boot_state(runtime::BootState::kSafePins);
    ESP_ERROR_CHECK(runtime::io_gpio_init());
    ESP_ERROR_CHECK(runtime::io_pwm_init());
    ESP_ERROR_CHECK(runtime::io_servo_init());
    ESP_ERROR_CHECK(runtime::io_adc_init());
    ESP_ERROR_CHECK(runtime::io_rules_init());
    runtime::io_gpio_safe_defaults();

    ESP_ERROR_CHECK(runtime::command_router_init());
    ESP_ERROR_CHECK(runtime::module_manager_init());
    ESP_ERROR_CHECK(runtime::mod_mfrc522_init());
    ESP_ERROR_CHECK(runtime::mod_bme280_init());
    ESP_ERROR_CHECK(runtime::ota_init());
    ESP_ERROR_CHECK(runtime::telemetry_init());
    ESP_ERROR_CHECK(runtime::mqtt_init());
    ESP_ERROR_CHECK(runtime::provisioning_init());

    rt.set_boot_state(runtime::BootState::kNetwork);
    ESP_ERROR_CHECK(runtime::network_init());
    ESP_ERROR_CHECK(runtime::network_start());
    runtime::memory_boot_mark("wifi");
    if (!runtime::config_has_wifi() || rt.safe_mode()) {
        rt.set_boot_state(runtime::BootState::kProvisioning);
        runtime::provisioning_start_dns();
        runtime::network_enable_recovery_ap();
    }

    rt.set_boot_state(runtime::BootState::kManagement);
    ESP_ERROR_CHECK(runtime::web_server_start());
    runtime::memory_boot_mark("http");

    rt.set_boot_state(runtime::BootState::kMqtt);
    ESP_ERROR_CHECK(runtime::mqtt_start());
    runtime::memory_boot_mark("mqtt");

    rt.set_boot_state(runtime::BootState::kComponents);
    runtime::command_apply_saved_io(true);
    runtime::command_apply_saved_modules(true);
    runtime::memory_boot_mark("modules");
    runtime::command_apply_saved_rules(true);

    runtime::telemetry_start_task();
    xTaskCreate(status_led_task, "led", 2048, nullptr, 3, nullptr);
    xTaskCreate(boot_button_task, "boot_btn", 3072, nullptr, 5, nullptr);
    xTaskCreate(recovery_watch_task, "net_watch", 3072, nullptr, 4, nullptr);
    xTaskCreate(sntp_task, "sntp", 3072, nullptr, 3, nullptr);
    xTaskCreate(healthy_clear_task, "healthy", 2048, nullptr, 3, nullptr);
    start_console();

    rt.mark_healthy();
    {
        esp_err_t ota_rc = runtime::ota_mark_valid(rt.safe_mode());
        if (ota_rc != ESP_OK) {
            ESP_LOGE(TAG, "ota confirm failed: %s", esp_err_to_name(ota_rc));
        }
    }
    ESP_LOGI(TAG, "runtime healthy (safe_mode=%d) heap=%u", rt.safe_mode() ? 1 : 0,
             (unsigned)esp_get_free_heap_size());
}
