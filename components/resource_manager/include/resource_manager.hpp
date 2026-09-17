#pragma once

#include "esp_err.h"

namespace runtime {

esp_err_t resource_init();
esp_err_t resource_claim(int gpio, const char* owner, char* err, size_t err_len);
esp_err_t resource_release(int gpio, const char* owner);
const char* resource_owner(int gpio);
void resource_release_all();

/** SPI2_HOST (1) for hspi, SPI3_HOST (2) for vspi. -1 if unknown. Never SPI1/flash. */
int resource_spi_host(const char* bus_id);

/** First claim on a bus stores SCK/MISO/MOSI and takes those GPIOs as bus_<id>.
 *  Later claims must match the same three pins; refcount increments. */
esp_err_t resource_spi_claim(const char* bus_id, int sck, int miso, int mosi, char* err,
                             size_t err_len);
/** Decrement refcount; at 0, release the three bus GPIOs. */
esp_err_t resource_spi_release(const char* bus_id);

}  // namespace runtime
