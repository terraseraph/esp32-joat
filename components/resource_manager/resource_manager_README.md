# resource_manager_README.md

## Purpose

One owner string per GPIO so PWM cannot steal a pin still claimed as `gpio_4`.

## User story

Safe pins / GPIO: configuring ADC on a pin already used as output fails with a clear error.

## Public API

`resource_claim(gpio, owner, err, len)`, `resource_release`, `resource_owner`, `resource_release_all`.

## Depends on

[capability_manager_README.md](../capability_manager/capability_manager_README.md) (callers validate first).

## Used by

io_gpio, io_pwm, io_adc.

## How to update and maintain

Owner names must match I/O key prefixes (`gpio_N`, `pwm_N`, `adc_N`). command_router releases the other drivers before claiming a new mode.

## How to test

Configure GPIO 4 as out, then pwm on 4 without disable — expect owned-by error. Disable then pwm — ok.

## Known limits

No peripheral-level locks for I2C/SPI yet (those buses are out of MVP).
