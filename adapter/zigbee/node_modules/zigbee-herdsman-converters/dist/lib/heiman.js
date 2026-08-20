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
exports.manufacturerOptions = void 0;
exports.addCustomClusterHeimanSpecificAirQuality = addCustomClusterHeimanSpecificAirQuality;
exports.addCustomClusterHeimanSpecificAirQualityShort = addCustomClusterHeimanSpecificAirQualityShort;
exports.addCustomClusterHeimanSpecificScenes = addCustomClusterHeimanSpecificScenes;
exports.addCustomClusterHeimanSpecificInfraRedRemote = addCustomClusterHeimanSpecificInfraRedRemote;
const zigbee_herdsman_1 = require("zigbee-herdsman");
const m = __importStar(require("../lib/modernExtend"));
exports.manufacturerOptions = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.HEIMAN_TECHNOLOGY_CO_LTD };
function addCustomClusterHeimanSpecificAirQuality() {
    return m.deviceAddCustomCluster("heimanSpecificAirQuality", {
        name: "heimanSpecificAirQuality",
        ...exports.manufacturerOptions,
        // from HS2AQ-3.0海曼智能空气质量检测仪API文档-V01
        ID: 0xfc81,
        attributes: {
            language: { name: "language", ID: 0xf000, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
            unitOfMeasure: { name: "unitOfMeasure", ID: 0xf001, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
            // (0 is not charged, 1 is charging, 2 is fully charged)
            batteryState: { name: "batteryState", ID: 0xf002, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
            pm10measuredValue: { name: "pm10measuredValue", ID: 0xf003, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            tvocMeasuredValue: { name: "tvocMeasuredValue", ID: 0xf004, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            aqiMeasuredValue: { name: "aqiMeasuredValue", ID: 0xf005, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            temperatureMeasuredMax: { name: "temperatureMeasuredMax", ID: 0xf006, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
            temperatureMeasuredMin: { name: "temperatureMeasuredMin", ID: 0xf007, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
            humidityMeasuredMax: { name: "humidityMeasuredMax", ID: 0xf008, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            humidityMeasuredMin: { name: "humidityMeasuredMin", ID: 0xf009, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            alarmEnable: { name: "alarmEnable", ID: 0xf00a, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
        },
        commands: {
            setLanguage: {
                name: "setLanguage",
                ID: 0x011b,
                parameters: [
                    // (1: English 0: Chinese)
                    { name: "languageCode", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                ],
            },
            setUnitOfTemperature: {
                name: "setUnitOfTemperature",
                ID: 0x011c,
                parameters: [
                    // (0: ℉ 1: ℃)
                    { name: "unitsCode", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                ],
            },
            getTime: {
                name: "getTime",
                ID: 0x011d,
                parameters: [],
            },
        },
        commandsResponse: {},
    });
}
function addCustomClusterHeimanSpecificAirQualityShort() {
    return m.deviceAddCustomCluster("heimanSpecificAirQuality", {
        name: "heimanSpecificAirQuality",
        ID: 0xfc81,
        attributes: {
            batteryState: { name: "batteryState", ID: 0xf002, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
            pm10measuredValue: { name: "pm10measuredValue", ID: 0xf003, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
            aqiMeasuredValue: { name: "aqiMeasuredValue", ID: 0xf005, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
        },
        commands: {},
        commandsResponse: {},
    });
}
function addCustomClusterHeimanSpecificScenes() {
    return m.deviceAddCustomCluster("heimanSpecificScenes", {
        name: "heimanSpecificScenes",
        ...exports.manufacturerOptions,
        // from HS2SS-3.0海曼智能情景开关API文档-V01
        ID: 0xfc80,
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.HEIMAN_TECHNOLOGY_CO_LTD,
        attributes: {},
        commands: {
            cinema: {
                name: "cinema",
                ID: 0xf0,
                parameters: [],
            },
            atHome: {
                name: "atHome",
                ID: 0xf1,
                parameters: [],
            },
            sleep: {
                name: "sleep",
                ID: 0xf2,
                parameters: [],
            },
            goOut: {
                name: "goOut",
                ID: 0xf3,
                parameters: [],
            },
            repast: {
                name: "repast",
                ID: 0xf4,
                parameters: [],
            },
        },
        commandsResponse: {},
    });
}
function addCustomClusterHeimanSpecificInfraRedRemote() {
    return m.deviceAddCustomCluster("heimanSpecificInfraRedRemote", {
        name: "heimanSpecificInfraRedRemote",
        ...exports.manufacturerOptions,
        // from HS2IRC-3.0海曼智能红外转发控制器API-V01文档
        ID: 0xfc82,
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.HEIMAN_TECHNOLOGY_CO_LTD,
        attributes: {},
        commands: {
            sendKey: {
                name: "sendKey",
                ID: 0xf0,
                parameters: [
                    { name: "id", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    { name: "keyCode", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                ],
            },
            studyKey: {
                // Total we can have 30 keycode for each device ID (1..30).
                name: "studyKey",
                ID: 0xf1,
                // response: 0xf2,
                parameters: [
                    { name: "id", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    { name: "keyCode", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                ],
            },
            deleteKey: {
                name: "deleteKey",
                ID: 0xf3,
                parameters: [
                    // 1-15 - Delete specific ID, >= 16 - Delete All
                    { name: "id", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    // 1-30 - Delete specific keycode, >= 31 - Delete All keycodes for the ID
                    { name: "keyCode", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                ],
            },
            createId: {
                // Total we can have 15 device IDs (1..15).
                name: "createId",
                ID: 0xf4,
                // response: 0xf5,
                parameters: [{ name: "modelType", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
            getIdAndKeyCodeList: {
                name: "getIdAndKeyCodeList",
                ID: 0xf6,
                // response: 0xf7,
                parameters: [],
            },
        },
        commandsResponse: {
            studyKeyRsp: {
                name: "studyKeyRsp",
                ID: 0xf2,
                parameters: [
                    { name: "id", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    { name: "keyCode", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    { name: "result", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }, // 0 - success, 1 - fail
                ],
            },
            createIdRsp: {
                name: "createIdRsp",
                ID: 0xf5,
                parameters: [
                    { name: "id", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }, // 0xFF - create failed
                    { name: "modelType", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                ],
            },
            getIdAndKeyCodeListRsp: {
                name: "getIdAndKeyCodeListRsp",
                ID: 0xf7,
                parameters: [
                    { name: "packetsTotal", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    { name: "packetNumber", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    { name: "packetLength", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }, // Max length is 70 bytes
                    // HELP for learnedDevicesList data structure:
                    //   struct structPacketPayload {
                    //     uint8_t ID;
                    //     uint8_t ModeType;
                    //     uint8_t KeyNum;
                    //     uint8_t KeyCode[KeyNum];
                    //   } arayPacketPayload[CurentPacketLenght];
                    // }
                    { name: "learnedDevicesList", type: zigbee_herdsman_1.Zcl.BuffaloZclDataType.LIST_UINT8 },
                ],
            },
        },
    });
}
//# sourceMappingURL=heiman.js.map