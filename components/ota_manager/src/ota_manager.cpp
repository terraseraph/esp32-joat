#include "ota_manager.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "runtime_version.hpp"

static const char* TAG = "ota";

namespace runtime {
namespace {

constexpr size_t kMinImage = 32768;
constexpr size_t kUrlMax = 384;
constexpr size_t kProgressStride = 65536;

SemaphoreHandle_t s_mu;
esp_ota_handle_t s_handle;
const esp_partition_t* s_dest;
const char* s_session = "idle";
size_t s_bytes;
size_t s_total;
size_t s_last_pub;
char s_last_err[96];
char s_incoming_ver[32];
char s_incoming_project[32];
uint8_t s_hdr[sizeof(esp_image_header_t)];
size_t s_hdr_len;
bool s_hdr_ok;

void set_err(char* err, size_t err_len, const char* msg) {
    const char* m = msg ? msg : "ota error";
    snprintf(s_last_err, sizeof(s_last_err), "%s", m);
    if (err && err_len) {
        snprintf(err, err_len, "%s", m);
    }
}

const char* image_state_name(esp_ota_img_states_t st) {
    switch (st) {
        case ESP_OTA_IMG_NEW:
            return "new";
        case ESP_OTA_IMG_PENDING_VERIFY:
            return "pending_verify";
        case ESP_OTA_IMG_VALID:
            return "valid";
        case ESP_OTA_IMG_INVALID:
            return "invalid";
        case ESP_OTA_IMG_ABORTED:
            return "aborted";
        default:
            return "undefined";
    }
}

void publish_progress(bool force) {
    if (!force && s_bytes > 0 && s_bytes - s_last_pub < kProgressStride) {
        return;
    }
    s_last_pub = s_bytes;
    cJSON* p = cJSON_CreateObject();
    if (!p) {
        return;
    }
    cJSON_AddStringToObject(p, "session", s_session);
    cJSON_AddNumberToObject(p, "bytes", static_cast<double>(s_bytes));
    cJSON_AddNumberToObject(p, "total", static_cast<double>(s_total));
    int pct = 0;
    if (s_total) {
        pct = static_cast<int>((s_bytes * 100U) / s_total);
        if (pct > 100) {
            pct = 100;
        }
    }
    cJSON_AddNumberToObject(p, "percent", pct);
    if (s_last_err[0]) {
        cJSON_AddStringToObject(p, "error", s_last_err);
    }
    event_bus_publish("ota/progress", p);
    cJSON_Delete(p);
}

void reset_session_locked(const char* session) {
    s_session = session;
    s_bytes = 0;
    s_total = 0;
    s_last_pub = 0;
    s_hdr_len = 0;
    s_hdr_ok = false;
    s_incoming_ver[0] = 0;
    s_incoming_project[0] = 0;
}

esp_err_t abort_locked() {
    esp_err_t rc = ESP_OK;
    if (s_handle) {
        rc = esp_ota_abort(s_handle);
        s_handle = 0;
    }
    s_dest = nullptr;
    reset_session_locked("idle");
    return rc;
}

bool url_ok(const char* url) {
    return url && (strncmp(url, "http://", 7) == 0 || strncmp(url, "https://", 8) == 0);
}

esp_err_t check_header_bytes(const uint8_t* data, size_t len, char* err, size_t err_len) {
    size_t need = sizeof(s_hdr) - s_hdr_len;
    size_t take = len < need ? len : need;
    if (take) {
        memcpy(s_hdr + s_hdr_len, data, take);
        s_hdr_len += take;
    }
    if (s_hdr_len < sizeof(esp_image_header_t) || s_hdr_ok) {
        return ESP_OK;
    }
    const auto* hdr = reinterpret_cast<const esp_image_header_t*>(s_hdr);
    if (hdr->magic != ESP_IMAGE_HEADER_MAGIC) {
        set_err(err, err_len, "not an ESP32 app image (bad magic)");
        return ESP_ERR_OTA_VALIDATE_FAILED;
    }
    if (hdr->chip_id != ESP_CHIP_ID_ESP32) {
        set_err(err, err_len, "image is not for classic ESP32");
        return ESP_ERR_OTA_VALIDATE_FAILED;
    }
    s_hdr_ok = true;
    return ESP_OK;
}

esp_err_t begin_locked(size_t expected_size, const char* session, bool claim_fetch, char* err,
                       size_t err_len) {
    if (s_handle) {
        set_err(err, err_len, "ota busy");
        return ESP_ERR_INVALID_STATE;
    }
    if (claim_fetch) {
        if (strcmp(s_session, "fetching") != 0 && strcmp(s_session, "idle") != 0) {
            set_err(err, err_len, "ota busy");
            return ESP_ERR_INVALID_STATE;
        }
    } else if (strcmp(s_session, "idle") != 0 && strcmp(s_session, "error") != 0) {
        set_err(err, err_len, "ota busy");
        return ESP_ERR_INVALID_STATE;
    }
    const esp_partition_t* update = esp_ota_get_next_update_partition(nullptr);
    if (!update) {
        set_err(err, err_len, "no OTA slot");
        return ESP_ERR_NOT_FOUND;
    }
    if (expected_size > 0 && expected_size > update->size) {
        set_err(err, err_len, "image larger than OTA slot");
        return ESP_ERR_INVALID_SIZE;
    }
    if (expected_size > 0 && expected_size < kMinImage) {
        set_err(err, err_len, "image too small");
        return ESP_ERR_INVALID_SIZE;
    }
    s_last_err[0] = 0;
    reset_session_locked(session);
    s_total = expected_size;
    s_dest = update;
    size_t begin_sz = expected_size ? expected_size : OTA_WITH_SEQUENTIAL_WRITES;
    esp_err_t rc = esp_ota_begin(update, begin_sz, &s_handle);
    if (rc != ESP_OK) {
        s_handle = 0;
        s_dest = nullptr;
        reset_session_locked("idle");
        if (rc == ESP_ERR_OTA_ROLLBACK_INVALID_STATE) {
            set_err(err, err_len, "running image still pending verify");
        } else {
            set_err(err, err_len, esp_err_to_name(rc));
        }
        return rc;
    }
    ESP_LOGI(TAG, "writing %s offset=0x%lx size=%u", update->label,
             (unsigned long)update->address, (unsigned)expected_size);
    return ESP_OK;
}

esp_err_t write_locked(const void* data, size_t len, char* err, size_t err_len) {
    if (!s_handle || !data) {
        set_err(err, err_len, "ota not started");
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t rc = check_header_bytes(static_cast<const uint8_t*>(data), len, err, err_len);
    if (rc != ESP_OK) {
        abort_locked();
        return rc;
    }
    rc = esp_ota_write(s_handle, data, len);
    if (rc != ESP_OK) {
        abort_locked();
        set_err(err, err_len, esp_err_to_name(rc));
        return rc;
    }
    s_bytes += len;
    return ESP_OK;
}

esp_err_t finish_locked(char* err, size_t err_len) {
    if (!s_handle || !s_dest) {
        set_err(err, err_len, "ota not started");
        return ESP_ERR_INVALID_STATE;
    }
    if (s_bytes < kMinImage) {
        abort_locked();
        set_err(err, err_len, "image too small");
        return ESP_ERR_INVALID_SIZE;
    }
    if (!s_hdr_ok) {
        abort_locked();
        set_err(err, err_len, "not an ESP32 app image (bad magic)");
        return ESP_ERR_OTA_VALIDATE_FAILED;
    }
    esp_err_t rc = esp_ota_end(s_handle);
    s_handle = 0;
    if (rc != ESP_OK) {
        s_dest = nullptr;
        reset_session_locked("idle");
        set_err(err, err_len, rc == ESP_ERR_OTA_VALIDATE_FAILED ? "image failed validation"
                                                                : esp_err_to_name(rc));
        return rc;
    }
    esp_app_desc_t nd{};
    rc = esp_ota_get_partition_description(s_dest, &nd);
    if (rc != ESP_OK) {
        s_dest = nullptr;
        reset_session_locked("idle");
        set_err(err, err_len, "could not read new app description");
        return rc;
    }
    snprintf(s_incoming_ver, sizeof(s_incoming_ver), "%s", nd.version);
    snprintf(s_incoming_project, sizeof(s_incoming_project), "%s", nd.project_name);
    const esp_app_desc_t* run = esp_app_get_description();
    if (run && strcmp(nd.project_name, run->project_name) != 0) {
        s_dest = nullptr;
        reset_session_locked("idle");
        set_err(err, err_len, "image project name does not match de_esp32_runtime");
        return ESP_ERR_OTA_VALIDATE_FAILED;
    }
    rc = esp_ota_set_boot_partition(s_dest);
    if (rc != ESP_OK) {
        s_dest = nullptr;
        reset_session_locked("idle");
        set_err(err, err_len, esp_err_to_name(rc));
        return rc;
    }
    ESP_LOGW(TAG, "boot slot %s version %s — reboot to apply", s_dest->label, nd.version);
    s_session = "rebooting";
    s_dest = nullptr;
    return ESP_OK;
}

struct UrlJob {
    char url[kUrlMax];
};

void fetch_task(void* arg) {
    UrlJob* job = static_cast<UrlJob*>(arg);
    char err[96];
    err[0] = 0;

    esp_http_client_config_t cfg{};
    cfg.url = job->url;
    cfg.timeout_ms = 30000;
    cfg.keep_alive_enable = true;
    cfg.buffer_size = 1024;
    cfg.user_agent = "de-esp32-runtime/" RUNTIME_VERSION;
    if (strncmp(job->url, "https://", 8) == 0) {
        cfg.crt_bundle_attach = esp_crt_bundle_attach;
    }

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        xSemaphoreTake(s_mu, portMAX_DELAY);
        set_err(err, sizeof(err), "http init failed");
        abort_locked();
        s_session = "error";
        publish_progress(true);
        xSemaphoreGive(s_mu);
        free(job);
        vTaskDelete(nullptr);
        return;
    }

    esp_err_t rc = esp_http_client_open(client, 0);
    int status = 0;
    int content_len = -1;
    if (rc == ESP_OK) {
        content_len = esp_http_client_fetch_headers(client);
        status = esp_http_client_get_status_code(client);
    }
    if (rc != ESP_OK || status != 200) {
        xSemaphoreTake(s_mu, portMAX_DELAY);
        set_err(err, sizeof(err), rc != ESP_OK ? esp_err_to_name(rc) : "HTTP not 200");
        abort_locked();
        s_session = "error";
        publish_progress(true);
        xSemaphoreGive(s_mu);
        esp_http_client_cleanup(client);
        free(job);
        vTaskDelete(nullptr);
        return;
    }

    size_t expected = content_len > 0 ? static_cast<size_t>(content_len) : 0;
    xSemaphoreTake(s_mu, portMAX_DELAY);
    rc = begin_locked(expected, "fetching", true, err, sizeof(err));
    if (rc != ESP_OK) {
        s_session = "error";
    }
    publish_progress(true);
    xSemaphoreGive(s_mu);
    if (rc != ESP_OK) {
        esp_http_client_cleanup(client);
        free(job);
        vTaskDelete(nullptr);
        return;
    }

    uint8_t buf[1024];
    while (true) {
        int n = esp_http_client_read(client, reinterpret_cast<char*>(buf), sizeof(buf));
        if (n < 0) {
            xSemaphoreTake(s_mu, portMAX_DELAY);
            set_err(err, sizeof(err), "HTTP read failed");
            abort_locked();
            s_session = "error";
            publish_progress(true);
            xSemaphoreGive(s_mu);
            esp_http_client_cleanup(client);
            free(job);
            vTaskDelete(nullptr);
            return;
        }
        if (n == 0) {
            break;
        }
        xSemaphoreTake(s_mu, portMAX_DELAY);
        rc = write_locked(buf, static_cast<size_t>(n), err, sizeof(err));
        if (rc != ESP_OK) {
            s_session = "error";
            publish_progress(true);
        } else {
            publish_progress(false);
        }
        xSemaphoreGive(s_mu);
        if (rc != ESP_OK) {
            esp_http_client_cleanup(client);
            free(job);
            vTaskDelete(nullptr);
            return;
        }
    }
    esp_http_client_cleanup(client);

    xSemaphoreTake(s_mu, portMAX_DELAY);
    rc = finish_locked(err, sizeof(err));
    publish_progress(true);
    xSemaphoreGive(s_mu);
    free(job);
    if (rc == ESP_OK) {
        ota_schedule_reboot();
    }
    vTaskDelete(nullptr);
}

void reboot_task(void*) {
    vTaskDelay(pdMS_TO_TICKS(800));
    esp_restart();
}

}  // namespace

esp_err_t ota_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    s_last_err[0] = 0;
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (running) {
        esp_ota_get_state_partition(running, &st);
    }
    ESP_LOGI(TAG, "running %s offset=0x%lx state=%s rollback=%d",
             running ? running->label : "?", running ? (unsigned long)running->address : 0,
             image_state_name(st), esp_ota_check_rollback_is_possible() ? 1 : 0);
    return ESP_OK;
}

esp_err_t ota_mark_valid(bool safe_mode) {
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (!running) {
        return ESP_OK;
    }
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (esp_ota_get_state_partition(running, &st) != ESP_OK) {
        return ESP_OK;
    }
    if (st != ESP_OTA_IMG_PENDING_VERIFY) {
        return ESP_OK;
    }
    if (safe_mode) {
        ESP_LOGE(TAG, "pending image entered safe mode — rolling back");
        return esp_ota_mark_app_invalid_rollback_and_reboot();
    }
    ESP_LOGI(TAG, "pending image healthy — cancel rollback");
    return esp_ota_mark_app_valid_cancel_rollback();
}

cJSON* ota_status_json() {
    cJSON* o = cJSON_CreateObject();
    const esp_app_desc_t* desc = esp_app_get_description();
    cJSON_AddStringToObject(o, "fw", RUNTIME_VERSION);
    if (desc) {
        cJSON_AddStringToObject(o, "idf", desc->idf_ver);
        cJSON_AddStringToObject(o, "app_version", desc->version);
        cJSON_AddStringToObject(o, "project", desc->project_name);
        cJSON_AddStringToObject(o, "compile_date", desc->date);
        cJSON_AddStringToObject(o, "compile_time", desc->time);
    }
    const esp_partition_t* running = esp_ota_get_running_partition();
    const esp_partition_t* update = esp_ota_get_next_update_partition(nullptr);
    if (running) {
        cJSON_AddStringToObject(o, "running_partition", running->label);
        cJSON_AddNumberToObject(o, "running_offset", running->address);
        cJSON_AddNumberToObject(o, "running_size", running->size);
        esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
        if (esp_ota_get_state_partition(running, &st) == ESP_OK) {
            cJSON_AddStringToObject(o, "image_state", image_state_name(st));
        }
    }
    if (update) {
        cJSON_AddStringToObject(o, "next_partition", update->label);
        cJSON_AddNumberToObject(o, "next_size", update->size);
    }
    cJSON_AddBoolToObject(o, "rollback_possible", esp_ota_check_rollback_is_possible());

    if (s_mu) {
        xSemaphoreTake(s_mu, portMAX_DELAY);
    }
    cJSON_AddBoolToObject(o, "busy", strcmp(s_session, "idle") != 0 && strcmp(s_session, "error") != 0);
    cJSON_AddStringToObject(o, "session", s_session);
    cJSON_AddNumberToObject(o, "bytes", static_cast<double>(s_bytes));
    cJSON_AddNumberToObject(o, "total", static_cast<double>(s_total));
    int pct = 0;
    if (s_total) {
        pct = static_cast<int>((s_bytes * 100U) / s_total);
        if (pct > 100) {
            pct = 100;
        }
    }
    cJSON_AddNumberToObject(o, "percent", pct);
    if (s_last_err[0]) {
        cJSON_AddStringToObject(o, "last_error", s_last_err);
    }
    if (s_incoming_ver[0]) {
        cJSON_AddStringToObject(o, "incoming_version", s_incoming_ver);
    }
    if (s_incoming_project[0]) {
        cJSON_AddStringToObject(o, "incoming_project", s_incoming_project);
    }
    if (s_mu) {
        xSemaphoreGive(s_mu);
    }
    return o;
}

bool ota_is_busy() {
    if (!s_mu) {
        return false;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    bool busy = strcmp(s_session, "idle") != 0 && strcmp(s_session, "error") != 0;
    xSemaphoreGive(s_mu);
    return busy;
}

esp_err_t ota_begin_write(size_t expected_size, char* err, size_t err_len) {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (strcmp(s_session, "error") == 0) {
        reset_session_locked("idle");
    }
    esp_err_t rc = begin_locked(expected_size, "writing", false, err, err_len);
    if (rc == ESP_OK) {
        publish_progress(true);
    }
    xSemaphoreGive(s_mu);
    return rc;
}

esp_err_t ota_write_chunk(const void* data, size_t len, char* err, size_t err_len) {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    esp_err_t rc = write_locked(data, len, err, err_len);
    if (rc == ESP_OK) {
        publish_progress(false);
    } else {
        s_session = "error";
        publish_progress(true);
    }
    xSemaphoreGive(s_mu);
    return rc;
}

esp_err_t ota_finish_write(char* err, size_t err_len) {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    esp_err_t rc = finish_locked(err, err_len);
    if (rc != ESP_OK) {
        s_session = "error";
    }
    publish_progress(true);
    xSemaphoreGive(s_mu);
    return rc;
}

void ota_abort_write() {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    abort_locked();
    publish_progress(true);
    xSemaphoreGive(s_mu);
}

esp_err_t ota_apply_url(const char* url, char* err, size_t err_len) {
    if (!url_ok(url)) {
        set_err(err, err_len, "url must be http:// or https://");
        return ESP_ERR_INVALID_ARG;
    }
    if (strlen(url) >= kUrlMax) {
        set_err(err, err_len, "url too long");
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (s_handle || (strcmp(s_session, "idle") != 0 && strcmp(s_session, "error") != 0)) {
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "ota busy");
        return ESP_ERR_INVALID_STATE;
    }
    UrlJob* job = static_cast<UrlJob*>(calloc(1, sizeof(UrlJob)));
    if (!job) {
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "no mem");
        return ESP_ERR_NO_MEM;
    }
    snprintf(job->url, sizeof(job->url), "%s", url);
    s_last_err[0] = 0;
    reset_session_locked("fetching");
    publish_progress(true);
    xSemaphoreGive(s_mu);
    if (xTaskCreate(fetch_task, "ota_url", 12288, job, 5, nullptr) != pdPASS) {
        free(job);
        xSemaphoreTake(s_mu, portMAX_DELAY);
        reset_session_locked("idle");
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "could not start ota task");
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "fetch %s", url);
    return ESP_OK;
}

esp_err_t ota_rollback(char* err, size_t err_len) {
    if (ota_is_busy()) {
        set_err(err, err_len, "ota busy");
        return ESP_ERR_INVALID_STATE;
    }
    if (!esp_ota_check_rollback_is_possible()) {
        set_err(err, err_len, "no valid previous slot");
        return ESP_ERR_OTA_ROLLBACK_FAILED;
    }
    ESP_LOGW(TAG, "rolling back to previous slot");
    return esp_ota_mark_app_invalid_rollback_and_reboot();
}

void ota_schedule_reboot() {
    xTaskCreate(reboot_task, "ota_rb", 2048, nullptr, 6, nullptr);
}

}  // namespace runtime
