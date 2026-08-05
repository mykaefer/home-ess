# homeESS features

[Hier klicken für die deutsche Fassung.](FEATURES_de.md)

homeESS combines energy monitoring, forecasts and load control in one local,
self-hosted system. Pages are rendered by the server and provide dedicated
desktop and mobile layouts.

## User interface and access control

- Responsive desktop and mobile interfaces with touch-friendly navigation,
  dialogs and dashboards.
- Login with persistent sessions, user selection and the roles Read, Operate
  and Write. Administrators retain unrestricted access.
- Multiple dashboard tabs with configurable value, switch and information
  widgets. Groups and widgets can be arranged using drag and drop.
- System-wide language selection with German and English catalogs. Adapters can
  provide their own language files.

## Energy monitoring

- Electricity-consumption dashboard for self-consumption, grid import, export
  and daily, weekly and annual energy values.
- Raw meter handling that counts deltas safely and avoids jumps after meter or
  MQTT-topic changes.
- Management of multiple photovoltaic plants including live power, yields,
  converter and cell metadata and clear-sky reference power.
- Solar-position calculation using local solar time, configurable reference
  thresholds and direct-sun detection.
- Open-Meteo PV forecast for today and the following three days, including
  per-plant self-calibration in 15-minute windows.
- Battery dashboard for state of charge, power, voltage, temperature,
  efficiencies, capacity and configurable minimum state of charge.
- Bidirectional synchronization of selected settings and live header indicators
  for battery, power, temperature, time and operating state.

## Forecast and operating strategy

- Four-day energy forecast combining PV production, learned consumption,
  battery limits, configurable reserves and scheduled loads.
- Learned base consumption, weekday profiles, temperature-dependent heating or
  cooling demand and separate wallbox demand models.
- A central operating-level handler gates all registered consumers by priority.
- Emergency and autonomy states, hysteresis and persistent state prevent unsafe
  switching after restarts or incomplete measurements.

## Measuring and switching loads

- Freely configurable measuring or switching devices with MQTT topics for
  command, remote synchronization, status, power and energy meters.
- Nested groups, group priorities, virtual power derived from nominal ratings
  and internal energy counters.
- Optional phase-specific load shedding controlled by Grid Control, including
  staged shutdown and delayed recovery.
- Animated energy-flow diagram for PV, grid, battery, self-consumption and
  nested consumer groups, including public read-only exports.
- Switch groups with drag-and-drop assignment, common switching, remote topics
  and optional timers.

## Optional control modules

- Grid Control switches grid and inverter paths using verified readback,
  configurable thresholds, hysteresis and an audit log.
- Pool Control manages solar and filter pumps using schedules, temperatures,
  solar conditions, priorities and learned energy demand.
- Wallbox Control supports multiple chargers, private, work and always-full
  charging modes, vehicle state of charge, forecasts, priorities and metering.
- Optional modules can be enabled or disabled from the settings page without
  creating parallel server or authentication structures.

## Adapters, states, automations and output

- Isolated adapter instances connect Modbus, Tasmota, Shelly, Homematic RPC,
  hDP and additional portable integrations.
- Every hDP ARGB device can apply a device-specific dimming switch: when a
  selected state equals the configured value, homeESS reduces the calculated
  output brightness by the configured percentage before sending it.
- Custom States use the same full-width group layout as Measuring + Switching.
  Direct drag handles reorder or move folders and states, while all folder and
  state properties remain editable after creation.
- Persistent conditions combine any number of triggers, checks and ordered
  actions. They react to intervals, weekly schedules, value changes or exact
  state events, evaluate typed state comparisons and write actions through the
  central state boundary. The responsive editor uses the same expandable group
  layout as Measuring + Switching and Custom States, including nested folders
  that conditions can be dragged into.
- Administrators can upload validated ZIP packages. Archive structure, paths,
  checksums, limits, manifest values and JavaScript syntax are checked before
  an adapter reaches `/adapter/`.
- Adapters can be deleted only after all instances are removed, an explicit
  warning is acknowledged and the exact adapter ID is entered.
- Uploaded adapters and deliberate removals persist across both installer and
  internal updates. Only the installer's explicit `--all` flag restores all
  official adapters.
- A central hierarchical state catalog combines system, MQTT, custom and
  adapter values and is shared by dashboards, outputs and state pickers.
- Writable states and calculated values can be published back to configured
  targets.

## Remote access and updates

- Optional paired remote access follows the flow Browser → homeESS → essrelay.
  Relay tokens and private Ed25519 keys remain server-side.
- Origin WebSocket tunneling is enabled only for provisioned identities and is
  independent from normal local operation.
- Built-in release checks support manual and scheduled updates with a maintenance
  window, progress reporting, health verification and automatic rollback.
- Persistent data lives outside the replaceable application directory and the
  systemd service runs with a restricted filesystem view on standard installs.
