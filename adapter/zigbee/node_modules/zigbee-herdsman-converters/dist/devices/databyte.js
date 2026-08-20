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
const utils = __importStar(require("../lib/utils"));
const ea = exposes.access;
const e = exposes.presets;
const tzLocal = {
    DTB190502A1_LED: {
        key: ["LED"],
        convertSet: async (entity, key, value, meta) => {
            if (value === "default") {
                value = 1;
            }
            const lookup = {
                OFF: 0,
                ON: 1,
            };
            value = utils.getFromLookup(value, lookup);
            // Check for valid data
            utils.assertNumber(value, key);
            if ((value >= 0 && value < 2) === false)
                value = 0;
            const payload = {
                16400: {
                    value,
                    type: 0x21,
                },
            };
            await entity.write("genBasic", payload);
        },
    },
};
const fzLocal = {
    DTB2011014: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            return {
                key_1: msg.data["41361"] === 1 ? "ON" : "OFF",
                key_2: msg.data["41362"] === 1 ? "ON" : "OFF",
                key_3: msg.data["41363"] === 1 ? "ON" : "OFF",
                key_4: msg.data["41364"] === 1 ? "ON" : "OFF",
            };
        },
    },
    DTB190502A1: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const lookupKEY = {
                "0": "KEY_SYS",
                "1": "KEY_UP",
                "2": "KEY_DOWN",
                "3": "KEY_NONE",
            };
            const lookupLED = { "0": "OFF", "1": "ON" };
            return {
                cpu_temperature: utils.precisionRound(msg.data["41361"], 2),
                key_state: lookupKEY[msg.data["41362"]],
                led_state: lookupLED[msg.data["41363"]],
            };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["DTB190502A1"],
        model: "DTB190502A1",
        vendor: "databyte.ch",
        description: "CC2530 based IO Board",
        fromZigbee: [fzLocal.DTB190502A1],
        toZigbee: [tzLocal.DTB190502A1_LED],
        exposes: [e.binary("led_state", ea.STATE, "ON", "OFF"), e.enum("key_state", ea.STATE, ["KEY_SYS", "KEY_UP", "KEY_DOWN", "KEY_NONE"])],
    },
    {
        zigbeeModel: ["DTB-ED2004-012"],
        model: "ED2004-012",
        vendor: "databyte.ch",
        description: "Panda 1 - wall switch",
        extend: [m.onOff()],
    },
    {
        zigbeeModel: ["DTB-ED2011-014"],
        model: "Touch4",
        vendor: "databyte.ch",
        description: "Wall touchsensor with 4 keys",
        fromZigbee: [fzLocal.DTB2011014, fz.battery],
        toZigbee: [],
        exposes: [
            e.battery(),
            e.binary("key_1", ea.STATE, "ON", "OFF"),
            e.binary("key_2", ea.STATE, "ON", "OFF"),
            e.binary("key_3", ea.STATE, "ON", "OFF"),
            e.binary("key_4", ea.STATE, "ON", "OFF"),
        ],
    },
];
//# sourceMappingURL=databyte.js.map