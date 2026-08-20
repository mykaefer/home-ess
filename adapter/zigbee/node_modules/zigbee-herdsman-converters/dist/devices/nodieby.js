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
const m = __importStar(require("../lib/modernExtend"));
// Custom manufacturer cluster (0xFC00) that holds the NoDieby device settings.
// The firmware registers these as plain read/write attributes without a
// manufacturer code, so the cluster is defined without one here as well.
const NODIEBY_CLUSTER = "nodiebyConfig";
exports.definitions = [
    {
        zigbeeModel: ["ND-01"],
        model: "ND-01",
        vendor: "NoDieby",
        description: "Infrasonic intrusion detector",
        extend: [
            // Endpoint 1 = alarm (motion, armed state, settings), endpoint 2 = siren.
            m.deviceEndpoints({ endpoints: { alarm: 1, siren: 2 } }),
            m.deviceAddCustomCluster(NODIEBY_CLUSTER, {
                name: NODIEBY_CLUSTER,
                ID: 0xfc00,
                attributes: {
                    ledBrightness: { name: "ledBrightness", ID: 0x0001, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 100 },
                    sirenVolume: { name: "sirenVolume", ID: 0x0002, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 100 },
                    sensitivity: { name: "sensitivity", ID: 0x0003, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 2 },
                    alarmDuration: { name: "alarmDuration", ID: 0x0004, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 300 },
                    alarmDelay: { name: "alarmDelay", ID: 0x0005, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 120 },
                },
                commands: {},
                commandsResponse: {},
            }),
            // Armed state on endpoint 1, siren on endpoint 2. powerOnBehavior is
            // disabled because the firmware does not implement startUpOnOff.
            m.onOff({ powerOnBehavior: false, endpointNames: ["alarm", "siren"] }),
            // IAS Zone motion detection on endpoint 1, surfaced as occupancy.
            m.iasZoneAlarm({ zoneType: "occupancy", zoneAttributes: ["alarm_1"] }),
            // iasZoneAlarm is event-driven and never reads zoneStatus at join, so
            // occupancy stays unknown until the first notification. Read it once
            // during configure to initialise the state right after pairing.
            {
                isModernExtend: true,
                configure: [
                    async (device) => {
                        await device.getEndpoint(1).read("ssIasZone", ["zoneStatus"]);
                    },
                ],
            },
            m.numeric({
                name: "led_brightness",
                cluster: NODIEBY_CLUSTER,
                attribute: "ledBrightness",
                valueMin: 0,
                valueMax: 100,
                unit: "%",
                description: "Brightness of the status LED",
                access: "ALL",
                entityCategory: "config",
                endpointNames: ["alarm"],
            }),
            m.numeric({
                name: "volume",
                cluster: NODIEBY_CLUSTER,
                attribute: "sirenVolume",
                valueMin: 0,
                valueMax: 100,
                unit: "%",
                description: "Siren volume",
                access: "ALL",
                entityCategory: "config",
                endpointNames: ["alarm"],
            }),
            m.enumLookup({
                name: "sensitivity",
                cluster: NODIEBY_CLUSTER,
                attribute: "sensitivity",
                lookup: { low: 0, medium: 1, high: 2 },
                description: "Intrusion detection sensitivity",
                access: "ALL",
                entityCategory: "config",
                endpointName: "alarm",
            }),
            m.numeric({
                name: "alarm_duration",
                cluster: NODIEBY_CLUSTER,
                attribute: "alarmDuration",
                valueMin: 1,
                valueMax: 300,
                unit: "s",
                description: "Siren duration once triggered",
                access: "ALL",
                entityCategory: "config",
                endpointNames: ["alarm"],
            }),
            m.numeric({
                name: "alarm_delay",
                cluster: NODIEBY_CLUSTER,
                attribute: "alarmDelay",
                valueMin: 0,
                valueMax: 120,
                unit: "s",
                description: "Delay before the alarm triggers after detection",
                access: "ALL",
                entityCategory: "config",
                endpointNames: ["alarm"],
            }),
        ],
    },
];
//# sourceMappingURL=nodieby.js.map