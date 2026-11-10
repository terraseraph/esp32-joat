#include "network_manager.hpp"

#include <cstdio>
#include <cstring>
#include <ctime>

#include "lwip/ip4_addr.h"

#include "board_profiles.hpp"
#include "config_manager.hpp"
#include "device_identity.hpp"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mdns.h"
#include "runtime_status.hpp"
#include "runtime_version.hpp"
#include "security.hpp"

static const char* TAG = "network";

static const int GOT_IP_BIT = BIT0;
static const int FAIL_BIT = BIT1;
static const int SCAN_DONE_BIT = BIT2;

namespace runtime {
namespace {

EventGroupHandle_t s_wifi_eg;
SemaphoreHandle_t s_mu;
NetState s_state = NetState::kIdle;
esp_netif_t* s_sta;
esp_netif_t* s_ap;
char s_sta_ip[16];
char s_ap_ip[16] = "192.168.4.1";
int s_rssi;
int s_retry;
bool s_mdns;
bool s_want_ap;
char s_pending_ssid[33];
char s_pending_pass[65];
char s_captive_uri[] = "http://192.168.4.1";
// Wi-Fi change bookkeeping (network_try_sta / network_commit_wifi). See README "Safe Wi-Fi change".
bool s_sta_link;          // associated (WIFI_EVENT_STA_CONNECTED seen, no disconnect since)
uint8_t s_last_reason;    // last STA disconnect reason this test, 0 = none
bool s_restore_sta_only;  // on next GOT_IP: drop the SoftAP the test raised (old mode was STA)
volatile bool s_swapping; // switch_sta() in progress: event handler must not reconnect or fail
volatile bool s_testing;  // network_try_sta() running: network_watch_tick() stands aside
// Outage handling (network_watch_tick). See README "Lost network".
constexpr int kFastRetries = 8;          // back-to-back reconnects after a drop
constexpr uint32_t kBgRetryMs = 30000;   // then one attempt this often, only with no AP clients
constexpr uint32_t kApStableMs = 60000;  // STA up this long with no AP clients -> auto SoftAP off
uint8_t s_ap_clients;           // stations on our SoftAP (event task writes)
bool s_auto_ap;                 // SoftAP raised by us (outage or Wi-Fi change), not by the user
bool s_sta_down;                // saved network not connected since s_sta_down_tick
TickType_t s_sta_down_tick;
TickType_t s_sta_up_tick;
TickType_t s_bg_tick;

bool elapsed(TickType_t since, TickType_t now, uint32_t ms) {
    return static_cast<TickType_t>(now - since) >= pdMS_TO_TICKS(ms);
}
struct WifiChange {
    const char* result = "none";  // none | testing | ok | failed
    const char* reason = "";      // auth | no_ap | no_ip | timeout | connect_failed | save_failed
    char ssid[33] = {0};
    uint8_t disconnect_reason = 0;
    bool restored_previous = false;
    uint16_t seq = 0;
    uint32_t uptime_s = 0;
    int64_t epoch = 0;
} s_change;

void record_change(const char* result, const char* reason, const char* ssid, bool restored) {
    s_change.result = result;
    s_change.reason = reason ? reason : "";
    if (ssid) {
        snprintf(s_change.ssid, sizeof(s_change.ssid), "%s", ssid);
    }
    s_change.disconnect_reason = s_last_reason;
    s_change.restored_previous = restored;
    s_change.uptime_s = RuntimeStatus::instance().uptime_s();
    time_t now = time(nullptr);
    s_change.epoch = now > 1700000000 ? static_cast<int64_t>(now) : 0;  // 0 until SNTP set the clock
}

// Why a test failed. Mirrored by test/test_wifi_change_spec.py - keep both in sync.
const char* classify_failure(bool associated, uint8_t reason) {
    if (associated) {
        return "no_ip";  // joined the AP but DHCP never answered
    }
    switch (reason) {
        case 0:
            return "timeout";
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return "no_ap";
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_AUTH_EXPIRE:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_MIC_FAILURE:
        case WIFI_REASON_802_1X_AUTH_FAILED:
            return "auth";
        default:
            return "connect_failed";
    }
}

bool load_saved_wifi(char* ssid, size_t ssid_len, char* pass, size_t pass_len) {
    size_t slen = ssid_len;
    if (config_get_str("network", "ssid", ssid, &slen) != ESP_OK || !ssid[0]) {
        ssid[0] = '\0';
        return false;
    }
    size_t plen = pass_len;
    if (config_get_str("network", "password", pass, &plen) != ESP_OK) {
        pass[0] = '\0';
    }
    return true;
}

void setup_ap_dhcp() {
    if (!s_ap) {
        return;
    }
    esp_err_t err = esp_netif_dhcps_stop(s_ap);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) {
        ESP_LOGW(TAG, "DHCP stop %s", esp_err_to_name(err));
    }
    uint8_t offer_dns = 1;
    err = esp_netif_dhcps_option(s_ap, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &offer_dns,
                                 sizeof(offer_dns));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "DHCP DNS offer %s", esp_err_to_name(err));
    }
    err = esp_netif_dhcps_option(s_ap, ESP_NETIF_OP_SET, ESP_NETIF_CAPTIVEPORTAL_URI, s_captive_uri,
                                 strlen(s_captive_uri));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "DHCP captive URI %s", esp_err_to_name(err));
    }
    esp_netif_dns_info_t dns{};
    dns.ip.type = ESP_IPADDR_TYPE_V4;
    dns.ip.u_addr.ip4.addr = ESP_IP4TOADDR(192, 168, 4, 1);
    esp_netif_set_dns_info(s_ap, ESP_NETIF_DNS_MAIN, &dns);
    err = esp_netif_dhcps_start(s_ap);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED) {
        ESP_LOGW(TAG, "DHCP start %s", esp_err_to_name(err));
    }
}

void set_state(NetState st) {
    s_state = st;
    cJSON* ev = cJSON_CreateObject();
    cJSON_AddStringToObject(ev, "state", network_state_name());
    cJSON_AddStringToObject(ev, "sta_ip", s_sta_ip);
    event_bus_publish("net", ev);
    cJSON_Delete(ev);
}

void wifi_event(void*, esp_event_base_t base, int32_t id, void* data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (s_pending_ssid[0]) {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        s_sta_link = true;
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        s_ap_clients++;
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STADISCONNECTED) {
        if (s_ap_clients) {
            s_ap_clients--;
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STOP) {
        s_ap_clients = 0;
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        auto* ev = static_cast<wifi_event_sta_disconnected_t*>(data);
        ESP_LOGW(TAG, "STA disconnected reason=%d", ev ? ev->reason : -1);
        s_sta_link = false;
        // ASSOC_LEAVE is our own esp_wifi_disconnect(); it says nothing about the new network.
        if (ev && ev->reason != WIFI_REASON_ASSOC_LEAVE) {
            s_last_reason = ev->reason;
        }
        s_sta_ip[0] = '\0';
        if (!s_sta_down) {
            s_sta_down = true;
            s_sta_down_tick = xTaskGetTickCount();
        }
        if (s_swapping) {
            // switch_sta() is replacing the STA config and calls esp_wifi_connect() itself.
            return;
        }
        s_retry++;
        if (s_retry < kFastRetries && s_pending_ssid[0]) {
            esp_wifi_connect();
            set_state(NetState::kStaConnecting);
        } else {
            xEventGroupSetBits(s_wifi_eg, FAIL_BIT);
            if (s_want_ap || !config_has_wifi()) {
                set_state(s_want_ap ? NetState::kApStaRecovery : NetState::kApOnly);
            } else {
                // Saved network unreachable: network_watch_tick() keeps retrying it and raises the
                // recovery SoftAP once it has been down for the configured time.
                set_state(NetState::kStaConnecting);
            }
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        xEventGroupSetBits(s_wifi_eg, SCAN_DONE_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* ev = static_cast<ip_event_got_ip_t*>(data);
        snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&ev->ip_info.ip));
        s_retry = 0;
        s_sta_down = false;
        s_sta_up_tick = xTaskGetTickCount();
        xEventGroupSetBits(s_wifi_eg, GOT_IP_BIT);
        wifi_ap_record_t ap{};
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            s_rssi = ap.rssi;
        }
        ESP_LOGI(TAG, "got IP %s rssi=%d", s_sta_ip, s_rssi);
        if (s_restore_sta_only) {
            // Back on the previous network after a failed change: drop the SoftAP the test raised.
            s_restore_sta_only = false;
            s_want_ap = false;
            esp_wifi_set_mode(WIFI_MODE_STA);
            ESP_LOGI(TAG, "previous network restored; SoftAP off");
        }
        set_state(s_want_ap ? NetState::kApStaRecovery : NetState::kStaConnected);
        network_start_mdns();
    }
}

esp_err_t apply_ap_config() {
    wifi_config_t ap{};
    snprintf(reinterpret_cast<char*>(ap.ap.ssid), sizeof(ap.ap.ssid), "%s", ap_ssid());
    ap.ap.ssid_len = strlen(ap_ssid());
    ap.ap.max_connection = 4;
    ap.ap.channel = 1;
    ap.ap.pmf_cfg.required = false;
    if (ap_is_open()) {
        ap.ap.authmode = WIFI_AUTH_OPEN;
        ap.ap.password[0] = 0;
    } else {
        snprintf(reinterpret_cast<char*>(ap.ap.password), sizeof(ap.ap.password), "%s", ap_password());
        ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
    }
    return esp_wifi_set_config(WIFI_IF_AP, &ap);
}

esp_err_t apply_sta_config(const char* ssid, const char* pass) {
    wifi_config_t sta{};
    snprintf(reinterpret_cast<char*>(sta.sta.ssid), sizeof(sta.sta.ssid), "%s", ssid ? ssid : "");
    snprintf(reinterpret_cast<char*>(sta.sta.password), sizeof(sta.sta.password), "%s",
             pass ? pass : "");
    sta.sta.threshold.authmode = WIFI_AUTH_WPA_WPA2_PSK;
    sta.sta.pmf_cfg.capable = true;
    return esp_wifi_set_config(WIFI_IF_STA, &sta);
}

// Point the STA at ssid/pass and start connecting. Used by the test and by the rollback.
// esp_wifi_set_config(STA) fails with ESP_ERR_WIFI_STATE while a connect is in flight, and the
// event handler would otherwise reconnect (or raise FAIL_BIT) on our own disconnect, so the
// handler stands aside while s_swapping is set.
void switch_sta(const char* ssid, const char* pass, bool connect = true) {
    s_swapping = true;
    esp_wifi_disconnect();
    esp_err_t err = apply_sta_config(ssid, pass);
    for (int i = 0; err == ESP_ERR_WIFI_STATE && i < 20; ++i) {
        vTaskDelay(pdMS_TO_TICKS(50));
        esp_wifi_disconnect();
        err = apply_sta_config(ssid, pass);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "STA config %s", esp_err_to_name(err));
    }
    snprintf(s_pending_ssid, sizeof(s_pending_ssid), "%s", ssid);
    snprintf(s_pending_pass, sizeof(s_pending_pass), "%s", pass ? pass : "");
    s_retry = 0;
    s_sta_link = false;
    xEventGroupClearBits(s_wifi_eg, GOT_IP_BIT | FAIL_BIT);
    set_state(NetState::kStaConnecting);
    s_swapping = false;
    if (connect) {
        esp_wifi_connect();
    } else {
        s_retry = kFastRetries;  // leave it to network_watch_tick()'s background retry
    }
}

// Go back to the saved network after a failed test. Returns at once; the event handler finishes
// the reconnect (8 retries, then background retry - same as at boot).
// With a client on our SoftAP (setup over 192.168.4.1) only the config is restored: joining the old
// network, or scanning for it, moves the SoftAP channel and can drop that client before it reads
// wifi_change. The background retry reconnects once the AP has no clients.
void rollback_sta(const char* ssid, const char* pass, bool sta_only) {
    s_restore_sta_only = sta_only;
    bool now = s_ap_clients == 0;
    ESP_LOGW(TAG, "wifi change failed - %s saved ssid=%s", now ? "reconnecting to" : "restored (AP client attached)", ssid);
    switch_sta(ssid, pass, now);
}

}  // namespace

void on_identity_rename(const char*, cJSON*, void*);

esp_err_t network_init() {
    s_mu = xSemaphoreCreateMutex();
    s_wifi_eg = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_sta = esp_netif_create_default_wifi_sta();
    s_ap = esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event, nullptr));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    event_bus_subscribe("identity/", on_identity_rename, nullptr);
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t network_start() {
    char ssid[33] = {0};
    char pass[65] = {0};
    size_t slen = sizeof(ssid);
    size_t plen = sizeof(pass);
    bool have = config_get_str("network", "ssid", ssid, &slen) == ESP_OK && ssid[0];
    if (have) {
        size_t p2 = sizeof(pass);
        config_get_str("network", "password", pass, &p2);
    }

    s_want_ap = !have;
    s_sta_down = have;
    s_sta_down_tick = xTaskGetTickCount();
    snprintf(s_pending_ssid, sizeof(s_pending_ssid), "%s", have ? ssid : "");
    snprintf(s_pending_pass, sizeof(s_pending_pass), "%s", have ? pass : "");

    if (have) {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        apply_sta_config(ssid, pass);
        set_state(NetState::kStaConnecting);
    } else {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
        apply_ap_config();
        set_state(NetState::kApOnly);
        ESP_LOGI(TAG, "unprovisioned - SoftAP SSID=%s auth=%s", ap_ssid(),
                 ap_is_open() ? "open" : "WPA2");
        ESP_LOGI(TAG, "portal http://%s  mDNS %s.local after STA", ap_ip(), hostname());
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    setup_ap_dhcp();
    if (have) {
        esp_wifi_connect();
    }
    return ESP_OK;
}

NetState network_state() { return s_state; }

const char* network_state_name() {
    switch (s_state) {
        case NetState::kIdle:
            return "idle";
        case NetState::kApOnly:
            return "ap_only";
        case NetState::kStaConnecting:
            return "sta_connecting";
        case NetState::kStaConnected:
            return "sta_connected";
        case NetState::kApStaRecovery:
            return "apsta_recovery";
        default:
            return "unknown";
    }
}

const char* sta_ip() { return s_sta_ip; }
const char* ap_ip() { return s_ap_ip; }
int sta_rssi() { return s_rssi; }
bool sta_connected() { return s_sta_ip[0] != '\0'; }

esp_err_t network_enable_recovery_ap() {
    s_want_ap = true;
    s_auto_ap = false;  // asked for (BOOT hold, command, safe mode): stays up until reboot
    wifi_mode_t mode;
    esp_wifi_get_mode(&mode);
    if (mode != WIFI_MODE_APSTA) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
    }
    apply_ap_config();
    ESP_LOGW(TAG, "recovery SoftAP up SSID=%s auth=%s", ap_ssid(), ap_is_open() ? "open" : "WPA2");
    set_state(s_sta_ip[0] ? NetState::kApStaRecovery : NetState::kApOnly);
    return ESP_OK;
}

esp_err_t network_set_ap_password(const char* password) {
    esp_err_t err = set_ap_password(password);
    if (err != ESP_OK) {
        return err;
    }
    return apply_ap_config();
}

esp_err_t network_try_sta(const char* ssid, const char* password, int timeout_ms) {
    if (!ssid || !ssid[0]) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_mu, 0) != pdTRUE) {
        ESP_LOGW(TAG, "wifi test already running");
        return ESP_ERR_INVALID_STATE;
    }
    s_testing = true;
    // The saved network stays in NVS until network_commit_wifi; remember it so a failed test can
    // reconnect to it now instead of waiting for a reboot.
    char prev_ssid[33] = {0};
    char prev_pass[65] = {0};
    bool have_prev = load_saved_wifi(prev_ssid, sizeof(prev_ssid), prev_pass, sizeof(prev_pass));
    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&mode);
    bool prev_sta_only = mode == WIFI_MODE_STA && !s_want_ap;

    s_restore_sta_only = false;
    s_last_reason = 0;
    s_change.seq++;
    record_change("testing", nullptr, ssid, false);
    ESP_LOGI(TAG, "wifi test ssid=%s (saved=%s)", ssid, have_prev ? prev_ssid : "-");

    // Always test in APSTA so a phone on the portal stays connected.
    esp_wifi_set_mode(WIFI_MODE_APSTA);
    apply_ap_config();
    switch_sta(ssid, password);
    EventBits_t bits = xEventGroupWaitBits(s_wifi_eg, GOT_IP_BIT | FAIL_BIT, pdTRUE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    if (bits & GOT_IP_BIT) {
        // Result stays "testing" until network_commit_wifi saves it.
        s_testing = false;
        xSemaphoreGive(s_mu);
        return ESP_OK;
    }
    const char* why = classify_failure(s_sta_link, s_last_reason);
    ESP_LOGW(TAG, "wifi test ssid=%s failed: %s (reason=%u)", ssid, why, (unsigned)s_last_reason);
    record_change("failed", why, nullptr, have_prev);
    if (have_prev) {
        rollback_sta(prev_ssid, prev_pass, prev_sta_only);
    }
    // else first-time provisioning: nothing to go back to; the SoftAP stays up as before.
    s_testing = false;
    xSemaphoreGive(s_mu);
    return ESP_ERR_TIMEOUT;
}

esp_err_t network_commit_wifi(const char* ssid, const char* password) {
    esp_err_t err = config_set_str("network", "ssid", ssid);
    if (err == ESP_OK) {
        err = config_set_str("network", "password", password ? password : "");
    }
    if (err != ESP_OK) {
        // Running on the new network but it is not saved; a reboot goes back to the old one.
        record_change("failed", "save_failed", ssid, false);
        return err;
    }
    uint8_t provisioned = 1;
    config_set_u8("system", "provisioned", provisioned);
    s_want_ap = true;  // keep AP briefly so the portal can show STA IP
    s_auto_ap = true;  // network_watch_tick() drops it once the STA is stable and the AP is empty
    record_change("ok", nullptr, ssid, false);
    ESP_LOGI(TAG, "wifi committed ssid=%s sta_ip=%s mdns=%s.local", ssid, s_sta_ip, hostname());
    return ESP_OK;
}

esp_err_t network_clear_wifi() {
    config_erase_key("network", "ssid");
    config_erase_key("network", "password");
    config_set_u8("system", "provisioned", 0);
    s_pending_ssid[0] = '\0';
    s_pending_pass[0] = '\0';
    s_sta_ip[0] = '\0';
    s_want_ap = true;
    s_auto_ap = false;
    s_sta_down = false;
    esp_wifi_disconnect();
    esp_wifi_set_mode(WIFI_MODE_APSTA);
    apply_ap_config();
    set_state(NetState::kApOnly);
    ESP_LOGW(TAG, "wifi credentials cleared");
    return ESP_OK;
}

cJSON* network_scan() {
    xEventGroupClearBits(s_wifi_eg, SCAN_DONE_BIT);
    wifi_scan_config_t scan{};
    scan.show_hidden = false;
    scan.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    esp_err_t err = esp_wifi_scan_start(&scan, false);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "scan start %s", esp_err_to_name(err));
        return cJSON_CreateArray();
    }
    xEventGroupWaitBits(s_wifi_eg, SCAN_DONE_BIT, pdTRUE, pdFALSE, pdMS_TO_TICKS(8000));
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n > 24) {
        n = 24;
    }
    wifi_ap_record_t rec[24];
    uint16_t got = n;
    esp_wifi_scan_get_ap_records(&got, rec);
    cJSON* arr = cJSON_CreateArray();
    for (uint16_t i = 0; i < got; ++i) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", reinterpret_cast<const char*>(rec[i].ssid));
        cJSON_AddNumberToObject(o, "rssi", rec[i].rssi);
        cJSON_AddNumberToObject(o, "channel", rec[i].primary);
        cJSON_AddNumberToObject(o, "auth", rec[i].authmode);
        cJSON_AddItemToArray(arr, o);
    }
    return arr;
}

cJSON* network_status_json() {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "state", network_state_name());
    cJSON_AddStringToObject(o, "sta_ip", s_sta_ip);
    cJSON_AddStringToObject(o, "ap_ip", s_ap_ip);
    cJSON_AddStringToObject(o, "ap_ssid", ap_ssid());
    cJSON_AddBoolToObject(o, "ap_open", ap_is_open());
    cJSON_AddStringToObject(o, "hostname", hostname());
    cJSON_AddNumberToObject(o, "rssi", s_rssi);
    cJSON_AddBoolToObject(o, "provisioned", config_has_wifi());
    cJSON_AddBoolToObject(o, "sta_connected", sta_connected());
    cJSON_AddNumberToObject(o, "ap_clients", s_ap_clients);
    cJSON* wc = cJSON_AddObjectToObject(o, "wifi_change");
    if (wc) {
        cJSON_AddStringToObject(wc, "result", s_change.result);
        if (s_change.seq) {
            cJSON_AddStringToObject(wc, "ssid", s_change.ssid);
            cJSON_AddStringToObject(wc, "reason", s_change.reason);
            cJSON_AddNumberToObject(wc, "disconnect_reason", s_change.disconnect_reason);
            cJSON_AddBoolToObject(wc, "restored_previous", s_change.restored_previous);
            cJSON_AddNumberToObject(wc, "uptime_s", s_change.uptime_s);
            cJSON_AddNumberToObject(wc, "time", static_cast<double>(s_change.epoch));
            cJSON_AddNumberToObject(wc, "seq", s_change.seq);
        }
    }
    return o;
}

void network_start_mdns() {
    if (s_mdns) {
        mdns_hostname_set(hostname());
        return;
    }
    if (mdns_init() != ESP_OK) {
        ESP_LOGW(TAG, "mdns init failed");
        return;
    }
    mdns_hostname_set(hostname());
    mdns_instance_name_set(device_name());
    mdns_txt_item_t txt[] = {
        {"path", "/"},
        {"api", "/api/v1"},
        {"openapi", "/api/v1/openapi.json"},
        {"id", device_id()},
        {"name", device_name()},
        {"fw", RUNTIME_VERSION},
        {"board", board_profile().id},
    };
    const size_t ntxt = sizeof(txt) / sizeof(txt[0]);
    mdns_service_add(nullptr, "_http", "_tcp", 80, txt, ntxt);
    if (mdns_service_add(nullptr, "_de-esp32", "_tcp", 80, txt, ntxt) != ESP_OK) {
        ESP_LOGW(TAG, "mDNS _de-esp32._tcp add failed");
    }
    s_mdns = true;
    ESP_LOGI(TAG, "mDNS %s.local _http._tcp + _de-esp32._tcp:80", hostname());
}

void network_mdns_refresh_identity() {
    if (!s_mdns) {
        return;
    }
    mdns_instance_name_set(device_name());
    mdns_service_txt_item_set("_http", "_tcp", "name", device_name());
    mdns_service_txt_item_set("_de-esp32", "_tcp", "name", device_name());
}

void on_identity_rename(const char*, cJSON*, void*) { network_mdns_refresh_identity(); }

bool network_watch_tick(uint32_t fail_ap_ms) {
    if (s_testing || s_swapping || !config_has_wifi()) {
        return false;
    }
    TickType_t now = xTaskGetTickCount();
    if (s_sta_down) {
        bool raised = false;
        if (!s_want_ap && elapsed(s_sta_down_tick, now, fail_ap_ms)) {
            ESP_LOGW(TAG, "saved network down %ums - recovery SoftAP up, still retrying",
                     (unsigned)fail_ap_ms);
            network_enable_recovery_ap();
            s_auto_ap = true;
            raised = true;
        }
        // One attempt at a time after the fast retries. Not while a client is on the SoftAP: each
        // attempt scans every channel and a join moves the SoftAP to the router's channel.
        if (s_retry >= kFastRetries && s_ap_clients == 0 && elapsed(s_bg_tick, now, kBgRetryMs)) {
            s_bg_tick = now;
            esp_wifi_connect();
        }
        return raised;
    }
    if (s_auto_ap && s_want_ap && s_ap_clients == 0 && sta_connected() &&
        elapsed(s_sta_up_tick, now, kApStableMs)) {
        s_auto_ap = false;
        s_want_ap = false;
        esp_wifi_set_mode(WIFI_MODE_STA);
        set_state(NetState::kStaConnected);
        ESP_LOGI(TAG, "station stable - SoftAP off");
    }
    return false;
}

void network_note_sta_lost_for_recovery() {
    network_enable_recovery_ap();
}

}  // namespace runtime
