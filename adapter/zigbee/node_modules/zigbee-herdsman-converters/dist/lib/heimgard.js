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
exports.tzLocal = exports.fzLocal = exports.SLM_2 = void 0;
const zigbee_herdsman_1 = require("zigbee-herdsman");
const fz = __importStar(require("../converters/fromZigbee"));
const m = __importStar(require("./modernExtend"));
const utils = __importStar(require("./utils"));
const VOLUME_LOOKUP = { off: 0, low: 1, medium: 2, high: 3 };
exports.SLM_2 = {
    sound_volume: (args) => m.enumLookup({
        name: "sound_volume",
        cluster: "closuresDoorLock",
        attribute: { ID: 0x0024, type: zigbee_herdsman_1.Zcl.DataType.UINT8 },
        description: "Sound volume",
        lookup: VOLUME_LOOKUP,
        access: "ALL",
        ...args,
    }),
};
exports.fzLocal = {
    slm_2_lock: {
        cluster: "closuresDoorLock",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const convertedResult = fz.lock.convert(model, msg, publish, options, meta);
            const result = typeof convertedResult === "object" && convertedResult !== null ? convertedResult : {};
            if (msg.data["soundVolume"] !== undefined) {
                result.volume = utils.getFromLookup(msg.data["soundVolume"], { 0: "off", 1: "low", 2: "medium", 3: "high" });
            }
            return result;
        },
    },
};
exports.tzLocal = {
    slm_2_sound_volume: {
        key: ["volume"],
        convertSet: async (entity, key, value, meta) => {
            const payload = utils.getFromLookup(value, VOLUME_LOOKUP);
            await entity.write("closuresDoorLock", { 36: { value: payload, type: zigbee_herdsman_1.Zcl.DataType.UINT8 } });
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", [0x0024]);
        },
    },
};
//# sourceMappingURL=heimgard.js.map