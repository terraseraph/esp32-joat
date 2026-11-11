#pragma once

#include "cJSON.h"

namespace runtime {

/**
 * Delivery class of a live io source (a pin or a module instance), chosen when it is configured.
 *   "reliable": every event must arrive (button edge, RFID read). Never downgraded or dropped
 *               while the MQTT outbox is backed up.
 *   "latest":   only the newest value matters (ADC, environment). May be sent at QoS 0 or
 *               dropped under backlog; a snapshot is re-emitted once the backlog clears.
 */

/** Parses "reliable" / "latest"; empty or null gives `fallback`. False when it is neither. */
bool io_delivery_parse(const char* s, bool fallback, bool* reliable);
const char* io_delivery_name(bool reliable);

void io_delivery_set_pin(int gpio, bool reliable);
void io_delivery_set_module(const char* id, bool reliable);
void io_delivery_clear_module(const char* id);

/** Class of the source that produced this io payload: by "gpio" for pins, else by module "id". */
bool io_delivery_reliable(const cJSON* payload);

}  // namespace runtime
