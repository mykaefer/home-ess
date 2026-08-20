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
const tz = __importStar(require("../converters/toZigbee"));
const exposes = __importStar(require("../lib/exposes"));
const reporting = __importStar(require("../lib/reporting"));
const e = exposes.presets;
const wyzeLockRawSeq = new Map();
const isStaleWyzeLockRawFrame = (msg) => {
    if (msg.data.length <= 3)
        return false;
    const seq = msg.data[3];
    const key = `${msg.device.ieeeAddr}:${msg.endpoint.ID}`;
    const lastSeq = wyzeLockRawSeq.get(key);
    if (lastSeq !== undefined && seq <= lastSeq && lastSeq - seq < 50)
        return true;
    wyzeLockRawSeq.set(key, seq);
    return false;
};
// The Wyze Lock v1 reports lock state via manufacturer-specific cluster 64512 (0xFC00)
// raw frames rather than standard ZCL lock operation events.
// Only len=85 frames reliably encode physical lock state at byte 80:
//   low two bits 0b11 = locked, 0b00 = unlocked.
// Heartbeat/rejoin frames (len=123) always have byte 80 = 0 regardless of actual state
// and must be skipped to avoid corrupting HA state on Z2M restart.
// Raw frames can also arrive out of order; byte 3 is a per-device sequence byte and
// stale frames must be skipped to avoid publishing an old lock state after a newer one.
// fz.lock is intentionally excluded: the device sends a ZCL lockState attribute report
// (cluster 0x0101) approximately every hour that always contains lockState=1 (locked)
// regardless of the actual physical state, causing false "locked" updates in HA.
const fzLocal = {
    wyzeLockRaw: {
        cluster: 64512,
        type: ["raw"],
        convert: (model, msg) => {
            if (isStaleWyzeLockRawFrame(msg))
                return undefined;
            if (msg.data.length !== 85)
                return undefined;
            const stateBit = msg.data[80] & 3;
            if (stateBit === 3)
                return { state: "LOCK", lock_state: "locked" };
            if (stateBit === 0)
                return { state: "UNLOCK", lock_state: "unlocked" };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["Ford"],
        model: "WLCKG1",
        vendor: "Wyze",
        description: "Lock",
        fromZigbee: [fz.battery, fzLocal.wyzeLockRaw],
        toZigbee: [tz.lock],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.endpoints[0];
            await reporting.bind(endpoint, coordinatorEndpoint, ["closuresDoorLock", "genPowerCfg"]);
            await reporting.batteryPercentageRemaining(endpoint);
        },
        exposes: [e.lock(), e.battery()],
    },
];
//# sourceMappingURL=wyze.js.map