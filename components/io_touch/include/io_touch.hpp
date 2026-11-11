#pragma once

#include <cstddef>
#include "esp_err.h"

namespace runtime {

esp_err_t io_touch_init();
/**
 * Use a touch-capable GPIO (T0-T9) as a touch input. A touch lowers the pad's reading; the pad
 * counts as touched when it drops threshold_pct below its untouched baseline. The baseline is
 * measured now (keep fingers off) and then follows slow drift while the pad is not touched.
 */
esp_err_t io_touch_configure(int gpio, int threshold_pct, int sample_ms, char* err, size_t err_len);
esp_err_t io_touch_release(int gpio);
/** Store the latest reading of every touch pad in state_registry. No event bus. */
void io_touch_refresh();

}  // namespace runtime
