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
exports.definitions = void 0;
const zigbee_herdsman_1 = require("zigbee-herdsman");
const fz = __importStar(require("../converters/fromZigbee"));
const tz = __importStar(require("../converters/toZigbee"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const e = exposes.presets;
const fzLocal = {
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    SP600_power: {
        cluster: "seMetering",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (meta.device.dateCode === "20160120") {
                // Cannot use metering, divisor/multiplier is not according to ZCL.
                // https://github.com/Koenkk/zigbee2mqtt/issues/2233
                // https://github.com/Koenkk/zigbee-herdsman-converters/issues/915
                const result = {};
                if (msg.data.instantaneousDemand !== undefined) {
                    result.power = msg.data.instantaneousDemand;
                }
                // Summation is reported in Watthours
                if (msg.data.currentSummDelivered !== undefined) {
                    const value = msg.data.currentSummDelivered;
                    result.energy = value / 1000.0;
                }
                return result;
            }
            return fz.metering.convert(model, msg, publish, options, meta);
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["SPE600"],
        model: "SPE600",
        vendor: "Salus Controls",
        description: "Smart plug (EU socket)",
        extend: [m.onOff(), m.electricityMeter({ cluster: "metering" })],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["SP600"],
        model: "SP600",
        vendor: "Salus Controls",
        description: "Smart plug (UK socket)",
        extend: [m.onOff(), m.electricityMeter({ cluster: "metering", fzMetering: fzLocal.SP600_power })],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["SX885ZB"],
        model: "SX885ZB",
        vendor: "Salus Controls",
        description: "miniSmartPlug",
        extend: [m.onOff(), m.electricityMeter({ cluster: "metering" })],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["SR600"],
        model: "SR600",
        vendor: "Salus Controls",
        description: "Relay switch",
        extend: [m.onOff({ ota: { manufacturerName: "SalusControls" } })],
    },
    {
        zigbeeModel: ["SW600"],
        model: "SW600",
        vendor: "Salus Controls",
        description: "Door or window contact sensor",
        fromZigbee: [fz.ias_contact_alarm_1],
        toZigbee: [],
        exposes: [e.contact(), e.battery_low(), e.tamper()],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["WLS600"],
        model: "WLS600",
        vendor: "Salus Controls",
        description: "Water leakage sensor",
        fromZigbee: [fz.ias_water_leak_alarm_1],
        toZigbee: [],
        exposes: [e.water_leak(), e.battery_low(), e.tamper()],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["OS600"],
        model: "OS600",
        vendor: "Salus Controls",
        description: "Door or window contact sensor",
        fromZigbee: [fz.ias_contact_alarm_1],
        toZigbee: [],
        exposes: [e.contact(), e.battery_low(), e.tamper()],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["SS909ZB", "PS600"],
        model: "PS600",
        vendor: "Salus Controls",
        description: "Pipe temperature sensor",
        fromZigbee: [fz.temperature, fz.battery],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3000 } } },
        exposes: [e.battery(), e.temperature()],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(9);
            await reporting.bind(endpoint, coordinatorEndpoint, ["msTemperatureMeasurement", "genPowerCfg"]);
            await reporting.temperature(endpoint);
            await reporting.batteryVoltage(endpoint);
        },
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["RE600"],
        model: "RE600",
        vendor: "Salus Controls",
        description: "Router Zigbee",
        fromZigbee: [],
        toZigbee: [],
        exposes: [],
        ota: { manufacturerName: "SalusControls" },
    },
    {
        zigbeeModel: ["FC600", "FC600NH"],
        model: "FC600",
        vendor: "Salus Controls",
        description: "Fan coil thermostat",
        whiteLabel: [{ vendor: "Salus Controls", model: "FC600NH", description: "Fan coil thermostat", fingerprint: [{ modelID: "FC600NH" }] }],
        extend: [
            m.deviceAddCustomCluster("manuSpecificSalus", {
                name: "manuSpecificSalus",
                ID: 0xfc04,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.COMPUTIME,
                attributes: {
                    frostSetpoint: { name: "frostSetpoint", ID: 0x0000, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    minFrostSetpoint: { name: "minFrostSetpoint", ID: 0x0001, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    maxFrostSetpoint: { name: "maxFrostSetpoint", ID: 0x0002, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    timeDisplayFormat: { name: "timeDisplayFormat", ID: 0x0003, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
                    attr4: { name: "attr4", ID: 0x0004, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                    attr5: { name: "attr5", ID: 0x0005, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                    attr6: { name: "attr6", ID: 0x0006, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                    attr7: { name: "attr7", ID: 0x0007, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                    autoCoolingSetpoint: { name: "autoCoolingSetpoint", ID: 0x0008, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    autoHeatingSetpoint: { name: "autoHeatingSetpoint", ID: 0x0009, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    holdType: { name: "holdType", ID: 0x000a, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                    shortCycleProtection: { name: "shortCycleProtection", ID: 0x000b, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                    coolingFanDelay: { name: "coolingFanDelay", ID: 0x000c, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                    ruleCoolingSetpoint: { name: "ruleCoolingSetpoint", ID: 0x000d, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    ruleHeatingSetpoint: { name: "ruleHeatingSetpoint", ID: 0x000e, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                    attr15: { name: "attr15", ID: 0x000f, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
                },
                commands: {
                    resetDevice: {
                        name: "resetDevice",
                        ID: 0x01,
                        parameters: [],
                    },
                },
                commandsResponse: {},
            }),
            m.enumLookup({
                name: "preset",
                lookup: { schedule: 0, temporary_override: 1, permanent_override: 2, standby: 7, eco: 10 },
                cluster: "manuSpecificSalus",
                attribute: "holdType",
                description: "Operation mode",
                reporting: { min: 0, max: 3600, change: 0 },
            }),
        ],
        fromZigbee: [fz.thermostat, fz.fan],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_local_temperature_calibration,
            tz.thermostat_occupancy,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_unoccupied_heating_setpoint,
            tz.thermostat_setpoint_raise_lower,
            tz.thermostat_control_sequence_of_operation,
            tz.thermostat_system_mode,
            tz.thermostat_running_mode,
            tz.thermostat_weekly_schedule,
            tz.thermostat_clear_weekly_schedule,
            tz.thermostat_relay_status_log,
            tz.thermostat_running_state,
            tz.thermostat_keypad_lockout,
            tz.fan_mode,
        ],
        exposes: [
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 40, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "heat", "cool", "auto"])
                .withRunningMode(["off", "cool", "heat"])
                .withRunningState(["idle", "heat", "cool"])
                .withLocalTemperatureCalibration(-3, 3, 0.5)
                .withFanMode(["off", "low", "medium", "high", "auto"]),
            e.keypad_lockout(),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(9);
            const binds = ["genBasic", "genTime", "hvacThermostat", "hvacFanCtrl", "hvacUserInterfaceCfg"];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.fanMode(endpoint);
            await reporting.thermostatRunningMode(endpoint);
            await reporting.thermostatRunningState(endpoint);
        },
        ota: { manufacturerName: "SalusControls" },
    },
];
//# sourceMappingURL=salus_controls.js.map