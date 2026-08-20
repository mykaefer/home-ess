"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.definitions = exports.fzLocal = exports.tzLocal = exports.eurotronicExtend = void 0;
const zigbee_herdsman_1 = require("zigbee-herdsman");
const fz = __importStar(require("../converters/fromZigbee"));
const tz = __importStar(require("../converters/toZigbee"));
const constants = __importStar(require("../lib/constants"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const ea = exposes.access;
const manufacturerOptions = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.NXP_SEMICONDUCTORS };
exports.eurotronicExtend = {
    addEurotronicHvacThermostatCluster: () => m.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            trvMode: { name: "trvMode", ID: 0x4000, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true }, // 16384
            valvePosition: { name: "valvePosition", ID: 0x4001, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true }, // 16385
            errorStatus: { name: "errorStatus", ID: 0x4002, type: zigbee_herdsman_1.Zcl.DataType.UINT8 }, // 16386
            currentHeatingSetpoint: { name: "currentHeatingSetpoint", ID: 0x4003, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true }, // 16387
            hostFlags: { name: "hostFlags", ID: 0x4008, type: zigbee_herdsman_1.Zcl.DataType.UINT24, write: true }, // 16392
        },
        commands: {},
        commandsResponse: {},
    }),
};
exports.tzLocal = {
    eurotronic_host_flags: {
        key: ["eurotronic_host_flags", "system_mode"],
        convertSet: async (entity, key, value, meta) => {
            const origValue = value;
            await entity.read("hvacThermostat", ["hostFlags"], manufacturerOptions);
            // calculate bit value
            let bitValue = 0x01; // bit 0 always 1
            if (meta.state.mirror_display === "ON") {
                bitValue |= 0x02;
            }
            if (value === constants.thermostatSystemModes[0]) {
                // off
                bitValue |= 0x20;
            }
            else if (value === constants.thermostatSystemModes[4]) {
                // "heat"
                bitValue |= 0x04;
            }
            else {
                // auto
                bitValue |= 0x10;
            }
            if (meta.state.child_lock === "LOCK") {
                bitValue |= 0x80;
            }
            value = bitValue;
            const payload = { 16392: { value, type: 0x22 } };
            await entity.write("hvacThermostat", payload, manufacturerOptions);
            return { state: { [key]: origValue } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["hostFlags"], manufacturerOptions);
        },
    },
    eurotronic_error_status: {
        key: ["eurotronic_error_status"],
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["errorStatus"], manufacturerOptions);
        },
    },
    eurotronic_current_heating_setpoint: {
        key: ["current_heating_setpoint"],
        convertSet: async (entity, key, value, meta) => {
            utils.assertNumber(value, key);
            const val = Number((Math.round(Number((value * 2).toFixed(1))) / 2).toFixed(1)) * 100;
            const payload = { 16387: { value: val, type: 0x29 } };
            await entity.write("hvacThermostat", payload, manufacturerOptions);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["currentHeatingSetpoint"], manufacturerOptions);
        },
    },
    eurotronic_valve_position: {
        key: ["eurotronic_valve_position", "valve_position"],
        convertSet: async (entity, key, value, meta) => {
            const payload = { 16385: { value, type: 0x20 } };
            await entity.write("hvacThermostat", payload, manufacturerOptions);
            return { state: { [key]: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["valvePosition"], manufacturerOptions);
        },
    },
    eurotronic_trv_mode: {
        key: ["eurotronic_trv_mode", "trv_mode"],
        convertSet: async (entity, key, value, meta) => {
            const payload = { 16384: { value, type: 0x30 } };
            await entity.write("hvacThermostat", payload, manufacturerOptions);
            return { state: { [key]: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["trvMode"], manufacturerOptions);
        },
    },
    eurotronic_child_lock: {
        key: ["eurotronic_child_lock", "child_lock"],
        convertSet: async (entity, key, value, meta) => {
            await entity.read("hvacThermostat", ["hostFlags"], manufacturerOptions);
            // calculate bit value
            let bitValue = 0x01; // bit 0 always 1
            if (meta.state.mirror_display === "ON") {
                bitValue |= 0x02;
            }
            if (meta.state.system_mode === constants.thermostatSystemModes[0]) {
                // off
                bitValue |= 0x20;
            }
            else if (meta.state.system_mode === constants.thermostatSystemModes[4]) {
                // "heat"
                bitValue |= 0x04;
            }
            else {
                // auto
                bitValue |= 0x10;
            }
            if (value === "LOCK") {
                bitValue |= 0x80;
            }
            const origValue = value;
            value = bitValue;
            const payload = { 16392: { value, type: 0x22 } };
            await entity.write("hvacThermostat", payload, manufacturerOptions);
            return { state: { [key]: origValue } };
        },
    },
    eurotronic_mirror_display: {
        key: ["eurotronic_mirror_display", "mirror_display"],
        convertSet: async (entity, key, value, meta) => {
            await entity.read("hvacThermostat", ["hostFlags"], manufacturerOptions);
            // calculate bit value
            let bitValue = 0x01; // bit 0 always 1
            if (value === "ON") {
                bitValue |= 0x02;
            }
            if (meta.state.system_mode === constants.thermostatSystemModes[0]) {
                // off
                bitValue |= 0x20;
            }
            else if (meta.state.system_mode === constants.thermostatSystemModes[4]) {
                // "heat"
                bitValue |= 0x04;
            }
            else {
                // auto
                bitValue |= 0x10;
            }
            if (meta.state.child_lock === "LOCK") {
                bitValue |= 0x80;
            }
            const origValue = value;
            value = bitValue;
            const payload = { 16392: { value, type: 0x22 } };
            await entity.write("hvacThermostat", payload, manufacturerOptions);
            return { state: { [key]: origValue } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["hostFlags"], manufacturerOptions);
        },
    },
};
exports.fzLocal = {
    eurotronic_thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = fz.thermostat.convert(model, msg, publish, options, meta);
            if (result) {
                if (typeof msg.data.currentHeatingSetpoint === "number") {
                    result.current_heating_setpoint = utils.precisionRound(msg.data.currentHeatingSetpoint, 2) / 100;
                }
                if (typeof msg.data.hostFlags === "number") {
                    result.child_lock = (msg.data.hostFlags & 0x80) !== 0 ? "LOCK" : "UNLOCK";
                    result.mirror_display = (msg.data.hostFlags & 0x02) !== 0 ? "ON" : "OFF";
                    // This seems broken... We need to write 0x20 to turn it off and 0x10 to set
                    // it to auto mode. However, when it reports the flag, it will report 0x10
                    //  when it's off, and nothing at all when it's in auto mode
                    // the new Comet valve reports the off status on bit 5
                    // if either bit 4 or 5 is set, off mode is active
                    if ((msg.data.hostFlags & 0x30) !== 0) {
                        // reports auto -> setting to force_off
                        result.system_mode = constants.thermostatSystemModes[0];
                    }
                    else if ((msg.data.hostFlags & 0x04) !== 0) {
                        // always_on
                        result.system_mode = constants.thermostatSystemModes[4];
                    }
                    else {
                        // auto
                        result.system_mode = constants.thermostatSystemModes[1];
                    }
                }
                if (typeof msg.data.errorStatus === "number") {
                    result.error_status = msg.data.errorStatus;
                }
                if (typeof msg.data.trvMode === "number") {
                    result.trv_mode = msg.data.trvMode;
                }
                if (typeof msg.data.valvePosition === "number") {
                    result.valve_position = msg.data.valvePosition;
                }
                if (msg.data.pIHeatingDemand !== undefined) {
                    result.running_state = msg.data.pIHeatingDemand >= 10 ? "heat" : "idle";
                }
            }
            return result;
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["SPZB0001"],
        model: "SPZB0001",
        vendor: "Eurotronic",
        description: "Spirit Zigbee wireless heater thermostat",
        extend: [exports.eurotronicExtend.addEurotronicHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.eurotronic_thermostat, fz.battery],
        toZigbee: [
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_unoccupied_heating_setpoint,
            tz.thermostat_local_temperature_calibration,
            exports.tzLocal.eurotronic_host_flags,
            exports.tzLocal.eurotronic_error_status,
            tz.thermostat_setpoint_raise_lower,
            tz.thermostat_control_sequence_of_operation,
            tz.thermostat_remote_sensing,
            tz.thermostat_local_temperature,
            tz.thermostat_running_state,
            exports.tzLocal.eurotronic_current_heating_setpoint,
            exports.tzLocal.eurotronic_trv_mode,
            exports.tzLocal.eurotronic_valve_position,
            exports.tzLocal.eurotronic_child_lock,
            exports.tzLocal.eurotronic_mirror_display,
        ],
        exposes: [
            e.battery(),
            e.child_lock(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withSetpoint("current_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"])
                .withLocalTemperatureCalibration()
                .withPiHeatingDemand(),
            e
                .enum("trv_mode", exposes.access.ALL, [1, 2])
                .withDescription("Select between direct control of the valve via the `valve_position` or automatic control of the valve based on the `current_heating_setpoint`. For manual control set the value to 1, for automatic control set the value to 2 (the default). When switched to manual mode the display shows a value from 0 (valve closed) to 100 (valve fully open) and the buttons on the device are disabled."),
            e
                .numeric("valve_position", exposes.access.ALL)
                .withValueMin(0)
                .withValueMax(255)
                .withDescription("Directly control the radiator valve when `trv_mode` is set to 1. The values range from 0 (valve closed) to 255 (valve fully open)"),
            e
                .binary("mirror_display", ea.ALL, "ON", "OFF")
                .withDescription("Mirror display of the thermostat. Useful when it is mounted in a way where the display is presented upside down."),
        ],
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "hvacThermostat"]);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatUnoccupiedHeatingSetpoint(endpoint);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "currentHeatingSetpoint",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 25,
                },
            ], manufacturerOptions);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "hostFlags",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ], manufacturerOptions);
            await reporting.batteryPercentageRemaining(endpoint, { min: 3600, max: constants.repInterval.MAX, change: 1 });
        },
    },
    {
        fingerprint: [
            { modelID: "SPZB0001", manufacturerName: "Eurotronic", dateCode: "20221110" },
            { modelID: "SPZB0001", manufacturerName: "Eurotronic", dateCode: "20240821" },
            { modelID: "SPZB0001", manufacturerName: "Eurotronic", dateCode: "20241105" },
            { modelID: "SPZB0001", manufacturerName: "Eurotronic", dateCode: "20240315" },
            { modelID: "SPZB0001", manufacturerName: "Eurotronic", dateCode: "20231019" },
        ],
        model: "COZB0001",
        vendor: "Eurotronic",
        description: "Comet Zigbee wireless heater thermostat",
        extend: [exports.eurotronicExtend.addEurotronicHvacThermostatCluster()],
        meta: { thermostat: { dontMapPIHeatingDemand: true } },
        fromZigbee: [exports.fzLocal.eurotronic_thermostat, fz.battery],
        toZigbee: [
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_unoccupied_heating_setpoint,
            tz.thermostat_local_temperature_calibration,
            exports.tzLocal.eurotronic_host_flags,
            exports.tzLocal.eurotronic_error_status,
            tz.thermostat_setpoint_raise_lower,
            tz.thermostat_control_sequence_of_operation,
            tz.thermostat_remote_sensing,
            tz.thermostat_local_temperature,
            tz.thermostat_running_state,
            exports.tzLocal.eurotronic_current_heating_setpoint,
            exports.tzLocal.eurotronic_trv_mode,
            exports.tzLocal.eurotronic_valve_position,
            exports.tzLocal.eurotronic_child_lock,
            exports.tzLocal.eurotronic_mirror_display,
        ],
        exposes: [
            e.battery(),
            e.child_lock(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 8, 28, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"])
                .withLocalTemperatureCalibration()
                .withPiHeatingDemand(),
            e
                .enum("trv_mode", exposes.access.ALL, [1, 2])
                .withDescription("Select between direct control of the valve via the `valve_position` or automatic control of the valve based on the `current_heating_setpoint`. For manual control set the value to 1, for automatic control set the value to 2 (the default). When switched to manual mode the display shows a value from 0 (valve closed) to 100 (valve fully open) and the buttons on the device are disabled."),
            e
                .numeric("valve_position", exposes.access.ALL)
                .withValueMin(0)
                .withValueMax(255)
                .withDescription("Directly control the radiator valve when `trv_mode` is set to 1. The values range from 0 (valve closed) to 255 (valve fully open)"),
            e
                .binary("mirror_display", ea.ALL, "ON", "OFF")
                .withDescription("Mirror display of the thermostat. Useful when it is mounted in a way where the display is presented upside down."),
        ],
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "hvacThermostat"]);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatUnoccupiedHeatingSetpoint(endpoint);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "currentHeatingSetpoint",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 25,
                },
            ], manufacturerOptions);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "hostFlags",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ], manufacturerOptions);
            await reporting.batteryPercentageRemaining(endpoint, { min: 3600, max: constants.repInterval.MAX, change: 1 });
        },
    },
    {
        zigbeeModel: ["CoZB_dha"],
        model: "CoZB_dha",
        vendor: "Eurotronic",
        description: "Comet Zero Zigbee Zigbee wireless heater thermostat",
        fromZigbee: [exports.fzLocal.eurotronic_thermostat, fz.battery],
        toZigbee: [
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_unoccupied_heating_setpoint,
            tz.thermostat_local_temperature_calibration,
            exports.tzLocal.eurotronic_host_flags,
            exports.tzLocal.eurotronic_error_status,
            tz.thermostat_setpoint_raise_lower,
            tz.thermostat_control_sequence_of_operation,
            tz.thermostat_remote_sensing,
            tz.thermostat_local_temperature,
            tz.thermostat_running_state,
            exports.tzLocal.eurotronic_current_heating_setpoint,
            exports.tzLocal.eurotronic_trv_mode,
            exports.tzLocal.eurotronic_valve_position,
            exports.tzLocal.eurotronic_child_lock,
            exports.tzLocal.eurotronic_mirror_display,
        ],
        exposes: [
            e.battery(),
            e.child_lock(),
            e
                .climate()
                .withSetpoint("current_heating_setpoint", 5, 30, 0.5)
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"])
                .withLocalTemperatureCalibration()
                .withPiHeatingDemand(),
            e
                .enum("trv_mode", exposes.access.ALL, [1, 2])
                .withDescription("Select between direct control of the valve via the `valve_position` or automatic control of the valve based on the `current_heating_setpoint`. For manual control set the value to 1, for automatic control set the value to 2 (the default). When switched to manual mode the display shows a value from 0 (valve closed) to 100 (valve fully open) and the buttons on the device are disabled."),
            e
                .numeric("valve_position", exposes.access.ALL)
                .withValueMin(0)
                .withValueMax(255)
                .withDescription("Directly control the radiator valve when `trv_mode` is set to 1. The values range from 0 (valve closed) to 255 (valve fully open)"),
            e
                .binary("mirror_display", ea.ALL, "ON", "OFF")
                .withDescription("Mirror display of the thermostat. Useful when it is mounted in a way where the display is presented upside down."),
        ],
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "hvacThermostat"]);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatUnoccupiedHeatingSetpoint(endpoint);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "currentHeatingSetpoint",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 25,
                },
            ], manufacturerOptions);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "hostFlags",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ], manufacturerOptions);
            await reporting.batteryPercentageRemaining(endpoint, { min: 3600, max: constants.repInterval.MAX, change: 1 });
        },
    },
];
//# sourceMappingURL=eurotronic.js.map