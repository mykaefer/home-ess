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
exports.namronExtend = exports.edgeThermostat = exports.toZigbee = exports.fromZigbee = void 0;
const zigbee_herdsman_1 = require("zigbee-herdsman");
const utils = __importStar(require("../lib/utils"));
const modernExtend = __importStar(require("./modernExtend"));
const sunricherManufacturer = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD };
function toDate(value) {
    if (value === undefined) {
        return;
    }
    const date = new Date(value * 86400000);
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0"); // Månedene er 0-indeksert
    const year = date.getFullYear();
    return `${year}.${month}.${day}`;
}
function fromDate(value) {
    // Ekstrakt `attrId` og `key` direkte fra attributtobjektet
    const dateParts = value.split(/[.\-/]/);
    if (dateParts.length !== 3) {
        throw new Error("Invalid date format");
    }
    let date;
    if (dateParts[0].length === 4) {
        date = new Date(`${dateParts[0]}-${dateParts[1]}-${dateParts[2]}`);
    }
    else if (dateParts[2].length === 4) {
        date = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`);
    }
    else {
        throw new Error("Invalid date format");
    }
    return date.getTime() / 86400000 + 1;
}
exports.fromZigbee = {
    namron_edge_thermostat_vacation_date: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.vacationStartDate !== undefined) {
                result.vacation_start_date = toDate(msg.data.vacationStartDate);
            }
            if (msg.data.vacationEndDate !== undefined) {
                result.vacation_end_date = toDate(msg.data.vacationEndDate);
            }
            return result;
        },
    },
    namron_edge_thermostat_holiday_temp: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.programingOperMode !== undefined) {
                result.operating_mode = utils.getFromLookup(msg.data.programingOperMode, { 0: "manual", 1: "program", 5: "eco" });
            }
            if (msg.data.holidayTempSet !== undefined) {
                result.holiday_temp_set = Number(msg.data.holidayTempSet) / 100;
            }
            if (msg.data.holidayTempSetF !== undefined) {
                result.holiday_temp_set_f = Number(msg.data.holidayTempSetF) / 100;
            }
            return result;
        },
    },
    namron_thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data;
            if (data.lcdBrightness !== undefined) {
                const lookup = { 0: "low", 1: "mid", 2: "high" };
                result.lcd_brightness = lookup[data.lcdBrightness];
            }
            if (data.buttonVibrationLevel !== undefined) {
                const lookup = { 0: "off", 1: "low", 2: "high" };
                result.button_vibration_level = lookup[data.buttonVibrationLevel];
            }
            if (data.floorSensorType !== undefined) {
                const lookup = { 1: "10k", 2: "15k", 3: "50k", 4: "100k", 5: "12k" };
                result.floor_sensor_type = lookup[data.floorSensorType];
            }
            if (data.controlType !== undefined) {
                // Sensor
                const lookup = { 0: "air", 1: "floor", 2: "both" };
                result.sensor = lookup[data.controlType];
            }
            if (data.powerUpStatus !== undefined) {
                const lookup = { 0: "default", 1: "last_status" };
                result.powerup_status = lookup[data.powerUpStatus];
            }
            if (data.floorSensorCalibration !== undefined) {
                result.floor_sensor_calibration = utils.precisionRound(data.floorSensorCalibration, 2) / 10;
            }
            if (data.dryTime !== undefined) {
                result.dry_time = data.dryTime;
            }
            if (data.modeAfterDry !== undefined) {
                const lookup = { 0: "off", 1: "manual", 2: "auto", 3: "away" };
                result.mode_after_dry = lookup[data.modeAfterDry];
            }
            if (data.temperatureDisplay !== undefined) {
                const lookup = { 0: "room", 1: "floor" };
                result.temperature_display = lookup[data.temperatureDisplay];
            }
            if (data.windowOpenCheck2 !== undefined) {
                result.window_open_check = data.windowOpenCheck2 / 2;
            }
            if (data.hysterersis !== undefined) {
                result.hysterersis = utils.precisionRound(data.hysterersis, 2) / 10;
            }
            if (data.displayAutoOffEnable !== undefined) {
                result.display_auto_off_enabled = data.displayAutoOffEnable ? "enabled" : "disabled";
            }
            if (data.alarmAirTempOverValue !== undefined) {
                result.alarm_airtemp_overvalue = data.alarmAirTempOverValue;
            }
            if (data.awayModeSet !== undefined) {
                result.away_mode = data.awayModeSet ? "ON" : "OFF";
            }
            return result;
        },
    },
    namron_hvac_user_interface: {
        cluster: "hvacUserInterfaceCfg",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.keypadLockout !== undefined) {
                // Set as child lock instead as keypadlockout
                result.child_lock = msg.data.keypadLockout === 0 ? "UNLOCK" : "LOCK";
            }
            return result;
        },
    },
};
exports.toZigbee = {
    namron_edge_thermostat_vacation_date: {
        key: ["vacation_start_date", "vacation_end_date"],
        convertGet: async (entity, key, meta) => {
            switch (key) {
                case "vacation_start_date":
                    await entity.read("hvacThermostat", ["vacationStartDate"]);
                    break;
                case "vacation_end_date":
                    await entity.read("hvacThermostat", ["vacationEndDate"]);
                    break;
            }
        },
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
                case "vacation_start_date":
                    await entity.write("hvacThermostat", {
                        32800: { value: fromDate(String(value)), type: zigbee_herdsman_1.Zcl.DataType.UINT32 },
                    });
                    break;
                case "vacation_end_date":
                    await entity.write("hvacThermostat", {
                        32801: { value: fromDate(String(value)), type: zigbee_herdsman_1.Zcl.DataType.UINT32 },
                    });
                    break;
            }
        },
    },
    namron_edge_thermostat_holiday_temp: {
        key: ["operating_mode", "holiday_temp_set", "holiday_temp_set_f"],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
                case "operating_mode":
                    await entity.write("hvacThermostat", {
                        programingOperMode: utils.getFromLookup(value, { manual: 0, program: 1, eco: 5 }),
                    });
                    break;
                case "holiday_temp_set":
                    await entity.write("hvacThermostat", {
                        32787: { value: Number(value) * 100, type: zigbee_herdsman_1.Zcl.DataType.INT16 },
                    });
                    break;
                case "holiday_temp_set_f":
                    await entity.write("hvacThermostat", {
                        32795: { value: Number(value) * 100, type: zigbee_herdsman_1.Zcl.DataType.INT16 },
                    });
                    break;
            }
        },
        convertGet: async (entity, key, meta) => {
            switch (key) {
                case "operating_mode":
                    await entity.read("hvacThermostat", ["programingOperMode"]);
                    break;
                case "holiday_temp_set":
                    await entity.read("hvacThermostat", ["holidayTempSet"]);
                    break;
                case "holiday_temp_set_f":
                    await entity.read("hvacThermostat", ["holidayTempSetF"]);
                    break;
            }
        },
    },
    namron_thermostat: {
        key: [
            "lcd_brightness",
            "button_vibration_level",
            "floor_sensor_type",
            "sensor",
            "powerup_status",
            "floor_sensor_calibration",
            "dry_time",
            "mode_after_dry",
            "temperature_display",
            "window_open_check",
            "hysterersis",
            "display_auto_off_enabled",
            "alarm_airtemp_overvalue",
            "away_mode",
        ],
        convertSet: async (entity, key, value, meta) => {
            if (key === "lcd_brightness") {
                const lookup = { low: 0, mid: 1, high: 2 };
                const payload = { 4096: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "button_vibration_level") {
                const lookup = { off: 0, low: 1, high: 2 };
                const payload = { 4097: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "floor_sensor_type") {
                const lookup = { "10k": 1, "15k": 2, "50k": 3, "100k": 4, "12k": 5 };
                const payload = { 4098: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "sensor") {
                const lookup = { air: 0, floor: 1, both: 2 };
                const payload = { 4099: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "powerup_status") {
                const lookup = { default: 0, last_status: 1 };
                const payload = { 4100: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "floor_sensor_calibration") {
                utils.assertNumber(value);
                const payload = { 4101: { value: Math.round(value * 10), type: 0x28 } }; // INT8S
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "dry_time") {
                const payload = { 4102: { value: value, type: 0x20 } }; // INT8U
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "mode_after_dry") {
                const lookup = { off: 0, manual: 1, auto: 2, away: 3 };
                const payload = { 4103: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "temperature_display") {
                const lookup = { room: 0, floor: 1 };
                const payload = { 4104: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "window_open_check") {
                utils.assertNumber(value);
                const payload = { 4105: { value: value * 2, type: 0x20 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "hysterersis") {
                utils.assertNumber(value);
                const payload = { 4106: { value: value * 10, type: 0x20 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "display_auto_off_enabled") {
                const lookup = { disabled: 0, enabled: 1 };
                const payload = { 4107: { value: utils.getFromLookup(value, lookup), type: zigbee_herdsman_1.Zcl.DataType.ENUM8 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "alarm_airtemp_overvalue") {
                const payload = { 8193: { value: value, type: 0x20 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
            else if (key === "away_mode") {
                const payload = { 8194: { value: Number(value === "ON"), type: 0x30 } };
                await entity.write("hvacThermostat", payload, sunricherManufacturer);
            }
        },
        convertGet: async (entity, key, meta) => {
            switch (key) {
                case "lcd_brightness":
                    await entity.read("hvacThermostat", ["lcdBrightness"], sunricherManufacturer);
                    break;
                case "button_vibration_level":
                    await entity.read("hvacThermostat", ["buttonVibrationLevel"], sunricherManufacturer);
                    break;
                case "floor_sensor_type":
                    await entity.read("hvacThermostat", ["floorSensorType"], sunricherManufacturer);
                    break;
                case "sensor":
                    await entity.read("hvacThermostat", ["controlType"], sunricherManufacturer);
                    break;
                case "powerup_status":
                    await entity.read("hvacThermostat", ["powerUpStatus"], sunricherManufacturer);
                    break;
                case "floor_sensor_calibration":
                    await entity.read("hvacThermostat", ["floorSensorCalibration"], sunricherManufacturer);
                    break;
                case "dry_time":
                    await entity.read("hvacThermostat", ["dryTime"], sunricherManufacturer);
                    break;
                case "mode_after_dry":
                    await entity.read("hvacThermostat", ["modeAfterDry"], sunricherManufacturer);
                    break;
                case "temperature_display":
                    await entity.read("hvacThermostat", ["temperatureDisplay"], sunricherManufacturer);
                    break;
                case "window_open_check":
                    await entity.read("hvacThermostat", ["windowOpenCheck2"], sunricherManufacturer);
                    break;
                case "hysterersis":
                    await entity.read("hvacThermostat", ["hysterersis"], sunricherManufacturer);
                    break;
                case "display_auto_off_enabled":
                    await entity.read("hvacThermostat", ["displayAutoOffEnable"], sunricherManufacturer);
                    break;
                case "alarm_airtemp_overvalue":
                    await entity.read("hvacThermostat", ["alarmAirTempOverValue"], sunricherManufacturer);
                    break;
                case "away_mode":
                    await entity.read("hvacThermostat", ["awayModeSet"], sunricherManufacturer);
                    break;
                default: // Unknown key
                    throw new Error(`Unhandled key toZigbee.namron_thermostat.convertGet ${key}`);
            }
        },
    },
    namron_thermostat_child_lock: {
        key: ["child_lock"],
        convertSet: async (entity, key, value, meta) => {
            const keypadLockout = Number(value === "LOCK");
            await entity.write("hvacUserInterfaceCfg", { keypadLockout });
            return { state: { child_lock: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacUserInterfaceCfg", ["keypadLockout"]);
        },
    },
};
exports.edgeThermostat = {
    windowOpenDetection: (args) => modernExtend.binary({
        name: "window_open_check",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        cluster: "hvacThermostat",
        attribute: "windowOpenCheck",
        description: "Enables or disables the window open detection",
        access: "ALL",
        ...args,
    }),
    antiFrost: (args) => modernExtend.binary({
        name: "anti_frost",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        cluster: "hvacThermostat",
        attribute: "antiFrost",
        description: "Enables or disables the anti-frost mode",
        access: "ALL",
        ...args,
    }),
    summerWinterSwitch: (args) => modernExtend.binary({
        name: "summer_winter_switch",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        cluster: "hvacThermostat",
        attribute: "summerWinterSwitch",
        description: "Summer/winter switch",
        access: "ALL",
        ...args,
    }),
    vacationMode: (args) => modernExtend.binary({
        name: "vacation_mode",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        cluster: "hvacThermostat",
        attribute: "vacationMode",
        description: "Vacation mode",
        access: "ALL",
        ...args,
    }),
    timeSync: (args) => modernExtend.binary({
        name: "time_sync",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        cluster: "hvacThermostat",
        attribute: "timeSync",
        description: "Time sync",
        access: "ALL",
        ...args,
    }),
    autoTime: (args) => modernExtend.binary({
        name: "auto_time",
        valueOn: ["ON", 1],
        valueOff: ["OFF", 0],
        cluster: "hvacThermostat",
        attribute: "autoTime",
        description: "Auto time",
        access: "ALL",
        ...args,
    }),
    displayActiveBacklight: (args) => modernExtend.numeric({
        name: "display_active_backlight",
        cluster: "hvacThermostat",
        attribute: "displayActiveBacklight",
        description: "Display active backlight",
        valueMin: 1,
        valueMax: 100,
        valueStep: 1,
        unit: "%",
        access: "ALL",
        ...args,
    }),
    regulatorPercentage: (args) => modernExtend.numeric({
        name: "regulator_percentage",
        cluster: "hvacThermostat",
        attribute: "regulatorPercentage",
        description: "Regulator percentage",
        unit: "%",
        valueMax: 100,
        valueMin: 0,
        valueStep: 1,
        access: "ALL",
        ...args,
    }),
    regulationMode: (args) => modernExtend.enumLookup({
        name: "regulation_mode",
        cluster: "hvacThermostat",
        attribute: "regulationMode",
        description: "Regulation mode",
        lookup: { off: 0, heat: 1, cool: 2 },
        access: "ALL",
        ...args,
    }),
    displayAutoOff: (args) => modernExtend.enumLookup({
        name: "display_auto_off",
        cluster: "hvacThermostat",
        attribute: "displayAutoOff2",
        description: "Display auto off",
        lookup: { always_on: 0, auto_off_after_10s: 1, auto_off_after_30s: 2, auto_off_after_60s: 3 },
        access: "ALL",
        ...args,
    }),
    sensorMode: (args) => modernExtend.enumLookup({
        name: "sensor_mode",
        cluster: "hvacThermostat",
        attribute: "sensorMode",
        description: "Sensor mode",
        lookup: { air: 0, floor: 1, external: 3, regulator: 6 },
        access: "ALL",
        ...args,
    }),
    boostTime: (args) => modernExtend.enumLookup({
        name: "boost_time_set",
        cluster: "hvacThermostat",
        attribute: "boostTimeSet",
        description: "Boost time",
        lookup: {
            off: 0,
            "5min": 1,
            "10min": 2,
            "15min": 3,
            "20min": 4,
            "25min": 5,
            "30min": 6,
            "35min": 7,
            "40min": 8,
            "45min": 9,
            "50min": 10,
            "55min": 11,
            "1h": 12,
            "1h_5min": 13,
            "1h_10min": 14,
            "1h_15min": 15,
            "1h_20min": 16,
            "1h_25min": 17,
            "1h_30min": 18,
            "1h_35min": 19,
            "1h_40min": 20,
            "1h_45min": 21,
            "1h_50min": 22,
            "1h_55min": 23,
            "2h": 24,
        },
        access: "ALL",
        ...args,
    }),
    systemMode: (args) => modernExtend.enumLookup({
        name: "system_mode",
        cluster: "hvacThermostat",
        attribute: "systemMode",
        description: "System mode",
        lookup: { off: 0x00, auto: 0x01, cool: 0x03, heat: 0x04 },
        access: "ALL",
        ...args,
    }),
    deviceTime: (args) => modernExtend.numeric({
        name: "time_sync_value",
        cluster: "hvacThermostat",
        attribute: "deviceTime",
        description: "Device time",
        valueMin: 0,
        valueMax: 4294967295,
        access: "ALL",
        ...args,
    }),
    absMinHeatSetpointLimitF: (args) => modernExtend.numeric({
        name: "abs_min_heat_setpoint_limit_f",
        cluster: "hvacThermostat",
        attribute: "absMinHeatSetpointLimitF",
        description: "Absolute min heat setpoint limit",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    absMaxHeatSetpointLimitF: (args) => modernExtend.numeric({
        name: "abs_max_heat_setpoint_limit_f",
        cluster: "hvacThermostat",
        attribute: "absMaxHeatSetpointLimitF",
        description: "Absolute max heat setpoint limit",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    absMinCoolSetpointLimitF: (args) => modernExtend.numeric({
        name: "abs_min_cool_setpoint_limit_f",
        cluster: "hvacThermostat",
        attribute: "absMinCoolSetpointLimitF",
        description: "Absolute min cool setpoint limit",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    absMaxCoolSetpointLimitF: (args) => modernExtend.numeric({
        name: "abs_max_cool_setpoint_limit_f",
        cluster: "hvacThermostat",
        attribute: "absMaxCoolSetpointLimitF",
        description: "Absolute max cool setpoint limit",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    occupiedCoolingSetpointF: (args) => modernExtend.numeric({
        name: "occupied_cooling_setpoint_f",
        cluster: "hvacThermostat",
        attribute: "occupiedCoolingSetpointF",
        description: "Occupied cooling setpoint",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    occupiedHeatingSetpointF: (args) => modernExtend.numeric({
        name: "occupied_heating_setpoint_f",
        cluster: "hvacThermostat",
        attribute: "occupiedHeatingSetpointF",
        description: "Occupied heating setpoint",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    localTemperatureF: (args) => modernExtend.numeric({
        name: "local_temperature_f",
        cluster: "hvacThermostat",
        attribute: "localTemperatureF",
        description: "Local temperature",
        unit: "°F",
        access: "ALL",
        ...args,
    }),
    readOnly: {
        windowState: (args) => modernExtend.binary({
            name: "window_state",
            valueOn: ["OPEN", 1],
            valueOff: ["CLOSED", 0],
            cluster: "hvacThermostat",
            attribute: "windowState",
            description: "Window state",
            access: "STATE_GET",
            ...args,
        }),
        deviceFault: (args) => modernExtend.enumLookup({
            name: "fault",
            cluster: "hvacThermostat",
            attribute: "fault",
            description: "Device fault",
            lookup: {
                no_fault: 0,
                over_current_error: 1,
                over_heat_error: 2,
                "built-in_sensor_error": 3,
                air_sensor_error: 4,
                floor_sensor_error: 5,
            },
            access: "STATE_GET",
            ...args,
        }),
        workDays: (args) => modernExtend.enumLookup({
            name: "work_days",
            cluster: "hvacThermostat",
            attribute: "workDays",
            description: "Work days",
            lookup: { "monday-friday_saturday-sunday": 0, "monday-saturday_sunday": 1, no_time_off: 2, time_off: 3 },
            access: "STATE_GET",
            ...args,
        }),
        boostTimeRemaining: (args) => modernExtend.numeric({
            name: "boost_time_remaining",
            cluster: "hvacThermostat",
            attribute: "boostTimeRemaining",
            description: "Boost time remaining",
            unit: "min",
            access: "STATE_GET",
            ...args,
        }),
    },
};
exports.namronExtend = {
    addCustomClusterNamronPrivateE004: () => modernExtend.deviceAddCustomCluster("namronPrivateE004", {
        name: "namronPrivateE004",
        ID: 0xe004,
        attributes: {},
        commands: {},
        commandsResponse: {},
    }),
    addNamronHvacThermostatCluster: () => modernExtend.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            operateDisplayBrightness: {
                name: "operateDisplayBrightness",
                ID: 0x1000,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            displayAutoOff: {
                name: "displayAutoOff",
                ID: 0x1001,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            floorSensorType: {
                name: "floorSensorType",
                ID: 0x1002,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            controlType: {
                name: "controlType",
                ID: 0x1003,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            powerUpStatus: {
                name: "powerUpStatus",
                ID: 0x1004,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            floorSensorCalibration: {
                name: "floorSensorCalibration",
                ID: 0x1005,
                type: zigbee_herdsman_1.Zcl.DataType.INT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            dryTime: {
                name: "dryTime",
                ID: 0x1006,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            modeAfterDry: {
                name: "modeAfterDry",
                ID: 0x1007,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            temperatureDisplay: {
                name: "temperatureDisplay",
                ID: 0x1008,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            windowOpenCheck2: {
                name: "windowOpenCheck2",
                ID: 0x1009,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            hysterersis: {
                name: "hysterersis",
                ID: 0x100a,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            windowOpen: {
                name: "windowOpen",
                ID: 0x100b,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            adaptiveFunction: {
                name: "adaptiveFunction",
                ID: 0x100c,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            alarmAirTempOverValue: {
                name: "alarmAirTempOverValue",
                ID: 0x2001,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            awayModeSet: {
                name: "awayModeSet",
                ID: 0x2002,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            pidKp: {
                name: "pidKp",
                ID: 0x2006,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            pidKd: {
                name: "pidKd",
                ID: 0x2007,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            pidKi: {
                name: "pidKi",
                ID: 0x2008,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            controlMethod: {
                name: "controlMethod",
                ID: 0x2009,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            windowOpenCheck: {
                name: "windowOpenCheck",
                ID: 0x8000,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
            },
            antiFrost: {
                name: "antiFrost",
                ID: 0x8001,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
            },
            windowState: {
                name: "windowState",
                ID: 0x8002,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
            },
            workDays: {
                name: "workDays",
                ID: 0x8003,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            sensorMode: {
                name: "sensorMode",
                ID: 0x8004,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                write: true,
            },
            displayActiveBacklight: {
                name: "displayActiveBacklight",
                ID: 0x8005,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            fault: {
                name: "fault",
                ID: 0x8006,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            backlightOnoff: {
                name: "backlightOnoff",
                ID: 0x8009,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            timeSync: {
                name: "timeSync", // time_sync_value
                ID: 0x800a,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            deviceTime: {
                name: "deviceTime",
                ID: 0x800b,
                type: zigbee_herdsman_1.Zcl.DataType.UINT32,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            absMinHeatSetpointLimitF: {
                name: "absMinHeatSetpointLimitF",
                ID: 0x800c,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            absMaxHeatSetpointLimitF: {
                name: "absMaxHeatSetpointLimitF",
                ID: 0x800d,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            absMinCoolSetpointLimitF: {
                name: "absMinCoolSetpointLimitF",
                ID: 0x800e,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            absMaxCoolSetpointLimitF: {
                name: "absMaxCoolSetpointLimitF",
                ID: 0x800f,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            occupiedCoolingSetpointF: {
                name: "occupiedCoolingSetpointF",
                ID: 0x8010,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            occupiedHeatingSetpointF: {
                name: "occupiedHeatingSetpointF",
                ID: 0x8011,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            localTemperatureF: {
                name: "localTemperatureF",
                ID: 0x8012,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            holidayTempSet: {
                name: "holidayTempSet",
                ID: 0x8013,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            holidayTempSetF: {
                name: "holidayTempSetF",
                ID: 0x801b,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            regulationMode: {
                name: "regulationMode",
                ID: 0x801c,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            regulatorPercentage: {
                name: "regulatorPercentage",
                ID: 0x801d,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            summerWinterSwitch: {
                name: "summerWinterSwitch",
                ID: 0x801e,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            vacationMode: {
                name: "vacationMode",
                ID: 0x801f,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            vacationStartDate: {
                name: "vacationStartDate",
                ID: 0x8020,
                type: zigbee_herdsman_1.Zcl.DataType.UINT32,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            vacationEndDate: {
                name: "vacationEndDate",
                ID: 0x8021,
                type: zigbee_herdsman_1.Zcl.DataType.UINT32,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            autoTime: {
                name: "autoTime",
                ID: 0x8022,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            boostTimeSet: {
                name: "boostTimeSet",
                ID: 0x8023,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            boostTimeRemaining: {
                name: "boostTimeRemaining",
                ID: 0x8024,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
            displayAutoOff2: {
                name: "displayAutoOff2",
                ID: 0x8029,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                write: true,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
    addNamronHvacThermostat2Cluster: () => modernExtend.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            lcdBrightness: {
                name: "lcdBrightness",
                ID: 0x1000,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            buttonVibrationLevel: {
                name: "buttonVibrationLevel",
                ID: 0x1001,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            floorSensorType: {
                name: "floorSensorType",
                ID: 0x1002,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            controlType: {
                name: "controlType",
                ID: 0x1003,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            powerUpStatus: {
                name: "powerUpStatus",
                ID: 0x1004,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            floorSensorCalibration: {
                name: "floorSensorCalibration",
                ID: 0x1005,
                type: zigbee_herdsman_1.Zcl.DataType.INT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            dryTime: {
                name: "dryTime",
                ID: 0x1006,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            modeAfterDry: {
                name: "modeAfterDry",
                ID: 0x1007,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            temperatureDisplay: {
                name: "temperatureDisplay",
                ID: 0x1008,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            windowOpenCheck2: {
                name: "windowOpenCheck2",
                ID: 0x1009,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            hysterersis: {
                name: "hysterersis",
                ID: 0x100a,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            displayAutoOffEnable: {
                name: "displayAutoOffEnable", // WindowOpen
                ID: 0x100b,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            alarmAirTempOverValue: {
                name: "alarmAirTempOverValue",
                ID: 0x2001,
                type: zigbee_herdsman_1.Zcl.DataType.UINT8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
            awayModeSet: {
                name: "awayModeSet",
                ID: 0x2002,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.SHENZHEN_SUNRICHER_TECHNOLOGY_LTD,
                write: true,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
};
//# sourceMappingURL=namron.js.map