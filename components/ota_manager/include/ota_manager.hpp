#pragma once

#include <cstddef>

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t ota_init();
/** After a healthy boot: confirm pending image, or roll it back if we landed in safe mode. */
esp_err_t ota_mark_valid(bool safe_mode);
cJSON* ota_status_json();
bool ota_is_busy();

/** Stream an app image into the inactive slot. `expected_size` 0 = unknown. */
esp_err_t ota_begin_write(size_t expected_size, char* err, size_t err_len);
esp_err_t ota_write_chunk(const void* data, size_t len, char* err, size_t err_len);
esp_err_t ota_finish_write(char* err, size_t err_len);
void ota_abort_write();

/** Fetch `http://` or `https://` (public CA bundle) on a background task, then reboot. */
esp_err_t ota_apply_url(const char* url, char* err, size_t err_len);

/** Reboot into the previous valid slot. Does not return on success. */
esp_err_t ota_rollback(char* err, size_t err_len);

void ota_schedule_reboot();

}  // namespace runtime
