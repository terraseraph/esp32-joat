#include "serial_session.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cJSON.h"
#include "command_router.hpp"
#include "driver/uart.h"
#include "esp_console.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "json_util.hpp"
#include "runtime_status.hpp"
#include "sdkconfig.h"

static const char* TAG = "serial";

namespace runtime {
namespace {

constexpr uart_port_t kPort = static_cast<uart_port_t>(CONFIG_ESP_CONSOLE_UART_NUM);
constexpr int kLineMax = 512;
constexpr int kTxQueueLen = 16;
constexpr uint32_t kIdleMs = 600000;

QueueHandle_t s_txq;
TickType_t s_last_activity;

void bump_activity() { s_last_activity = xTaskGetTickCount(); }

void uart_line(const char* s) {
    if (!s) {
        return;
    }
    uart_write_bytes(kPort, s, strlen(s));
    uart_write_bytes(kPort, "\n", 1);
}

void enqueue_line(char* line) {
    if (!line) {
        return;
    }
    if (!s_txq || xQueueSend(s_txq, &line, 0) != pdTRUE) {
        free(line);
        return;
    }
    bump_activity();
}

void on_io(const char* bus_topic, cJSON* payload, void*) {
    if (!bus_topic || !RuntimeStatus::instance().live_serial()) {
        return;
    }
    cJSON* wrap = cJSON_CreateObject();
    cJSON_AddStringToObject(wrap, "topic", bus_topic);
    if (payload) {
        cJSON_AddItemToObject(wrap, "data", cJSON_Duplicate(payload, 1));
    }
    char* printed = cJSON_PrintUnformatted(wrap);
    cJSON_Delete(wrap);
    if (!printed) {
        return;
    }
    size_t n = strlen(printed) + 1;
    char* copy = static_cast<char*>(malloc(n));
    if (!copy) {
        cJSON_free(printed);
        return;
    }
    memcpy(copy, printed, n);
    cJSON_free(printed);
    enqueue_line(copy);
}

void tx_task(void*) {
    char* line = nullptr;
    while (xQueueReceive(s_txq, &line, portMAX_DELAY) == pdTRUE) {
        uart_line(line);
        free(line);
    }
}

void print_result(cJSON* res) {
    if (!res) {
        return;
    }
    char* printed = cJSON_PrintUnformatted(res);
    if (printed) {
        uart_line(printed);
        cJSON_free(printed);
    }
}

void dispatch_json(cJSON* req) {
    const char* cmd = json_str(req, "cmd", "");
    if (strcmp(cmd, "io.hydrate") == 0) {
        RuntimeStatus::instance().set_live_serial(true);
        bump_activity();
    }
    cJSON* res = command_dispatch(req);
    print_result(res);
    cJSON_Delete(res);
}

void run_named(const char* cmd) {
    cJSON* req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "cmd", cmd);
    if (strcmp(cmd, "io.hydrate") == 0) {
        RuntimeStatus::instance().set_live_serial(true);
        bump_activity();
    }
    dispatch_json(req);
    cJSON_Delete(req);
}

void prompt() {
    if (RuntimeStatus::instance().live_serial()) {
        return;
    }
    uart_write_bytes(kPort, "de-esp32> ", 10);
}

void handle_line(char* line) {
    while (*line == ' ' || *line == '\t') {
        line++;
    }
    size_t n = strlen(line);
    while (n > 0 && (line[n - 1] == ' ' || line[n - 1] == '\t')) {
        line[--n] = '\0';
    }
    if (!n) {
        prompt();
        return;
    }
    bump_activity();
    if (line[0] == '{') {
        cJSON* req = cJSON_Parse(line);
        if (!req) {
            uart_line("{\"v\":1,\"ok\":false,\"error\":\"bad json\"}");
            prompt();
            return;
        }
        dispatch_json(req);
        cJSON_Delete(req);
        prompt();
        return;
    }
    if (strcmp(line, "hello") == 0) {
        run_named("serial.hello");
        prompt();
        return;
    }
    if (strcmp(line, "bye") == 0) {
        run_named("serial.bye");
        prompt();
        return;
    }
    if (strcmp(line, "hydrate") == 0) {
        run_named("io.hydrate");
        prompt();
        return;
    }
    int ret = 0;
    esp_err_t err = esp_console_run(line, &ret);
    if (err == ESP_ERR_NOT_FOUND) {
        uart_line("unknown command");
    } else if (err == ESP_ERR_INVALID_ARG) {
        // empty
    } else if (err != ESP_OK) {
        uart_line(esp_err_to_name(err));
    }
    prompt();
}

void rx_task(void*) {
    char buf[kLineMax];
    int len = 0;
    prompt();
    while (true) {
        uint8_t c = 0;
        int n = uart_read_bytes(kPort, &c, 1, pdMS_TO_TICKS(200));
        if (RuntimeStatus::instance().live_serial()) {
            uint32_t idle = (xTaskGetTickCount() - s_last_activity) * portTICK_PERIOD_MS;
            if (idle >= kIdleMs) {
                RuntimeStatus::instance().set_live_serial(false);
                uart_line("{\"topic\":\"session\",\"data\":{\"state\":\"timeout\"}}");
                prompt();
            }
        }
        if (n <= 0) {
            continue;
        }
        bump_activity();
        if (c == '\r') {
            continue;
        }
        if (c == '\n') {
            buf[len] = '\0';
            handle_line(buf);
            len = 0;
            continue;
        }
        if (len + 1 < kLineMax) {
            buf[len++] = static_cast<char>(c);
        }
    }
}

}  // namespace

static int cmd_ignored(int, char**) { return 0; }

esp_err_t serial_session_init() {
    if (!s_txq) {
        s_txq = xQueueCreate(kTxQueueLen, sizeof(char*));
    }
    bump_activity();
    event_bus_subscribe("io/", on_io, nullptr);
    const esp_console_cmd_t extra[] = {
        {.command = "hello", .help = "Start UART IO session (info JSON, no pin dump)", .func = cmd_ignored},
        {.command = "bye", .help = "Stop UART IO session", .func = cmd_ignored},
        {.command = "hydrate", .help = "Start session and re-emit each pin as NDJSON", .func = cmd_ignored},
    };
    for (const auto& c : extra) {
        esp_console_cmd_register(&c);
    }
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t serial_session_start() {
    if (!uart_is_driver_installed(kPort)) {
        uart_config_t cfg = {};
        cfg.baud_rate = CONFIG_ESP_CONSOLE_UART_BAUDRATE;
        cfg.data_bits = UART_DATA_8_BITS;
        cfg.parity = UART_PARITY_DISABLE;
        cfg.stop_bits = UART_STOP_BITS_1;
        cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
        cfg.source_clk = UART_SCLK_DEFAULT;
        uart_param_config(kPort, &cfg);
        uart_driver_install(kPort, 512, 512, 0, nullptr, 0);
    }
    xTaskCreate(tx_task, "ser_tx", 3072, nullptr, 4, nullptr);
    xTaskCreate(rx_task, "ser_rx", 6144, nullptr, 5, nullptr);
    ESP_LOGI(TAG, "UART%d session ready", static_cast<int>(kPort));
    return ESP_OK;
}

}  // namespace runtime
