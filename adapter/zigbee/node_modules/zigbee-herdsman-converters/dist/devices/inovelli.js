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
const inovelli = __importStar(require("../lib/inovelli"));
const m = __importStar(require("../lib/modernExtend"));
exports.definitions = [
    {
        zigbeeModel: ["VZM30-SN"],
        model: "VZM30-SN",
        vendor: "Inovelli",
        description: "On/off switch",
        extend: [
            m.deviceEndpoints({
                endpoints: { "1": 1, "2": 2, "3": 3, "4": 4 },
                multiEndpointSkip: ["state", "voltage", "power", "current", "energy", "brightness", "temperature", "humidity"],
            }),
            inovelli.m.light(),
            inovelli.m.ledEffects(),
            inovelli.m.buttonTaps(),
            inovelli.m.parameters({
                attrs: [{ attributes: inovelli.VZM30_ATTRIBUTES, clusterName: inovelli.CLUSTER_NAME }],
                model: inovelli.Model.VZM30,
            }),
            inovelli.m.addCustomCluster(),
            m.identify(),
            inovelli.m.energyReset(),
            m.electricityMeter({ energy: { divisor: 1000 } }),
            m.temperature(),
            m.humidity(),
        ],
        ota: true,
    },
    {
        zigbeeModel: ["VZM31-SN"],
        model: "VZM31-SN",
        vendor: "Inovelli",
        description: "2-in-1 switch + dimmer",
        extend: [
            m.deviceEndpoints({
                endpoints: { "1": 1, "2": 2, "3": 3 },
                multiEndpointSkip: ["state", "power", "energy", "brightness"],
            }),
            inovelli.m.light(),
            inovelli.m.ledEffects(),
            inovelli.m.buttonTaps(),
            inovelli.m.parameters({
                attrs: [{ attributes: inovelli.VZM31_ATTRIBUTES, clusterName: inovelli.CLUSTER_NAME }],
                model: inovelli.Model.VZM31,
            }),
            inovelli.m.addCustomCluster(),
            m.identify(),
            inovelli.m.energyReset(),
            m.electricityMeter({
                current: false,
                voltage: false,
                power: { min: 15, max: 3600, change: 1 },
                energy: { min: 15, max: 3600, change: 0 },
            }),
        ],
        ota: true,
    },
    {
        zigbeeModel: ["VZM32-SN"],
        model: "VZM32-SN",
        vendor: "Inovelli",
        description: "mmWave Zigbee Dimmer",
        extend: [
            m.deviceEndpoints({
                endpoints: { "1": 1, "2": 2, "3": 3 },
                multiEndpointSkip: ["state", "voltage", "power", "current", "energy", "brightness", "illuminance", "occupancy"],
            }),
            inovelli.m.light(),
            inovelli.m.ledEffects(),
            inovelli.m.buttonTaps(),
            inovelli.m.parameters({
                attrs: [
                    { attributes: inovelli.VZM32_ATTRIBUTES, clusterName: inovelli.CLUSTER_NAME },
                    { attributes: inovelli.VZM32_MMWAVE_ATTRIBUTES, clusterName: inovelli.MMWAVE_CLUSTER_NAME },
                ],
                model: inovelli.Model.VZM32,
            }),
            inovelli.m.mmWave(),
            inovelli.m.addCustomCluster(),
            inovelli.m.addCustomMMWaveCluster(),
            m.identify(),
            inovelli.m.energyReset(),
            m.electricityMeter({
                energy: { divisor: 1000 },
            }),
            m.illuminance(),
            m.occupancy(),
        ],
        ota: true,
    },
    {
        zigbeeModel: ["VZM35-SN"],
        model: "VZM35-SN",
        vendor: "Inovelli",
        description: "Fan controller",
        extend: [
            inovelli.m.fan({ endpointId: 1 }),
            inovelli.m.ledEffects(),
            inovelli.m.buttonTaps(),
            inovelli.m.parameters({
                attrs: [{ attributes: inovelli.VZM35_ATTRIBUTES, clusterName: inovelli.CLUSTER_NAME }],
                model: inovelli.Model.VZM35,
            }),
            inovelli.m.addCustomCluster(),
            m.identify(),
        ],
        ota: true,
    },
    {
        zigbeeModel: ["VZM36"],
        model: "VZM36",
        vendor: "Inovelli",
        description: "Fan canopy module",
        fromZigbee: [],
        toZigbee: [],
        extend: [
            inovelli.m.light({ splitValuesByEndpoint: true }),
            inovelli.m.fan({ endpointId: 2, splitValuesByEndpoint: true }),
            inovelli.m.parameters({
                attrs: [{ attributes: inovelli.VZM36_ATTRIBUTES, clusterName: inovelli.CLUSTER_NAME }],
                model: inovelli.Model.VZM36,
                splitValuesByEndpoint: true,
            }),
            inovelli.m.addCustomCluster(),
            m.identify(),
        ],
        ota: true,
    },
];
//# sourceMappingURL=inovelli.js.map