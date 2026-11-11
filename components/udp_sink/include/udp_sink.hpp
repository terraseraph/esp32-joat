#pragma once

#include <cstddef>

#include "cJSON.h"
#include "esp_err.h"

namespace runtime {

/**
 * Live io over UDP: one datagram per io event to up to two IPv4 targets.
 *   {"id":"<device id>","seq":<n>,"topic":"io/gpio","data":{...}}
 * Same topic/data as WebSocket, MQTT and serial, plus the device id and a counter that
 * goes up by one per event, so a receiver can tell which device sent it and spot gaps.
 * Output only: nothing is received, nothing is acknowledged or retried.
 */
esp_err_t udp_init();   // subscribe to io events
esp_err_t udp_start();  // load saved config and open the socket if enabled

/**
 * {"targets":["192.168.1.10:9000", ...], "enabled":true,
 *  "announce":true, "announce_addr":"239.255.77.1:7701", "announce_s":5}
 * targets: 0-2 "ipv4:port" strings (unicast, broadcast or multicast); omitted keeps the saved ones.
 * enabled: omitted means on when there is at least one target.
 * announce: off by default. When on, every announce_s seconds (2-60) one datagram goes to
 *   announce_addr so listeners can find the device without mDNS or a broker:
 *   {"announce":"de-esp32","id":..,"name":..,"host":..,"ip":..,"fw":..,"http":80}
 *   It runs independently of the io stream and does not count as a live sink.
 * Every field is optional; an omitted one keeps its saved value.
 */
esp_err_t udp_configure(cJSON* req, char* err, size_t err_len);

/**
 * {enabled, active, targets:[...], sent, failed, oversize, seq,
 *  announce, announce_addr, announce_s, announced}. Caller deletes.
 */
cJSON* udp_status_json();

}  // namespace runtime
