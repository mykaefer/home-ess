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
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const fzLocal = {
    fzZunzunbeeSlateSwitchIAS: {
        cluster: "ssIasZone",
        type: ["attributeReport", "readResponse", "commandStatusChangeNotification"],
        convert: (model, msg, publish, options, meta) => {
            let zoneStatus;
            if ("zoneStatus" in msg.data) {
                zoneStatus = msg.data.zoneStatus;
            }
            else if ("zonestatus" in msg.data) {
                zoneStatus = msg.data.zonestatus;
            }
            else {
                return;
            }
            // Bit0 encodes press type
            const pressType = zoneStatus & 0x0001 ? "long_press" : "short_press";
            // Bits 1..8 encode button number (2..256)
            const masked = zoneStatus & 0x01fe;
            const map = { 2: 1, 4: 2, 8: 3, 16: 4, 32: 5, 64: 6, 128: 7, 256: 8 };
            if (masked in map) {
                return { action: `button_${utils.getFromLookup(masked, map)}_${pressType}` };
            }
        },
    },
};
exports.definitions = [
    {
        fingerprint: [{ manufacturerName: "zunzunbee", modelID: "SSWZ8T" }],
        model: "SSWZ8T",
        vendor: "zunzunbee",
        description: "Slate switch (8-button touch controller)",
        fromZigbee: [fzLocal.fzZunzunbeeSlateSwitchIAS],
        exposes: [
            e.action([
                "button_1_short_press",
                "button_1_long_press",
                "button_2_short_press",
                "button_2_long_press",
                "button_3_short_press",
                "button_3_long_press",
                "button_4_short_press",
                "button_4_long_press",
                "button_5_short_press",
                "button_5_long_press",
                "button_6_short_press",
                "button_6_long_press",
                "button_7_short_press",
                "button_7_long_press",
                "button_8_short_press",
                "button_8_long_press",
            ]),
        ],
        extend: [m.battery(), m.temperature()],
    },
];
//# sourceMappingURL=zunzunbee.js.map