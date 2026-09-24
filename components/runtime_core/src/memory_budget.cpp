#include "memory_budget.hpp"

#include <cstdio>
#include <cstring>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char* TAG = "memory";

namespace runtime {
namespace {

constexpr size_t kReserve = 24576;
constexpr size_t kCriticalLargest = 12 * 1024;
constexpr size_t kCriticalFree = 24 * 1024;
constexpr size_t kWarnLargest = 48 * 1024;
constexpr size_t kWarnFree = 48 * 1024;
constexpr uint32_t kInternalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
constexpr int kMaxBoot = 8;
constexpr int kMaxTasks = 24;

struct BootMark {
    char stage[16];
    size_t free_bytes;
    size_t largest;
};

struct TaskMark {
    char name[16];
    uint32_t stack_min;
};

BootMark s_boot[kMaxBoot];
int s_boot_n;

TaskMark s_tasks[kMaxTasks];
int s_task_n;
bool s_tasks_truncated;
int64_t s_tasks_us;

volatile bool s_alloc_failed;
volatile size_t s_alloc_failed_size;
bool s_alloc_logged;

const char* pressure_name(size_t free_bytes, size_t largest) {
    if (largest < kCriticalLargest || free_bytes < kCriticalFree) {
        return "critical";
    }
    if (largest < kWarnLargest || free_bytes < kWarnFree) {
        return "warn";
    }
    return "ok";
}

void internal_now(size_t* free_bytes, size_t* largest) {
    multi_heap_info_t info{};
    heap_caps_get_info(&info, kInternalCaps);
    if (free_bytes) {
        *free_bytes = info.total_free_bytes;
    }
    if (largest) {
        *largest = info.largest_free_block;
    }
}

void alloc_failed_cb(size_t size, uint32_t, const char*) {
    s_alloc_failed = true;
    s_alloc_failed_size = size;
}

void note_alloc_failed() {
    if (!s_alloc_failed || s_alloc_logged) {
        return;
    }
    s_alloc_logged = true;
    ESP_LOGW(TAG, "alloc failed size=%u", static_cast<unsigned>(s_alloc_failed_size));
}

cJSON* pool_json(uint32_t caps, bool with_totals) {
    multi_heap_info_t info{};
    heap_caps_get_info(&info, caps);
    size_t total = heap_caps_get_total_size(caps);
    cJSON* o = cJSON_CreateObject();
    if (with_totals) {
        cJSON_AddNumberToObject(o, "total", static_cast<double>(total));
        cJSON_AddNumberToObject(o, "min", static_cast<double>(info.minimum_free_bytes));
        size_t used = total > info.total_free_bytes ? total - info.total_free_bytes : 0;
        cJSON_AddNumberToObject(o, "used", static_cast<double>(used));
    }
    cJSON_AddNumberToObject(o, "free", static_cast<double>(info.total_free_bytes));
    cJSON_AddNumberToObject(o, "largest", static_cast<double>(info.largest_free_block));
    return o;
}

void refresh_tasks() {
    int64_t now = esp_timer_get_time();
    if (s_tasks_us != 0 && (now - s_tasks_us) < 5000000) {
        return;
    }
    s_tasks_us = now;
    // uxTaskGetSystemState fills the array only when it is large enough for every task.
    constexpr int kQuery = 40;
    static TaskStatus_t status[kQuery];
    UBaseType_t n = uxTaskGetSystemState(status, kQuery, nullptr);
    if (n == 0) {
        s_tasks_truncated = true;
        s_task_n = 0;
        return;
    }
    s_tasks_truncated = n > kMaxTasks;
    if (n > kMaxTasks) {
        n = kMaxTasks;
    }
    s_task_n = static_cast<int>(n);
    for (int i = 0; i < s_task_n; i++) {
        snprintf(s_tasks[i].name, sizeof(s_tasks[i].name), "%s",
                 status[i].pcTaskName ? status[i].pcTaskName : "?");
        s_tasks[i].stack_min = status[i].usStackHighWaterMark;
    }
}

}  // namespace

void memory_boot_mark(const char* stage) {
    if (!stage || !stage[0]) {
        return;
    }
    for (int i = 0; i < s_boot_n; i++) {
        if (strcmp(s_boot[i].stage, stage) == 0) {
            return;
        }
    }
    if (s_boot_n >= kMaxBoot) {
        return;
    }
    BootMark& m = s_boot[s_boot_n++];
    snprintf(m.stage, sizeof(m.stage), "%s", stage);
    internal_now(&m.free_bytes, &m.largest);
}

esp_err_t memory_admit(size_t internal_bytes, size_t dma_bytes, char* err, size_t err_len) {
    size_t free_bytes = 0;
    size_t largest = 0;
    internal_now(&free_bytes, &largest);
    const char* pressure = pressure_name(free_bytes, largest);
    bool dma_short = false;
    size_t dma_largest = 0;
    if (dma_bytes > 0) {
        dma_largest = heap_caps_get_largest_free_block(MALLOC_CAP_DMA);
        dma_short = dma_largest < dma_bytes;
    }
    bool critical = strcmp(pressure, "critical") == 0;
    bool reserve_short = internal_bytes > free_bytes || (free_bytes - internal_bytes) < kReserve;
    bool block_short = largest < internal_bytes;
    if (!critical && !reserve_short && !block_short && !dma_short) {
        return ESP_OK;
    }
    if (err && err_len) {
        if (dma_short) {
            snprintf(err, err_len, "need %u bytes, largest %u, free %u, dma largest %u",
                     static_cast<unsigned>(internal_bytes + dma_bytes), static_cast<unsigned>(largest),
                     static_cast<unsigned>(free_bytes), static_cast<unsigned>(dma_largest));
        } else {
            snprintf(err, err_len, "need %u bytes, largest %u, free %u",
                     static_cast<unsigned>(internal_bytes), static_cast<unsigned>(largest),
                     static_cast<unsigned>(free_bytes));
        }
    }
    return ESP_ERR_NO_MEM;
}

cJSON* memory_status_json() {
    note_alloc_failed();
    refresh_tasks();
    size_t free_bytes = 0;
    size_t largest = 0;
    internal_now(&free_bytes, &largest);
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "pressure", pressure_name(free_bytes, largest));
    cJSON_AddBoolToObject(o, "alloc_failed", s_alloc_failed);
    cJSON_AddNumberToObject(o, "alloc_failed_size", static_cast<double>(s_alloc_failed_size));
    cJSON_AddNumberToObject(o, "reserve", static_cast<double>(kReserve));
    cJSON_AddItemToObject(o, "internal", pool_json(kInternalCaps, true));
    cJSON_AddItemToObject(o, "dma", pool_json(MALLOC_CAP_DMA, false));
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) {
        cJSON_AddNullToObject(o, "psram");
    } else {
        cJSON_AddItemToObject(o, "psram", pool_json(MALLOC_CAP_SPIRAM, true));
    }
    cJSON* boot = cJSON_AddArrayToObject(o, "boot");
    for (int i = 0; i < s_boot_n; i++) {
        cJSON* row = cJSON_CreateObject();
        cJSON_AddStringToObject(row, "stage", s_boot[i].stage);
        cJSON_AddNumberToObject(row, "free", static_cast<double>(s_boot[i].free_bytes));
        cJSON_AddNumberToObject(row, "largest", static_cast<double>(s_boot[i].largest));
        cJSON_AddItemToArray(boot, row);
    }
    cJSON* tasks = cJSON_AddArrayToObject(o, "tasks");
    for (int i = 0; i < s_task_n; i++) {
        cJSON* row = cJSON_CreateObject();
        cJSON_AddStringToObject(row, "name", s_tasks[i].name);
        cJSON_AddNumberToObject(row, "stack_min", static_cast<double>(s_tasks[i].stack_min));
        cJSON_AddItemToArray(tasks, row);
    }
    cJSON_AddBoolToObject(o, "tasks_truncated", s_tasks_truncated);
    return o;
}

void memory_hooks_init() {
    heap_caps_register_failed_alloc_callback(alloc_failed_cb);
}

}  // namespace runtime
