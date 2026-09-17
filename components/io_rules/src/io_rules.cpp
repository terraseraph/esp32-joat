#include "io_rules.hpp"

#include <cstdio>
#include <cstring>

#include "config_manager.hpp"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "io_gpio.hpp"
#include "io_pwm.hpp"
#include "io_servo.hpp"
#include "json_util.hpp"
#include "runtime_status.hpp"
#include "state_registry.hpp"

static const char* TAG = "io_rules";

namespace runtime {
namespace {

constexpr int kMaxRules = 8;
constexpr int kGpioMax = 40;
constexpr int kBlob = 2048;

enum class Op : uint8_t { kGt, kGe, kLt, kLe, kEq, kNe };

struct Action {
    int gpio;
    int value;
    bool set;
};

struct Rule {
    char id[8];
    bool enabled;
    int src;
    Op op;
    int threshold;
    Action then;
    Action els;
    int8_t last;  // -1 none, 1 then, 0 else
};

struct Ev {
    int gpio;
    int value;
    char mode[8];
};

SemaphoreHandle_t s_mu;
QueueHandle_t s_q;
Rule s_rules[kMaxRules];
int s_n;

const char* op_str(Op op) {
    switch (op) {
        case Op::kGt:
            return "gt";
        case Op::kGe:
            return "ge";
        case Op::kLt:
            return "lt";
        case Op::kLe:
            return "le";
        case Op::kEq:
            return "eq";
        case Op::kNe:
            return "ne";
        default:
            return "gt";
    }
}

bool parse_op(const char* s, Op* out) {
    if (!s || !out) {
        return false;
    }
    if (strcmp(s, "gt") == 0 || strcmp(s, ">") == 0) {
        *out = Op::kGt;
        return true;
    }
    if (strcmp(s, "ge") == 0 || strcmp(s, ">=") == 0) {
        *out = Op::kGe;
        return true;
    }
    if (strcmp(s, "lt") == 0 || strcmp(s, "<") == 0) {
        *out = Op::kLt;
        return true;
    }
    if (strcmp(s, "le") == 0 || strcmp(s, "<=") == 0) {
        *out = Op::kLe;
        return true;
    }
    if (strcmp(s, "eq") == 0 || strcmp(s, "==") == 0) {
        *out = Op::kEq;
        return true;
    }
    if (strcmp(s, "ne") == 0 || strcmp(s, "!=") == 0) {
        *out = Op::kNe;
        return true;
    }
    return false;
}

bool cond(int v, Op op, int th) {
    switch (op) {
        case Op::kGt:
            return v > th;
        case Op::kGe:
            return v >= th;
        case Op::kLt:
            return v < th;
        case Op::kLe:
            return v <= th;
        case Op::kEq:
            return v == th;
        case Op::kNe:
            return v != th;
        default:
            return false;
    }
}

bool gpio_ok(int gpio) { return gpio >= 0 && gpio < kGpioMax; }

cJSON* pin_state(int gpio) {
    char key[16];
    const char* pref[] = {"gpio_", "adc_", "pwm_", "servo_"};
    for (const char* p : pref) {
        snprintf(key, sizeof(key), "%s%d", p, gpio);
        cJSON* st = state_get_clone(key);
        if (st) {
            return st;
        }
    }
    return nullptr;
}

bool dest_mode(int gpio, char* out, size_t out_len) {
    if (!out || out_len == 0) {
        return false;
    }
    out[0] = '\0';
    cJSON* st = pin_state(gpio);
    if (!st) {
        return false;
    }
    snprintf(out, out_len, "%s", json_str(st, "mode", ""));
    cJSON_Delete(st);
    return out[0] != '\0';
}

bool src_is_adc(int gpio) {
    cJSON* st = pin_state(gpio);
    if (!st) {
        return false;
    }
    bool adc = strcmp(json_str(st, "mode", ""), "adc") == 0;
    cJSON_Delete(st);
    return adc;
}

void refresh_live_sink() {
    int srcs[kMaxRules];
    bool en[kMaxRules];
    int n = 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < s_n; ++i) {
        srcs[n] = s_rules[i].src;
        en[n] = s_rules[i].enabled;
        n++;
    }
    xSemaphoreGive(s_mu);
    bool adc = false;
    for (int i = 0; i < n; ++i) {
        if (en[i] && src_is_adc(srcs[i])) {
            adc = true;
            break;
        }
    }
    RuntimeStatus::instance().set_live_rules(adc);
}

esp_err_t persist() {
    cJSON* root = cJSON_CreateObject();
    if (!root) {
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddNumberToObject(root, "v", 1);
    cJSON* arr = cJSON_AddArrayToObject(root, "rules");
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < s_n; ++i) {
        const Rule& r = s_rules[i];
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "id", r.id);
        cJSON_AddBoolToObject(o, "enabled", r.enabled);
        cJSON* on = cJSON_AddObjectToObject(o, "on");
        cJSON_AddNumberToObject(on, "gpio", r.src);
        cJSON_AddStringToObject(on, "op", op_str(r.op));
        cJSON_AddNumberToObject(on, "value", r.threshold);
        cJSON* th = cJSON_AddObjectToObject(o, "then");
        cJSON_AddNumberToObject(th, "gpio", r.then.gpio);
        cJSON_AddNumberToObject(th, "value", r.then.value);
        if (r.els.set) {
            cJSON* el = cJSON_AddObjectToObject(o, "else");
            cJSON_AddNumberToObject(el, "gpio", r.els.gpio);
            cJSON_AddNumberToObject(el, "value", r.els.value);
        }
        cJSON_AddItemToArray(arr, o);
    }
    xSemaphoreGive(s_mu);
    char* printed = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!printed) {
        return ESP_ERR_NO_MEM;
    }
    const size_t n = strlen(printed) + 1;
    esp_err_t err = ESP_ERR_NO_MEM;
    if (n <= kBlob) {
        err = config_set_blob("io", "rules", printed, n);
    }
    cJSON_free(printed);
    return err;
}

void parse_action(cJSON* o, Action* a, int fallback_gpio) {
    a->set = false;
    a->gpio = fallback_gpio;
    a->value = 0;
    if (!cJSON_IsObject(o)) {
        return;
    }
    a->gpio = json_int(o, "gpio", fallback_gpio);
    a->value = json_int(o, "value", 0);
    a->set = true;
}

bool fire(const Action& a) {
    if (!a.set || !gpio_ok(a.gpio)) {
        return false;
    }
    char mode[12];
    dest_mode(a.gpio, mode, sizeof(mode));
    int v = a.value;
    esp_err_t rc = ESP_ERR_INVALID_STATE;
    if (strcmp(mode, "out") == 0) {
        v = v ? 1 : 0;
        rc = io_gpio_set(a.gpio, v);
    } else if (strcmp(mode, "pwm") == 0) {
        if (v < 0) {
            v = 0;
        }
        if (v > 1000) {
            v = 1000;
        }
        rc = io_pwm_set(a.gpio, v);
    } else if (strcmp(mode, "servo") == 0) {
        if (v < 0) {
            v = 0;
        }
        if (v > 180) {
            v = 180;
        }
        rc = io_servo_set(a.gpio, v);
    } else {
        ESP_LOGW(TAG, "rule dest GPIO %d is not an output (mode=%s)", a.gpio, mode[0] ? mode : "?");
        return false;
    }
    if (rc != ESP_OK) {
        ESP_LOGW(TAG, "rule set GPIO %d failed: %s", a.gpio, esp_err_to_name(rc));
        return false;
    }
    return true;
}

void evaluate(const Ev& ev) {
    if (!gpio_ok(ev.gpio)) {
        return;
    }
    if (strcmp(ev.mode, "adc") != 0 && strcmp(ev.mode, "in") != 0) {
        return;
    }
    Rule copy[kMaxRules];
    int n = 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < s_n; ++i) {
        if (s_rules[i].enabled && s_rules[i].src == ev.gpio) {
            copy[n++] = s_rules[i];
        }
    }
    xSemaphoreGive(s_mu);
    for (int i = 0; i < n; ++i) {
        Rule& r = copy[i];
        const bool hit = cond(ev.value, r.op, r.threshold);
        const int8_t next = hit ? 1 : 0;
        if (r.last == next) {
            continue;
        }
        const bool ok = hit ? fire(r.then) : (r.els.set ? fire(r.els) : true);
        if (!ok) {
            continue;
        }
        xSemaphoreTake(s_mu, portMAX_DELAY);
        for (int j = 0; j < s_n; ++j) {
            if (strcmp(s_rules[j].id, r.id) == 0) {
                s_rules[j].last = next;
                break;
            }
        }
        xSemaphoreGive(s_mu);
    }
}

void eval_from_state(int gpio) {
    cJSON* st = pin_state(gpio);
    if (!st) {
        return;
    }
    Ev ev{};
    ev.gpio = gpio;
    snprintf(ev.mode, sizeof(ev.mode), "%s", json_str(st, "mode", ""));
    if (strcmp(ev.mode, "adc") == 0) {
        ev.value = json_int(st, "mv", 0);
    } else {
        ev.value = json_int(st, "level", 0);
    }
    cJSON_Delete(st);
    evaluate(ev);
}

void on_io(const char* /*topic*/, cJSON* payload, void* /*ctx*/) {
    if (!payload) {
        return;
    }
    Ev ev{};
    ev.gpio = json_int(payload, "gpio", -1);
    snprintf(ev.mode, sizeof(ev.mode), "%s", json_str(payload, "mode", ""));
    if (strcmp(ev.mode, "adc") == 0) {
        ev.value = json_int(payload, "mv", 0);
    } else {
        ev.value = json_int(payload, "level", 0);
    }
    if (s_q) {
        xQueueSend(s_q, &ev, 0);
    }
}

void rule_task(void*) {
    Ev ev;
    while (true) {
        if (xQueueReceive(s_q, &ev, portMAX_DELAY) == pdTRUE) {
            evaluate(ev);
        }
    }
}

int find_src(int gpio) {
    for (int i = 0; i < s_n; ++i) {
        if (s_rules[i].src == gpio) {
            return i;
        }
    }
    return -1;
}

int find_id(const char* id) {
    if (!id || !id[0]) {
        return -1;
    }
    for (int i = 0; i < s_n; ++i) {
        if (strcmp(s_rules[i].id, id) == 0) {
            return i;
        }
    }
    return -1;
}

void rule_to_json(const Rule& r, cJSON* arr) {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", r.id);
    cJSON_AddBoolToObject(o, "enabled", r.enabled);
    cJSON* on = cJSON_AddObjectToObject(o, "on");
    cJSON_AddNumberToObject(on, "gpio", r.src);
    cJSON_AddStringToObject(on, "op", op_str(r.op));
    cJSON_AddNumberToObject(on, "value", r.threshold);
    cJSON* th = cJSON_AddObjectToObject(o, "then");
    cJSON_AddNumberToObject(th, "gpio", r.then.gpio);
    cJSON_AddNumberToObject(th, "value", r.then.value);
    if (r.els.set) {
        cJSON* el = cJSON_AddObjectToObject(o, "else");
        cJSON_AddNumberToObject(el, "gpio", r.els.gpio);
        cJSON_AddNumberToObject(el, "value", r.els.value);
    }
    cJSON_AddItemToArray(arr, o);
}

bool load_one(cJSON* o, Rule* r, char* err, size_t err_len) {
    memset(r, 0, sizeof(*r));
    r->last = -1;
    r->enabled = json_bool(o, "enabled", true);
    cJSON* on = json_req_object(o, "on");
    if (!on) {
        on = o;
    }
    r->src = json_int(on, "gpio", json_int(o, "gpio", -1));
    if (!gpio_ok(r->src)) {
        snprintf(err, err_len, "on.gpio required");
        return false;
    }
    if (!parse_op(json_str(on, "op", "gt"), &r->op)) {
        snprintf(err, err_len, "on.op must be gt/ge/lt/le/eq/ne");
        return false;
    }
    r->threshold = json_int(on, "value", json_int(on, "mv", 0));
    cJSON* then_o = json_req_object(o, "then");
    parse_action(then_o, &r->then, -1);
    if (!r->then.set || !gpio_ok(r->then.gpio)) {
        snprintf(err, err_len, "then.gpio required");
        return false;
    }
    if (r->then.gpio == r->src) {
        snprintf(err, err_len, "then.gpio must differ from on.gpio");
        return false;
    }
    cJSON* else_o = json_req_object(o, "else");
    parse_action(else_o, &r->els, r->then.gpio);
    if (r->els.set && r->els.gpio == r->src) {
        snprintf(err, err_len, "else.gpio must differ from on.gpio");
        return false;
    }
    const char* id = json_str(o, "id", "");
    if (id[0]) {
        snprintf(r->id, sizeof(r->id), "%s", id);
        r->id[sizeof(r->id) - 1] = '\0';
    } else {
        snprintf(r->id, sizeof(r->id), "r%d", r->src);
    }
    return true;
}

}  // namespace

esp_err_t io_rules_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    s_n = 0;
    s_q = xQueueCreate(16, sizeof(Ev));
    if (!s_q) {
        return ESP_ERR_NO_MEM;
    }
    event_bus_subscribe("io/", on_io, nullptr);
    xTaskCreate(rule_task, "io_rules", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "rules engine ready");
    return ESP_OK;
}

esp_err_t io_rules_apply_saved() {
    char buf[kBlob];
    size_t len = sizeof(buf);
    if (config_get_blob("io", "rules", buf, &len) != ESP_OK || len == 0) {
        refresh_live_sink();
        return ESP_OK;
    }
    cJSON* root = cJSON_ParseWithLength(buf, len);
    if (!root) {
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(root, "rules");
    xSemaphoreTake(s_mu, portMAX_DELAY);
    s_n = 0;
    cJSON* it = nullptr;
    char err[96];
    cJSON_ArrayForEach(it, arr) {
        if (s_n >= kMaxRules) {
            break;
        }
        Rule r{};
        err[0] = '\0';
        if (!load_one(it, &r, err, sizeof(err))) {
            ESP_LOGW(TAG, "skip saved rule: %s", err);
            continue;
        }
        s_rules[s_n++] = r;
    }
    xSemaphoreGive(s_mu);
    cJSON_Delete(root);
    refresh_live_sink();
    int srcs[kMaxRules];
    int n = 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < s_n; ++i) {
        srcs[n++] = s_rules[i].src;
    }
    xSemaphoreGive(s_mu);
    for (int i = 0; i < n; ++i) {
        eval_from_state(srcs[i]);
    }
    ESP_LOGI(TAG, "applied %d rule(s)", n);
    return ESP_OK;
}

esp_err_t io_rules_set(cJSON* spec, char* err, size_t err_len) {
    if (err && err_len) {
        err[0] = '\0';
    }
    if (!spec) {
        snprintf(err, err_len, "rule required");
        return ESP_ERR_INVALID_ARG;
    }
    Rule r{};
    if (!load_one(spec, &r, err, err_len)) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    int idx = find_id(r.id);
    if (idx < 0) {
        idx = find_src(r.src);
    }
    if (idx < 0) {
        if (s_n >= kMaxRules) {
            xSemaphoreGive(s_mu);
            snprintf(err, err_len, "max %d rules", kMaxRules);
            return ESP_ERR_NO_MEM;
        }
        idx = s_n++;
    }
    r.last = -1;
    s_rules[idx] = r;
    const int src = r.src;
    xSemaphoreGive(s_mu);
    esp_err_t rc = persist();
    if (rc != ESP_OK) {
        snprintf(err, err_len, "persist failed");
        return rc;
    }
    refresh_live_sink();
    eval_from_state(src);
    return ESP_OK;
}

esp_err_t io_rules_remove(const char* id_or_empty, int gpio, char* err, size_t err_len) {
    if (err && err_len) {
        err[0] = '\0';
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    int idx = find_id(id_or_empty);
    if (idx < 0 && gpio_ok(gpio)) {
        idx = find_src(gpio);
    }
    if (idx < 0) {
        xSemaphoreGive(s_mu);
        snprintf(err, err_len, "rule not found");
        return ESP_ERR_NOT_FOUND;
    }
    for (int i = idx; i < s_n - 1; ++i) {
        s_rules[i] = s_rules[i + 1];
    }
    s_n--;
    xSemaphoreGive(s_mu);
    esp_err_t rc = persist();
    refresh_live_sink();
    return rc;
}

cJSON* io_rules_list_json() {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "v", 1);
    cJSON* arr = cJSON_AddArrayToObject(root, "rules");
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < s_n; ++i) {
        rule_to_json(s_rules[i], arr);
    }
    xSemaphoreGive(s_mu);
    return root;
}

void io_rules_on_io_change() {
    refresh_live_sink();
    int srcs[kMaxRules];
    int n = 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    for (int i = 0; i < s_n; ++i) {
        srcs[n++] = s_rules[i].src;
    }
    xSemaphoreGive(s_mu);
    for (int i = 0; i < n; ++i) {
        eval_from_state(srcs[i]);
    }
}

}  // namespace runtime
