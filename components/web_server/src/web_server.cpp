#include "web_server.hpp"

#include <cstdlib>
#include <cstring>
#include <unistd.h>

#include "board_profiles.hpp"
#include "cJSON.h"
#include "capability_manager.hpp"
#include "command_router.hpp"
#include "config_manager.hpp"
#include "device_identity.hpp"
#include "esp_http_server.h"
#include "esp_log.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "json_util.hpp"
#include "logging_service.hpp"
#include "mqtt_manager.hpp"
#include "network_manager.hpp"
#include "ota_manager.hpp"
#include "resource_manager.hpp"
#include "runtime_status.hpp"
#include "runtime_version.hpp"
#include "security.hpp"
#include "state_registry.hpp"
#include "telemetry.hpp"

static const char* TAG = "web";

extern const uint8_t index_html_start[] asm("_binary_index_html_start");
extern const uint8_t index_html_end[] asm("_binary_index_html_end");

namespace runtime {
namespace {

httpd_handle_t s_server;
int s_ws_fds[4];
int s_ws_count;
SemaphoreHandle_t s_ws_mu;

esp_err_t send_json(httpd_req_t* req, cJSON* obj, bool take_ownership = true) {
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    char* printed = cJSON_PrintUnformatted(obj);
    if (!printed) {
        if (take_ownership) {
            cJSON_Delete(obj);
        }
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "json");
    }
    esp_err_t err = httpd_resp_sendstr(req, printed);
    cJSON_free(printed);
    if (take_ownership) {
        cJSON_Delete(obj);
    }
    return err;
}

esp_err_t send_html(httpd_req_t* req) {
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, reinterpret_cast<const char*>(index_html_start),
                           index_html_end - index_html_start);
}

// Captive probes (Android generate_204, iOS hotspot-detect, Windows ncsi, …) miss
// the registered routes and land here. 302 + a body is what makes the OS "Sign in"
// sheet open the portal; iOS ignores an empty redirect.
esp_err_t captive_404(httpd_req_t* req, httpd_err_code_t) {
    char loc[40];
    snprintf(loc, sizeof(loc), "http://%s/", ap_ip());
    httpd_resp_set_status(req, "302 Temporary Redirect");
    httpd_resp_set_hdr(req, "Location", loc);
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, "Redirect to the captive portal");
}

cJSON* read_body(httpd_req_t* req) {
    int len = req->content_len;
    if (len <= 0 || len > 1536) {
        return nullptr;
    }
    char* buf = static_cast<char*>(malloc(len + 1));
    if (!buf) {
        return nullptr;
    }
    int rec = 0;
    while (rec < len) {
        int r = httpd_req_recv(req, buf + rec, len - rec);
        if (r <= 0) {
            free(buf);
            return nullptr;
        }
        rec += r;
    }
    buf[len] = 0;
    cJSON* j = cJSON_Parse(buf);
    free(buf);
    return j;
}

cJSON* status_json() {
    cJSON* o = telemetry_snapshot();
    cJSON_AddStringToObject(o, "name", device_name());
    cJSON_AddStringToObject(o, "topic_id", device_topic_id());
    cJSON_AddStringToObject(o, "hostname", hostname());
    cJSON_AddStringToObject(o, "mac", mac_colon());
    cJSON_AddStringToObject(o, "chip", chip_model());
    cJSON_AddItemToObject(o, "chip_info", chip_info_json());
    cJSON_AddStringToObject(o, "ap_ssid", ap_ssid());
    cJSON_AddNumberToObject(o, "schema", config_schema_version());
    cJSON_AddNumberToObject(o, "generation", static_cast<double>(config_generation()));
    cJSON_AddStringToObject(o, "safe_reason", RuntimeStatus::instance().safe_mode_reason());
    return o;
}

esp_err_t index_get(httpd_req_t* req) { return send_html(req); }

esp_err_t api_openapi(httpd_req_t* req);

esp_err_t api_status(httpd_req_t* req) { return send_json(req, status_json()); }

esp_err_t api_hardware(httpd_req_t* req) {
    cJSON* o = board_profile_json();
    cJSON_AddStringToObject(o, "chip", chip_model());
    cJSON_AddItemToObject(o, "chip_info", chip_info_json());
    cJSON* pins = capability_dump();
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, pins) {
        int g = json_int(it, "gpio", -1);
        const char* owner = resource_owner(g);
        cJSON_AddStringToObject(it, "owner", (owner && owner[0]) ? owner : "");
    }
    cJSON_AddItemToObject(o, "pins", pins);
    return send_json(req, o);
}

esp_err_t api_pins(httpd_req_t* req) {
    if (req->method == HTTP_POST) {
        cJSON* body = read_body(req);
        if (!body) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "json");
        }
        if (!cJSON_GetObjectItem(body, "cmd")) {
            cJSON_AddStringToObject(body, "cmd", "pin.configure");
        }
        cJSON* res = command_dispatch(body);
        cJSON_Delete(body);
        return send_json(req, res);
    }
    return send_json(req, state_snapshot());
}

esp_err_t api_command(httpd_req_t* req) {
    cJSON* body = read_body(req);
    if (!body) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "json");
    }
    cJSON* res = command_dispatch(body);
    cJSON_Delete(body);
    return send_json(req, res);
}

esp_err_t api_network(httpd_req_t* req) { return send_json(req, network_status_json()); }

esp_err_t api_scan(httpd_req_t* req) { return send_json(req, network_scan()); }

esp_err_t api_wifi(httpd_req_t* req) {
    cJSON* body = read_body(req);
    if (!body) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "json");
    }
    cJSON_AddStringToObject(body, "cmd", "network.wifi.set");
    cJSON* res = command_dispatch(body);
    cJSON_Delete(body);
    return send_json(req, res);
}

esp_err_t api_mqtt(httpd_req_t* req) {
    if (req->method == HTTP_POST) {
        cJSON* body = read_body(req);
        if (!body) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "json");
        }
        cJSON_AddStringToObject(body, "cmd", "mqtt.configure");
        cJSON* res = command_dispatch(body);
        cJSON_Delete(body);
        return send_json(req, res);
    }
    return send_json(req, mqtt_status_json());
}

esp_err_t api_logs(httpd_req_t* req) {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddItemToObject(o, "lines", logging_dump());
    return send_json(req, o);
}

esp_err_t api_telemetry(httpd_req_t* req) { return send_json(req, telemetry_snapshot()); }

esp_err_t send_cmd_err(httpd_req_t* req, const char* msg) {
    cJSON* r = cJSON_CreateObject();
    cJSON_AddNumberToObject(r, "v", 1);
    cJSON_AddBoolToObject(r, "ok", false);
    cJSON_AddStringToObject(r, "error", msg ? msg : "error");
    return send_json(req, r);
}

esp_err_t api_ota_upload(httpd_req_t* req) {
    int len = req->content_len;
    if (len <= 0) {
        return send_cmd_err(req, "Content-Length required");
    }
    char err[96];
    err[0] = '\0';
    if (ota_begin_write(static_cast<size_t>(len), err, sizeof(err)) != ESP_OK) {
        return send_cmd_err(req, err[0] ? err : "ota begin failed");
    }
    uint8_t buf[1024];
    int rec = 0;
    while (rec < len) {
        int want = len - rec;
        if (want > static_cast<int>(sizeof(buf))) {
            want = sizeof(buf);
        }
        int r = httpd_req_recv(req, reinterpret_cast<char*>(buf), want);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (r <= 0) {
            ota_abort_write();
            return send_cmd_err(req, "upload interrupted");
        }
        if (ota_write_chunk(buf, static_cast<size_t>(r), err, sizeof(err)) != ESP_OK) {
            return send_cmd_err(req, err[0] ? err : "ota write failed");
        }
        rec += r;
    }
    if (ota_finish_write(err, sizeof(err)) != ESP_OK) {
        return send_cmd_err(req, err[0] ? err : "ota finish failed");
    }
    cJSON* res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "v", 1);
    cJSON_AddBoolToObject(res, "ok", true);
    cJSON_AddItemToObject(res, "result", ota_status_json());
    esp_err_t se = send_json(req, res);
    ota_schedule_reboot();
    return se;
}

esp_err_t api_ota(httpd_req_t* req) {
    if (req->method == HTTP_POST) {
        return api_ota_upload(req);
    }
    return send_json(req, ota_status_json());
}

esp_err_t api_reboot(httpd_req_t* req) {
    cJSON* cmd = cJSON_CreateObject();
    cJSON_AddStringToObject(cmd, "cmd", "system.reboot");
    cJSON* res = command_dispatch(cmd);
    cJSON_Delete(cmd);
    return send_json(req, res);
}

esp_err_t api_factory(httpd_req_t* req) {
    cJSON* cmd = cJSON_CreateObject();
    cJSON_AddStringToObject(cmd, "cmd", "system.factory_reset");
    cJSON* res = command_dispatch(cmd);
    cJSON_Delete(cmd);
    return send_json(req, res);
}

void ws_add(int fd) {
    xSemaphoreTake(s_ws_mu, portMAX_DELAY);
    bool present = false;
    int slot = -1;
    for (int i = 0; i < 4; ++i) {
        if (s_ws_fds[i] == fd) {
            present = true;
            break;
        }
        if (slot < 0 && s_ws_fds[i] == 0) {
            slot = i;
        }
    }
    if (!present && slot >= 0) {
        s_ws_fds[slot] = fd;
        s_ws_count++;
    }
    int n = s_ws_count;
    xSemaphoreGive(s_ws_mu);
    RuntimeStatus::instance().set_live_viewers(n);
}

void ws_remove(int fd) {
    xSemaphoreTake(s_ws_mu, portMAX_DELAY);
    for (int i = 0; i < 4; ++i) {
        if (s_ws_fds[i] == fd) {
            s_ws_fds[i] = 0;
            if (s_ws_count > 0) {
                s_ws_count--;
            }
            break;
        }
    }
    int n = s_ws_count;
    xSemaphoreGive(s_ws_mu);
    RuntimeStatus::instance().set_live_viewers(n);
}

void on_sess_close(httpd_handle_t, int sockfd) {
    ws_remove(sockfd);
    close(sockfd);
}

void ws_broadcast(const char* msg) {
    if (!s_server || !msg) {
        return;
    }
    httpd_ws_frame_t frame{};
    frame.type = HTTPD_WS_TYPE_TEXT;
    frame.payload = reinterpret_cast<uint8_t*>(const_cast<char*>(msg));
    frame.len = strlen(msg);
    int drop[4] = {0, 0, 0, 0};
    xSemaphoreTake(s_ws_mu, portMAX_DELAY);
    for (int i = 0; i < 4; ++i) {
        if (!s_ws_fds[i]) {
            continue;
        }
        if (httpd_ws_get_fd_info(s_server, s_ws_fds[i]) != HTTPD_WS_CLIENT_WEBSOCKET) {
            drop[i] = s_ws_fds[i];
            continue;
        }
        if (httpd_ws_send_frame_async(s_server, s_ws_fds[i], &frame) != ESP_OK) {
            drop[i] = s_ws_fds[i];
        }
    }
    xSemaphoreGive(s_ws_mu);
    for (int i = 0; i < 4; ++i) {
        if (drop[i]) {
            ws_remove(drop[i]);
        }
    }
}

esp_err_t api_ws(httpd_req_t* req) {
    if (req->method == HTTP_GET) {
        int fd = httpd_req_to_sockfd(req);
        ws_add(fd);
        return ESP_OK;
    }
    httpd_ws_frame_t pkt{};
    pkt.type = HTTPD_WS_TYPE_TEXT;
    esp_err_t err = httpd_ws_recv_frame(req, &pkt, 0);
    if (err != ESP_OK) {
        return err;
    }
    if (pkt.len) {
        pkt.payload = static_cast<uint8_t*>(malloc(pkt.len + 1));
        if (!pkt.payload) {
            return ESP_ERR_NO_MEM;
        }
        err = httpd_ws_recv_frame(req, &pkt, pkt.len);
        if (err == ESP_OK) {
            pkt.payload[pkt.len] = 0;
            cJSON* reqj = cJSON_Parse(reinterpret_cast<char*>(pkt.payload));
            if (reqj) {
                cJSON* res = command_dispatch(reqj);
                char* printed = res ? cJSON_PrintUnformatted(res) : nullptr;
                if (printed) {
                    httpd_ws_frame_t out{};
                    out.type = HTTPD_WS_TYPE_TEXT;
                    out.payload = reinterpret_cast<uint8_t*>(printed);
                    out.len = strlen(printed);
                    httpd_ws_send_frame(req, &out);
                    cJSON_free(printed);
                }
                cJSON_Delete(res);
                cJSON_Delete(reqj);
            }
        }
        free(pkt.payload);
    }
    return ESP_OK;
}

void on_bus(const char* topic, cJSON* payload, void*) {
    if (RuntimeStatus::instance().live_viewers() <= 0) {
        return;
    }
    cJSON* wrap = cJSON_CreateObject();
    cJSON_AddStringToObject(wrap, "topic", topic);
    if (payload) {
        cJSON_AddItemToObject(wrap, "data", cJSON_Duplicate(payload, 1));
    }
    char* printed = cJSON_PrintUnformatted(wrap);
    if (printed) {
        ws_broadcast(printed);
        cJSON_free(printed);
    }
    cJSON_Delete(wrap);
}

struct ApiRoute {
    const char* path;
    httpd_method_t method;
    esp_err_t (*handler)(httpd_req_t*);
    const char* summary;
    bool websocket;
    bool ui;
};

const ApiRoute kRoutes[] = {
    {"/api/v1/status", HTTP_GET, api_status, "Live device status", false, false},
    {"/api/v1/hardware", HTTP_GET, api_hardware, "Chip, header pinout, buses, GPIO capabilities and owners", false, false},
    {"/api/v1/pins", HTTP_GET, api_pins, "Live I/O snapshot", false, false},
    {"/api/v1/pins", HTTP_POST, api_pins, "pin.configure (or any cmd)", false, false},
    {"/api/v1/command", HTTP_POST, api_command, "JSON command_dispatch", false, false},
    {"/api/v1/network", HTTP_GET, api_network, "STA/AP/mDNS status", false, false},
    {"/api/v1/network/scan", HTTP_GET, api_scan, "Wi-Fi scan", false, false},
    {"/api/v1/network/wifi", HTTP_POST, api_wifi, "network.wifi.set", false, false},
    {"/api/v1/mqtt", HTTP_GET, api_mqtt, "Broker status and topic suffixes", false, false},
    {"/api/v1/mqtt", HTTP_POST, api_mqtt, "mqtt.configure", false, false},
    {"/api/v1/logs", HTTP_GET, api_logs, "RAM log ring", false, false},
    {"/api/v1/telemetry", HTTP_GET, api_telemetry, "Diagnostics snapshot", false, false},
    {"/api/v1/ota", HTTP_GET, api_ota, "OTA slot status", false, false},
    {"/api/v1/ota", HTTP_POST, api_ota, "Raw firmware image (not JSON)", false, false},
    {"/api/v1/system/reboot", HTTP_POST, api_reboot, "system.reboot", false, false},
    {"/api/v1/system/factory_reset", HTTP_POST, api_factory, "system.factory_reset", false, false},
    {"/api/v1/ws", HTTP_GET, api_ws, "WebSocket: JSON cmds in, events out", true, false},
    {"/api/v1/openapi.json", HTTP_GET, api_openapi, "This OpenAPI document", false, false},
    {"/", HTTP_GET, index_get, "Embedded UI", false, true},
    {"/index.html", HTTP_GET, index_get, "Embedded UI", false, true},
};

void add_server(cJSON* servers, const char* url) {
    if (!url || !url[0]) {
        return;
    }
    cJSON* s = cJSON_CreateObject();
    cJSON_AddStringToObject(s, "url", url);
    cJSON_AddItemToArray(servers, s);
}

cJSON* openapi_json() {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "openapi", "3.0.3");
    cJSON* info = cJSON_AddObjectToObject(root, "info");
    cJSON_AddStringToObject(info, "title", RUNTIME_NAME);
    cJSON_AddStringToObject(info, "version", RUNTIME_VERSION);
    cJSON_AddStringToObject(info, "description",
                            "HTTP, WebSocket, and MQTT share command_router. UI is a client of this spec.");
    cJSON* servers = cJSON_AddArrayToObject(root, "servers");
    char url[80];
    const char* ip = sta_ip();
    if (ip && ip[0] && strcmp(ip, "0.0.0.0") != 0) {
        snprintf(url, sizeof(url), "http://%s", ip);
        add_server(servers, url);
    }
    snprintf(url, sizeof(url), "http://%s.local", hostname());
    add_server(servers, url);
    snprintf(url, sizeof(url), "http://%s", ap_ip());
    add_server(servers, url);

    cJSON* paths = cJSON_AddObjectToObject(root, "paths");
    for (const ApiRoute& r : kRoutes) {
        if (r.ui) {
            continue;
        }
        cJSON* path = cJSON_GetObjectItem(paths, r.path);
        if (!path) {
            path = cJSON_AddObjectToObject(paths, r.path);
        }
        const char* m = r.method == HTTP_POST ? "post" : "get";
        if (cJSON_GetObjectItem(path, m)) {
            continue;
        }
        cJSON* op = cJSON_AddObjectToObject(path, m);
        cJSON_AddStringToObject(op, "summary", r.summary);
        cJSON* responses = cJSON_AddObjectToObject(op, "responses");
        cJSON* ok = cJSON_AddObjectToObject(responses, "200");
        cJSON_AddStringToObject(ok, "description", "OK");
        if (r.websocket) {
            cJSON_AddTrueToObject(op, "x-websocket");
        }
    }

    cJSON_AddItemToObject(root, "x-commands", command_catalog());
    cJSON* mqtt = cJSON_AddObjectToObject(root, "x-mqtt");
    cJSON_AddStringToObject(mqtt, "root", mqtt_topic_root());
    char prefix[80];
    snprintf(prefix, sizeof(prefix), "%s/%s", mqtt_topic_root(), device_topic_id());
    cJSON_AddStringToObject(mqtt, "prefix", prefix);
    cJSON_AddItemToObject(mqtt, "topics", mqtt_topics_json());

    cJSON* disc = cJSON_AddObjectToObject(root, "x-discovery");
    cJSON_AddStringToObject(disc, "mdns", hostname());
    cJSON_AddStringToObject(disc, "service", "_http._tcp");
    cJSON_AddStringToObject(disc, "de_service", "_de-esp32._tcp");
    cJSON_AddStringToObject(disc, "board", board_profile().id);
    cJSON_AddNumberToObject(disc, "port", 80);
    return root;
}

esp_err_t api_openapi(httpd_req_t* req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return send_json(req, openapi_json());
}

}  // namespace

esp_err_t web_server_start() {
    s_ws_mu = xSemaphoreCreateMutex();
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.lru_purge_enable = true;
    config.max_uri_handlers = 28;
    config.max_open_sockets = 13;  // phones fire many captive-probe connections
    config.stack_size = 8192;
    config.recv_wait_timeout = 60;  // large OTA uploads over SoftAP
    config.send_wait_timeout = 30;
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.close_fn = on_sess_close;
    esp_log_level_set("httpd_uri", ESP_LOG_ERROR);
    esp_log_level_set("httpd_txrx", ESP_LOG_ERROR);
    esp_log_level_set("httpd_parse", ESP_LOG_ERROR);
    if (httpd_start(&s_server, &config) != ESP_OK) {
        return ESP_FAIL;
    }

    for (const ApiRoute& r : kRoutes) {
        httpd_uri_t u{};
        u.uri = r.path;
        u.method = r.method;
        u.handler = r.handler;
        u.is_websocket = r.websocket;
        httpd_register_uri_handler(s_server, &u);
    }
    httpd_register_err_handler(s_server, HTTPD_404_NOT_FOUND, captive_404);
    event_bus_subscribe("", on_bus, nullptr);
    ESP_LOGI(TAG, "HTTP+WS on :80");
    return ESP_OK;
}

}  // namespace runtime
