#include "network_manager.hpp"

#include <cstdio>
#include <cstring>

#include "lwip/ip4_addr.h"

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
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        auto* ev = static_cast<wifi_event_sta_disconnected_t*>(data);
        ESP_LOGW(TAG, "STA disconnected reason=%d", ev ? ev->reason : -1);
        s_sta_ip[0] = '\0';
        s_retry++;
        if (s_retry < 8 && s_pending_ssid[0]) {
            esp_wifi_connect();
            set_state(NetState::kStaConnecting);
        } else {
            xEventGroupSetBits(s_wifi_eg, FAIL_BIT);
            if (s_want_ap || !config_has_wifi()) {
                set_state(s_want_ap ? NetState::kApStaRecovery : NetState::kApOnly);
            } else {
                set_state(NetState::kApStaRecovery);
                network_enable_recovery_ap();
            }
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        xEventGroupSetBits(s_wifi_eg, SCAN_DONE_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* ev = static_cast<ip_event_got_ip_t*>(data);
        snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&ev->ip_info.ip));
        s_retry = 0;
        xEventGroupSetBits(s_wifi_eg, GOT_IP_BIT);
        wifi_ap_record_t ap{};
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            s_rssi = ap.rssi;
        }
        ESP_LOGI(TAG, "got IP %s rssi=%d", s_sta_ip, s_rssi);
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
    xEventGroupClearBits(s_wifi_eg, GOT_IP_BIT | FAIL_BIT);
    s_retry = 0;
    snprintf(s_pending_ssid, sizeof(s_pending_ssid), "%s", ssid);
    snprintf(s_pending_pass, sizeof(s_pending_pass), "%s", password ? password : "");
    wifi_mode_t mode;
    esp_wifi_get_mode(&mode);
    if (mode != WIFI_MODE_APSTA && mode != WIFI_MODE_STA) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
    } else if (mode == WIFI_MODE_STA) {
        // Keep AP available during first-provision test if already in APSTA.
    }
    // Always test in APSTA so the phone stays on the portal.
    esp_wifi_set_mode(WIFI_MODE_APSTA);
    apply_ap_config();
    apply_sta_config(ssid, password);
    set_state(NetState::kStaConnecting);
    esp_wifi_disconnect();
    esp_wifi_connect();
    EventBits_t bits = xEventGroupWaitBits(s_wifi_eg, GOT_IP_BIT | FAIL_BIT, pdTRUE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    if (bits & GOT_IP_BIT) {
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

esp_err_t network_commit_wifi(const char* ssid, const char* password) {
    esp_err_t err = config_set_str("network", "ssid", ssid);
    if (err != ESP_OK) {
        return err;
    }
    err = config_set_str("network", "password", password ? password : "");
    if (err != ESP_OK) {
        return err;
    }
    uint8_t provisioned = 1;
    config_set_u8("system", "provisioned", provisioned);
    s_want_ap = true;  // keep AP briefly so the portal can show STA IP
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
    };
    mdns_service_add(nullptr, "_http", "_tcp", 80, txt, sizeof(txt) / sizeof(txt[0]));
    s_mdns = true;
    ESP_LOGI(TAG, "mDNS %s.local _http._tcp:80", hostname());
}

void network_mdns_refresh_identity() {
    if (!s_mdns) {
        return;
    }
    mdns_instance_name_set(device_name());
    mdns_service_txt_item_set("_http", "_tcp", "name", device_name());
}

void on_identity_rename(const char*, cJSON*, void*) { network_mdns_refresh_identity(); }

void network_note_sta_lost_for_recovery() {
    network_enable_recovery_ap();
}

}  // namespace runtime
