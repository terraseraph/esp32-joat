#include "mqtt_manager.hpp"

#include <cstdio>
#include <cstring>

#include "cJSON.h"
#include "command_router.hpp"
#include "config_manager.hpp"
#include "device_identity.hpp"
#include "esp_log.h"
#include "event_bus.hpp"
#include "json_util.hpp"
#include "mqtt_client.h"
#include "runtime_status.hpp"
#include "runtime_version.hpp"

static const char* TAG = "mqtt";

namespace runtime {
namespace {

esp_mqtt_client_handle_t s_client;
bool s_connected;
char s_uri[128];
char s_root[48];
int s_reconnects;
int s_pub_ok;
int s_pub_fail;
int s_rx;
char s_last_err[48];

void load_root() {
    char buf[48] = {0};
    size_t n = sizeof(buf);
    if (config_get_str("mqtt", "root", buf, &n) != ESP_OK) {
        buf[0] = '\0';
    }
    size_t j = 0;
    bool slash = true;
    for (size_t i = 0; buf[i] && j + 1 < sizeof(s_root); ++i) {
        const char c = buf[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' ||
            c == '-') {
            s_root[j++] = c;
            slash = false;
        } else if (c == '/' && !slash) {
            s_root[j++] = '/';
            slash = true;
        }
    }
    while (j > 0 && s_root[j - 1] == '/') {
        j--;
    }
    s_root[j] = '\0';
    if (!s_root[0]) {
        snprintf(s_root, sizeof(s_root), "devices");
    }
}

const char* root() {
    if (!s_root[0]) {
        load_root();
    }
    return s_root;
}

void topic(char* out, size_t n, const char* suffix) {
    snprintf(out, n, "%s/%s/%s", root(), device_topic_id(), suffix);
}

struct MqttTopicDef {
    const char* suffix;
    bool sub;
    bool pub;
    bool retain;
    const char* summary;
};

// Subscribe/publish use this table; OpenAPI and GET /mqtt read the same rows.
const MqttTopicDef kMqttTopics[] = {
    {"system/command", true, false, false,
     "JSON command_dispatch - same body as POST /api/v1/command"},
    {"config/set", true, false, false, "Alias of system/command"},
    {"components/+/set", true, false, false, "Alias of system/command; + is not interpreted"},
    {"availability", false, true, true, "LWT retained online / offline"},
    {"status", false, true, true, "Retained identity snapshot"},
    {"telemetry", false, true, false, "Periodic diagnostics"},
    {"io", false, true, false,
     "Live GPIO/PWM/servo/ADC/RFID {topic,data} JSON (QoS 1); hydrate burst on connect"},
    {"events", false, true, false, "Command replies (corr echoed)"},
    {"api", false, true, true, "Retained pointer at OpenAPI + command topic"},
};

cJSON* build_mqtt_topics() {
    cJSON* arr = cJSON_CreateArray();
    for (const MqttTopicDef& d : kMqttTopics) {
        cJSON* o = cJSON_CreateObject();
        char t[128];
        topic(t, sizeof(t), d.suffix);
        cJSON_AddStringToObject(o, "topic", t);
        cJSON_AddStringToObject(o, "suffix", d.suffix);
        cJSON_AddBoolToObject(o, "subscribe", d.sub);
        cJSON_AddBoolToObject(o, "publish", d.pub);
        cJSON_AddBoolToObject(o, "retain", d.retain);
        cJSON_AddStringToObject(o, "summary", d.summary);
        cJSON_AddItemToArray(arr, o);
    }
    return arr;
}

void mqtt_publish_discovery() {
    if (!s_client || !s_connected) {
        return;
    }
    cJSON* o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "v", 1);
    cJSON_AddStringToObject(o, "id", device_id());
    cJSON_AddStringToObject(o, "name", device_name());
    cJSON_AddStringToObject(o, "topic_id", device_topic_id());
    cJSON_AddStringToObject(o, "fw", RUNTIME_VERSION);
    char url[128];
    snprintf(url, sizeof(url), "http://%s.local/api/v1/openapi.json", hostname());
    cJSON_AddStringToObject(o, "openapi", url);
    snprintf(url, sizeof(url), "http://%s.local/", hostname());
    cJSON_AddStringToObject(o, "ui", url);
    snprintf(url, sizeof(url), "%s/%s", root(), device_topic_id());
    cJSON_AddStringToObject(o, "prefix", url);
    cJSON_AddStringToObject(o, "root", root());
    topic(url, sizeof(url), "system/command");
    cJSON_AddStringToObject(o, "command", url);
    char* printed = cJSON_PrintUnformatted(o);
    char t[128];
    topic(t, sizeof(t), "api");
    if (printed) {
        esp_mqtt_client_publish(s_client, t, printed, 0, 1, 1);
        cJSON_free(printed);
        s_pub_ok++;
    }
    cJSON_Delete(o);
}

void mqtt_publish_discovery();
void retire_topics(const char* old_root, const char* old_id);

static void mqtt_event_handler(void*, esp_event_base_t, int32_t event_id, void* event_data) {
    auto* ev = static_cast<esp_mqtt_event_t*>(event_data);
    switch (static_cast<esp_mqtt_event_id_t>(event_id)) {
        case MQTT_EVENT_CONNECTED: {
            s_connected = true;
            RuntimeStatus::instance().set_live_mqtt(true);
            s_reconnects++;
            ESP_LOGI(TAG, "connected");
            char t[128];
            for (const MqttTopicDef& d : kMqttTopics) {
                if (!d.sub) {
                    continue;
                }
                topic(t, sizeof(t), d.suffix);
                esp_mqtt_client_subscribe(s_client, t, 1);
            }
            topic(t, sizeof(t), "availability");
            esp_mqtt_client_publish(s_client, t, "online", 0, 1, 1);
            if (strcmp(device_topic_id(), device_id()) != 0) {
                retire_topics(root(), device_id());
            }
            mqtt_publish_status();
            mqtt_publish_discovery();
            io_emit_snapshot();
            break;
        }
        case MQTT_EVENT_DISCONNECTED:
            s_connected = false;
            RuntimeStatus::instance().set_live_mqtt(false);
            snprintf(s_last_err, sizeof(s_last_err), "disconnected");
            ESP_LOGW(TAG, "disconnected");
            break;
        case MQTT_EVENT_DATA: {
            s_rx++;
            char payload[512];
            int n = ev->data_len < 511 ? ev->data_len : 511;
            memcpy(payload, ev->data, n);
            payload[n] = 0;
            cJSON* req = cJSON_Parse(payload);
            if (!req) {
                break;
            }
            cJSON* res = command_dispatch(req);
            char t[128];
            topic(t, sizeof(t), "events");
            if (res) {
                char* printed = cJSON_PrintUnformatted(res);
                if (printed) {
                    esp_mqtt_client_publish(s_client, t, printed, 0, 1, 0);
                    cJSON_free(printed);
                    s_pub_ok++;
                }
                cJSON_Delete(res);
            }
            cJSON_Delete(req);
            break;
        }
        case MQTT_EVENT_ERROR:
            snprintf(s_last_err, sizeof(s_last_err), "error");
            s_pub_fail++;
            break;
        default:
            break;
    }
}

void retire_topics(const char* old_root, const char* old_id) {
    if (!s_client || !old_root || !old_root[0] || !old_id || !old_id[0]) {
        return;
    }
    if (strcmp(old_root, root()) == 0 && strcmp(old_id, device_topic_id()) == 0) {
        return;
    }
    const char* retained[] = {"availability", "status", "api"};
    char t[128];
    for (const char* suf : retained) {
        snprintf(t, sizeof(t), "%s/%s/%s", old_root, old_id, suf);
        esp_mqtt_client_publish(s_client, t, "", 0, 1, 1);
    }
    ESP_LOGI(TAG, "retired old prefix %s/%s", old_root, old_id);
}

void on_io(const char* bus_topic, cJSON* payload, void*) {
    if (!bus_topic || !s_client || !s_connected) {
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
    char t[128];
    topic(t, sizeof(t), "io");
    int msg_id = esp_mqtt_client_publish(s_client, t, printed, 0, 1, 0);
    cJSON_free(printed);
    if (msg_id < 0) {
        s_pub_fail++;
    } else {
        s_pub_ok++;
    }
}

void on_reconfigure(const char*, cJSON* payload, void*) {
    const char* old_root = json_str(payload, "old_root", "");
    const char* old_id = json_str(payload, "old_topic_id", "");
    if (!old_root[0]) {
        old_root = root();
    }
    if (old_id[0]) {
        retire_topics(old_root, old_id);
    } else if (json_str(payload, "old_root", "")[0]) {
        retire_topics(old_root, device_topic_id());
        if (strcmp(device_topic_id(), device_id()) != 0) {
            retire_topics(old_root, device_id());
        }
    }
    mqtt_stop();
    mqtt_start();
}

}  // namespace

esp_err_t mqtt_init() {
    load_root();
    event_bus_subscribe("mqtt/", on_reconfigure, nullptr);
    event_bus_subscribe("identity/", on_reconfigure, nullptr);
    event_bus_subscribe("io/", on_io, nullptr);
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t mqtt_start() {
    load_root();
    uint8_t enabled = 0;
    config_get_u8("mqtt", "enabled", &enabled);
    size_t ulen = sizeof(s_uri);
    if (!enabled || config_get_str("mqtt", "uri", s_uri, &ulen) != ESP_OK || !s_uri[0]) {
        ESP_LOGI(TAG, "MQTT disabled or no uri");
        return ESP_OK;
    }
    char user[64] = {0};
    char pass[64] = {0};
    size_t n = sizeof(user);
    config_get_str("mqtt", "user", user, &n);
    n = sizeof(pass);
    config_get_str("mqtt", "password", pass, &n);

    char lwt[128];
    topic(lwt, sizeof(lwt), "availability");

    esp_mqtt_client_config_t cfg{};
    cfg.broker.address.uri = s_uri;
    cfg.credentials.client_id = device_id();
    if (user[0]) {
        cfg.credentials.username = user;
        cfg.credentials.authentication.password = pass;
    }
    cfg.session.last_will.topic = lwt;
    cfg.session.last_will.msg = "offline";
    cfg.session.last_will.qos = 1;
    cfg.session.last_will.retain = true;
    cfg.network.timeout_ms = 10000;

    s_client = esp_mqtt_client_init(&cfg);
    if (!s_client) {
        return ESP_FAIL;
    }
    esp_mqtt_client_register_event(s_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr);
    return esp_mqtt_client_start(s_client);
}

void mqtt_stop() {
    if (s_client) {
        esp_mqtt_client_stop(s_client);
        esp_mqtt_client_destroy(s_client);
        s_client = nullptr;
    }
    s_connected = false;
    RuntimeStatus::instance().set_live_mqtt(false);
}

bool mqtt_connected() { return s_connected; }

cJSON* mqtt_status_json() {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "connected", s_connected);
    cJSON_AddStringToObject(o, "uri", s_uri);
    cJSON_AddNumberToObject(o, "reconnects", s_reconnects);
    cJSON_AddNumberToObject(o, "published", s_pub_ok);
    cJSON_AddNumberToObject(o, "publish_fail", s_pub_fail);
    cJSON_AddNumberToObject(o, "received", s_rx);
    cJSON_AddStringToObject(o, "last_error", s_last_err);
    cJSON_AddStringToObject(o, "root", root());
    char prefix[80];
    snprintf(prefix, sizeof(prefix), "%s/%s", root(), device_topic_id());
    cJSON_AddStringToObject(o, "prefix", prefix);
    cJSON_AddStringToObject(o, "topic_id", device_topic_id());
    cJSON* sub = cJSON_AddArrayToObject(o, "sub");
    cJSON* pub = cJSON_AddArrayToObject(o, "pub");
    for (const MqttTopicDef& d : kMqttTopics) {
        if (d.sub) {
            cJSON_AddItemToArray(sub, cJSON_CreateString(d.suffix));
        }
        if (d.pub) {
            cJSON_AddItemToArray(pub, cJSON_CreateString(d.suffix));
        }
    }
    return o;
}

cJSON* mqtt_topics_json() { return build_mqtt_topics(); }

const char* mqtt_topic_root() { return root(); }

void mqtt_publish_status() {
    if (!s_client || !s_connected) {
        return;
    }
    cJSON* o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "v", 1);
    cJSON_AddStringToObject(o, "id", device_id());
    cJSON_AddStringToObject(o, "name", device_name());
    cJSON_AddStringToObject(o, "topic_id", device_topic_id());
    cJSON_AddStringToObject(o, "fw", RUNTIME_VERSION);
    char* printed = cJSON_PrintUnformatted(o);
    char t[128];
    topic(t, sizeof(t), "status");
    if (printed) {
        esp_mqtt_client_publish(s_client, t, printed, 0, 1, 1);
        cJSON_free(printed);
        s_pub_ok++;
    }
    cJSON_Delete(o);
}

void mqtt_publish_telemetry(cJSON* payload) {
    if (!s_client || !s_connected || !payload) {
        return;
    }
    char* printed = cJSON_PrintUnformatted(payload);
    char t[128];
    topic(t, sizeof(t), "telemetry");
    if (printed) {
        int msg_id = esp_mqtt_client_publish(s_client, t, printed, 0, 0, 0);
        if (msg_id < 0) {
            s_pub_fail++;
        } else {
            s_pub_ok++;
        }
        cJSON_free(printed);
    }
}

}  // namespace runtime
