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
const constants = __importStar(require("../lib/constants"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const ea = exposes.access;
const cluster = {
    addCtmGroupConfigCluster: () => m.deviceAddCustomCluster("ctmGroupConfig", {
        name: "ctmGroupConfig",
        ID: 0xfea7,
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
        attributes: {
            groupId: { name: "groupId", ID: 0x0000, type: zigbee_herdsman_1.Zcl.DataType.UINT16, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        },
        commands: {},
        commandsResponse: {},
    }),
    addCtmStoveGuardCluster: () => m.deviceAddCustomCluster("ctmStoveGuard", {
        name: "ctmStoveGuard",
        ID: 0xffc9, // 65481
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
        attributes: {
            alarmStatus: { name: "alarmStatus", ID: 0x0001, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS }, // .UINT8
            batteryLow: { name: "batteryLow", ID: 0x0002, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            stoveTemperature: {
                name: "stoveTemperature",
                ID: 0x0003,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
            ambientTemperature: {
                name: "ambientTemperature",
                ID: 0x0004,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
            active: { name: "active", ID: 0x0005, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            runtime: { name: "runtime", ID: 0x0006, type: zigbee_herdsman_1.Zcl.DataType.UINT16, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            runtimeTimeout: {
                name: "runtimeTimeout",
                ID: 0x0007,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
            resetReason: { name: "resetReason", ID: 0x0008, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            dipSwitch: { name: "dipSwitch", ID: 0x0009, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            swVersion: { name: "swVersion", ID: 0x000a, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            hwVersion: { name: "hwVersion", ID: 0x000b, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            bootloaderVersion: {
                name: "bootloaderVersion",
                ID: 0x000c,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
            model: { name: "model", ID: 0x000d, type: zigbee_herdsman_1.Zcl.DataType.UINT16, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            //  Use type IEEE_ADDR for EmberEUI64
            relayAddress: {
                name: "relayAddress",
                ID: 0x0010,
                type: zigbee_herdsman_1.Zcl.DataType.IEEE_ADDR,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
            currentFlag: { name: "currentFlag", ID: 0x0100, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            relayCurrent: { name: "relayCurrent", ID: 0x0101, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            relayStatus: { name: "relayStatus", ID: 0x0102, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            externalButton: {
                name: "externalButton",
                ID: 0x0103,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
            relayAlarm: { name: "relayAlarm", ID: 0x0104, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            relayAlarmStatus: {
                name: "relayAlarmStatus",
                ID: 0x0105,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
    addCtmGenOnOffCluster: () => m.deviceAddCustomCluster("genOnOff", {
        name: "genOnOff",
        ID: zigbee_herdsman_1.Zcl.Clusters.genOnOff.ID,
        attributes: {
            deviceMode: { name: "deviceMode", ID: 0x2200, type: zigbee_herdsman_1.Zcl.DataType.UINT8 },
            deviceEnabled: { name: "deviceEnabled", ID: 0x2201, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
            childLock: { name: "childLock", ID: 0x2202, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
            currentFlag: { name: "currentFlag", ID: 0x5000, type: zigbee_herdsman_1.Zcl.DataType.UINT8, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
            relayState: { name: "relayState", ID: 0x5001, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        },
        commands: {},
        commandsResponse: {},
    }),
    addCtmToHvacThermostatCluster: () => m.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            ctmLoad: { name: "ctmLoad", ID: 0x0401, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            ctmDisplayText: { name: "ctmDisplayText", ID: 0x0402, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR, write: true },
            ctmSensor: { name: "ctmSensor", ID: 0x0403, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true, max: 0xff },
            ctmRegulatorMode: { name: "ctmRegulatorMode", ID: 0x0405, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmPowerStatus: { name: "ctmPowerStatus", ID: 0x0406, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmMeanPower: { name: "ctmMeanPower", ID: 0x0408, type: zigbee_herdsman_1.Zcl.DataType.UINT16 },
            ctmFloorTemp: { name: "ctmFloorTemp", ID: 0x0409, type: zigbee_herdsman_1.Zcl.DataType.INT16 },
            ctmNightSwitching: { name: "ctmNightSwitching", ID: 0x0411, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmFrostGuard: { name: "ctmFrostGuard", ID: 0x0412, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmChildLock: { name: "ctmChildLock", ID: 0x0413, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmMaxFloorTemp: { name: "ctmMaxFloorTemp", ID: 0x0414, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
            ctmRelayState: { name: "ctmRelayState", ID: 0x0415, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
            ctmRegulatorSetpoint: { name: "ctmRegulatorSetpoint", ID: 0x0420, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            ctmRegulationMode: { name: "ctmRegulationMode", ID: 0x0421, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            ctmOperationMode: { name: "ctmOperationMode", ID: 0x0422, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            ctmMaxFloorGuard: { name: "ctmMaxFloorGuard", ID: 0x0423, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmWeeklyTimer: { name: "ctmWeeklyTimer", ID: 0x0424, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ctmFrostGuardSetpoint: { name: "ctmFrostGuardSetpoint", ID: 0x0425, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            ctmExternalTemp: { name: "ctmExternalTemp", ID: 0x0426, type: zigbee_herdsman_1.Zcl.DataType.INT16 },
            ctmExternalSensorSource: { name: "ctmExternalSensorSource", ID: 0x0428, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true },
            ctmAirTemp: { name: "ctmAirTemp", ID: 0x0429, type: zigbee_herdsman_1.Zcl.DataType.INT16 },
            ctmFloorSensorError: { name: "ctmFloorSensorError", ID: 0x042b, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
            ctmAirSensorError: { name: "ctmAirSensorError", ID: 0x042c, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
        },
        commands: {},
        commandsResponse: {},
    }),
};
const _ctmExtend = {
    groupId: (args) => m.numeric({
        name: "group_id",
        cluster: "ctmGroupConfig",
        attribute: "groupId",
        description: "The device sends commands with this group ID. Put devices in this group to control them.",
        access: "STATE",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
    }),
    alarmStatus: (args) => m.enumLookup({
        name: "alarm_status",
        cluster: "ctmStoveGuard",
        attribute: "alarmStatus",
        description: "Alarm status.",
        access: "STATE",
        lookup: {
            OK: 0x00,
            Tamper: 0x01,
            "High Temperature": 0x02,
            Timer: 0x03,
            "Battery alarm": 0x07,
            Error: 0x08,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    batteryLow: (args) => m.enumLookup({
        name: "battery_low",
        cluster: "ctmStoveGuard",
        attribute: "batteryLow",
        description: "Indicates the status of the battery ('OK' or 'Change')",
        access: "STATE",
        lookup: {
            "Battery OK": 0x00,
            "Change battery": 0x01,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    stoveTemperature: (args) => m.numeric({
        name: "stove_temperature",
        cluster: "ctmStoveGuard",
        attribute: "stoveTemperature",
        description: "Stove temperature",
        access: "STATE",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ambientTemperature: (args) => m.numeric({
        name: "ambient_temperature",
        cluster: "ctmStoveGuard",
        attribute: "ambientTemperature",
        description: "X",
        access: "STATE",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    active: (args) => m.enumLookup({
        name: "active",
        cluster: "ctmStoveGuard",
        attribute: "active",
        description: "Stove guard active/inactive (Stove in use)",
        access: "STATE",
        lookup: {
            Inactive: 0x00,
            Active: 0x01,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    runtime: (args) => m.numeric({
        name: "runtime",
        cluster: "ctmStoveGuard",
        attribute: "runtime",
        description: "",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    runtimeTimeout: (args) => m.numeric({
        name: "runtime_timeout",
        cluster: "ctmStoveGuard",
        attribute: "runtimeTimeout",
        description: "",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    resetReason: (args) => m.enumLookup({
        name: "reset_reason",
        cluster: "ctmStoveGuard",
        attribute: "resetReason",
        description: "Reset reason.",
        access: "STATE",
        lookup: {
            Unknown: 0x00,
            "Power-on Reset": 0x01,
            "External Reset": 0x02,
            "Brown-Out Reset": 0x03,
            "Watchdog Reset": 0x04,
            "Program and debug interface reset": 0x05,
            "Software reset": 0x06,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    dipSwitch: (args) => m.numeric({
        name: "dip_switch",
        cluster: "ctmStoveGuard",
        attribute: "dipSwitch",
        description: "Dip switch",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    swVersion: (args) => m.numeric({
        name: "sw_version",
        cluster: "ctmStoveGuard",
        attribute: "swVersion",
        description: "Software version",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    hwVersion: (args) => m.numeric({
        name: "hw_version",
        cluster: "ctmStoveGuard",
        attribute: "hwVersion",
        description: "Hardware version",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    bootloaderVersion: (args) => m.numeric({
        name: "bootloader_version",
        cluster: "ctmStoveGuard",
        attribute: "bootloaderVersion",
        description: "Bootloader version",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    model: (args) => m.enumLookup({
        name: "model",
        cluster: "ctmStoveGuard",
        attribute: "model",
        description: "Stove guard model.",
        access: "STATE",
        lookup: {
            "mKomfy 1.8": 0x0001,
            "mKomfy Infinity": 0x0002,
            "mKomfy Hybrid": 0x0003,
            "mKomfy Tak": 0x0004,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    relayAddress: (args) => m.numeric({
        name: "relay_address",
        cluster: "ctmStoveGuard",
        attribute: "relayAddress",
        description: "",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    currentFlagStove: (args) => m.enumLookup({
        name: "current_flag",
        cluster: "ctmStoveGuard",
        attribute: "currentFlag",
        description: ")",
        access: "STATE",
        lookup: {
            False: 0x00,
            True: 0x01,
            Unknown: 0xff,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    relayCurrent: (args) => m.numeric({
        name: "relay_current",
        cluster: "ctmStoveGuard",
        attribute: "relayCurrent",
        description: "Relay current.",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    relayStatus: (args) => m.enumLookup({
        name: "relay_status",
        cluster: "ctmStoveGuard",
        attribute: "relayStatus",
        description: "Relay status.",
        access: "STATE",
        lookup: {
            OFF: 0x00,
            ON: 0x01,
            "Not present": 0x02,
            Unknown: 0xff,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    externalButton: (args) => m.enumLookup({
        name: "external_button",
        cluster: "ctmStoveGuard",
        attribute: "externalButton",
        description: "External button.",
        access: "STATE",
        lookup: {
            "Not clicked": 0x00,
            "Button clicked": 0x01,
            Unknown: 0xff,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    relayAlarm: (args) => m.enumLookup({
        name: "relay_alarm",
        cluster: "ctmStoveGuard",
        attribute: "relayAlarm",
        description: "Relay alarm.",
        access: "STATE",
        lookup: {
            OK: 0x00,
            "No communication": 0x01,
            "Over Current": 0x02,
            "Over Temperature": 0x03,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    relayAlarmStatus: (args) => m.enumLookup({
        name: "relay_alarm_status",
        cluster: "ctmStoveGuard",
        attribute: "relayAlarmStatus",
        description: "Relay alarm status.",
        access: "STATE",
        lookup: {
            OK: 0x00,
            Tamper: 0x01,
            "High Temperature": 0x02,
            Timer: 0x03,
            "Battery alarm": 0x07,
            Error: 0x08,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    deviceMode: (args) => m.enumLookup({
        name: "device_mode",
        cluster: "genOnOff",
        attribute: "deviceMode",
        description: "ZZZ",
        access: "STATE",
        lookup: {
            "AU: Astro clock": 0x00,
            "TM: Timer": 0x01,
            "DU: Daily timer": 0x02,
            "UU: Weekly Timer": 0x03,
        },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    deviceEnabled: (args) => m.binary({
        name: "device_enabled",
        cluster: "genOnOff",
        attribute: "deviceEnabled",
        description: "Turn the device on or off",
        access: "ALL",
        valueOn: ["On", 0],
        valueOff: ["Off", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    childLock: (args) => m.binary({
        name: "child_lock",
        cluster: "genOnOff",
        attribute: "childLock",
        description: "Enables/disables physical input on the device.",
        access: "STATE_SET",
        valueOn: ["LOCK", 1],
        valueOff: ["UNLOCK", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    currentFlag: (args) => m.numeric({
        name: "current_flag",
        cluster: "genOnOff",
        attribute: "currentFlag",
        description: "Current flag.",
        access: "STATE_SET",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    relayState: (args) => m.binary({
        name: "state",
        cluster: "genOnOff",
        attribute: "relayState",
        description: "Relay state.",
        access: "STATE_SET",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmLoad: (args) => m.numeric({
        name: "load",
        cluster: "hvacThermostat",
        attribute: "ctmLoad",
        description: "Load in W when heating is on (between 0-3600 W). The thermostat uses the value as input to the mean_power calculation.",
        unit: "W",
        valueMin: 0,
        valueMax: 3600,
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmDisplayText: (args) => m.text({
        name: "display_text",
        cluster: "hvacThermostat",
        attribute: "ctmDisplayText",
        description: "Displayed text on thermostat display (zone). Max 19 characters",
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmSensor: (args) => m.enumLookup({
        name: "sensor",
        cluster: "hvacThermostat",
        attribute: "ctmSensor",
        description: "Select temperature sensor to use",
        lookup: {
            "Air sensor": 0x00,
            "Floor sensor": 0x01,
            "External sensor": 0x02,
            Regulator: 0x03,
            "MV Air": 0x04,
            "MV External Air": 0x05,
            "MV Regulator": 0x06,
        },
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmRegulatorMode: (args) => m.binary({
        name: "regulator_mode",
        cluster: "hvacThermostat",
        attribute: "ctmRegulatorMode",
        description: "Device in regulator or thermostat mode.",
        access: "ALL",
        reporting: { min: "1_SECOND", max: "MAX", change: null },
        valueOn: ["regulator", 1],
        valueOff: ["thermostat", 0],
        entityCategory: "config",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmPowerStatus: (args) => m.binary({
        name: "power_status",
        cluster: "hvacThermostat",
        attribute: "ctmPowerStatus",
        description: "Relay state.",
        access: "STATE_GET",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmMeanPower: (args) => m.numeric({
        name: "mean_power",
        cluster: "hvacThermostat",
        attribute: "ctmMeanPower",
        description: "Reports average power usage last 10 minutes.",
        unit: "W",
        access: "STATE_GET",
        entityCategory: "diagnostic",
        reporting: { min: "MIN", max: "1_HOUR", change: 5 },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmFloorTemp: (args) => m.numeric({
        name: "floor_temp",
        cluster: "hvacThermostat",
        attribute: "ctmFloorTemp",
        scale: 100,
        description: "Current temperature measured from the floor sensor",
        unit: "°C",
        access: "STATE_GET",
        reporting: { min: "MIN", max: "1_HOUR", change: 10 },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmNightSwitching: (args) => m.binary({
        name: "night_switching",
        cluster: "hvacThermostat",
        attribute: "ctmNightSwitching",
        description: "Relay state.",
        access: "STATE_SET",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmFrostGuard: (args) => m.binary({
        name: "frost_guard",
        cluster: "hvacThermostat",
        attribute: "ctmFrostGuard",
        description: "When frost guard is ON, it is activated when the thermostat is switched OFF with the ON/OFF button." +
            'At the same time, the display will fade and the text "Frostsikring x °C" appears in the display and remains until the ' +
            "thermostat is switched on again. ",
        access: "ALL",
        entityCategory: "config",
        reporting: { min: "MIN", max: "MAX", change: null },
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmChildLockThermostat: (args) => m.binary({
        name: "child_lock",
        cluster: "hvacThermostat",
        attribute: "ctmChildLock",
        description: "Enables/disables physical input on the device.",
        access: "ALL",
        reporting: { min: "MIN", max: "MAX", change: null },
        valueOn: ["LOCK", 1],
        valueOff: ["UNLOCK", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmMaxFloorTemp: (args) => m.numeric({
        name: "max_floor_temp",
        cluster: "hvacThermostat",
        attribute: "ctmMaxFloorTemp",
        description: "Maximum allowed floor temperature.",
        valueMin: 15,
        valueMax: 40,
        unit: "°C",
        access: "ALL",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmRelayState: (args) => m.binary({
        name: "relay_state",
        cluster: "hvacThermostat",
        attribute: "ctmRelayState",
        description: "Is heating ON or OFF.",
        access: "STATE",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmRegulatorSetpoint: (args) => m.numeric({
        name: "regulator_setpoint",
        cluster: "hvacThermostat",
        attribute: "ctmRegulatorSetpoint",
        description: "Setpoint in %, use only when the thermostat is in regulator mode.",
        valueMin: 1,
        valueMax: 99,
        unit: "%",
        access: "ALL",
        reporting: { min: "MIN", max: "1_HOUR", change: 1 },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmRegulationMode: (args) => m.enumLookup({
        name: "ctm_regulaton_mode",
        cluster: "hvacThermostat",
        attribute: "ctmRegulationMode",
        description: "Regulation mode",
        lookup: {
            Thermostat: 0x00,
            Regulator: 0x01,
            Zzilent: 0x02,
        },
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmOperationMode: (args) => 
    // const presetLookup = {0: "off", 1: "away", 2: "sleep", 3: "home"};
    m.enumLookup({
        name: "ctm_operation_mode",
        cluster: "hvacThermostat",
        attribute: "ctmOperationMode",
        description: "Regulation mode",
        lookup: {
            OFF: 0x00,
            "Anti-Freeze": "0x01",
            "Night Saving": 0x02,
            "Comfort/ON": 0x03,
        },
        access: "ALL",
        reporting: { min: "MIN", max: "1_HOUR", change: 1 },
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmMaxFloorGuard: (args) => m.binary({
        name: "max_floor_guard",
        cluster: "hvacThermostat",
        attribute: "ctmMaxFloorGuard",
        description: "If 'Max floor guard' is ON the thermostat will stop heating if the floor temperature becomes higher than 'Max floor temp'.",
        access: "ALL",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmWeeklyTimer: (args) => m.binary({
        name: "weekly_timer",
        cluster: "hvacThermostat",
        attribute: "ctmWeeklyTimer",
        description: "Weekly timer enabled/disabled.",
        access: "ALL",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmFrostGuardSetpoint: (args) => m.numeric({
        name: "frost_guard_setpoint",
        cluster: "hvacThermostat",
        attribute: "ctmFrostGuardSetpoint",
        description: "Temperature setpoint used when frost guard is active.",
        access: "ALL",
        unit: "°C",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmExternalTemp: (args) => m.numeric({
        name: "external_temp",
        cluster: "hvacThermostat",
        attribute: "ctmExternalTemp",
        scale: 100,
        description: "Current temperature measured from the external sensor.",
        access: "STATE_GET",
        unit: "°C",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmExternalSensorSource: (args) => m.numeric({
        name: "external_sensor_source",
        cluster: "hvacThermostat",
        attribute: "ctmExternalSensorSource",
        description: "External sensor source.",
        access: "ALL",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmAirTemp: (args) => m.numeric({
        name: "air_temp",
        cluster: "hvacThermostat",
        attribute: "ctmAirTemp",
        scale: 100,
        description: "Current temperature measured from the air sensor.",
        access: "STATE_GET",
        reporting: { min: "MIN", max: "1_HOUR", change: 0.1 },
        unit: "°C",
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmFloorSensorError: (args) => m.binary({
        name: "floor_sensor_error",
        cluster: "hvacThermostat",
        attribute: "ctmFloorSensorError",
        description: "Indicates a floor sensor error.",
        access: "STATE_GET",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
    ctmAirSensorError: (args) => m.binary({
        name: "air_sensor_error",
        cluster: "hvacThermostat",
        attribute: "ctmAirSensorError",
        description: "Indicates an air temperature sensor error.",
        access: "STATE_GET",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        zigbeeCommandOptions: { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS },
        ...args,
    }),
};
const fzLocal = {
    ctm_mbd_device_enabled: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.onOff !== undefined) {
                result.device_enabled = data.onOff ? "ON" : "OFF";
            }
            return result;
        },
    },
    ctm_device_mode: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.deviceMode !== undefined) {
                const deviceModeLookup = { 0: "astro_clock", 1: "timer", 2: "daily_timer", 3: "weekly_timer" };
                result.device_mode = utils.getFromLookup(data.deviceMode, deviceModeLookup);
            }
            return result;
        },
    },
    ctm_device_enabled: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.deviceEnabled !== undefined) {
                result.device_enabled = data.deviceEnabled ? "ON" : "OFF";
            }
            return result;
        },
    },
    ctm_child_lock: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.childLock !== undefined) {
                result.child_lock = data.childLock ? "locked" : "unlocked";
            }
            return result;
        },
    },
    ctm_relay_state: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.relayState !== undefined) {
                result.state = data.relayState ? "ON" : "OFF";
            }
            return result;
        },
    },
    ctm_thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.ctmLoad !== undefined) {
                result.load = data.ctmLoad;
            }
            if (data.ctmDisplayText !== undefined) {
                result.display_text = data.ctmDisplayText;
            }
            if (data.ctmRegulatorMode !== undefined) {
                result.regulator_mode = data.ctmRegulatorMode ? "regulator" : "thermostat";
            }
            if (data.ctmPowerStatus !== undefined) {
                result.power_status = data.ctmPowerStatus ? "ON" : "OFF";
            }
            if (data.ctmMeanPower !== undefined) {
                result.mean_power = data.ctmMeanPower;
            }
            if (data.ctmFloorTemp !== undefined) {
                result.floor_temp = utils.precisionRound(data.ctmFloorTemp, 2) / 100;
            }
            if (data.ctmFrostGuard !== undefined) {
                result.frost_guard = data.ctmFrostGuard ? "ON" : "OFF";
            }
            if (data.ctmChildLock !== undefined) {
                result.child_lock = data.ctmChildLock ? "LOCK" : "UNLOCK";
            }
            if (data.ctmRelayState !== undefined) {
                result.running_state = data.ctmRelayState ? "heat" : "idle";
            }
            if (data.ctmRegulatorSetpoint !== undefined) {
                result.regulator_setpoint = data.ctmRegulatorSetpoint;
            }
            if (data.ctmRegulationMode !== undefined) {
                const regulationModeLookup = { 0: "thermostat", 1: "regulator", 2: "zzilent" };
                result.regulation_mode = utils.getFromLookup(data.ctmRegulationMode, regulationModeLookup);
            }
            if (data.ctmOperationMode !== undefined) {
                const presetLookup = { 0: "off", 1: "away", 2: "sleep", 3: "home" };
                const systemModeLookup = { 0: "off", 1: "off", 2: "off", 3: "heat" };
                result.preset = utils.getFromLookup(data.ctmOperationMode, presetLookup);
                result.system_mode = utils.getFromLookup(data.ctmOperationMode, systemModeLookup);
            }
            if (data.ctmExternalTemp !== undefined) {
                result.external_temp = utils.precisionRound(data.ctmExternalTemp, 2) / 100;
            }
            if (data.ctmAirTemp !== undefined) {
                result.air_temp = utils.precisionRound(data.ctmAirTemp, 2) / 100;
            }
            return result;
        },
    },
    ctm_group_config: {
        cluster: "ctmGroupConfig",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.groupId !== undefined) {
                result.group_id = data.groupId;
            }
            return result;
        },
    },
    ctm_stove_guard: {
        cluster: "ctmStoveGuard",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.alarmStatus !== undefined) {
                // Alarm status
                const alarmStatusLookup = {
                    0: "ok",
                    1: "tamper",
                    2: "high_temperatur",
                    3: "timer",
                    4: "battery_alarm",
                    5: "error",
                    255: "unknown",
                };
                result.alarm_status = utils.getFromLookup(data.alarmStatus, alarmStatusLookup);
            }
            if (data.batteryLow !== undefined) {
                // Change battery
                result.battery_low = !!data.batteryLow;
            }
            if (data.active !== undefined) {
                result.active = !!data.active;
            }
            return result;
        },
    },
    ctm_water_leak_alarm: {
        cluster: "ssIasZone",
        type: ["commandStatusChangeNotification", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = "zonestatus" in msg.data ? msg.data.zonestatus : msg.data.zoneStatus;
            return {
                active_water_leak: (zoneStatus & 1) > 0,
                water_leak: (zoneStatus & (1 << 1)) > 0,
                battery_low: (zoneStatus & (1 << 3)) > 0,
            };
        },
    },
};
const tzLocal = {
    ctm_mbd_device_enabled: {
        key: ["device_enabled"],
        convertSet: async (entity, key, value, meta) => {
            utils.assertString(value, "device_enabled");
            await entity.command("genOnOff", value.toLowerCase(), {}, utils.getOptions(meta.mapped, entity));
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("genOnOff", ["onOff"]);
        },
    },
    ctm_mbd_brightness: {
        key: ["brightness"],
        convertSet: async (entity, key, value, meta) => {
            await entity.command("genLevelCtrl", "moveToLevel", { level: value, transtime: 1, optionsMask: 0, optionsOverride: 0 }, utils.getOptions(meta.mapped, entity));
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("genLevelCtrl", ["currentLevel"]);
        },
    },
    ctm_device_mode: {
        key: ["device_mode"],
        convertGet: async (entity, key, meta) => {
            await entity.read("genOnOff", ["deviceMode"]);
        },
    },
    ctm_device_enabled: {
        key: ["device_enabled"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("genOnOff", { 8705: { value: utils.getFromLookup(value, { OFF: 0, ON: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } });
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("genOnOff", ["deviceEnabled"]);
        },
    },
    ctm_child_lock: {
        key: ["child_lock"],
        convertGet: async (entity, key, meta) => {
            await entity.read("genOnOff", ["childLock"]);
        },
    },
    ctm_relay_state: {
        key: ["state"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("genOnOff", { 20481: { value: utils.getFromLookup(value, { OFF: 0, ON: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("genOnOff", ["relayState"], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
        },
    },
    ctm_thermostat: {
        key: [
            "load",
            "display_text",
            "regulator_mode",
            "power_status",
            "system_mode",
            "frost_guard",
            "regulator_setpoint",
            "regulation_mode",
            "weekly_timer",
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
                case "load":
                    await entity.write("hvacThermostat", { 1025: { value: value, type: zigbee_herdsman_1.Zcl.DataType.UINT16 } });
                    break;
                case "display_text":
                    await entity.write("hvacThermostat", { 1026: { value: value, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR } });
                    break;
                case "regulator_mode":
                    await entity.write("hvacThermostat", {
                        1029: { value: utils.getFromLookup(value, { thermostat: 0, regulator: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
                    });
                    break;
                case "power_status":
                    await entity.write("hvacThermostat", { 1030: { value: utils.getFromLookup(value, { OFF: 0, ON: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } });
                    break;
                case "system_mode":
                    if (value === "off") {
                        await entity.write("hvacThermostat", { 1030: { value: 0, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } });
                    }
                    else if (value === "heat") {
                        await entity.write("hvacThermostat", { 1058: { value: 3, type: zigbee_herdsman_1.Zcl.DataType.UINT8 } });
                    }
                    break;
                case "frost_guard":
                    await entity.write("hvacThermostat", { 1042: { value: utils.getFromLookup(value, { OFF: 0, ON: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } });
                    break;
                case "regulator_setpoint":
                    await entity.write("hvacThermostat", { 1056: { value: value, type: zigbee_herdsman_1.Zcl.DataType.UINT8 } });
                    break;
                case "regulation_mode":
                    await entity.write("hvacThermostat", {
                        1057: {
                            value: utils.getFromLookup(value, { thermostat: 0, regulator: 1, zzilent: 2 }),
                            type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                        },
                    });
                    break;
                case "weekly_timer":
                    await entity.write("hvacThermostat", { 1060: { value: utils.getFromLookup(value, { OFF: 0, ON: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } });
                    break;
                default: // Unknown key
                    throw new Error(`Unhandled key tzLocal.ctm_thermostat.convertSet ${key}`);
            }
        },
        convertGet: async (entity, key, meta) => {
            switch (key) {
                case "load":
                    await entity.read("hvacThermostat", ["ctmLoad"]);
                    break;
                case "display_text":
                    await entity.read("hvacThermostat", ["ctmDisplayText"]);
                    break;
                case "regulator_mode":
                    await entity.read("hvacThermostat", ["ctmRegulatorMode"]);
                    break;
                case "power_status":
                    await entity.read("hvacThermostat", ["ctmPowerStatus"]);
                    break;
                case "frost_guard":
                    await entity.read("hvacThermostat", ["ctmFrostGuard"]);
                    break;
                case "regulator_setpoint":
                    await entity.read("hvacThermostat", ["ctmRegulatorSetpoint"]);
                    break;
                case "regulation_mode":
                    await entity.read("hvacThermostat", ["ctmRegulationMode"]);
                    break;
                case "system_mode":
                    await entity.read("hvacThermostat", ["ctmOperationMode"]);
                    break;
                default: // Unknown key
                    throw new Error(`Unhandled key tzLocal.ctm_thermostat.convertGet ${key}`);
            }
        },
    },
    ctm_thermostat_preset: {
        key: ["preset"],
        convertSet: async (entity, key, value, meta) => {
            const presetLookup = { off: 0, away: 1, sleep: 2, home: 3 };
            await entity.write("hvacThermostat", { 1058: { value: utils.getFromLookup(value, presetLookup), type: zigbee_herdsman_1.Zcl.DataType.UINT8 } });
        },
    },
    ctm_thermostat_child_lock: {
        key: ["child_lock"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("hvacThermostat", { 1043: { value: utils.getFromLookup(value, { UNLOCK: 0, LOCK: 1 }), type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN } });
        },
    },
    ctm_thermostat_gets: {
        key: ["mean_power", "floor_temp", "running_state", "external_temp", "air_temp"],
        convertGet: async (entity, key, meta) => {
            switch (key) {
                case "mean_power":
                    await entity.read("hvacThermostat", ["ctmMeanPower"]);
                    break;
                case "floor_temp":
                    await entity.read("hvacThermostat", ["ctmFloorTemp"]);
                    break;
                case "running_state":
                    await entity.read("hvacThermostat", ["ctmRelayState"]);
                    break;
                case "external_temp":
                    await entity.read("hvacThermostat", ["ctmExternalTemp"]);
                    break;
                case "air_temp":
                    await entity.read("hvacThermostat", ["ctmAirTemp"]);
                    break;
                default: // Unknown key
                    throw new Error(`Unhandled key tzLocal.ctm_thermostat.convertGet ${key}`);
            }
        },
    },
    ctm_group_config: {
        key: ["group_id"],
        convertGet: async (entity, key, meta) => {
            await entity.read("ctmGroupConfig", ["groupId"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
    },
    ctm_stove_guard: {
        key: ["alarm_status", "change_battery", "active"],
        convertGet: async (entity, key, meta) => {
            switch (key) {
                case "alarm_status":
                    await entity.read("ctmStoveGuard", ["alarmStatus"], {
                        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
                    });
                    break;
                case "battery_low":
                    await entity.read("ctmStoveGuard", ["batteryLow"], {
                        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
                    });
                    break;
                case "active":
                    await entity.read("ctmStoveGuard", ["active"], {
                        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
                    });
                    break;
                default: // Unknown key
                    throw new Error(`Unhandled key tzLocal.ctm_stove_guard.convertGet ${key}`);
            }
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["mTouch Dim", "DimmerPille"],
        model: "mTouch_Dim",
        vendor: "CTM Lyng",
        description: "mTouch Dim OP, touch dimmer",
        fromZigbee: [fz.on_off, fz.brightness, fz.lighting_ballast_configuration],
        toZigbee: [tz.on_off, tz.light_onoff_brightness, tz.light_brightness_move, tz.ballast_config],
        meta: { disableDefaultResponse: true },
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "genLevelCtrl", "lightingBallastCfg"]);
            await endpoint.read("genOnOff", ["onOff"]);
            await reporting.onOff(endpoint);
            await endpoint.read("genLevelCtrl", ["currentLevel"]);
            await reporting.brightness(endpoint);
            await endpoint.read("lightingBallastCfg", ["minLevel", "maxLevel", "powerOnLevel"]);
            await endpoint.configureReporting("lightingBallastCfg", [
                {
                    attribute: "minLevel",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("lightingBallastCfg", [
                {
                    attribute: "maxLevel",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("lightingBallastCfg", [
                {
                    attribute: "powerOnLevel",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
        },
        exposes: [
            e.light_brightness(),
            e.numeric("ballast_minimum_level", ea.ALL).withValueMin(1).withValueMax(99).withDescription("Specifies the minimum brightness value"),
            e.numeric("ballast_maximum_level", ea.ALL).withValueMin(1).withValueMax(99).withDescription("Specifies the maximum brightness value"),
            e
                .numeric("ballast_power_on_level", ea.ALL)
                .withValueMin(1)
                .withValueMax(99)
                .withDescription('Specifies the initialisation light level. Can not be set lower than "ballast_minimum_level"'),
        ],
        whiteLabel: [{ vendor: "CTM Lyng", model: "CTM_DimmerPille", description: "CTM Lyng DimmerPille", fingerprint: [{ modelID: "DimmerPille" }] }],
    },
    {
        zigbeeModel: ["mTouch Bryter"],
        model: "mTouch_Bryter",
        vendor: "CTM Lyng",
        description: "mTouch Bryter OP, 3 channel switch",
        extend: [cluster.addCtmGroupConfigCluster()],
        fromZigbee: [
            fz.temperature,
            fz.battery,
            fz.command_recall,
            fz.command_on,
            fz.command_off,
            fz.command_toggle,
            fz.command_move,
            fz.command_stop,
            fzLocal.ctm_group_config,
        ],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3200 } } },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "msTemperatureMeasurement"]);
            await reporting.batteryVoltage(endpoint);
            await endpoint.read("msTemperatureMeasurement", ["measuredValue"]);
            await reporting.temperature(endpoint, { min: constants.repInterval.MINUTES_10, max: constants.repInterval.HOUR, change: 100 });
            await endpoint.read("ctmGroupConfig", ["groupId"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
        exposes: [
            e.battery(),
            e.temperature(),
            e.action(["recall_1", "recall_2", "recall_3", "on", "off", "toggle", "brightness_move_down", "brightness_move_up", "brightness_stop"]),
            e
                .numeric("group_id", ea.STATE)
                .withDescription("The device sends commands with this group ID. Put dvices in this group to control them."),
        ],
    },
    {
        zigbeeModel: ["mTouch One"],
        model: "mTouch_One",
        vendor: "CTM Lyng",
        description: "mTouch One OP, touch thermostat",
        extend: [cluster.addCtmToHvacThermostatCluster()],
        fromZigbee: [fz.thermostat, fzLocal.ctm_thermostat],
        toZigbee: [
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_local_temperature,
            tzLocal.ctm_thermostat,
            tzLocal.ctm_thermostat_preset,
            tzLocal.ctm_thermostat_child_lock,
            tzLocal.ctm_thermostat_gets,
        ],
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["hvacThermostat"]);
            await endpoint.read("hvacThermostat", ["localTemp", "occupiedHeatingSetpoint"]);
            await endpoint.read("hvacThermostat", [
                "ctmLoad",
                "ctmDisplayText",
                "ctmRegulatorMode",
                "ctmMeanPower",
                "ctmFloorTemp",
            ]);
            await endpoint.read("hvacThermostat", [
                "ctmFrostGuard",
                "ctmChildLock",
                "ctmRegulatorSetpoint",
                "ctmOperationMode",
                "ctmAirTemp",
            ]);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmRegulatorMode",
                    minimumReportInterval: 1,
                    maximumReportInterval: constants.repInterval.MAX,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmMeanPower",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 5,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmFloorTemp",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 10,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmFrostGuard",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.MAX,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmChildLock",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.MAX,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmRegulatorSetpoint",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmOperationMode",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "ctmAirTemp",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 10,
                },
            ]);
        },
        exposes: [
            e.child_lock(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 40, 1)
                .withLocalTemperature()
                .withSystemMode(["off", "heat"])
                .withPreset(["off", "away", "sleep", "home"])
                .withRunningState(["idle", "heat"]),
            e
                .numeric("load", ea.ALL)
                .withUnit("W")
                .withDescription("Load in W when heating is on (between 0-3600 W). The thermostat uses the value as input to the mean_power calculation.")
                .withValueMin(0)
                .withValueMax(3600),
            e.text("display_text", ea.ALL).withDescription("Displayed text on thermostat display (zone). Max 19 characters"),
            e.binary("regulator_mode", ea.ALL, "regulator", "thermostat").withDescription("Device in regulator or thermostat mode."),
            e.numeric("mean_power", ea.STATE_GET).withUnit("W").withDescription("Reports average power usage last 10 minutes"),
            e.numeric("floor_temp", ea.STATE_GET).withUnit("°C").withDescription("Current temperature measured from the floor sensor"),
            e
                .binary("frost_guard", ea.ALL, "ON", "OFF")
                .withDescription("When frost guard is ON, it is activated when the thermostat is switched OFF with the ON/OFF button." +
                'At the same time, the display will fade and the text "Frostsikring x °C" appears in the display and remains until the ' +
                "thermostat is switched on again."),
            e
                .numeric("regulator_setpoint", ea.ALL)
                .withUnit("%")
                .withDescription("Setpoint in %, use only when the thermostat is in regulator mode.")
                .withValueMin(1)
                .withValueMax(99),
            e.numeric("air_temp", ea.STATE_GET).withUnit("°C").withDescription("Current temperature measured from the air sensor"),
        ],
    },
    {
        zigbeeModel: ["mStikk Outlet", "mStikk 16A", "mStikk 25A", "Tavlerele 25A"],
        model: "mStikk_Outlet",
        vendor: "CTM Lyng",
        description: "mStikk OP, wall socket",
        fromZigbee: [fz.on_off, fz.electrical_measurement, fz.metering],
        toZigbee: [tz.on_off],
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "haElectricalMeasurement", "seMetering"]);
            await endpoint.read("haElectricalMeasurement", ["acVoltageMultiplier", "acVoltageDivisor"]);
            await endpoint.read("haElectricalMeasurement", ["acCurrentMultiplier", "acCurrentDivisor"]);
            await endpoint.read("haElectricalMeasurement", ["acPowerMultiplier", "acPowerDivisor"]);
            await reporting.readMeteringMultiplierDivisor(endpoint);
            await endpoint.read("genOnOff", ["onOff"]);
            await reporting.onOff(endpoint);
            await reporting.rmsVoltage(endpoint, { change: 100 });
            await reporting.rmsCurrent(endpoint);
            await reporting.activePower(endpoint);
            await reporting.currentSummDelivered(endpoint);
        },
        exposes: [e.power(), e.current(), e.voltage(), e.switch(), e.energy()],
    },
    {
        zigbeeModel: ["mKomfy 2.0"],
        model: "6254380",
        vendor: "CTM Lyng",
        description: "2.0 Stove guard",
        extend: [
            m.deviceTemperature(),
            m.iasZoneAlarm({
                zoneType: "generic",
                manufacturerZoneAttributes: [
                    {
                        bit: 0,
                        name: "high_temperature",
                        valueOn: true,
                        valueOff: false,
                        description: "Stove guard detected high hemperature",
                    },
                    {
                        bit: 1,
                        name: "power_cut_off",
                        valueOn: true,
                        valueOff: false,
                        description: "Power to stove disconnected",
                    },
                ],
                zoneAttributes: ["tamper", "battery_low"],
            }),
            m.electricityMeter({ cluster: "metering" }),
        ],
    },
    {
        zigbeeModel: ["mKomfy 2.5"],
        model: "mkomfy25",
        vendor: "CTM Lyng",
        description: "2.5 Stove guard",
        extend: [
            m.onOff({ powerOnBehavior: false }),
            m.iasZoneAlarm({
                zoneType: "generic",
                manufacturerZoneAttributes: [
                    {
                        bit: 0,
                        name: "high_temperature",
                        valueOn: true,
                        valueOff: false,
                        description: "Stove guard detected high hemperature",
                    },
                    {
                        bit: 1,
                        name: "power_cut_off",
                        valueOn: true,
                        valueOff: false,
                        description: "Power to stove disconnected",
                    },
                ],
                zoneAttributes: ["tamper", "battery_low"],
            }),
            m.electricityMeter({ cluster: "metering" }),
        ],
    },
    {
        zigbeeModel: ["mKomfy", "mKomfy Tak"],
        model: "mKomfy_Sensor",
        vendor: "CTM Lyng",
        description: "mKomfy, stove guard",
        extend: [cluster.addCtmStoveGuardCluster()],
        fromZigbee: [fz.temperature, fz.battery, fzLocal.ctm_stove_guard],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "msTemperatureMeasurement", "ctmStoveGuard"]);
            await reporting.batteryPercentageRemaining(endpoint);
            await reporting.temperature(endpoint, { min: constants.repInterval.MINUTES_10, max: constants.repInterval.HOUR, change: 100 });
            // Alarm status
            await endpoint.configureReporting("ctmStoveGuard", [
                {
                    attribute: "alarmStatus",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 0,
                },
            ], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            // Change battery
            await endpoint.configureReporting("ctmStoveGuard", [
                {
                    attribute: "batteryLow",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.MAX,
                    reportableChange: 0,
                },
            ], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            // Active
            await endpoint.configureReporting("ctmStoveGuard", [
                {
                    attribute: "active",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 0,
                },
            ], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
        },
        exposes: [
            e.battery(),
            e.battery_low(),
            e.temperature(),
            e
                .enum("alarm_status", ea.STATE, ["ok", "tamper", "high_temperatur", "timer", "battery_alarm", "error", "unknown"])
                .withDescription("Alarm status."),
            e.binary("active", ea.STATE, true, false).withDescription("Stove guard active/inactive (Stove in use)"),
        ],
    },
    {
        zigbeeModel: ["mTouch Astro"],
        model: "mTouch_Astro",
        vendor: "CTM Lyng",
        description: "mTouch Astro OP, astro clock",
        extend: [cluster.addCtmGroupConfigCluster(), cluster.addCtmGenOnOffCluster()],
        fromZigbee: [
            fz.on_off,
            fz.command_on,
            fz.command_off,
            fzLocal.ctm_device_mode,
            fzLocal.ctm_device_enabled,
            fzLocal.ctm_child_lock,
            fzLocal.ctm_group_config,
        ],
        toZigbee: [tz.on_off, tzLocal.ctm_device_enabled],
        meta: { disableDefaultResponse: true },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff"]);
            await endpoint.read("genOnOff", ["onOff"]);
            await reporting.onOff(endpoint);
            await endpoint.read("genOnOff", ["deviceMode"]);
            await endpoint.configureReporting("genOnOff", [
                {
                    attribute: "deviceMode",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 0,
                },
            ]);
            await endpoint.read("genOnOff", ["deviceEnabled"]);
            await endpoint.configureReporting("genOnOff", [
                {
                    attribute: "deviceEnabled",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.read("genOnOff", ["childLock"]);
            await endpoint.configureReporting("genOnOff", [
                {
                    attribute: "childLock",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.read("ctmGroupConfig", ["groupId"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
        exposes: [
            e.switch(),
            e.action(["on", "off"]),
            e.enum("device_mode", ea.STATE, ["astro_clock", "timer", "daily_timer", "weekly_timer"]).withDescription("Device mode."),
            e.binary("device_enabled", ea.ALL, "ON", "OFF").withDescription("Turn the device on or off"),
            e.binary("child_lock", ea.STATE, "locked", "unlocked").withDescription("Physical input on the device enabled/disabled"),
            e
                .numeric("group_id", ea.STATE)
                .withDescription("The device sends commands with this group ID. Put devices in this group to control them."),
        ],
    },
    {
        zigbeeModel: ["AX Water Sensor"],
        model: "AX_Water_Sensor",
        vendor: "CTM Lyng",
        description: "AX Water Sensor, water leakage detector",
        fromZigbee: [fz.battery, fz.ias_enroll, fzLocal.ctm_water_leak_alarm],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3200 } } },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "ssIasZone"]);
            await reporting.batteryVoltage(endpoint);
            await endpoint.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
        },
        exposes: [
            e.battery(),
            e.battery_low(),
            e.water_leak(),
            e.binary("active_water_leak", ea.STATE, true, false).withDescription("Indicates whether there is an active water leak"),
        ],
    },
    {
        zigbeeModel: ["AX Valve Controller"],
        model: "AX_Valve_Controller",
        vendor: "CTM Lyng",
        description: "AX Valve Controller, water shutoff valve controller",
        fromZigbee: [fz.on_off, fz.ias_enroll, fzLocal.ctm_water_leak_alarm],
        toZigbee: [tz.on_off],
        meta: { disableDefaultResponse: true },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff"]);
            await endpoint.read("genOnOff", ["onOff"]);
            await reporting.onOff(endpoint);
            const endpoint2 = device.getEndpoint(2);
            await reporting.bind(endpoint2, coordinatorEndpoint, ["ssIasZone"]);
            await endpoint2.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
        },
        exposes: [
            e.switch(),
            e.water_leak(),
            e.binary("active_water_leak", ea.STATE, true, false).withDescription("Indicates whether there is an active water leak"),
        ],
    },
    {
        zigbeeModel: ["Mikrofon"],
        model: "mSwitch_Mic",
        vendor: "CTM Lyng",
        description: "Mikrofon, alarm detection microphone",
        extend: [cluster.addCtmGroupConfigCluster()],
        fromZigbee: [fz.temperature, fz.battery, fz.command_on, fz.command_off, fz.ias_enroll, fz.ias_smoke_alarm_1, fzLocal.ctm_group_config],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3200 } } },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "ssIasZone", "msTemperatureMeasurement"]);
            await reporting.batteryVoltage(endpoint);
            await endpoint.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
            await endpoint.read("msTemperatureMeasurement", ["measuredValue"]);
            await reporting.temperature(endpoint, { min: constants.repInterval.MINUTES_10, max: constants.repInterval.HOUR, change: 100 });
            await endpoint.read("ctmGroupConfig", ["groupId"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
        exposes: [
            e.temperature(),
            e.battery(),
            e.battery_low(),
            e.smoke(),
            e.action(["on", "off"]),
            e
                .numeric("group_id", ea.STATE)
                .withDescription("The device sends commands with this group ID. Put devices in this group to control them."),
        ],
    },
    {
        zigbeeModel: ["Air Sensor"],
        model: "mTouch_Air_Sensor",
        vendor: "CTM Lyng",
        description: "Air Sensor, temperature & humidity sensor",
        fromZigbee: [fz.battery, fz.temperature, fz.humidity],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3200 } } },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "msTemperatureMeasurement", "msRelativeHumidity"]);
            await reporting.batteryVoltage(endpoint);
            await endpoint.read("msTemperatureMeasurement", ["measuredValue"]);
            await reporting.temperature(endpoint);
            await endpoint.read("msRelativeHumidity", ["measuredValue"]);
            await reporting.humidity(endpoint);
        },
        exposes: [e.battery(), e.temperature(), e.humidity()],
    },
    {
        zigbeeModel: ["MBD-S"],
        model: "MBD-S",
        vendor: "CTM Lyng",
        description: "MBD-S, motion detector with 16A relay",
        fromZigbee: [fz.occupancy, fzLocal.ctm_mbd_device_enabled, fzLocal.ctm_relay_state],
        toZigbee: [tzLocal.ctm_mbd_device_enabled, tzLocal.ctm_relay_state],
        meta: { disableDefaultResponse: true },
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "msOccupancySensing"]);
            await endpoint.read("genOnOff", ["onOff"]);
            await reporting.onOff(endpoint);
            await endpoint.read("msOccupancySensing", ["occupancy"]);
            await reporting.occupancy(endpoint);
            await endpoint.read("genOnOff", ["relayState"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
            await endpoint.configureReporting("genOnOff", [
                {
                    attribute: "relayState",
                    minimumReportInterval: 1,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 0,
                },
            ], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
        },
        exposes: [e.switch(), e.occupancy(), e.binary("device_enabled", ea.ALL, "ON", "OFF").withDescription("Turn the device on or off")],
        extend: [cluster.addCtmGenOnOffCluster(), m.illuminance()],
    },
    {
        zigbeeModel: ["MBD Dim"],
        model: "CTM_MBD_Dim",
        vendor: "CTM Lyng",
        description: "MBD Dim, motion detector with dimmer",
        fromZigbee: [fz.occupancy, fzLocal.ctm_mbd_device_enabled, fzLocal.ctm_relay_state, fz.brightness, fz.lighting_ballast_configuration],
        toZigbee: [tzLocal.ctm_mbd_device_enabled, tzLocal.ctm_relay_state, tzLocal.ctm_mbd_brightness, tz.ballast_config],
        meta: { disableDefaultResponse: true },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "genLevelCtrl", "lightingBallastCfg", "msOccupancySensing"]);
            await endpoint.read("genOnOff", ["onOff"]);
            await reporting.onOff(endpoint);
            await endpoint.read("genLevelCtrl", ["currentLevel"]);
            await reporting.brightness(endpoint);
            await endpoint.read("lightingBallastCfg", ["minLevel", "maxLevel", "powerOnLevel"]);
            await endpoint.configureReporting("lightingBallastCfg", [
                {
                    attribute: "minLevel",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("lightingBallastCfg", [
                {
                    attribute: "maxLevel",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.configureReporting("lightingBallastCfg", [
                {
                    attribute: "powerOnLevel",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: null,
                },
            ]);
            await endpoint.read("msOccupancySensing", ["occupancy"]);
            await reporting.occupancy(endpoint);
            // Relay State
            await endpoint.read("genOnOff", ["relayState"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
            await endpoint.configureReporting("genOnOff", [
                {
                    attribute: "relayState",
                    minimumReportInterval: 1,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 0,
                },
            ], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
        },
        exposes: [
            e.light_brightness(),
            e.occupancy(),
            e.binary("device_enabled", ea.ALL, "ON", "OFF").withDescription("Turn the device on or off"),
            e.numeric("ballast_minimum_level", ea.ALL).withValueMin(10).withValueMax(97).withDescription("Specifies the minimum brightness value"),
            e.numeric("ballast_maximum_level", ea.ALL).withValueMin(10).withValueMax(97).withDescription("Specifies the maximum brightness value"),
            e
                .numeric("ballast_power_on_level", ea.ALL)
                .withValueMin(10)
                .withValueMax(97)
                .withDescription('Specifies the initialisation light level. Can not be set lower than "ballast_minimum_level"'),
        ],
        extend: [cluster.addCtmGenOnOffCluster(), m.illuminance()],
    },
    {
        fingerprint: [{ modelID: "DIMMER", manufacturerName: "NorLum Dim OP" }],
        model: "4503145",
        vendor: "CTM Lyng",
        description: "NorLum Dim OP, 2-250W rotary dimmer",
        extend: [m.identify(), m.light({ configureReporting: true, powerOnBehavior: true, effect: false })],
        ota: true,
        meta: {},
    },
];
//# sourceMappingURL=ctm.js.map