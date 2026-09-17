#include "resource_manager.hpp"

#include <cstdio>
#include <cstring>

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

}  // namespace

esp_err_t resource_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    memset(s_owner, 0, sizeof(s_owner));
    memset(s_spi, 0, sizeof(s_spi));
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

}  // namespace runtime
