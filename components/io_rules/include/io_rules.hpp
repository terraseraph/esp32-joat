#pragma once

#include <cstddef>
#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

esp_err_t io_rules_init();
esp_err_t io_rules_apply_saved();
/** Upsert one rule (one per source GPIO). Caller keeps `spec`. */
esp_err_t io_rules_set(cJSON* spec, char* err, size_t err_len);
esp_err_t io_rules_remove(const char* id_or_empty, int gpio, char* err, size_t err_len);
/** `{v, rules:[...]}`. Caller deletes. */
cJSON* io_rules_list_json();
/** Recompute ADC live-sink after pin modes change. */
void io_rules_on_io_change();

}  // namespace runtime
