#include "provisioning.hpp"

#include <cstdint>
#include <cstring>

#include "esp_log.h"
#include "lwip/sockets.h"
#include "unistd.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char* TAG = "provision";

namespace runtime {
namespace {

int s_sock = -1;
TaskHandle_t s_task;
volatile bool s_run;

int question_end(const uint8_t* buf, int len) {
    int pos = 12;
    while (pos < len) {
        uint8_t lab = buf[pos];
        if (lab == 0) {
            return pos + 5;  // 0 + QTYPE + QCLASS
        }
        if ((lab & 0xC0) == 0xC0) {
            return pos + 6;  // pointer + QTYPE + QCLASS
        }
        pos += lab + 1;
    }
    return -1;
}

void dns_task(void*) {
    uint8_t buf[512];
    while (s_run) {
        sockaddr_in from{};
        socklen_t fromlen = sizeof(from);
        int len = recvfrom(s_sock, buf, sizeof(buf), 0, reinterpret_cast<sockaddr*>(&from), &fromlen);
        if (len < 12 || (buf[2] & 0x78) != 0) {
            continue;
        }
        int qend = question_end(buf, len);
        if (qend < 0 || qend > len || qend > static_cast<int>(sizeof(buf)) - 16) {
            continue;
        }
        uint16_t qtype = static_cast<uint16_t>((buf[qend - 4] << 8) | buf[qend - 3]);
        uint8_t resp[512];
        memcpy(resp, buf, static_cast<size_t>(qend));
        resp[2] = 0x84;  // QR + AA
        resp[3] = 0x00;
        resp[4] = 0x00;
        resp[5] = 0x01;  // QDCOUNT
        resp[8] = 0x00;
        resp[9] = 0x00;  // NSCOUNT
        resp[10] = 0x00;
        resp[11] = 0x00;  // ARCOUNT (drop EDNS so the A answer is valid)
        int out = qend;
        if (qtype == 1 || qtype == 255) {
            resp[6] = 0x00;
            resp[7] = 0x01;  // one A
            resp[out++] = 0xC0;
            resp[out++] = 0x0C;
            resp[out++] = 0x00;
            resp[out++] = 0x01;
            resp[out++] = 0x00;
            resp[out++] = 0x01;
            resp[out++] = 0x00;
            resp[out++] = 0x00;
            resp[out++] = 0x00;
            resp[out++] = 0x1E;
            resp[out++] = 0x00;
            resp[out++] = 0x04;
            resp[out++] = 192;
            resp[out++] = 168;
            resp[out++] = 4;
            resp[out++] = 1;
        } else {
            resp[6] = 0x00;
            resp[7] = 0x00;  // NODATA for AAAA / HTTPS
        }
        sendto(s_sock, resp, out, 0, reinterpret_cast<sockaddr*>(&from), fromlen);
    }
    vTaskDelete(nullptr);
}

}  // namespace

esp_err_t provisioning_init() {
    ESP_LOGI(TAG, "init (SoftAP portal + captive DNS)");
    return ESP_OK;
}

esp_err_t provisioning_start_dns() {
    if (s_sock >= 0) {
        return ESP_OK;
    }
    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (s_sock < 0) {
        return ESP_FAIL;
    }
    int yes = 1;
    setsockopt(s_sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(53);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(s_sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        close(s_sock);
        s_sock = -1;
        ESP_LOGW(TAG, "DNS bind failed");
        return ESP_FAIL;
    }
    struct timeval tv = {.tv_sec = 1, .tv_usec = 0};
    setsockopt(s_sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    s_run = true;
    xTaskCreate(dns_task, "dns", 3072, nullptr, 5, &s_task);
    ESP_LOGI(TAG, "captive DNS on :53 -> 192.168.4.1");
    return ESP_OK;
}

void provisioning_stop_dns() {
    s_run = false;
    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
}

}  // namespace runtime
