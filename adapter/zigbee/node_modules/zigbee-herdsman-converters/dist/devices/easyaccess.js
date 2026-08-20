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
const onesti = __importStar(require("../devices/onesti"));
const exposes = __importStar(require("../lib/exposes"));
const reporting = __importStar(require("../lib/reporting"));
const e = exposes.presets;
const ea = exposes.access;
const fzLocal = {
    easycode_action: {
        cluster: "closuresDoorLock",
        type: "raw",
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                13: "lock",
                14: "zigbee_unlock",
                3: "rfid_unlock",
                0: "keypad_unlock",
            };
            const value = lookup[msg.data[4]];
            if (value === "lock" || value === "zigbee_unlock") {
                return { action: value };
            }
            return { action: lookup[msg.data[3]] };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["EasyCode903G2.1"],
        model: "EasyCode903G2.1",
        vendor: "EasyAccess",
        description: "EasyFinger V2",
        fromZigbee: [fz.lock, fzLocal.easycode_action, fz.battery],
        toZigbee: [tz.lock, onesti.tzLocal.easycode_auto_relock, tz.lock_sound_volume],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(11);
            await reporting.bind(endpoint, coordinatorEndpoint, ["closuresDoorLock", "genPowerCfg"]);
            await reporting.lockState(endpoint);
            await reporting.batteryPercentageRemaining(endpoint);
        },
        exposes: [
            e.lock(),
            e.battery(),
            e.sound_volume(),
            e.action(["zigbee_unlock", "lock", "rfid_unlock", "keypad_unlock"]),
            e.binary("auto_relock", ea.STATE_SET, true, false).withDescription("Auto relock after 7 seconds."),
        ],
        whiteLabel: [{ vendor: "Datek Wireless", model: "EasyCode903G2.1" }],
    },
];
//# sourceMappingURL=easyaccess.js.map