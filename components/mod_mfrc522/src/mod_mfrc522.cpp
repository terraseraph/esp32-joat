#include "mod_mfrc522.hpp"

#include <cstdio>
#include <cstring>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "event_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "json_util.hpp"
#include "module_manager.hpp"
#include "resource_manager.hpp"
#include "state_registry.hpp"

static const char* TAG = "mfrc522";

namespace runtime {
namespace {

constexpr int kMax = 4;
constexpr int kPollMs = 150;

enum {
    CommandReg = 0x01,
    ComIrqReg = 0x04,
    DivIrqReg = 0x05,
    ErrorReg = 0x06,
    Status1Reg = 0x07,
    Status2Reg = 0x08,
    FIFODataReg = 0x09,
    FIFOLevelReg = 0x0A,
    ControlReg = 0x0C,
    BitFramingReg = 0x0D,
    CollReg = 0x0E,
    ModeReg = 0x11,
    TxModeReg = 0x12,
    RxModeReg = 0x13,
    TxControlReg = 0x14,
    TxASKReg = 0x15,
    RFCfgReg = 0x26,
    ModWidthReg = 0x24,
    CRCResultRegL = 0x22,
    CRCResultRegM = 0x21,
    TModeReg = 0x2A,
    TPrescalerReg = 0x2B,
    TReloadRegH = 0x2C,
    TReloadRegL = 0x2D,
    VersionReg = 0x37,
};

enum {
    PCD_Idle = 0x00,
    PCD_CalcCRC = 0x03,
    PCD_Transceive = 0x0C,
    PCD_SoftReset = 0x0F,
};

enum {
    PICC_REQA = 0x26,
    PICC_SEL_CL1 = 0x93,
    PICC_SEL_CL2 = 0x95,
    PICC_SEL_CL3 = 0x97,
};

const ModulePinRole kPins[] = {
    {"sck", true, "bus", "out"},
    {"mosi", true, "bus", "out"},
    {"miso", true, "bus", "in"},
    {"cs", true, "instance", "out"},
    {"rst", false, "instance", "out"},
};

struct Slot {
    bool used;
    char id[16];
    char bus[8];
    int sck;
    int miso;
    int mosi;
    int cs;
    int rst;
    spi_device_handle_t dev;
    bool present;
    char uid[21];
    uint8_t version;
    uint8_t tx;
};

Slot s_slots[kMax];
int s_bus_devs[2];
bool s_bus_hw[2];
TaskHandle_t s_poll;
SemaphoreHandle_t s_mu;

void set_err(char* err, size_t err_len, const char* msg) {
    if (err && err_len) {
        snprintf(err, err_len, "%s", msg ? msg : "error");
    }
}

int bus_idx(const char* bus) {
    int host = resource_spi_host(bus);
    if (host == 1) {
        return 0;
    }
    if (host == 2) {
        return 1;
    }
    return -1;
}

void owner_name(char* out, size_t n, const char* id) { snprintf(out, n, "mod_%s", id); }

int pin_of(cJSON* inst, const char* role, int fallback) {
    cJSON* pins = cJSON_GetObjectItemCaseSensitive(inst, "pins");
    if (!cJSON_IsObject(pins)) {
        return fallback;
    }
    cJSON* v = cJSON_GetObjectItemCaseSensitive(pins, role);
    return cJSON_IsNumber(v) ? v->valueint : fallback;
}

esp_err_t spi_xfer(spi_device_handle_t dev, const uint8_t* tx, uint8_t* rx, size_t n) {
    spi_transaction_t t{};
    t.length = n * 8;
    t.tx_buffer = tx;
    t.rx_buffer = rx;
    return spi_device_polling_transmit(dev, &t);
}

esp_err_t wr(spi_device_handle_t dev, uint8_t reg, uint8_t val) {
    uint8_t tx[2] = {static_cast<uint8_t>((reg << 1) & 0x7E), val};
    return spi_xfer(dev, tx, nullptr, 2);
}

esp_err_t rd(spi_device_handle_t dev, uint8_t reg, uint8_t* val) {
    uint8_t tx[2] = {static_cast<uint8_t>(((reg << 1) & 0x7E) | 0x80), 0};
    uint8_t rx[2] = {};
    esp_err_t e = spi_xfer(dev, tx, rx, 2);
    if (e == ESP_OK && val) {
        *val = rx[1];
    }
    return e;
}

esp_err_t wrn(spi_device_handle_t dev, uint8_t reg, const uint8_t* data, size_t n) {
    uint8_t tx[65];
    if (n + 1 > sizeof(tx)) {
        return ESP_ERR_INVALID_SIZE;
    }
    tx[0] = static_cast<uint8_t>((reg << 1) & 0x7E);
    memcpy(tx + 1, data, n);
    return spi_xfer(dev, tx, nullptr, n + 1);
}

esp_err_t rdn(spi_device_handle_t dev, uint8_t reg, uint8_t* data, size_t n) {
    uint8_t tx[65] = {};
    uint8_t rx[65] = {};
    if (n + 1 > sizeof(tx)) {
        return ESP_ERR_INVALID_SIZE;
    }
    uint8_t addr = static_cast<uint8_t>(((reg << 1) & 0x7E) | 0x80);
    for (size_t i = 0; i < n; ++i) {
        tx[i] = addr;
    }
    tx[n] = 0;
    esp_err_t e = spi_xfer(dev, tx, rx, n + 1);
    if (e == ESP_OK) {
        memcpy(data, rx + 1, n);
    }
    return e;
}

esp_err_t set_bits(spi_device_handle_t dev, uint8_t reg, uint8_t mask) {
    uint8_t v = 0;
    esp_err_t e = rd(dev, reg, &v);
    if (e != ESP_OK) {
        return e;
    }
    return wr(dev, reg, v | mask);
}

esp_err_t clr_bits(spi_device_handle_t dev, uint8_t reg, uint8_t mask) {
    uint8_t v = 0;
    esp_err_t e = rd(dev, reg, &v);
    if (e != ESP_OK) {
        return e;
    }
    return wr(dev, reg, v & static_cast<uint8_t>(~mask));
}

esp_err_t pcd_transceive(spi_device_handle_t dev, const uint8_t* tx, size_t tx_n, uint8_t bitframing,
                         uint8_t* rx, size_t* rx_n) {
    wr(dev, CommandReg, PCD_Idle);
    wr(dev, ComIrqReg, 0x7F);
    wr(dev, FIFOLevelReg, 0x80);
    if (tx_n) {
        wrn(dev, FIFODataReg, tx, tx_n);
    }
    wr(dev, BitFramingReg, bitframing);
    wr(dev, CommandReg, PCD_Transceive);
    set_bits(dev, BitFramingReg, 0x80);

    int64_t start = esp_timer_get_time();
    uint8_t irq = 0;
    while (esp_timer_get_time() - start < 25000) {
        rd(dev, ComIrqReg, &irq);
        if (irq & 0x30) {  // RxIRq | IdleIRq
            break;
        }
        if (irq & 0x01) {  // TimerIRq
            break;
        }
    }
    clr_bits(dev, BitFramingReg, 0x80);
    uint8_t err = 0;
    rd(dev, ErrorReg, &err);
    if (err & 0x13) {  // BufferOvfl | CollErr | ParityErr
        return ESP_FAIL;
    }
    uint8_t level = 0;
    rd(dev, FIFOLevelReg, &level);
    size_t n = level;
    if (rx && rx_n) {
        if (n > *rx_n) {
            n = *rx_n;
        }
        if (n) {
            rdn(dev, FIFODataReg, rx, n);
        }
        *rx_n = n;
    }
    wr(dev, CommandReg, PCD_Idle);
    if ((irq & 0x20) == 0 && n == 0) {
        return ESP_ERR_TIMEOUT;
    }
    return (rx_n && *rx_n == 0 && (irq & 0x20) == 0) ? ESP_ERR_NOT_FOUND : ESP_OK;
}

esp_err_t pcd_crc(spi_device_handle_t dev, const uint8_t* data, size_t n, uint8_t* lo, uint8_t* hi) {
    wr(dev, CommandReg, PCD_Idle);
    wr(dev, DivIrqReg, 0x04);
    wr(dev, FIFOLevelReg, 0x80);
    wrn(dev, FIFODataReg, data, n);
    wr(dev, CommandReg, PCD_CalcCRC);
    int64_t start = esp_timer_get_time();
    uint8_t irq = 0;
    while (esp_timer_get_time() - start < 25000) {
        rd(dev, DivIrqReg, &irq);
        if (irq & 0x04) {
            break;
        }
    }
    wr(dev, CommandReg, PCD_Idle);
    if (lo) {
        rd(dev, CRCResultRegL, lo);
    }
    if (hi) {
        rd(dev, CRCResultRegM, hi);
    }
    return ESP_OK;
}

void uid_hex(const uint8_t* uid, int len, char* out, size_t n) {
    size_t j = 0;
    for (int i = 0; i < len && j + 2 < n; ++i) {
        static const char* hex = "0123456789ABCDEF";
        out[j++] = hex[(uid[i] >> 4) & 0xF];
        out[j++] = hex[uid[i] & 0xF];
    }
    out[j] = '\0';
}

bool picc_reqa(spi_device_handle_t dev) {
    clr_bits(dev, CollReg, 0x80);  // ValuesAfterColl=0, ISO 14443 anticollision
    uint8_t tx = PICC_REQA;
    uint8_t rx[2] = {};
    size_t rxn = sizeof(rx);
    if (pcd_transceive(dev, &tx, 1, 0x07, rx, &rxn) == ESP_OK && rxn >= 2) {
        return true;
    }
    clr_bits(dev, CollReg, 0x80);
    tx = 0x52;  // WUPA — also sees a PICC left in HALT
    rxn = sizeof(rx);
    return pcd_transceive(dev, &tx, 1, 0x07, rx, &rxn) == ESP_OK && rxn >= 2;
}

bool picc_anticoll(spi_device_handle_t dev, uint8_t cascade, uint8_t* uid4) {
    uint8_t tx[2] = {cascade, 0x20};
    uint8_t rx[5] = {};
    size_t rxn = sizeof(rx);
    clr_bits(dev, CollReg, 0x80);
    if (pcd_transceive(dev, tx, 2, 0x00, rx, &rxn) != ESP_OK || rxn < 5) {
        return false;
    }
    uint8_t bcc = rx[0] ^ rx[1] ^ rx[2] ^ rx[3];
    if (bcc != rx[4]) {
        return false;
    }
    memcpy(uid4, rx, 4);
    return true;
}

bool picc_select(spi_device_handle_t dev, uint8_t cascade, const uint8_t uid4[4]) {
    uint8_t tx[9] = {cascade, 0x70, uid4[0], uid4[1], uid4[2], uid4[3], 0, 0, 0};
    tx[6] = static_cast<uint8_t>(uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3]);
    if (pcd_crc(dev, tx, 7, &tx[7], &tx[8]) != ESP_OK) {
        return false;
    }
    uint8_t rx[3] = {};
    size_t rxn = sizeof(rx);
    return pcd_transceive(dev, tx, 9, 0x00, rx, &rxn) == ESP_OK && rxn >= 1;
}

int picc_uid(spi_device_handle_t dev, uint8_t* uid, int maxn) {
    static const uint8_t cascades[] = {PICC_SEL_CL1, PICC_SEL_CL2, PICC_SEL_CL3};
    int n = 0;
    for (uint8_t c : cascades) {
        uint8_t uid4[4];
        if (!picc_anticoll(dev, c, uid4)) {
            return 0;
        }
        if (uid4[0] == 0x88) {
            if (!picc_select(dev, c, uid4) || n + 3 > maxn) {
                return 0;
            }
            memcpy(uid + n, uid4 + 1, 3);
            n += 3;
        } else {
            if (n + 4 > maxn) {
                return 0;
            }
            memcpy(uid + n, uid4, 4);
            return n + 4;
        }
    }
    return n;
}

void pcd_init(spi_device_handle_t dev, uint8_t* version, uint8_t* txctl) {
    wr(dev, CommandReg, PCD_SoftReset);
    vTaskDelay(pdMS_TO_TICKS(50));
    wr(dev, TxModeReg, 0x00);
    wr(dev, RxModeReg, 0x00);
    wr(dev, ModWidthReg, 0x26);
    wr(dev, TModeReg, 0x80);
    wr(dev, TPrescalerReg, 0xA9);
    wr(dev, TReloadRegH, 0x03);
    wr(dev, TReloadRegL, 0xE8);
    wr(dev, TxASKReg, 0x40);
    wr(dev, ModeReg, 0x3D);
    wr(dev, RFCfgReg, 0x48);
    clr_bits(dev, TxControlReg, 0x03);
    vTaskDelay(pdMS_TO_TICKS(2));
    set_bits(dev, TxControlReg, 0x03);
    uint8_t ver = 0;
    uint8_t tx = 0;
    rd(dev, VersionReg, &ver);
    rd(dev, TxControlReg, &tx);
    if (ver == 0x00 || ver == 0xFF) {
        ESP_LOGW(TAG, "version 0x%02x — chip not answering", ver);
    } else if ((tx & 0x03) != 0x03) {
        ESP_LOGW(TAG, "version 0x%02x tx 0x%02x — antenna off", ver, tx);
    } else {
        ESP_LOGI(TAG, "version 0x%02x tx 0x%02x", ver, tx);
    }
    if (version) {
        *version = ver;
    }
    if (txctl) {
        *txctl = tx;
    }
}

void publish(Slot& s) {
    char key[32];
    owner_name(key, sizeof(key), s.id);
    cJSON* st = cJSON_CreateObject();
    cJSON_AddStringToObject(st, "id", s.id);
    cJSON_AddStringToObject(st, "type", "mfrc522");
    cJSON_AddBoolToObject(st, "present", s.present);
    cJSON_AddStringToObject(st, "uid", s.present ? s.uid : "");
    cJSON_AddNumberToObject(st, "version", s.version);
    cJSON_AddNumberToObject(st, "tx", s.tx);
    state_set(key, st);
    event_bus_publish("io/rfid", st);
    cJSON_Delete(st);
}

void field_cycle(spi_device_handle_t dev) {
    clr_bits(dev, TxControlReg, 0x03);
    vTaskDelay(pdMS_TO_TICKS(2));
    set_bits(dev, TxControlReg, 0x03);
    vTaskDelay(pdMS_TO_TICKS(5));
}

void poll_one(Slot& s) {
    if (!s.dev) {
        return;
    }
    wr(s.dev, CommandReg, PCD_Idle);
    wr(s.dev, Status2Reg, 0x00);
    field_cycle(s.dev);
    bool present = picc_reqa(s.dev);
    char uid[21] = "";
    if (present) {
        uint8_t raw[10];
        int n = picc_uid(s.dev, raw, sizeof(raw));
        if (n <= 0) {
            present = false;
        } else {
            uid_hex(raw, n, uid, sizeof(uid));
        }
    }
    if (present == s.present && strcmp(uid, s.uid) == 0) {
        return;
    }
    s.present = present;
    snprintf(s.uid, sizeof(s.uid), "%s", uid);
    publish(s);
}

void poll_task(void*) {
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(kPollMs));
        xSemaphoreTake(s_mu, portMAX_DELAY);
        for (int i = 0; i < kMax; ++i) {
            if (s_slots[i].used) {
                poll_one(s_slots[i]);
            }
        }
        xSemaphoreGive(s_mu);
    }
}

void ensure_poll() {
    if (!s_poll) {
        xTaskCreate(poll_task, "rfid_poll", 3072, nullptr, 5, &s_poll);
    }
}

int used_count() {
    int n = 0;
    for (int i = 0; i < kMax; ++i) {
        if (s_slots[i].used) {
            n++;
        }
    }
    return n;
}

Slot* find_slot(const char* id) {
    for (int i = 0; i < kMax; ++i) {
        if (s_slots[i].used && strcmp(s_slots[i].id, id) == 0) {
            return &s_slots[i];
        }
    }
    return nullptr;
}

Slot* alloc_slot() {
    for (int i = 0; i < kMax; ++i) {
        if (!s_slots[i].used) {
            return &s_slots[i];
        }
    }
    return nullptr;
}

void release_pins(const Slot& s) {
    char owner[24];
    owner_name(owner, sizeof(owner), s.id);
    resource_release(s.cs, owner);
    if (s.rst >= 0) {
        resource_release(s.rst, owner);
    }
    resource_spi_release(s.bus);
}

esp_err_t hw_bus_add(const char* bus, int sck, int miso, int mosi, int cs,
                     spi_device_handle_t* out, char* err, size_t err_len) {
    int idx = bus_idx(bus);
    int host = resource_spi_host(bus);
    if (idx < 0 || host < 0) {
        set_err(err, err_len, "unknown spi bus");
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_bus_hw[idx]) {
        spi_bus_config_t cfg{};
        cfg.mosi_io_num = mosi;
        cfg.miso_io_num = miso;
        cfg.sclk_io_num = sck;
        cfg.quadwp_io_num = -1;
        cfg.quadhd_io_num = -1;
        cfg.max_transfer_sz = 64;
        esp_err_t rc = spi_bus_initialize(static_cast<spi_host_device_t>(host), &cfg, SPI_DMA_DISABLED);
        if (rc == ESP_OK) {
            gpio_set_pull_mode(static_cast<gpio_num_t>(miso), GPIO_FLOATING);
        }
        if (rc != ESP_OK) {
            char buf[96];
            snprintf(buf, sizeof(buf), "spi_bus_initialize %s", esp_err_to_name(rc));
            set_err(err, err_len, buf);
            return rc;
        }
        s_bus_hw[idx] = true;
    }
    spi_device_interface_config_t devcfg{};
    devcfg.clock_speed_hz = 1000000;
    devcfg.mode = 0;
    devcfg.spics_io_num = cs;
    devcfg.queue_size = 1;
    esp_err_t rc = spi_bus_add_device(static_cast<spi_host_device_t>(host), &devcfg, out);
    if (rc != ESP_OK) {
        char buf[96];
        snprintf(buf, sizeof(buf), "spi_bus_add_device %s", esp_err_to_name(rc));
        set_err(err, err_len, buf);
        if (s_bus_devs[idx] == 0 && s_bus_hw[idx]) {
            spi_bus_free(static_cast<spi_host_device_t>(host));
            s_bus_hw[idx] = false;
        }
        return rc;
    }
    s_bus_devs[idx]++;
    return ESP_OK;
}

void hw_bus_remove(const char* bus, spi_device_handle_t dev) {
    int idx = bus_idx(bus);
    int host = resource_spi_host(bus);
    if (dev) {
        spi_bus_remove_device(dev);
    }
    if (idx < 0) {
        return;
    }
    if (s_bus_devs[idx] > 0) {
        s_bus_devs[idx]--;
    }
    if (s_bus_devs[idx] == 0 && s_bus_hw[idx] && host >= 0) {
        spi_bus_free(static_cast<spi_host_device_t>(host));
        s_bus_hw[idx] = false;
    }
}

void pulse_rst(int rst) {
    if (rst < 0) {
        return;
    }
    gpio_config_t io{};
    io.pin_bit_mask = 1ULL << rst;
    io.mode = GPIO_MODE_OUTPUT;
    gpio_config(&io);
    gpio_set_level(static_cast<gpio_num_t>(rst), 0);
    vTaskDelay(pdMS_TO_TICKS(2));
    gpio_set_level(static_cast<gpio_num_t>(rst), 1);
    vTaskDelay(pdMS_TO_TICKS(50));
}

esp_err_t apply(cJSON* inst, char* err, size_t err_len) {
    const char* id = json_str(inst, "id", "");
    const char* bus = json_str(inst, "bus", "vspi");
    int sck = pin_of(inst, "sck", -1);
    int miso = pin_of(inst, "miso", -1);
    int mosi = pin_of(inst, "mosi", -1);
    int cs = pin_of(inst, "cs", -1);
    int rst = pin_of(inst, "rst", -1);
    if (!id[0] || cs < 0) {
        set_err(err, err_len, "mfrc522 id and cs required");
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    if (find_slot(id)) {
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "mfrc522 already applied");
        return ESP_ERR_INVALID_STATE;
    }
    if (used_count() >= kMax) {
        xSemaphoreGive(s_mu);
        set_err(err, err_len, "mfrc522 limited to 4 instances");
        return ESP_ERR_NO_MEM;
    }
    Slot* slot = alloc_slot();
    char owner[24];
    owner_name(owner, sizeof(owner), id);
    esp_err_t rc = resource_spi_claim(bus, sck, miso, mosi, err, err_len);
    if (rc != ESP_OK) {
        xSemaphoreGive(s_mu);
        return rc;
    }
    rc = resource_claim(cs, owner, err, err_len);
    if (rc == ESP_OK && rst >= 0) {
        rc = resource_claim(rst, owner, err, err_len);
    }
    if (rc != ESP_OK) {
        if (rst >= 0) {
            resource_release(rst, owner);
        }
        resource_release(cs, owner);
        resource_spi_release(bus);
        xSemaphoreGive(s_mu);
        return rc;
    }
    spi_device_handle_t dev = nullptr;
    rc = hw_bus_add(bus, sck, miso, mosi, cs, &dev, err, err_len);
    if (rc != ESP_OK) {
        resource_release(cs, owner);
        if (rst >= 0) {
            resource_release(rst, owner);
        }
        resource_spi_release(bus);
        xSemaphoreGive(s_mu);
        return rc;
    }
    pulse_rst(rst);
    uint8_t ver = 0;
    uint8_t tx = 0;
    pcd_init(dev, &ver, &tx);
    memset(slot, 0, sizeof(*slot));
    slot->used = true;
    snprintf(slot->id, sizeof(slot->id), "%s", id);
    snprintf(slot->bus, sizeof(slot->bus), "%s", bus);
    slot->sck = sck;
    slot->miso = miso;
    slot->mosi = mosi;
    slot->cs = cs;
    slot->rst = rst;
    slot->dev = dev;
    slot->version = ver;
    slot->tx = tx;
    ensure_poll();
    publish(*slot);
    xSemaphoreGive(s_mu);
    ESP_LOGI(TAG, "rfid %s bus=%s cs=%d rst=%d", id, bus, cs, rst);
    return ESP_OK;
}

esp_err_t teardown(const char* id) {
    if (!id || !id[0]) {
        return ESP_OK;
    }
    xSemaphoreTake(s_mu, portMAX_DELAY);
    Slot* slot = find_slot(id);
    if (!slot) {
        xSemaphoreGive(s_mu);
        return ESP_OK;
    }
    hw_bus_remove(slot->bus, slot->dev);
    release_pins(*slot);
    char key[32];
    owner_name(key, sizeof(key), slot->id);
    state_clear(key);
    memset(slot, 0, sizeof(*slot));
    xSemaphoreGive(s_mu);
    ESP_LOGI(TAG, "removed %s", id);
    return ESP_OK;
}

const ModuleTypeOps kOps = {
    "mfrc522",
    "RFID MFRC522",
    "SPI RFID reader. Multiple share one SPI bus; unique CS (RST optional). RC522 SDA is chip-select.",
    "spi",
    "vspi",
    "rfid",
    kMax,
    kPins,
    static_cast<int>(sizeof(kPins) / sizeof(kPins[0])),
    apply,
    teardown,
    nullptr,
    nullptr,
    0,
    nullptr,
};

}  // namespace

esp_err_t mod_mfrc522_init() {
    if (!s_mu) {
        s_mu = xSemaphoreCreateMutex();
    }
    memset(s_slots, 0, sizeof(s_slots));
    return module_register_type(&kOps);
}

}  // namespace runtime
