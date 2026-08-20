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
        zigbeeModel: ["Panel gen4", "Mill Wi-Fi Panel Heater Gen4\u0000\u0000\u0000\u0018Mill Int"],
        model: "Mill-gen-4",
        vendor: "Mill",
        description: "WiFi heating panel gen4",
        extend: [
            m.identify(),
            m.thermostat({
                setpoints: {
                    values: {
                        occupiedHeatingSetpoint: { min: 5, max: 35, step: 0.5 },
                    },
                },
                systemMode: {
                    values: ["off", "heat"],
                },
            }),
        ],
    },
    {
        fingerprint: [{ manufacturerName: "Mill International\u0000Threa" }, { manufacturerName: "Mill InternationalThrea" }],
        zigbeeModel: ["Mill International\u0000Threa", "Mill InternationalThrea"],
        model: "MFTWIFI",
        vendor: "Mill",
        description: "Smart floor thermostat WiFi & Zigbee",
        extend: [
            m.thermostat({
                setpoints: {
                    values: {
                        occupiedHeatingSetpoint: { min: 5, max: 35, step: 0.5 },
                    },
                },
                systemMode: {
                    values: ["off", "heat"],
                },
            }),
        ],
    },
];
//# sourceMappingURL=mill.js.map