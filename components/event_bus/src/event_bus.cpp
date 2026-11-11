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

// The event being delivered on this task, so subscribers can share one printed frame.
// Callbacks run in the publisher's task and may publish again (nested), so each task
// points at a context on its publish's stack, saved and restored around the callbacks.
struct FrameCtx {
    const char* topic;
    const cJSON* payload;
    char* owned;  // printed lazily by event_bus_frame, freed by deliver
    const char* frame;
    size_t len;
    bool tried;
};

thread_local FrameCtx* t_frame = nullptr;

// Prints {"topic":..,"data":..} with cJSON's own printer, so the bytes match the old
// wrap + cJSON_Duplicate + print path exactly, but without copying the payload tree:
// the wrapper and the "data" member are shallow stack nodes sharing the payload's children.
char* print_frame(const char* topic, const cJSON* payload) {
    cJSON wrap;
    cJSON t;
    cJSON d;
    memset(&wrap, 0, sizeof(wrap));
    memset(&t, 0, sizeof(t));
    wrap.type = cJSON_Object;
    wrap.child = &t;
    t.type = cJSON_String;
    t.valuestring = const_cast<char*>(topic);
    t.string = const_cast<char*>("topic");
    t.prev = &t;
    if (payload) {
        d = *payload;
        d.string = const_cast<char*>("data");
        d.next = nullptr;
        d.prev = &t;
        t.next = &d;
        t.prev = &d;
    }
    return cJSON_PrintUnformatted(&wrap);
}

esp_err_t deliver(const char* topic, cJSON* payload, const char* frame) {
    if (!topic) {
        return ESP_ERR_INVALID_ARG;
    }
    Sub local[kMaxSubs];
    int n = 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    n = s_count;
    memcpy(local, s_subs, sizeof(Sub) * n);
    xSemaphoreGive(s_mu);
    FrameCtx ctx{topic, payload, nullptr, frame, frame ? strlen(frame) : 0, frame != nullptr};
    FrameCtx* outer = t_frame;
    t_frame = &ctx;
    for (int i = 0; i < n; ++i) {
        if (strncmp(topic, local[i].prefix, strlen(local[i].prefix)) == 0) {
            local[i].cb(topic, payload, local[i].ctx);
        }
    }
    t_frame = outer;
    if (ctx.owned) {
        cJSON_free(ctx.owned);
    }
    return ESP_OK;
}

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
    return deliver(topic, payload, nullptr);
}

esp_err_t event_bus_publish_framed(const char* topic, cJSON* payload, const char* frame) {
    return deliver(topic, payload, frame);
}

const char* event_bus_frame(const char* topic, const cJSON* payload, size_t* len) {
    FrameCtx* ctx = t_frame;
    if (!ctx || ctx->topic != topic || ctx->payload != payload) {
        return nullptr;
    }
    if (!ctx->tried) {
        ctx->tried = true;
        ctx->owned = print_frame(topic, payload);
        ctx->frame = ctx->owned;
        ctx->len = ctx->owned ? strlen(ctx->owned) : 0;
    }
    if (len) {
        *len = ctx->len;
    }
    return ctx->frame;
}

char* event_bus_print_frame(const char* topic, const cJSON* payload, size_t* data_off,
                            size_t* data_len) {
    if (!topic) {
        return nullptr;
    }
    char* out = print_frame(topic, payload);
    if (!out) {
        return nullptr;
    }
    // An escaped topic cannot contain a bare quote, so the first "," "data": is the boundary.
    static const char kData[] = "\",\"data\":";
    const char* p = payload ? strstr(out, kData) : nullptr;
    const size_t total = strlen(out);
    const size_t off = p ? static_cast<size_t>(p - out) + sizeof(kData) - 1 : total;
    if (data_off) {
        *data_off = off;
    }
    if (data_len) {
        *data_len = (p && total > off) ? total - off - 1 : 0;  // minus the closing brace
    }
    return out;
}

}  // namespace runtime
