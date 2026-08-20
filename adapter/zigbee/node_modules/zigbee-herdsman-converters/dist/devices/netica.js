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
const manufacturerOptions = {
    // no official manufacturer code yet
    manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.RESERVED_10,
};
exports.definitions = [
    {
        zigbeeModel: ["FRZ1"],
        model: "FRZ1",
        vendor: "Netica",
        description: "FreezBee, a smart thermostat designed to operate with Frisquet boilers",
        ota: true,
        extend: [
            // standard attributes
            m.temperature(),
            m.humidity(),
            m.thermostat({
                localTemperature: {
                    values: {
                        description: "Perceived room temperature. Can be measured on the device or defined using the remote temperature attribute.",
                    },
                },
                setpoints: {
                    values: {
                        occupiedHeatingSetpoint: { min: 5, max: 30, step: 0.5 },
                    },
                },
                ctrlSeqeOfOper: {
                    values: ["heating_only"],
                },
                runningState: {
                    values: ["idle", "heat"],
                },
                systemMode: {
                    values: ["off", "heat"],
                },
            }),
            // custom attributes
            m.deviceAddCustomCluster("hvacThermostat", {
                name: "hvacThermostat",
                ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
                attributes: {
                    remoteTemperature: {
                        name: "remoteTemperature",
                        ID: 0x4000,
                        manufacturerCode: manufacturerOptions.manufacturerCode,
                        type: zigbee_herdsman_1.Zcl.DataType.INT16,
                        min: -32768,
                        max: 32767,
                        write: true,
                    },
                    useRemoteTemperature: {
                        name: "useRemoteTemperature",
                        ID: 0x4001,
                        manufacturerCode: manufacturerOptions.manufacturerCode,
                        type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                        write: true,
                    },
                    targetWaterTemperature: {
                        name: "targetWaterTemperature",
                        ID: 0x4002,
                        manufacturerCode: manufacturerOptions.manufacturerCode,
                        type: zigbee_herdsman_1.Zcl.DataType.INT16,
                        min: -32768,
                        max: 32767,
                    },
                },
                commands: {},
                commandsResponse: {},
            }),
            // UI
            m.numeric({
                cluster: "hvacThermostat",
                attribute: "remoteTemperature",
                name: "remote_temperature",
                label: "Remote temperature",
                entityCategory: "config",
                description: "The value of a remote temperature sensor. " +
                    "Note: synchronisation of this value with the remote temperature sensor " +
                    "needs to happen outside of Zigbee2MQTT.",
                valueMin: 0.0,
                valueMax: 99.9,
                valueStep: 0.1,
                unit: "°C",
                scale: 100,
                precision: 1,
            }),
            m.binary({
                cluster: "hvacThermostat",
                attribute: "useRemoteTemperature",
                name: "use_remote_temperature",
                entityCategory: "config",
                description: "Whether to use the value of the internal temperature sensor " +
                    "or a remote temperature sensor for the perceived room temperature.",
                valueOff: ["OFF", 0x00],
                valueOn: ["ON", 0x01],
            }),
            m.numeric({
                cluster: "hvacThermostat",
                attribute: "targetWaterTemperature",
                name: "target_water_temperature",
                label: "Target water temperature",
                access: "STATE_GET",
                entityCategory: "diagnostic",
                description: "Target water temperature in the heating circuit.",
                valueMin: 0.0,
                valueMax: 99.9,
                valueStep: 0.1,
                unit: "°C",
                scale: 100,
                precision: 1,
            }),
        ],
    },
];
//# sourceMappingURL=netica.js.map