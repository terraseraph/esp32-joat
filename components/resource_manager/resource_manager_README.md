# resource_manager_README.md

## Purpose

One owner string per GPIO so PWM cannot steal a pin still claimed as `gpio_4`. SPI hosts (`vspi` / `hspi`) are refcounted: the first claimant defines SCK/MISO/MOSI. I2C hosts (`i2c0` / `i2c1`) are the same for SDA/SCL/Hz (100 kHz or 400 kHz) and own the IDF `i2c_master` bus.

## User story

Safe pins / GPIO: configuring ADC on a pin already used as output fails with a clear error. Two RC522 readers share VSPI; a third with different SCK is rejected. Two BME280s share i2c0; a third with different SDA is rejected.

## Public API

`resource_claim(gpio, owner, err, len)`, `resource_release`, `resource_owner`, `resource_release_all`.

SPI: `resource_spi_host(bus_id)` → 1 (`hspi` / SPI2) or 2 (`vspi` / SPI3), `resource_spi_claim(bus_id, sck, miso, mosi, err, len)`, `resource_spi_release(bus_id)`. First claim takes those three GPIOs as `bus_<id>`. Later claims must match pins and increment a refcount. SPI1/flash is not available.

I2C: `resource_i2c_host(bus_id)` → 0 (`i2c0`) or 1 (`i2c1`), `resource_i2c_claim(bus_id, sda, scl, hz, err, len)`, `resource_i2c_release(bus_id)`, `resource_i2c_bus`, `resource_i2c_add_device`, `resource_i2c_rm_device`. First claim stores SDA/SCL/Hz, takes those GPIOs as `bus_<id>`, and creates the master bus. Later claims must match all three.

GPIO owner strings stay ≤23 characters: `gpio_N`, `pwm_N`, `adc_N`, `servo_N`, `bus_vspi`, `bus_i2c0`, `mod_<id>`.

## Depends on

[capability_manager_README.md](../capability_manager/capability_manager_README.md) (callers validate first).

## Used by

io_gpio, io_pwm, io_adc, io_servo, [mod_mfrc522_README.md](../mod_mfrc522/mod_mfrc522_README.md), [mod_bme280_README.md](../mod_bme280/mod_bme280_README.md).

## How to update and maintain

Owner names must match I/O key prefixes (`gpio_N`, `pwm_N`, `adc_N`, `servo_N`) or module ids (`mod_<id>`). command_router releases the other drivers before claiming a new GPIO mode. UART hosts are not locked yet.

## How to test

Configure GPIO 4 as out, then pwm on 4 without disable — expect owned-by error. Disable then pwm — ok. Add an MFRC522 on VSPI, then `pin.configure` GPIO 18 as out — owned by `bus_vspi`. Add a BME280 on i2c0, then `pin.configure` GPIO 21 as out — owned by `bus_i2c0`.

## Known limits

No UART/RMT locks yet. Status LED GPIO2 is driven by the boot LED task without a claim.
