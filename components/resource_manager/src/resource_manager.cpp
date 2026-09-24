#include "resource_manager.hpp"

#include <cstdio>
#include <cstring>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* TAG = "resource";

namespace runtime {
namespace {

constexpr int kMaxGpio = 40;
char s_owner[kMaxGpio][24];
SemaphoreHandle_t s_mu;

struct SpiSlot {
    int refcount;
    int sck;
    int miso;
    int mosi;
};

// [0] hspi / SPI2_HOST, [1] vspi / SPI3_HOST
SpiSlot s_spi[2];

struct I2cSlot {
    int refcount;
    int sda;
    int scl;
    int hz;
    i2c_master_bus_handle_t bus;
};

// [0] i2c0 / I2C_NUM_0, [1] i2c1 / I2C_NUM_1
I2cSlot s_i2c[2];

int spi_index(const char* bus_id) {
    if (!bus_id) {
        return -1;
    }
    if (strcmp(bus_id, "hspi") == 0) {
        return 0;
    }
    if (strcmp(bus_id, "vspi") == 0) {
        return 1;
    }
    return -1;
}

const char* spi_bus_id(int idx) { return idx == 0 ? "hspi" : "vspi"; }

int i2c_index(const char* bus_id) {
    if (!bus_id) {
        return -1;
    }
    if (strcmp(bus_id, "i2c0") == 0) {
        return 0;
    }
    if (strcmp(bus_id, "i2c1") == 0) {
        return 1;
    }
    return -1;
}

const char* i2c_bus_id(int idx) { return idx == 0 ? "i2c0" : "i2c1"; }

esp_err_t claim_unlocked(int gpio, const char* owner, char* err, size_t err_len) {
    if (gpio < 0 || gpio >= kMaxGpio || !owner || !owner[0]) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_owner[gpio][0] && strcmp(s_owner[gpio], owner) != 0) {
        if (err && err_len) {
            snprintf(err, err_len, "gpio %d owned by %s", gpio, s_owner[gpio]);
        }
        return ESP_ERR_INVALID_STATE;
    }
    snprintf(s_owner[gpio], sizeof(s_owner[gpio]), "%s", owner);
    return ESP_OK;
}

void release_unlocked(int gpio, const char* owner) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return;
    }
    if (s_owner[gpio][0] && owner && strcmp(s_owner[gpio], owner) != 0) {
        return;
    }
    s_owner[gpio][0] = '\0';
}

void i2c_del_unlocked(int idx) {
    I2cSlot& slot = s_i2c[idx];
    if (slot.bus) {
        i2c_del_master_bus(slot.bus);
        slot.bus = nullptr;
    }
    char owner[24];
    snprintf(owner, sizeof(owner), "bus_%s", i2c_bus_id(idx));
    release_unlocked(slot.sda, owner);
    release_unlocked(slot.scl, owner);
    slot.refcount = 0;
    slot.sda = slot.scl = slot.hz = 0;
}

}  // namespace

esp_err_t resource_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    memset(s_owner, 0, sizeof(s_owner));
    memset(s_spi, 0, sizeof(s_spi));
    memset(s_i2c, 0, sizeof(s_i2c));
    ESP_LOGI(TAG, "init");
    return ESP_OK;
}

esp_err_t resource_claim(int gpio, const char* owner, char* err, size_t err_len) {
    if (gpio < 0 || gpio >= kMaxGpio || !owner) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    esp_err_t rc = claim_unlocked(gpio, owner, err, err_len);
    xSemaphoreGive(s_mu);
    return rc;
}

esp_err_t resource_release(int gpio, const char* owner) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (s_owner[gpio][0] && owner && strcmp(s_owner[gpio], owner) != 0) {
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_STATE;
    }
    s_owner[gpio][0] = '\0';
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

const char* resource_owner(int gpio) {
    if (gpio < 0 || gpio >= kMaxGpio) {
        return "";
    }
    return s_owner[gpio];
}

void resource_release_all() {
    xSemaphoreTake(s_mu, portMAX_DELAY);
    i2c_del_unlocked(0);
    i2c_del_unlocked(1);
    memset(s_owner, 0, sizeof(s_owner));
    memset(s_spi, 0, sizeof(s_spi));
    xSemaphoreGive(s_mu);
}

int resource_spi_host(const char* bus_id) {
    int idx = spi_index(bus_id);
    if (idx < 0) {
        return -1;
    }
    return idx == 0 ? 1 : 2;  // SPI2_HOST / SPI3_HOST
}

esp_err_t resource_spi_claim(const char* bus_id, int sck, int miso, int mosi, char* err,
                             size_t err_len) {
    int idx = spi_index(bus_id);
    if (idx < 0) {
        if (err && err_len) {
            snprintf(err, err_len, "unknown spi bus (use vspi or hspi)");
        }
        return ESP_ERR_INVALID_ARG;
    }
    if (sck < 0 || miso < 0 || mosi < 0 || sck == miso || sck == mosi || miso == mosi) {
        if (err && err_len) {
            snprintf(err, err_len, "spi %s needs distinct sck/miso/mosi", bus_id);
        }
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    SpiSlot& slot = s_spi[idx];
    if (slot.refcount > 0) {
        if (slot.sck != sck || slot.miso != miso || slot.mosi != mosi) {
            if (err && err_len) {
                snprintf(err, err_len, "spi %s pins must match sck=%d miso=%d mosi=%d", bus_id,
                         slot.sck, slot.miso, slot.mosi);
            }
            xSemaphoreGive(s_mu);
            return ESP_ERR_INVALID_STATE;
        }
        slot.refcount++;
        xSemaphoreGive(s_mu);
        return ESP_OK;
    }
    char owner[24];
    snprintf(owner, sizeof(owner), "bus_%s", spi_bus_id(idx));
    esp_err_t rc = claim_unlocked(sck, owner, err, err_len);
    if (rc == ESP_OK) {
        rc = claim_unlocked(miso, owner, err, err_len);
    }
    if (rc == ESP_OK) {
        rc = claim_unlocked(mosi, owner, err, err_len);
    }
    if (rc != ESP_OK) {
        release_unlocked(sck, owner);
        release_unlocked(miso, owner);
        release_unlocked(mosi, owner);
        xSemaphoreGive(s_mu);
        return rc;
    }
    slot.refcount = 1;
    slot.sck = sck;
    slot.miso = miso;
    slot.mosi = mosi;
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

esp_err_t resource_spi_release(const char* bus_id) {
    int idx = spi_index(bus_id);
    if (idx < 0) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    SpiSlot& slot = s_spi[idx];
    if (slot.refcount <= 0) {
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_STATE;
    }
    slot.refcount--;
    if (slot.refcount == 0) {
        char owner[24];
        snprintf(owner, sizeof(owner), "bus_%s", spi_bus_id(idx));
        release_unlocked(slot.sck, owner);
        release_unlocked(slot.miso, owner);
        release_unlocked(slot.mosi, owner);
        slot.sck = slot.miso = slot.mosi = 0;
    }
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

int resource_i2c_host(const char* bus_id) {
    int idx = i2c_index(bus_id);
    if (idx < 0) {
        return -1;
    }
    return idx;  // I2C_NUM_0 / I2C_NUM_1
}

i2c_master_bus_handle_t resource_i2c_bus(const char* bus_id) {
    int idx = i2c_index(bus_id);
    if (idx < 0) {
        return nullptr;
    }
    return s_i2c[idx].bus;
}

esp_err_t resource_i2c_claim(const char* bus_id, int sda, int scl, int hz, char* err,
                             size_t err_len) {
    int idx = i2c_index(bus_id);
    if (idx < 0) {
        if (err && err_len) {
            snprintf(err, err_len, "unknown i2c bus (use i2c0 or i2c1)");
        }
        return ESP_ERR_INVALID_ARG;
    }
    if (sda < 0 || scl < 0 || sda == scl) {
        if (err && err_len) {
            snprintf(err, err_len, "i2c %s needs distinct sda/scl", bus_id);
        }
        return ESP_ERR_INVALID_ARG;
    }
    if (hz != 100000 && hz != 400000) {
        if (err && err_len) {
            snprintf(err, err_len, "i2c %s hz must be 100000 or 400000", bus_id);
        }
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    I2cSlot& slot = s_i2c[idx];
    if (slot.refcount > 0) {
        if (slot.sda != sda || slot.scl != scl || slot.hz != hz) {
            if (err && err_len) {
                snprintf(err, err_len, "i2c %s pins must match sda=%d scl=%d hz=%d", bus_id,
                         slot.sda, slot.scl, slot.hz);
            }
            xSemaphoreGive(s_mu);
            return ESP_ERR_INVALID_STATE;
        }
        slot.refcount++;
        xSemaphoreGive(s_mu);
        return ESP_OK;
    }
    char owner[24];
    snprintf(owner, sizeof(owner), "bus_%s", i2c_bus_id(idx));
    esp_err_t rc = claim_unlocked(sda, owner, err, err_len);
    if (rc == ESP_OK) {
        rc = claim_unlocked(scl, owner, err, err_len);
    }
    if (rc != ESP_OK) {
        release_unlocked(sda, owner);
        release_unlocked(scl, owner);
        xSemaphoreGive(s_mu);
        return rc;
    }
    i2c_master_bus_config_t cfg = {};
    cfg.i2c_port = static_cast<i2c_port_num_t>(idx);
    cfg.sda_io_num = static_cast<gpio_num_t>(sda);
    cfg.scl_io_num = static_cast<gpio_num_t>(scl);
    cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    cfg.glitch_ignore_cnt = 7;
    cfg.flags.enable_internal_pullup = true;
    i2c_master_bus_handle_t bus = nullptr;
    rc = i2c_new_master_bus(&cfg, &bus);
    if (rc != ESP_OK) {
        release_unlocked(sda, owner);
        release_unlocked(scl, owner);
        if (err && err_len) {
            snprintf(err, err_len, "i2c_new_master_bus %s", esp_err_to_name(rc));
        }
        xSemaphoreGive(s_mu);
        return rc;
    }
    slot.refcount = 1;
    slot.sda = sda;
    slot.scl = scl;
    slot.hz = hz;
    slot.bus = bus;
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

esp_err_t resource_i2c_release(const char* bus_id) {
    int idx = i2c_index(bus_id);
    if (idx < 0) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    I2cSlot& slot = s_i2c[idx];
    if (slot.refcount <= 0) {
        xSemaphoreGive(s_mu);
        return ESP_ERR_INVALID_STATE;
    }
    slot.refcount--;
    if (slot.refcount == 0) {
        i2c_del_unlocked(idx);
    }
    xSemaphoreGive(s_mu);
    return ESP_OK;
}

esp_err_t resource_i2c_add_device(const char* bus_id, uint16_t addr, int hz,
                                  i2c_master_dev_handle_t* out, char* err, size_t err_len) {
    if (!out) {
        return ESP_ERR_INVALID_ARG;
    }
    *out = nullptr;
    int idx = i2c_index(bus_id);
    if (idx < 0) {
        if (err && err_len) {
            snprintf(err, err_len, "unknown i2c bus");
        }
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    I2cSlot& slot = s_i2c[idx];
    if (!slot.bus || slot.refcount <= 0) {
        xSemaphoreGive(s_mu);
        if (err && err_len) {
            snprintf(err, err_len, "i2c %s not claimed", bus_id);
        }
        return ESP_ERR_INVALID_STATE;
    }
    int use_hz = hz > 0 ? hz : slot.hz;
    i2c_device_config_t devcfg = {};
    devcfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    devcfg.device_address = addr;
    devcfg.scl_speed_hz = static_cast<uint32_t>(use_hz);
    i2c_master_dev_handle_t dev = nullptr;
    esp_err_t rc = i2c_master_bus_add_device(slot.bus, &devcfg, &dev);
    xSemaphoreGive(s_mu);
    if (rc != ESP_OK) {
        if (err && err_len) {
            snprintf(err, err_len, "i2c add 0x%02x %s", addr, esp_err_to_name(rc));
        }
        return rc;
    }
    *out = dev;
    return ESP_OK;
}

esp_err_t resource_i2c_rm_device(i2c_master_dev_handle_t dev) {
    if (!dev) {
        return ESP_OK;
    }
    return i2c_master_bus_rm_device(dev);
}

}  // namespace runtime
