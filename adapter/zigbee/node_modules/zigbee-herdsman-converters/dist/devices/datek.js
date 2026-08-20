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
const constants_1 = require("../lib/constants");
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const ea = exposes.access;
const datekExtend = {
    datekGenBasicCluster: () => m.deviceAddCustomCluster("genBasic", {
        name: "genBasic",
        ID: zigbee_herdsman_1.Zcl.Clusters.genBasic.ID,
        attributes: {
            lockFw: { name: "lockFw", ID: 0x5000, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR },
        },
        commands: {},
        commandsResponse: {},
    }),
    datekClosuresDoorLockCluster: () => m.deviceAddCustomCluster("closuresDoorLock", {
        name: "closuresDoorLock",
        ID: zigbee_herdsman_1.Zcl.Clusters.closuresDoorLock.ID,
        attributes: {
            masterPinMode: { name: "masterPinMode", ID: 0x4000, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            rfidEnable: { name: "rfidEnable", ID: 0x4001, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            hingeMode: { name: "hingeMode", ID: 0x4002, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true }, //False: Right hinged door, True: Left hinged door
            serviceMode: { name: "serviceMode", ID: 0x4003, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            lockMode: { name: "lockMode", ID: 0x4004, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            relockEnabled: { name: "relockEnabled", ID: 0x4005, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            audioVolume: { name: "audioVolume", ID: 0x4006, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, min: 0x00, max: 0x05 },
        },
        commands: {},
        commandsResponse: {},
    }),
    datekSsIasZoneCluster: () => m.deviceAddCustomCluster("ssIasZone", {
        name: "ssIasZone",
        ID: zigbee_herdsman_1.Zcl.Clusters.ssIasZone.ID,
        attributes: {
            ledOnMotion: { name: "ledOnMotion", ID: 0x4000, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
};
const tzLocal = {
    idlock_master_pin_mode: {
        key: ["master_pin_mode"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("closuresDoorLock", { 16384: { value: value === true ? 1 : 0, type: 0x10 } }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            return { state: { master_pin_mode: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", ["masterPinMode"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
    },
    idlock_rfid_enable: {
        key: ["rfid_enable"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("closuresDoorLock", { 16385: { value: value === true ? 1 : 0, type: 0x10 } }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            return { state: { rfid_enable: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", ["rfidEnable"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
    },
    idlock_service_mode: {
        key: ["service_mode"],
        convertSet: async (entity, key, value, meta) => {
            const lookup = { deactivated: 0, random_pin_1x_use: 5, random_pin_24_hours: 6 };
            await entity.write("closuresDoorLock", { 16387: { value: utils.getFromLookup(value, lookup), type: 0x20 } }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            return { state: { service_mode: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", ["serviceMode"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
    },
    idlock_lock_mode: {
        key: ["lock_mode"],
        convertSet: async (entity, key, value, meta) => {
            const lookup = { auto_off_away_off: 0, auto_on_away_off: 1, auto_off_away_on: 2, auto_on_away_on: 3 };
            await entity.write("closuresDoorLock", { 16388: { value: utils.getFromLookup(value, lookup), type: 0x20 } }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            return { state: { lock_mode: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", ["lockMode"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
    },
    idlock_relock_enabled: {
        key: ["relock_enabled"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("closuresDoorLock", { 16389: { value: value === true ? 1 : 0, type: 0x10 } }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            return { state: { relock_enabled: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", ["relockEnabled"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS,
            });
        },
    },
    led_on_motion: {
        key: ["led_on_motion"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("ssIasZone", { ledOnMotion: value === true }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
            return { state: { led_on_motion: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("ssIasZone", ["ledOnMotion"], { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS });
        },
    },
};
const fzLocal = {
    idlock: {
        cluster: "closuresDoorLock",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if ("masterPinMode" in msg.data) {
                result.master_pin_mode = msg.data.masterPinMode === true;
            }
            if ("rfidEnable" in msg.data) {
                result.rfid_enable = msg.data.rfidEnable === true;
            }
            if ("serviceMode" in msg.data) {
                const lookup = {
                    0: "deactivated",
                    1: "random_pin_1x_use",
                    5: "random_pin_1x_use",
                    6: "random_pin_24_hours",
                    9: "random_pin_24_hours",
                };
                // From Datek manual:  0: Deactivated, 1: 1x use, 2: 2x uses,  3: 5x uses,  4: 10x uses, 5: Random PIN 1x use, 6: Random PIN 24 hours,  7: Always valid, 8: 12 hours,  9: 24 hours
                result.service_mode = lookup[msg.data.serviceMode];
            }
            if ("lockMode" in msg.data) {
                const lookup = { 0: "auto_off_away_off", 1: "auto_on_away_off", 2: "auto_off_away_on", 3: "auto_on_away_on" };
                result.lock_mode = lookup[msg.data.lockMode];
            }
            if ("relockEnabled" in msg.data) {
                result.relock_enabled = msg.data.relockEnabled === true;
            }
            return result;
        },
    },
    idlock_fw: {
        cluster: "genBasic",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if ("lockFw" in msg.data) {
                result.idlock_lock_fw = msg.data.lockFw;
            }
            return result;
        },
    },
    metering_datek: {
        cluster: "seMetering",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = fz.metering.convert(model, msg, publish, options, meta);
            // Filter incorrect 0 energy values reported by the device:
            // https://github.com/Koenkk/zigbee2mqtt/issues/7852
            if (result && result.energy === 0) {
                delete result.energy;
            }
            return result;
        },
    },
    led_on_motion: {
        cluster: "ssIasZone",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if ("ledOnMotion" in msg.data) {
                result.led_on_motion = msg.data.ledOnMotion === true;
            }
            return result;
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["PoP"],
        model: "HLU2909K",
        vendor: "Datek",
        description: "APEX smart plug 16A",
        version: "0.0.1",
        extend: [m.electricityMeter({ cluster: "electrical", power: { min: 5, max: "1_HOUR", change: 1 } }), m.onOff(), m.temperature()],
        ota: true,
    },
    {
        zigbeeModel: ["Meter Reader"],
        model: "HSE2905E",
        vendor: "Datek",
        description: "Datek Eva AMS HAN power-meter sensor",
        fromZigbee: [fz.hw_version],
        extend: [
            m.electricityMeter({
                cluster: "metering",
                fzMetering: fzLocal.metering_datek,
                producedEnergy: true,
            }),
            m.electricityMeter({
                cluster: "electrical",
                threePhase: true,
                power: false,
            }),
            m.temperature(),
        ],
        ota: true,
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            try {
                // hwVersion < 2 do not support hwVersion attribute, so we are testing if this is hwVersion 1 or 2
                await endpoint.read("genBasic", ["hwVersion"]);
            }
            catch {
                /* empty */
            }
        },
    },
    {
        zigbeeModel: ["Motion Sensor"],
        model: "HSE2927E",
        vendor: "Datek",
        description: "Eva motion sensor",
        fromZigbee: [
            fz.battery,
            fz.occupancy,
            fz.occupancy_timeout,
            fz.temperature,
            fz.ias_enroll,
            fz.ias_occupancy_alarm_1,
            fz.ias_occupancy_alarm_1_report,
            fzLocal.led_on_motion,
        ],
        toZigbee: [tz.occupancy_timeout, tzLocal.led_on_motion],
        configure: async (device, coordinatorEndpoint) => {
            const options = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS };
            const endpoint = device.getEndpoint(1);
            const binds = ["msTemperatureMeasurement", "msOccupancySensing", "ssIasZone"];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            await reporting.occupancy(endpoint);
            await reporting.temperature(endpoint);
            await endpoint.configureReporting("ssIasZone", reporting.payload("ledOnMotion", 0, constants_1.repInterval.HOUR, 0), options);
            await endpoint.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
            await endpoint.read("msOccupancySensing", ["pirOToUDelay"]);
            await endpoint.read("ssIasZone", ["ledOnMotion"], options);
        },
        exposes: [
            e.temperature(),
            e.occupancy(),
            e.battery_low(),
            e.binary("led_on_motion", ea.ALL, true, false).withDescription("Enable/disable LED on motion"),
            e.numeric("occupancy_timeout", ea.ALL).withUnit("s").withValueMin(0).withValueMax(65535),
        ],
        extend: [m.illuminance(), datekExtend.datekSsIasZoneCluster()],
    },
    {
        zigbeeModel: ["ID Lock 150", "ID Lock 202"],
        model: "0402946",
        vendor: "Datek",
        description: "Zigbee module for ID lock",
        extend: [datekExtend.datekClosuresDoorLockCluster(), datekExtend.datekGenBasicCluster()],
        fromZigbee: [
            fz.lock,
            fz.battery,
            fz.lock_operation_event,
            fz.lock_programming_event,
            fzLocal.idlock,
            fzLocal.idlock_fw,
            fz.lock_pin_code_response,
            fz.lock_programming_event_read_pincode,
        ],
        toZigbee: [
            tz.lock,
            tz.lock_sound_volume,
            tzLocal.idlock_master_pin_mode,
            tzLocal.idlock_rfid_enable,
            tzLocal.idlock_service_mode,
            tzLocal.idlock_lock_mode,
            tzLocal.idlock_relock_enabled,
            tz.pincode_lock,
        ],
        meta: { pinCodeCount: 109 },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            const options = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.DATEK_WIRELESS_AS };
            await reporting.bind(endpoint, coordinatorEndpoint, ["closuresDoorLock", "genPowerCfg"]);
            await reporting.lockState(endpoint);
            await reporting.batteryPercentageRemaining(endpoint);
            const payload = [
                {
                    attribute: "masterPinMode",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants_1.repInterval.HOUR,
                    reportableChange: 1,
                },
                {
                    attribute: "rfidEnable",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants_1.repInterval.HOUR,
                    reportableChange: 1,
                },
                {
                    attribute: "serviceMode",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants_1.repInterval.HOUR,
                    reportableChange: 1,
                },
                {
                    attribute: "lockMode",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants_1.repInterval.HOUR,
                    reportableChange: 1,
                },
                {
                    attribute: "relockEnabled",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants_1.repInterval.HOUR,
                    reportableChange: 1,
                },
            ];
            await endpoint.configureReporting("closuresDoorLock", payload, options);
            await endpoint.read("closuresDoorLock", ["lockState", "soundVolume", "doorState"]);
            await endpoint.read("closuresDoorLock", ["masterPinMode", "rfidEnable", "serviceMode", "lockMode", "relockEnabled"], options);
            await endpoint.read("genBasic", ["lockFw"], options);
        },
        exposes: [
            e.lock(),
            e.battery(),
            e.pincode(),
            e.door_state(),
            e.lock_action(),
            e.lock_action_source_name(),
            e.lock_action_user(),
            e.enum("sound_volume", ea.ALL, constants.lockSoundVolume).withDescription("Sound volume of the lock"),
            e.binary("master_pin_mode", ea.ALL, true, false).withDescription("Allow Master PIN Unlock"),
            e.binary("rfid_enable", ea.ALL, true, false).withDescription("Allow RFID to Unlock"),
            e.binary("relock_enabled", ea.ALL, true, false).withDescription("Allow Auto Re-Lock"),
            e
                .enum("lock_mode", ea.ALL, ["auto_off_away_off", "auto_on_away_off", "auto_off_away_on", "auto_on_away_on"])
                .withDescription("Lock-Mode of the Lock"),
            e.enum("service_mode", ea.ALL, ["deactivated", "random_pin_1x_use", "random_pin_24_hours"]).withDescription("Service Mode of the Lock"),
        ],
    },
    {
        zigbeeModel: ["Water Sensor"],
        model: "HSE2919E",
        vendor: "Datek",
        description: "Eva water leak sensor",
        fromZigbee: [fz.temperature, fz.battery, fz.ias_enroll, fz.ias_water_leak_alarm_1, fz.ias_water_leak_alarm_1_report],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3000 } } },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "genBasic", "ssIasZone"]);
            await reporting.batteryVoltage(endpoint);
            await endpoint.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
            const endpoint2 = device.getEndpoint(2);
            await reporting.bind(endpoint2, coordinatorEndpoint, ["msTemperatureMeasurement"]);
        },
        endpoint: (device) => {
            return { default: 1 };
        },
        exposes: [e.battery(), e.battery_low(), e.temperature(), e.water_leak(), e.tamper()],
    },
    {
        zigbeeModel: ["Scene Selector", "SSDS"],
        model: "HBR2917E",
        vendor: "Datek",
        description: "Eva scene selector",
        fromZigbee: [fz.temperature, fz.battery, fz.command_recall, fz.command_on, fz.command_off, fz.command_move, fz.command_stop],
        toZigbee: [tz.on_off],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3000 } } },
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg", "genBasic", "genOnOff", "genLevelCtrl", "msTemperatureMeasurement"]);
            await reporting.batteryVoltage(endpoint);
            await reporting.temperature(endpoint, { min: constants.repInterval.MINUTES_10, max: constants.repInterval.HOUR, change: 100 });
        },
        exposes: [
            e.battery(),
            e.temperature(),
            e.action(["recall_1", "recall_2", "recall_3", "recall_4", "on", "off", "brightness_move_down", "brightness_move_up", "brightness_stop"]),
        ],
    },
    {
        zigbeeModel: ["Door/Window Sensor"],
        model: "HSE2920E",
        vendor: "Datek",
        description: "Door/window sensor",
        fromZigbee: [fz.ias_contact_alarm_1, fz.ias_contact_alarm_1_report, fz.temperature, fz.ias_enroll],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["ssIasZone", "msTemperatureMeasurement"]);
            await reporting.temperature(endpoint);
            await endpoint.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
        },
        exposes: [e.contact(), e.battery_low(), e.tamper(), e.temperature()],
    },
    {
        zigbeeModel: ["Contact Switch"],
        model: "HSE2936T",
        vendor: "Datek",
        description: "Door/window sensor",
        fromZigbee: [fz.ias_contact_alarm_1, fz.ias_contact_alarm_1_report, fz.temperature, fz.ias_enroll],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["ssIasZone", "msTemperatureMeasurement"]);
            await reporting.temperature(endpoint);
            await endpoint.read("ssIasZone", ["iasCieAddr", "zoneState", "zoneId"]);
        },
        exposes: [e.contact(), e.battery_low(), e.tamper(), e.temperature()],
    },
];
//# sourceMappingURL=datek.js.map