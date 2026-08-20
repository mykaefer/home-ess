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
const fz = __importStar(require("../converters/fromZigbee"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const e = exposes.presets;
const ea = exposes.access;
const fzLocal = {
    MIRSO100: {
        cluster: "ssIasZone",
        type: "raw",
        convert: (model, msg, publish, options, meta) => {
            switch (msg.data[3]) {
                case 0:
                    return { action: "single" };
                case 1:
                    return { action: "double" };
                case 128:
                    return { action: "hold" };
            }
        },
    },
};
const tzLocal = {
    MIRSM200: {
        key: ["silence"],
        convertSet: async (entity, key, value, meta) => {
            if (value === "ON") {
                await entity.command("genOnOff", "off", {});
            }
        },
    },
};
const fzhe300Local = {
    HE300: {
        cluster: "msOccupancySensing",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const value = msg.data.occupancy;
            let occupancy = false;
            let humanMotionstate = "none";
            if (value === 0x00) {
                occupancy = false;
                humanMotionstate = "none";
            }
            else if (value === 0x01) {
                occupancy = true;
                humanMotionstate = "active";
            }
            else if (value === 0x02) {
                occupancy = true;
                humanMotionstate = "static";
            }
            else {
                occupancy = (value & 0x01) !== 0 || (value & 0x02) !== 0;
                humanMotionstate = (value & 0x02) !== 0 ? "static" : (value & 0x01) !== 0 ? "active" : "none";
            }
            return {
                occupancy: occupancy,
                human_motion_state: humanMotionstate,
            };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["MIR-MC100", "MIR-MC100-E"],
        model: "MIR-MC100",
        vendor: "MultIR",
        description: "Door sensor",
        whiteLabel: [{ model: "MIR-MC100-E", fingerprint: [{ modelID: "MIR-MC100-E" }] }],
        extend: [
            m.battery(),
            m.iasZoneAlarm({
                zoneType: "contact",
                zoneAttributes: ["alarm_1", "tamper", "battery_low"],
            }),
        ],
    },
    {
        zigbeeModel: ["MIR-IL100", "MIR-IR100", "MIR-IR100-E"],
        model: "MIR-IR100",
        vendor: "MultIR",
        description: "PIR sensor",
        whiteLabel: [{ vendor: "Intelbras", model: "MSM 1001", fingerprint: [{ modelID: "MIR-IR100-E" }] }],
        extend: [
            m.battery(),
            m.illuminance(),
            m.iasZoneAlarm({
                zoneType: "occupancy",
                zoneAttributes: ["alarm_1", "tamper", "battery_low"],
            }),
            m.enumLookup({
                name: "sensitivity",
                cluster: "ssIasZone",
                attribute: "currentZoneSensitivityLevel",
                description: "Sensitivity of the pir detector",
                lookup: {
                    low: 0x00,
                    medium: 0x01,
                    high: 0x02,
                },
                entityCategory: "config",
            }),
        ],
    },
    {
        zigbeeModel: ["HE300_ZB"],
        model: "HE300_ZB",
        vendor: "MultIR",
        description: "Human presence sensor",
        fromZigbee: [fz.occupancy, fzhe300Local.HE300],
        toZigbee: [],
        extend: [
            m.illuminance(),
            m.numeric({
                name: "occupancy_distance",
                cluster: 0x0406,
                attribute: { ID: 0xa205, type: 0x20 },
                description: "Motion Range Detection (meter)",
                valueMin: 2,
                valueMax: 6,
                entityCategory: "config",
            }),
            m.numeric({
                name: "unmanned_duration",
                cluster: 0x0406,
                attribute: { ID: 0xa206, type: 0x21 },
                description: "Ultrasonic occupied to unoccupied delay (seconds)",
                valueMin: 0,
                valueMax: 65535,
                entityCategory: "config",
            }),
            m.enumLookup({
                name: "sensitivity",
                cluster: 0x0406,
                attribute: { ID: 0xa203, type: 0x30 },
                description: "Sensitivity of human presence detection",
                lookup: {
                    low: 0x00,
                    medium: 0x01,
                    high: 0x02,
                },
                entityCategory: "config",
            }),
        ],
        exposes: [e.occupancy(), e.enum("human_motion_state", ea.STATE, ["none", "active", "static"]).withDescription("Human Motion State")],
    },
    {
        zigbeeModel: ["MIR-SM100-E"],
        model: "MIR-SM100-E",
        vendor: "MultIR",
        description: "Smoke sensor",
        extend: [m.battery(), m.iasZoneAlarm({ zoneType: "generic", zoneAttributes: ["alarm_1", "alarm_2", "tamper", "battery_low"] })],
        exposes: [
            exposes.enum("silence", ea.SET, ["ON"]).withDescription("After enabling mute, it will return to detection state after 90 seconds."),
        ],
    },
    {
        zigbeeModel: ["MIR-SM200"],
        model: "MIR-SM200",
        vendor: "MultIR",
        description: "Smoke sensor",
        toZigbee: [tzLocal.MIRSM200],
        extend: [m.battery(), m.iasZoneAlarm({ zoneType: "smoke", zoneAttributes: ["alarm_1", "tamper", "battery_low"] })],
        exposes: [
            exposes.enum("silence", ea.SET, ["ON"]).withDescription("After enabling mute, it will return to detection state after 90 seconds."),
        ],
    },
    {
        zigbeeModel: ["MIR-SO100"],
        model: "MIR-SO100",
        vendor: "MultIR",
        description: "SOS Button",
        fromZigbee: [fzLocal.MIRSO100],
        exposes: [e.action(["single", "double", "hold"])],
        extend: [m.battery()],
    },
    {
        zigbeeModel: ["MIR-TE600"],
        model: "MIR-TE600",
        vendor: "MultIR",
        description: "Temperature sensor",
        extend: [m.battery(), m.temperature(), m.humidity()],
        meta: {
            multiEndpoint: true,
        },
    },
    {
        zigbeeModel: ["MIR-WA100"],
        model: "MIR-WA100",
        vendor: "MultIR",
        description: "Water leakage sensor",
        extend: [
            m.battery(),
            m.iasZoneAlarm({
                zoneType: "water_leak",
                zoneAttributes: ["alarm_1", "battery_low"],
            }),
        ],
    },
];
//# sourceMappingURL=multir.js.map