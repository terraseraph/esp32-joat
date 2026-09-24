#pragma once

#include <cstddef>

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

/** First sample for this stage name wins. Later calls with the same name are ignored. */
void memory_boot_mark(const char* stage);

/** Refuse when pressure is already critical, the block will not fit, or free heap
 *  would fall below the 24 KB reserve. err receives bytes needed, largest, and free. */
esp_err_t memory_admit(size_t internal_bytes, size_t dma_bytes, char* err, size_t err_len);

/** Caller deletes. Includes pressure, pools, boot marks, and cached task stacks. */
cJSON* memory_status_json();

void memory_hooks_init();

}  // namespace runtime
