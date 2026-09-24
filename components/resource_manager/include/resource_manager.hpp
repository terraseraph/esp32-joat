#pragma once

#include "driver/i2c_master.h"
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

/** I2C_NUM_0 for i2c0, I2C_NUM_1 for i2c1. -1 if unknown. */
int resource_i2c_host(const char* bus_id);

/** First claim stores SDA/SCL/Hz, takes those GPIOs as bus_<id>, and creates the
 *  i2c_master bus. Later claims must match all three; refcount increments.
 *  hz must be 100000 or 400000. */
esp_err_t resource_i2c_claim(const char* bus_id, int sda, int scl, int hz, char* err,
                             size_t err_len);
/** Decrement refcount; at 0, delete the master bus and release SDA/SCL. */
esp_err_t resource_i2c_release(const char* bus_id);

i2c_master_bus_handle_t resource_i2c_bus(const char* bus_id);

esp_err_t resource_i2c_add_device(const char* bus_id, uint16_t addr, int hz,
                                  i2c_master_dev_handle_t* out, char* err, size_t err_len);
esp_err_t resource_i2c_rm_device(i2c_master_dev_handle_t dev);

}  // namespace runtime
