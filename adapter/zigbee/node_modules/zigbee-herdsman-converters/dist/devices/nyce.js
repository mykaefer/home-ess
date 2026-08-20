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
const reporting = __importStar(require("../lib/reporting"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
async function readNyceIasState(endpoint) {
    return await endpoint.read("ssIasZone", ["zoneState", "iasCieAddr", "zoneStatus"], { sendPolicy: "immediate" });
}
function hasExpectedNyceIasState(state, coordinatorIeeeAddress) {
    return state.zoneState === 1 && state.iasCieAddr?.toLowerCase() === coordinatorIeeeAddress.toLowerCase();
}
// NYCE NCZ-3011-HA fails IAS CIE address write during interview: https://github.com/Koenkk/zigbee2mqtt/issues/32480
// This is fixable in the configure step. Usually it is enough to read the iasState to finish the enrollment; but this code can also attempt to re-write it.
async function ensureNyceIasEnrollment(endpoint, coordinatorEndpoint) {
    const coordinatorIeeeAddress = coordinatorEndpoint.deviceIeeeAddress;
    let state = await readNyceIasState(endpoint);
    if (hasExpectedNyceIasState(state, coordinatorIeeeAddress)) {
        return;
    }
    let enrollmentError;
    try {
        await endpoint.write("ssIasZone", { iasCieAddr: coordinatorIeeeAddress }, { sendPolicy: "immediate" });
        await endpoint.command("ssIasZone", "enrollRsp", { enrollrspcode: 0, zoneid: 23 }, { disableDefaultResponse: true, sendPolicy: "immediate" });
    }
    catch (error) {
        enrollmentError = error;
    }
    await utils.sleep(500);
    state = await readNyceIasState(endpoint);
    if (!hasExpectedNyceIasState(state, coordinatorIeeeAddress)) {
        throw new Error(`NYCE IAS enrollment failed; expected zoneState=1 and iasCieAddr=${coordinatorIeeeAddress}, got ${JSON.stringify(state)}${enrollmentError ? ` after enrollment error: ${enrollmentError}` : ""}`);
    }
}
exports.definitions = [
    {
        zigbeeModel: ["3010"],
        model: "NCZ-3010",
        vendor: "Nyce",
        description: "Door hinge sensor",
        fromZigbee: [fz.ias_contact_alarm_1, fz.battery],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg"]);
            await reporting.batteryPercentageRemaining(endpoint);
        },
        exposes: [e.contact(), e.battery_low(), e.battery()],
    },
    {
        zigbeeModel: ["3011"],
        model: "NCZ-3011-HA",
        vendor: "Nyce",
        description: "Door/window sensor",
        fromZigbee: [fz.ias_contact_alarm_1, fz.ias_contact_alarm_1_report, fz.battery],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg"]);
            await reporting.batteryPercentageRemaining(endpoint);
            await ensureNyceIasEnrollment(endpoint, coordinatorEndpoint);
        },
        exposes: [e.contact(), e.battery_low(), e.tamper(), e.battery()],
    },
    {
        zigbeeModel: ["3014"],
        model: "NCZ-3014-HA",
        vendor: "Nyce",
        description: "Garage door tilt sensor",
        extend: [m.iasZoneAlarm({ zoneType: "contact", zoneAttributes: ["alarm_1", "tamper", "battery_low"] }), m.battery()],
    },
    {
        zigbeeModel: ["3043"],
        model: "NCZ-3043-HA",
        vendor: "Nyce",
        description: "Ceiling motion sensor",
        fromZigbee: [
            fz.occupancy,
            fz.humidity,
            fz.temperature,
            fz.ignore_genIdentify,
            fz.battery,
            fz.ignore_iaszone_report,
            fz.ias_occupancy_alarm_2,
        ],
        toZigbee: [],
        exposes: [e.occupancy(), e.humidity(), e.temperature(), e.battery(), e.battery_low(), e.tamper()],
    },
    {
        zigbeeModel: ["3041"],
        model: "NCZ-3041-HA",
        vendor: "Nyce",
        description: "Wall motion sensor",
        fromZigbee: [
            fz.occupancy,
            fz.humidity,
            fz.temperature,
            fz.ignore_genIdentify,
            fz.battery,
            fz.ignore_iaszone_report,
            fz.ias_occupancy_alarm_2,
        ],
        toZigbee: [],
        meta: { battery: { dontDividePercentage: true } },
        exposes: [e.occupancy(), e.humidity(), e.temperature(), e.battery(), e.battery_low(), e.tamper()],
    },
    {
        zigbeeModel: ["3045"],
        model: "NCZ-3045-HA",
        vendor: "Nyce",
        description: "Curtain motion sensor",
        fromZigbee: [
            fz.occupancy,
            fz.humidity,
            fz.temperature,
            fz.ignore_genIdentify,
            fz.battery,
            fz.ignore_iaszone_report,
            fz.ias_occupancy_alarm_2,
        ],
        toZigbee: [],
        meta: { battery: { dontDividePercentage: true } },
        exposes: [e.occupancy(), e.humidity(), e.temperature(), e.battery(), e.battery_low(), e.tamper()],
    },
];
//# sourceMappingURL=nyce.js.map