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
const m = __importStar(require("../lib/modernExtend"));
exports.definitions = [
    {
        zigbeeModel: ["RD-250ZG"],
        model: "RD-250ZG",
        vendor: "Repenic Ltd.",
        description: "Dimmer",
        extend: [
            m.light({ configureReporting: true }),
            m.electricityMeter(),
            m.numeric({
                name: "min_brightness",
                cluster: "genLevelCtrl",
                attribute: { ID: 0xa000, type: 0x20 },
                description: "Minimum brightness (≈1–99%)",
                valueMin: 1,
                valueMax: 99,
            }),
            m.numeric({
                name: "max_brightness",
                cluster: "genLevelCtrl",
                attribute: { ID: 0xa003, type: 0x20 },
                description: "Maximum brightness (≈1–100%)",
                valueMin: 1,
                valueMax: 100,
            }),
            m.numeric({
                name: "start_brightness",
                cluster: "genLevelCtrl",
                attribute: { ID: 0x0011, type: 0x20 },
                description: "Default brightness at power-on/startup (0-254)",
                valueMin: 0,
                valueMax: 254,
            }),
            m.binary({
                name: "boost",
                cluster: "genLevelCtrl",
                attribute: { ID: 0xa004, type: 0x20 },
                description: "Boost function",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
            }),
            m.enumLookup({
                name: "dimming_mode",
                cluster: "genLevelCtrl",
                attribute: { ID: 0xb000, type: 0x30 },
                description: "Dimming mode",
                lookup: { "Leading edge": 0, "Trailing edge": 1 },
            }),
            m.numeric({
                name: "default_move_rate",
                cluster: "genLevelCtrl",
                attribute: { ID: 0x0014, type: 0x20 },
                description: "Default Move Rate",
                valueMin: 1,
                valueMax: 10,
            }),
        ],
    },
];
//# sourceMappingURL=repenic_ltd.js.map