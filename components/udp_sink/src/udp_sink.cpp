#include "udp_sink.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "config_manager.hpp"
#include "device_identity.hpp"
#include "esp_log.h"
#include "esp_timer.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "json_util.hpp"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "network_manager.hpp"
#include "runtime_status.hpp"
#include "runtime_version.hpp"

static const char* TAG = "udp";

namespace runtime {
namespace {

constexpr int kMaxTargets = 2;
constexpr size_t kMaxDatagram = 1400;  // stay inside one Wi-Fi frame; never fragment
constexpr char kAnnounceDefault[] = "239.255.77.1:7701";  // administratively scoped, local only
constexpr int kAnnounceSecDefault = 5;
constexpr int kAnnounceSecMin = 2;
constexpr int kAnnounceSecMax = 60;

struct Target {
    char text[24];  // "255.255.255.255:65535"
    sockaddr_in addr;
};

// s_mu guards everything below: io producer tasks and the announce timer send,
// command tasks reconfigure.
SemaphoreHandle_t s_mu;
int s_sock = -1;  // shared by the io stream and the announce; open when either is on
Target s_targets[kMaxTargets];
int s_ntargets;
bool s_enabled;
bool s_active;  // io stream is sending
uint32_t s_seq;
uint32_t s_sent;
uint32_t s_failed;
uint32_t s_oversize;

bool s_announce;
Target s_announce_to;
int s_announce_s = kAnnounceSecDefault;
uint32_t s_announced;
esp_timer_handle_t s_timer;

bool parse_target(const char* s, Target* out) {
    if (!s) {
        return false;
    }
    const char* colon = strrchr(s, ':');
    if (!colon || colon == s) {
        return false;
    }
    char host[16];
    const size_t hl = static_cast<size_t>(colon - s);
    if (hl >= sizeof(host)) {
        return false;
    }
    memcpy(host, s, hl);
    host[hl] = '\0';
    char* end = nullptr;
    const long port = strtol(colon + 1, &end, 10);
    if (end == colon + 1 || *end || port < 1 || port > 65535) {
        return false;
    }
    memset(&out->addr, 0, sizeof(out->addr));
    out->addr.sin_family = AF_INET;
    out->addr.sin_port = htons(static_cast<uint16_t>(port));
    if (inet_pton(AF_INET, host, &out->addr.sin_addr) != 1) {
        return false;
    }
    snprintf(out->text, sizeof(out->text), "%s:%ld", host, port);
    return true;
}

// Caller holds s_mu. Opens or closes the socket to match the settings.
void reopen_locked() {
    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
    const bool stream = s_enabled && s_ntargets > 0;
    s_active = false;
    if (!stream && !s_announce) {
        return;
    }
    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) {
        ESP_LOGW(TAG, "socket failed errno=%d", errno);
        return;
    }
    const int on = 1;
    setsockopt(s_sock, SOL_SOCKET, SO_BROADCAST, &on, sizeof(on));
    const uint8_t ttl = 1;  // multicast stays on the local network
    setsockopt(s_sock, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
    s_active = stream;
}

// Not under s_mu: esp_timer has its own locking and the callback takes s_mu.
void apply_timer(bool announce, int seconds) {
    if (!s_timer) {
        return;
    }
    esp_timer_stop(s_timer);  // fails harmlessly when it was not running
    if (announce) {
        esp_timer_start_periodic(s_timer, static_cast<uint64_t>(seconds) * 1000000ULL);
    }
}

void on_io(const char* topic, cJSON* payload, void*) {
    if (!RuntimeStatus::instance().live_udp()) {
        return;
    }
    size_t len = 0;
    const char* frame = event_bus_frame(topic, payload, &len);  // shared, freed by the bus
    if (!frame || len < 2) {
        return;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (!s_active || s_sock < 0) {
        xSemaphoreGive(s_mu);
        return;
    }
    // The frame is {"topic":..,"data":..}; send {"id":..,"seq":.., then the frame minus its
    // opening brace, as two pieces so nothing is copied.
    char head[48];
    const int hn = snprintf(head, sizeof(head), "{\"id\":\"%s\",\"seq\":%u,", device_id(),
                            static_cast<unsigned>(s_seq + 1));
    if (hn <= 0 || hn >= static_cast<int>(sizeof(head)) || hn + len - 1 > kMaxDatagram) {
        s_oversize++;
        xSemaphoreGive(s_mu);
        return;
    }
    s_seq++;
    iovec iov[2];
    iov[0].iov_base = head;
    iov[0].iov_len = static_cast<size_t>(hn);
    iov[1].iov_base = const_cast<char*>(frame + 1);
    iov[1].iov_len = len - 1;
    for (int i = 0; i < s_ntargets; ++i) {
        msghdr msg{};
        msg.msg_name = &s_targets[i].addr;
        msg.msg_namelen = sizeof(s_targets[i].addr);
        msg.msg_iov = iov;
        msg.msg_iovlen = 2;
        // Never wait: a datagram that cannot go now is dropped, the next value replaces it.
        if (sendmsg(s_sock, &msg, MSG_DONTWAIT) < 0) {
            s_failed++;
        } else {
            s_sent++;
        }
    }
    xSemaphoreGive(s_mu);
}

// esp_timer task, every s_announce_s seconds: who this device is and where to reach it.
// Built with cJSON because the device name is user text and needs escaping.
void announce_cb(void*) {
    cJSON* o = cJSON_CreateObject();
    if (!o) {
        return;
    }
    const char* ip = sta_ip();
    cJSON_AddStringToObject(o, "announce", "de-esp32");
    cJSON_AddStringToObject(o, "id", device_id());
    cJSON_AddStringToObject(o, "name", device_name());
    cJSON_AddStringToObject(o, "host", hostname());
    cJSON_AddStringToObject(o, "ip", (ip && ip[0]) ? ip : ap_ip());
    cJSON_AddStringToObject(o, "fw", RUNTIME_VERSION);
    cJSON_AddNumberToObject(o, "http", 80);
    char* printed = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (!printed) {
        return;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (s_announce && s_sock >= 0 &&
        sendto(s_sock, printed, strlen(printed), MSG_DONTWAIT,
               reinterpret_cast<const sockaddr*>(&s_announce_to.addr),
               sizeof(s_announce_to.addr)) >= 0) {
        s_announced++;
    }
    xSemaphoreGive(s_mu);
    cJSON_free(printed);
}

void target_key(char* out, size_t n, int i) { snprintf(out, n, "t%d", i); }

}  // namespace

esp_err_t udp_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    parse_target(kAnnounceDefault, &s_announce_to);
    if (!s_timer) {
        esp_timer_create_args_t args{};
        args.callback = announce_cb;
        args.name = "udp_announce";
        esp_timer_create(&args, &s_timer);
    }
    event_bus_subscribe("io/", on_io, nullptr);
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t udp_start() {
    uint8_t enabled = 0;
    uint8_t announce = 0;
    uint8_t announce_s = kAnnounceSecDefault;
    config_get_u8("udp", "enabled", &enabled);
    config_get_u8("udp", "ann", &announce);
    config_get_u8("udp", "ann_s", &announce_s);
    char ann_addr[24] = {0};
    size_t an = sizeof(ann_addr);
    config_get_str("udp", "ann_addr", ann_addr, &an);

    xSemaphoreTake(s_mu, portMAX_DELAY);
    s_enabled = enabled != 0;
    s_ntargets = 0;
    for (int i = 0; i < kMaxTargets; ++i) {
        char key[4];
        target_key(key, sizeof(key), i);
        char text[24] = {0};
        size_t n = sizeof(text);
        if (config_get_str("udp", key, text, &n) == ESP_OK && text[0] &&
            parse_target(text, &s_targets[s_ntargets])) {
            s_ntargets++;
        }
    }
    s_announce = announce != 0;
    if (announce_s >= kAnnounceSecMin && announce_s <= kAnnounceSecMax) {
        s_announce_s = announce_s;
    }
    Target ann;
    if (ann_addr[0] && parse_target(ann_addr, &ann)) {
        s_announce_to = ann;
    }
    reopen_locked();
    const bool active = s_active;
    const bool ann_on = s_announce && s_sock >= 0;
    const int ann_s = s_announce_s;
    const int targets = s_ntargets;
    xSemaphoreGive(s_mu);
    RuntimeStatus::instance().set_live_udp(active);
    apply_timer(ann_on, ann_s);
    ESP_LOGI(TAG, "io %s, %d target(s); announce %s", active ? "sending" : "off", targets,
             ann_on ? "on" : "off");
    return ESP_OK;
}

esp_err_t udp_configure(cJSON* req, char* err, size_t err_len) {
    if (err && err_len) {
        err[0] = '\0';
    }
    Target next[kMaxTargets];
    int nnext = -1;  // -1: keep the saved targets
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(req, "targets");
    if (arr) {
        if (!cJSON_IsArray(arr) || cJSON_GetArraySize(arr) > kMaxTargets) {
            snprintf(err, err_len, "targets must be an array of up to %d \"ipv4:port\"", kMaxTargets);
            return ESP_ERR_INVALID_ARG;
        }
        nnext = 0;
        cJSON* it = nullptr;
        cJSON_ArrayForEach(it, arr) {
            if (!cJSON_IsString(it) || !parse_target(it->valuestring, &next[nnext])) {
                snprintf(err, err_len, "target must be \"ipv4:port\", e.g. 192.168.1.10:9000");
                return ESP_ERR_INVALID_ARG;
            }
            nnext++;
        }
    }
    cJSON* ann_item = cJSON_GetObjectItemCaseSensitive(req, "announce");
    if (ann_item && !cJSON_IsBool(ann_item)) {
        snprintf(err, err_len, "announce must be true or false");
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* addr_item = cJSON_GetObjectItemCaseSensitive(req, "announce_addr");
    Target ann_next;
    if (addr_item && (!cJSON_IsString(addr_item) || !parse_target(addr_item->valuestring, &ann_next))) {
        snprintf(err, err_len, "announce_addr must be \"ipv4:port\", e.g. %s", kAnnounceDefault);
        return ESP_ERR_INVALID_ARG;
    }
    cJSON* sec_item = cJSON_GetObjectItemCaseSensitive(req, "announce_s");
    if (sec_item && (!cJSON_IsNumber(sec_item) || sec_item->valueint < kAnnounceSecMin ||
                     sec_item->valueint > kAnnounceSecMax)) {
        snprintf(err, err_len, "announce_s must be %d-%d", kAnnounceSecMin, kAnnounceSecMax);
        return ESP_ERR_INVALID_ARG;
    }

    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (nnext >= 0) {
        memcpy(s_targets, next, sizeof(next));
        s_ntargets = nnext;
    }
    s_enabled = json_bool(req, "enabled", s_ntargets > 0) && s_ntargets > 0;
    if (ann_item) {
        s_announce = cJSON_IsTrue(ann_item);
    }
    if (addr_item) {
        s_announce_to = ann_next;
    }
    if (sec_item) {
        s_announce_s = sec_item->valueint;
    }
    reopen_locked();
    const bool active = s_active;
    const bool enabled = s_enabled;
    const bool announce = s_announce;
    const bool ann_on = s_announce && s_sock >= 0;
    const int ann_s = s_announce_s;
    Target saved[kMaxTargets];
    memcpy(saved, s_targets, sizeof(saved));
    const int nsaved = s_ntargets;
    char ann_text[24];
    snprintf(ann_text, sizeof(ann_text), "%s", s_announce_to.text);
    xSemaphoreGive(s_mu);
    RuntimeStatus::instance().set_live_udp(active);
    apply_timer(ann_on, ann_s);

    esp_err_t rc = ESP_OK;
    if (nnext >= 0) {
        for (int i = 0; i < kMaxTargets && rc == ESP_OK; ++i) {
            char key[4];
            target_key(key, sizeof(key), i);
            rc = config_set_str("udp", key, i < nsaved ? saved[i].text : "");
        }
    }
    if (rc == ESP_OK) {
        rc = config_set_u8("udp", "enabled", enabled ? 1 : 0);
    }
    if (rc == ESP_OK && ann_item) {
        rc = config_set_u8("udp", "ann", announce ? 1 : 0);
    }
    if (rc == ESP_OK && addr_item) {
        rc = config_set_str("udp", "ann_addr", ann_text);
    }
    if (rc == ESP_OK && sec_item) {
        rc = config_set_u8("udp", "ann_s", static_cast<uint8_t>(ann_s));
    }
    if (rc != ESP_OK) {
        snprintf(err, err_len, "applied but not saved: %s", esp_err_to_name(rc));
    }
    ESP_LOGI(TAG, "io %s, %d target(s); announce %s", active ? "sending" : "off", nsaved,
             ann_on ? "on" : "off");
    return rc;
}

cJSON* udp_status_json() {
    cJSON* o = cJSON_CreateObject();
    xSemaphoreTake(s_mu, portMAX_DELAY);
    cJSON_AddBoolToObject(o, "enabled", s_enabled);
    cJSON_AddBoolToObject(o, "active", s_active);
    cJSON* arr = cJSON_AddArrayToObject(o, "targets");
    for (int i = 0; i < s_ntargets; ++i) {
        cJSON_AddItemToArray(arr, cJSON_CreateString(s_targets[i].text));
    }
    cJSON_AddNumberToObject(o, "sent", s_sent);
    cJSON_AddNumberToObject(o, "failed", s_failed);
    cJSON_AddNumberToObject(o, "oversize", s_oversize);
    cJSON_AddNumberToObject(o, "seq", s_seq);
    cJSON_AddBoolToObject(o, "announce", s_announce);
    cJSON_AddStringToObject(o, "announce_addr", s_announce_to.text);
    cJSON_AddNumberToObject(o, "announce_s", s_announce_s);
    cJSON_AddNumberToObject(o, "announced", s_announced);
    xSemaphoreGive(s_mu);
    return o;
}

}  // namespace runtime
