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
const fz = __importStar(require("../converters/fromZigbee"));
const tz = __importStar(require("../converters/toZigbee"));
const constants = __importStar(require("../lib/constants"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const utils_1 = require("../lib/utils");
const e = exposes.presets;
const ea = exposes.access;
const sprutCode = zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE;
const manufacturerOptions = { manufacturerCode: sprutCode };
const switchActionValues = ["OFF", "ON"];
const co2Lookup = {
    co2_autocalibration: "sprutCO2AutoCalibration",
    co2_manual_calibration: "sprutCO2Calibration",
};
const fzLocal = {
    temperature: {
        cluster: "msTemperatureMeasurement",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const temperature = msg.data.measuredValue / 100.0;
            return { temperature };
        },
    },
    occupancy_level: {
        cluster: "msOccupancySensing",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.sprutOccupancyLevel !== undefined) {
                return { occupancy_level: msg.data.sprutOccupancyLevel };
            }
        },
    },
    voc: {
        cluster: "sprutVoc",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.voc !== undefined) {
                return { voc: msg.data.voc };
            }
        },
    },
    noise: {
        cluster: "sprutNoise",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.noise !== undefined) {
                return { noise: msg.data.noise.toFixed(2) };
            }
        },
    },
    noise_detected: {
        cluster: "sprutNoise",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.noiseDetected !== undefined) {
                return { noise_detected: msg.data.noiseDetected === 1 };
            }
        },
    },
    occupancy_timeout: {
        cluster: "msOccupancySensing",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            return { occupancy_timeout: msg.data.pirOToUDelay };
        },
    },
    noise_timeout: {
        cluster: "sprutNoise",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            return { noise_timeout: msg.data.noiseAfterDetectDelay };
        },
    },
    occupancy_sensitivity: {
        cluster: "msOccupancySensing",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            return { occupancy_sensitivity: msg.data.sprutOccupancySensitivity };
        },
    },
    noise_detect_level: {
        cluster: "sprutNoise",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            return { noise_detect_level: msg.data.noiseDetectLevel };
        },
    },
    co2_mh_z19b_config: {
        cluster: "msCO2",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.sprutCO2AutoCalibration !== undefined) {
                return { co2_autocalibration: switchActionValues[msg.data.sprutCO2AutoCalibration] };
            }
            if (msg.data.sprutCO2Calibration !== undefined) {
                return { co2_manual_calibration: switchActionValues[msg.data.sprutCO2Calibration] };
            }
        },
    },
    th_heater: {
        cluster: "msRelativeHumidity",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.sprutHeater !== undefined) {
                return { th_heater: switchActionValues[msg.data.sprutHeater] };
            }
        },
    },
};
const tzLocal = {
    sprut_ir_remote: {
        key: ["play_store", "learn_start", "learn_stop", "clear_store", "play_ram", "learn_ram_start", "learn_ram_stop"],
        convertSet: async (entity, key, value, meta) => {
            const options = {
                frameType: 0,
                manufacturerCode: sprutCode,
                disableDefaultResponse: true,
                disableResponse: true,
                reservedBits: 0,
                direction: 0,
                writeUndiv: false,
                // @ts-expect-error ignore
                transactionSequenceNumber: null,
            };
            switch (key) {
                case "play_store":
                    await entity.command("sprutIrBlaster", "playStore", { param: value.rom }, options);
                    break;
                case "learn_start":
                    await entity.command("sprutIrBlaster", "learnStart", { value: value.rom }, options);
                    break;
                case "learn_stop":
                    await entity.command("sprutIrBlaster", "learnStop", { value: value.rom }, options);
                    break;
                case "clear_store":
                    await entity.command("sprutIrBlaster", "clearStore", {}, options);
                    break;
                case "play_ram":
                    await entity.command("sprutIrBlaster", "playRam", {}, options);
                    break;
                case "learn_ram_start":
                    await entity.command("sprutIrBlaster", "learnRamStart", {}, options);
                    break;
                case "learn_ram_stop":
                    await entity.command("sprutIrBlaster", "learnRamStop", {}, options);
                    break;
            }
        },
    },
    occupancy_timeout: {
        key: ["occupancy_timeout"],
        convertSet: async (entity, key, value, meta) => {
            const number = (0, utils_1.toNumber)(value, "occupancy_timeout");
            await entity.write("msOccupancySensing", { pirOToUDelay: number }, (0, utils_1.getOptions)(meta.mapped, entity));
            return { state: { [key]: number } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("msOccupancySensing", ["pirOToUDelay"]);
        },
    },
    noise_timeout: {
        key: ["noise_timeout"],
        convertSet: async (entity, key, value, meta) => {
            let number = (0, utils_1.toNumber)(value, "noise_timeout");
            number *= 1;
            await entity.write("sprutNoise", { noiseAfterDetectDelay: number }, (0, utils_1.getOptions)(meta.mapped, entity));
            return { state: { [key]: number } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("sprutNoise", ["noiseAfterDetectDelay"]);
        },
    },
    occupancy_sensitivity: {
        key: ["occupancy_sensitivity"],
        convertSet: async (entity, key, value, meta) => {
            let number = (0, utils_1.toNumber)(value, "occupancy_sensitivity");
            number *= 1;
            const options = (0, utils_1.getOptions)(meta.mapped, entity, manufacturerOptions);
            await entity.write("msOccupancySensing", { sprutOccupancySensitivity: number }, options);
            return { state: { [key]: number } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("msOccupancySensing", ["sprutOccupancySensitivity"], manufacturerOptions);
        },
    },
    noise_detect_level: {
        key: ["noise_detect_level"],
        convertSet: async (entity, key, value, meta) => {
            let number = (0, utils_1.toNumber)(value, "noise_detect_level");
            number *= 1;
            const options = (0, utils_1.getOptions)(meta.mapped, entity, manufacturerOptions);
            await entity.write("sprutNoise", { noiseDetectLevel: number }, options);
            return { state: { [key]: number } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("sprutNoise", ["noiseDetectLevel"], manufacturerOptions);
        },
    },
    temperature_offset: {
        key: ["temperature_offset"],
        convertSet: async (entity, key, value, meta) => {
            let number = (0, utils_1.toNumber)(value, "temperature_offset");
            number *= 1;
            const newValue = number * 100.0;
            const options = (0, utils_1.getOptions)(meta.mapped, entity, manufacturerOptions);
            await entity.write("msTemperatureMeasurement", { sprutTemperatureOffset: newValue }, options);
            return { state: { [key]: number } };
        },
    },
    co2_mh_z19b_config: {
        key: ["co2_autocalibration", "co2_manual_calibration"],
        convertSet: async (entity, key, value, meta) => {
            let newValue = value;
            (0, utils_1.assertString)(value, "co2_autocalibration/co2_manual_calibration");
            newValue = switchActionValues.indexOf(value);
            const options = (0, utils_1.getOptions)(meta.mapped, entity, manufacturerOptions);
            const payload = {
                [(0, utils_1.getFromLookup)(key, co2Lookup)]: newValue,
            };
            await entity.write("msCO2", payload, options);
            return { state: { [key]: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("msCO2", [(0, utils_1.getFromLookup)(key, co2Lookup)], manufacturerOptions);
        },
    },
    th_heater: {
        key: ["th_heater"],
        convertSet: async (entity, key, value, meta) => {
            (0, utils_1.assertString)(value, "th_heater");
            const newValue = switchActionValues.indexOf(value);
            const options = (0, utils_1.getOptions)(meta.mapped, entity, manufacturerOptions);
            await entity.write("msRelativeHumidity", { sprutHeater: newValue }, options);
            return { state: { [key]: value } };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("msRelativeHumidity", ["sprutHeater"], manufacturerOptions);
        },
    },
};
const sprutModernExtend = {
    addSprutVocCluster: () => m.deviceAddCustomCluster("sprutVoc", {
        name: "sprutVoc",
        ID: 0x6601,
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
        attributes: {
            voc: { name: "voc", ID: 0x6600, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
        },
        commands: {},
        commandsResponse: {},
    }),
    addSprutNoiseCluster: () => m.deviceAddCustomCluster("sprutNoise", {
        name: "sprutNoise",
        ID: 0x6602,
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
        attributes: {
            noise: { name: "noise", ID: 0x6600, type: zigbee_herdsman_1.Zcl.DataType.SINGLE_PREC, write: true },
            noiseDetected: { name: "noiseDetected", ID: 0x6601, type: zigbee_herdsman_1.Zcl.DataType.BITMAP8, write: true },
            noiseDetectLevel: { name: "noiseDetectLevel", ID: 0x6602, type: zigbee_herdsman_1.Zcl.DataType.SINGLE_PREC, write: true },
            noiseAfterDetectDelay: { name: "noiseAfterDetectDelay", ID: 0x6603, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
        },
        commands: {},
        commandsResponse: {},
    }),
    addSprutIrBlasterCluster: () => m.deviceAddCustomCluster("sprutIrBlaster", {
        name: "sprutIrBlaster",
        ID: 0x6603,
        manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
        attributes: {},
        commands: {
            playStore: { name: "playStore", ID: 0x00, parameters: [{ name: "param", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }] },
            learnStart: { name: "learnStart", ID: 0x01, parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }] },
            learnStop: { name: "learnStop", ID: 0x02, parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }] },
            clearStore: { name: "clearStore", ID: 0x03, parameters: [] },
            playRam: { name: "playRam", ID: 0x04, parameters: [] },
            learnRamStart: { name: "learnRamStart", ID: 0x05, parameters: [] },
            learnRamStop: { name: "learnRamStop", ID: 0x06, parameters: [] },
        },
        commandsResponse: {},
    }),
    addSprutMsRelativeHumidityCluster: () => m.deviceAddCustomCluster("msRelativeHumidity", {
        name: "msRelativeHumidity",
        ID: zigbee_herdsman_1.Zcl.Clusters.msRelativeHumidity.ID,
        attributes: {
            sprutHeater: {
                name: "sprutHeater",
                ID: 0x6600,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                write: true,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
    addSprutMsOccupancySensingCluster: () => m.deviceAddCustomCluster("msOccupancySensing", {
        name: "msOccupancySensing",
        ID: zigbee_herdsman_1.Zcl.Clusters.msOccupancySensing.ID,
        attributes: {
            sprutOccupancyLevel: {
                name: "sprutOccupancyLevel",
                ID: 0x6600,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                write: true,
                max: 0xffff,
            },
            sprutOccupancySensitivity: {
                name: "sprutOccupancySensitivity",
                ID: 0x6601,
                type: zigbee_herdsman_1.Zcl.DataType.UINT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                write: true,
                max: 0xffff,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
    addSprutMsTemperatureMeasurementCluster: () => m.deviceAddCustomCluster("msTemperatureMeasurement", {
        name: "msTemperatureMeasurement",
        ID: zigbee_herdsman_1.Zcl.Clusters.msTemperatureMeasurement.ID,
        attributes: {
            sprutTemperatureOffset: {
                name: "sprutTemperatureOffset",
                ID: 0x6600,
                type: zigbee_herdsman_1.Zcl.DataType.INT16,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                write: true,
                min: -32768,
                max: 32767,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
    addSprutMsCO2Cluster: () => m.deviceAddCustomCluster("msCO2", {
        name: "msCO2",
        ID: zigbee_herdsman_1.Zcl.Clusters.msCO2.ID,
        attributes: {
            sprutCO2Calibration: {
                name: "sprutCO2Calibration",
                ID: 0x6600,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                write: true,
            },
            sprutCO2AutoCalibration: {
                name: "sprutCO2AutoCalibration",
                ID: 0x6601,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                write: true,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
    sprutActivityIndicator: (args) => m.binary({
        name: "activity_led",
        cluster: "genBinaryOutput",
        attribute: "presentValue",
        description: "Controls green activity LED",
        reporting: { min: "MIN", max: "MAX", change: 1 },
        valueOn: [true, 1],
        valueOff: [false, 0],
        access: "ALL",
        entityCategory: "config",
        ...args,
    }),
    sprutIsConnected: (args) => m.binary({
        name: "uart_connection",
        cluster: "sprutDevice",
        attribute: "isConnected",
        valueOn: [true, 1],
        valueOff: [false, 0],
        description: "Indicates whether the device is communicating with sensors via UART",
        access: "STATE_GET",
        entityCategory: "diagnostic",
        ...args,
    }),
    sprutUartBaudRate: (args) => m.enumLookup({
        name: "uart_baud_rate",
        lookup: {
            "9600": 9600,
            "19200": 19200,
            "38400": 38400,
            "57600": 57600,
            "115200": 115200,
        },
        cluster: "sprutDevice",
        attribute: "UartBaudRate",
        description: "UART baud rate",
        access: "ALL",
        entityCategory: "config",
        ...args,
    }),
    sprutTemperatureOffset: (args) => m.numeric({
        name: "temperature_offset",
        cluster: "msTemperatureMeasurement",
        attribute: "sprutTemperatureOffset",
        description: "Self-heating compensation. The compensation value is subtracted from the measured temperature (default: 0)",
        valueMin: -10,
        valueMax: 10,
        unit: "°C",
        scale: 100,
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: manufacturerOptions,
        ...args,
    }),
    sprutThHeater: (args) => m.binary({
        name: "th_heater",
        cluster: "msRelativeHumidity",
        attribute: "sprutHeater",
        description: "Turn on when working in conditions of high humidity (more than 70 %, RH) or condensation, if the sensor shows 0 or 100 %.",
        valueOn: [true, 1],
        valueOff: [false, 0],
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: manufacturerOptions,
        ...args,
    }),
    sprutOccupancyLevel: (args) => m.numeric({
        name: "occupancy_level",
        cluster: "msOccupancySensing",
        attribute: "sprutOccupancyLevel",
        reporting: { min: "10_SECONDS", max: "1_MINUTE", change: 5 },
        description: "Measured occupancy level",
        access: "STATE_GET",
        entityCategory: "diagnostic",
        ...args,
    }),
    sprutOccupancyTimeout: (args) => m.numeric({
        name: "occupancy_timeout",
        cluster: "msOccupancySensing",
        attribute: "pirOToUDelay",
        description: "Time in seconds after which occupancy is cleared after detecting it (default: 60)",
        valueMin: 0,
        valueMax: 2000,
        unit: "s",
        access: "ALL",
        entityCategory: "config",
        ...args,
    }),
    sprutOccupancySensitivity: (args) => m.numeric({
        name: "occupancy_sensitivity",
        cluster: "msOccupancySensing",
        attribute: "sprutOccupancySensitivity",
        description: "If the sensor is triggered by the slightest movement, reduce the sensitivity, otherwise increase it (default: 50)",
        valueMin: 0,
        valueMax: 2000,
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: manufacturerOptions,
        ...args,
    }),
    sprutNoise: (args) => m.numeric({
        name: "noise",
        cluster: "sprutNoise",
        attribute: "noise",
        reporting: { min: "10_SECONDS", max: "1_MINUTE", change: 5 },
        description: "Measured noise level",
        unit: "dBA",
        precision: 2,
        access: "STATE_GET",
        entityCategory: "diagnostic",
        ...args,
    }),
    sprutNoiseDetectLevel: (args) => m.numeric({
        name: "noise_detect_level",
        cluster: "sprutNoise",
        attribute: "noiseDetectLevel",
        description: "The minimum noise level at which the detector will work (default: 50)",
        valueMin: 0,
        valueMax: 150,
        unit: "dBA",
        access: "ALL",
        entityCategory: "config",
        zigbeeCommandOptions: manufacturerOptions,
        ...args,
    }),
    sprutNoiseDetected: (args) => m.binary({
        name: "noise_detected",
        cluster: "sprutNoise",
        attribute: "noiseDetected",
        valueOn: [true, 1],
        valueOff: [false, 0],
        description: "Indicates whether the device detected noise",
        access: "STATE_GET",
        ...args,
    }),
    sprutNoiseTimeout: (args) => m.numeric({
        name: "noise_timeout",
        cluster: "sprutNoise",
        attribute: "noiseAfterDetectDelay",
        description: "Time in seconds after which noise is cleared after detecting it (default: 60)",
        valueMin: 0,
        valueMax: 2000,
        unit: "s",
        access: "ALL",
        entityCategory: "config",
        ...args,
    }),
    sprutVoc: (args) => m.numeric({
        name: "voc",
        label: "VOC",
        cluster: "sprutVoc",
        attribute: "voc",
        reporting: { min: "10_SECONDS", max: "1_MINUTE", change: 10 },
        description: "Measured VOC level",
        unit: "µg/m³",
        access: "STATE_GET",
        ...args,
    }),
    sprutIrBlaster: () => {
        const toZigbee = [
            {
                key: ["play_store", "learn_start", "learn_stop", "clear_store", "play_ram", "learn_ram_start", "learn_ram_stop"],
                convertSet: async (entity, key, value, meta) => {
                    const options = {
                        frameType: 0,
                        manufacturerCode: sprutCode,
                        disableDefaultResponse: true,
                        disableResponse: true,
                        reservedBits: 0,
                        direction: 0,
                        writeUndiv: false,
                        // @ts-expect-error ignore
                        transactionSequenceNumber: null,
                    };
                    switch (key) {
                        case "play_store":
                            await entity.command("sprutIrBlaster", "playStore", { param: value.rom }, options);
                            break;
                        case "learn_start":
                            await entity.command("sprutIrBlaster", "learnStart", { value: value.rom }, options);
                            break;
                        case "learn_stop":
                            await entity.command("sprutIrBlaster", "learnStop", { value: value.rom }, options);
                            break;
                        case "clear_store":
                            await entity.command("sprutIrBlaster", "clearStore", {}, options);
                            break;
                        case "play_ram":
                            await entity.command("sprutIrBlaster", "playRam", {}, options);
                            break;
                        case "learn_ram_start":
                            await entity.command("sprutIrBlaster", "learnRamStart", {}, options);
                            break;
                        case "learn_ram_stop":
                            await entity.command("sprutIrBlaster", "learnRamStop", {}, options);
                            break;
                    }
                },
            },
        ];
        const configure = [m.setupConfigureForBinding("sprutIrBlaster", "input")];
        return { toZigbee, configure, isModernExtend: true };
    },
};
const { addSprutVocCluster, addSprutNoiseCluster, addSprutIrBlasterCluster, addSprutMsRelativeHumidityCluster, addSprutMsOccupancySensingCluster, addSprutMsTemperatureMeasurementCluster, addSprutMsCO2Cluster, sprutActivityIndicator, sprutIsConnected, sprutUartBaudRate, sprutOccupancyLevel, sprutNoise, sprutVoc, sprutNoiseDetected, sprutOccupancyTimeout, sprutNoiseTimeout, sprutTemperatureOffset, sprutThHeater, sprutOccupancySensitivity, sprutNoiseDetectLevel, sprutIrBlaster, } = sprutModernExtend;
exports.definitions = [
    {
        zigbeeModel: ["WB-MSW-ZIGBEE v.4"],
        model: "WB-MSW-ZIGBEE_v.4_official",
        vendor: "Wiren Board",
        description: "Wall-mounted multi sensor with official Wiren Board firmware",
        ota: true,
        extend: [
            m.deviceEndpoints({
                endpoints: { default: 1, buzzer: 2, heater: 3, led_red: 4, led_green: 5, ir: 6 },
                multiEndpointSkip: ["occupancy", "ir_action", "ir_rom_id"],
            }),
            // Custom cluster declarations
            m.deviceAddCustomCluster("genAnalogInput", {
                name: "genAnalogInput",
                ID: zigbee_herdsman_1.Zcl.Clusters.genAnalogInput.ID,
                attributes: {
                    noiseDetected: { name: "noiseDetected", ID: 0x1000, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN },
                    noiseThreshold: { name: "noiseThreshold", ID: 0x1001, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                    noiseTimeout: { name: "noiseTimeout", ID: 0x1002, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                },
                commands: {},
                commandsResponse: {},
            }),
            m.deviceAddCustomCluster("genMultistateInput", {
                name: "genMultistateInput",
                ID: zigbee_herdsman_1.Zcl.Clusters.genMultistateInput.ID,
                attributes: {
                    mswSlaveId: { name: "mswSlaveId", ID: 0x1000, type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff },
                    mswSerialNumber: { name: "mswSerialNumber", ID: 0x1001, type: zigbee_herdsman_1.Zcl.DataType.UINT32, max: 0xffffffff },
                    mswFwVersion: { name: "mswFwVersion", ID: 0x1002, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR },
                    mswFwSignature: { name: "mswFwSignature", ID: 0x1003, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR },
                    mswBootVersion: { name: "mswBootVersion", ID: 0x1004, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR },
                    mswComponentVersion: { name: "mswComponentVersion", ID: 0x1005, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR },
                    mswComponentSignature: { name: "mswComponentSignature", ID: 0x1006, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR },
                },
                commands: {},
                commandsResponse: {},
            }),
            m.deviceAddCustomCluster("genMultistateOutput", {
                name: "genMultistateOutput",
                ID: zigbee_herdsman_1.Zcl.Clusters.genMultistateOutput.ID,
                attributes: {
                    irRomId: { name: "irRomId", ID: 0x1000, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                },
                commands: {},
                commandsResponse: {},
            }),
            m.deviceAddCustomCluster("msTemperatureMeasurement", {
                name: "msTemperatureMeasurement",
                ID: zigbee_herdsman_1.Zcl.Clusters.msTemperatureMeasurement.ID,
                attributes: {
                    temperatureOffset: { name: "temperatureOffset", ID: 0x1000, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768, max: 32767 },
                },
                commands: {},
                commandsResponse: {},
            }),
            m.deviceAddCustomCluster("msOccupancySensing", {
                name: "msOccupancySensing",
                ID: zigbee_herdsman_1.Zcl.Clusters.msOccupancySensing.ID,
                attributes: {
                    occupancyLevel: { name: "occupancyLevel", ID: 0x1000, type: zigbee_herdsman_1.Zcl.DataType.UINT16, max: 0xffff },
                    occupancySensitivity: { name: "occupancySensitivity", ID: 0x1001, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                    occupancyTimeout: { name: "occupancyTimeout", ID: 0x1002, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true, max: 0xffff },
                },
                commands: {},
                commandsResponse: {},
            }),
            m.deviceAddCustomCluster("wbVoc", {
                name: "wbVoc",
                ID: 0x042e,
                attributes: {
                    measuredValue: { name: "measuredValue", ID: 0x0000, type: zigbee_herdsman_1.Zcl.DataType.SINGLE_PREC },
                },
                commands: {},
                commandsResponse: {},
            }),
            // Standard measurements & switches
            m.onOff({ powerOnBehavior: false, endpointNames: ["buzzer", "heater", "led_red", "led_green"] }),
            m.illuminance({ reporting: false }),
            m.temperature({ reporting: false }),
            m.humidity({ reporting: false }),
            m.occupancy({ reporting: false }),
            m.co2({ reporting: false }),
            // Custom attributes
            m.numeric({
                name: "noise_level",
                cluster: "genAnalogInput",
                attribute: "presentValue",
                description: "Current noise level",
                unit: "dBA",
                precision: 2,
                access: "STATE_GET",
                entityCategory: "diagnostic",
                reporting: false,
            }),
            m.binary({
                name: "noise",
                cluster: "genAnalogInput",
                attribute: "noiseDetected",
                valueOn: [true, 1],
                valueOff: [false, 0],
                description: "Noise detected",
                access: "STATE_GET",
                reporting: false,
            }),
            m.numeric({
                name: "noise_threshold",
                cluster: "genAnalogInput",
                attribute: "noiseThreshold",
                description: "Noise detection threshold",
                valueMin: 0,
                valueMax: 150,
                unit: "dBA",
                access: "ALL",
                entityCategory: "config",
                reporting: false,
            }),
            m.numeric({
                name: "noise_timeout",
                cluster: "genAnalogInput",
                attribute: "noiseTimeout",
                description: "Time in seconds after which noise is cleared",
                valueMin: 0,
                valueMax: 2000,
                unit: "s",
                access: "ALL",
                entityCategory: "config",
                reporting: false,
            }),
            m.binary({
                name: "status_led",
                cluster: "genBinaryOutput",
                attribute: "presentValue",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                description: "Status LED control",
                access: "ALL",
                reporting: false,
            }),
            m.enumLookup({
                name: "connectivity",
                lookup: { offline: 1, online: 2, firmware_update: 3, component_update: 4 },
                cluster: "genMultistateInput",
                attribute: "presentValue",
                description: "Device connectivity state",
                access: "STATE_GET",
                entityCategory: "diagnostic",
                reporting: false,
            }),
            m.numeric({
                name: "modbus_slave_id",
                cluster: "genMultistateInput",
                attribute: "mswSlaveId",
                description: "Device Modbus slave ID",
                access: "STATE_GET",
                entityCategory: "diagnostic",
                reporting: false,
            }),
            m.numeric({
                name: "serial_number",
                cluster: "genMultistateInput",
                attribute: "mswSerialNumber",
                description: "Device serial number",
                access: "STATE_GET",
                entityCategory: "diagnostic",
                reporting: false,
            }),
            m.text({
                name: "fw_version",
                cluster: "genMultistateInput",
                attribute: "mswFwVersion",
                description: "Device firmware version",
                access: "STATE_GET",
                entityCategory: "diagnostic",
            }),
            m.text({
                name: "fw_signature",
                cluster: "genMultistateInput",
                attribute: "mswFwSignature",
                description: "Device firmware signature",
                access: "STATE_GET",
                entityCategory: "diagnostic",
            }),
            m.text({
                name: "boot_version",
                cluster: "genMultistateInput",
                attribute: "mswBootVersion",
                description: "Device bootloader version",
                access: "STATE_GET",
                entityCategory: "diagnostic",
            }),
            m.text({
                name: "component_version",
                cluster: "genMultistateInput",
                attribute: "mswComponentVersion",
                description: "Device component firmware version",
                access: "STATE_GET",
                entityCategory: "diagnostic",
            }),
            m.text({
                name: "component_signature",
                cluster: "genMultistateInput",
                attribute: "mswComponentSignature",
                description: "Device component firmware signature",
                access: "STATE_GET",
                entityCategory: "diagnostic",
            }),
            m.numeric({
                name: "temperature_offset",
                cluster: "msTemperatureMeasurement",
                attribute: "temperatureOffset",
                description: "Offset subtracted from the raw temperature reading",
                valueMin: -10,
                valueMax: 10,
                valueStep: 0.1,
                unit: "°C",
                scale: 100,
                access: "ALL",
                entityCategory: "config",
                reporting: false,
            }),
            m.numeric({
                name: "occupancy_level",
                cluster: "msOccupancySensing",
                attribute: "occupancyLevel",
                description: "Raw occupancy level reported by the sensor",
                access: "STATE_GET",
                entityCategory: "diagnostic",
                reporting: false,
            }),
            m.numeric({
                name: "occupancy_sensitivity",
                cluster: "msOccupancySensing",
                attribute: "occupancySensitivity",
                description: "Occupancy detection sensitivity",
                valueMin: 0,
                valueMax: 2000,
                access: "ALL",
                entityCategory: "config",
                reporting: false,
            }),
            m.numeric({
                name: "occupancy_timeout",
                cluster: "msOccupancySensing",
                attribute: "occupancyTimeout",
                description: "Time in seconds after which occupancy is cleared",
                valueMin: 0,
                valueMax: 2000,
                unit: "s",
                access: "ALL",
                entityCategory: "config",
                reporting: false,
            }),
            m.numeric({
                name: "voc",
                label: "VOC",
                cluster: "wbVoc",
                attribute: "measuredValue",
                description: "Measured VOC concentration",
                unit: "µg/m³",
                access: "STATE_GET",
                reporting: false,
            }),
            // IR transceiver (endpoint 6). Action returns to stop once the device
            // finishes playing/clearing; learn holds until an explicit stop.
            m.numeric({
                name: "ir_rom_id",
                cluster: "genMultistateOutput",
                attribute: "irRomId",
                description: "Target ROM bank for IR learn/play",
                valueMin: 0,
                valueMax: 79,
                access: "ALL",
                endpointNames: ["ir"],
                reporting: false,
            }),
            m.enumLookup({
                name: "ir_action",
                lookup: { stop: 0, learn_ram: 1, learn_rom: 2, play_ram: 3, play_rom: 4, clear_all_rom: 5 },
                cluster: "genMultistateOutput",
                attribute: "presentValue",
                description: "IR transceiver action for the selected ROM bank",
                access: "ALL",
                endpointName: "ir",
                reporting: false,
            }),
            // Bindings (reporting is firmware-driven, so clusters are only bound)
            m.bindCluster({ cluster: "genAnalogInput", clusterType: "input" }),
            m.bindCluster({ cluster: "genBinaryOutput", clusterType: "input" }),
            m.bindCluster({ cluster: "genMultistateInput", clusterType: "input" }),
            m.bindCluster({ cluster: "msIlluminanceMeasurement", clusterType: "input" }),
            m.bindCluster({ cluster: "msTemperatureMeasurement", clusterType: "input" }),
            m.bindCluster({ cluster: "msRelativeHumidity", clusterType: "input" }),
            m.bindCluster({ cluster: "msOccupancySensing", clusterType: "input" }),
            m.bindCluster({ cluster: "msCO2", clusterType: "input" }),
            m.bindCluster({ cluster: "wbVoc", clusterType: "input" }),
            m.bindCluster({ cluster: "genMultistateOutput", clusterType: "input", endpointNames: ["ir"] }),
        ],
    },
    {
        zigbeeModel: ["WBMSW3"],
        model: "WB-MSW-ZIGBEE v.3",
        vendor: "Wirenboard",
        description: "Wall-mounted multi sensor",
        fromZigbee: [
            fzLocal.temperature,
            fz.humidity,
            fz.occupancy,
            fzLocal.occupancy_level,
            fz.co2,
            fzLocal.voc,
            fzLocal.noise,
            fzLocal.noise_detected,
            fz.on_off,
            fzLocal.occupancy_timeout,
            fzLocal.noise_timeout,
            fzLocal.co2_mh_z19b_config,
            fzLocal.th_heater,
            fzLocal.occupancy_sensitivity,
            fzLocal.noise_detect_level,
        ],
        toZigbee: [
            tz.on_off,
            tzLocal.sprut_ir_remote,
            tzLocal.occupancy_timeout,
            tzLocal.noise_timeout,
            tzLocal.co2_mh_z19b_config,
            tzLocal.th_heater,
            tzLocal.temperature_offset,
            tzLocal.occupancy_sensitivity,
            tzLocal.noise_detect_level,
        ],
        exposes: [
            e.temperature(),
            e.humidity(),
            e.occupancy(),
            e.occupancy_level(),
            e.co2(),
            e.voc(),
            e.noise(),
            e.noise_detected(),
            e.switch().withEndpoint("l1"),
            e.switch().withEndpoint("l2"),
            e.switch().withEndpoint("l3"),
            e
                .numeric("noise_timeout", ea.ALL)
                .withValueMin(0)
                .withValueMax(2000)
                .withUnit("s")
                .withCategory("config")
                .withDescription("Time in seconds after which noise is cleared after detecting it (default: 60)"),
            e
                .numeric("occupancy_timeout", ea.ALL)
                .withValueMin(0)
                .withValueMax(2000)
                .withUnit("s")
                .withCategory("config")
                .withDescription("Time in seconds after which occupancy is cleared after detecting it (default: 60)"),
            e
                .numeric("temperature_offset", ea.SET)
                .withValueMin(-10)
                .withValueMax(10)
                .withUnit("°C")
                .withCategory("config")
                .withDescription("Self-heating compensation. The compensation value is subtracted from the measured temperature"),
            e
                .numeric("occupancy_sensitivity", ea.ALL)
                .withValueMin(0)
                .withValueMax(2000)
                .withCategory("config")
                .withDescription("If the sensor is triggered by the slightest movement, reduce the sensitivity, otherwise increase it (default: 50)"),
            e
                .numeric("noise_detect_level", ea.ALL)
                .withValueMin(0)
                .withValueMax(150)
                .withUnit("dBA")
                .withCategory("config")
                .withDescription("The minimum noise level at which the detector will work (default: 50)"),
            e
                .enum("co2_autocalibration", ea.ALL, switchActionValues)
                .withCategory("config")
                .withDescription("Automatic calibration of the CO2 sensor. If ON, the CO2 sensor will automatically calibrate every 7 days. (MH-Z19B sensor)"),
            e
                .enum("co2_manual_calibration", ea.ALL, switchActionValues)
                .withCategory("config")
                .withDescription("Ventilate the room for 20 minutes, turn on manual calibration, and turn it off after one second. " +
                "After about 5 minutes the CO2 sensor will show 400ppm. Calibration completed. (MH-Z19B sensor)"),
            e
                .enum("th_heater", ea.ALL, switchActionValues)
                .withCategory("config")
                .withDescription("Turn on when working in conditions of high humidity (more than 70 %, RH) or condensation, if the sensor shows 0 or 100 %."),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint1 = device.getEndpoint(1);
            const binds = [
                "genBasic",
                "msTemperatureMeasurement",
                "msRelativeHumidity",
                "msOccupancySensing",
                "msCO2",
                "sprutVoc",
                "sprutNoise",
                "sprutIrBlaster",
                "genOta",
            ];
            await reporting.bind(endpoint1, coordinatorEndpoint, binds);
            // report configuration
            await reporting.temperature(endpoint1);
            await reporting.humidity(endpoint1);
            await reporting.occupancy(endpoint1);
            let payload = reporting.payload("sprutOccupancyLevel", 10, constants.repInterval.MINUTE, 5);
            await endpoint1.configureReporting("msOccupancySensing", payload, manufacturerOptions);
            payload = reporting.payload("noise", 10, constants.repInterval.MINUTE, 5);
            await endpoint1.configureReporting("sprutNoise", payload);
            // led_red
            await device.getEndpoint(2).read("genOnOff", ["onOff"]);
            // led_green
            await device.getEndpoint(3).read("genOnOff", ["onOff"]);
            // buzzer
            await device.getEndpoint(4).read("genOnOff", ["onOff"]);
        },
        endpoint: (device) => {
            return { default: 1, l1: 2, l2: 3, l3: 4 };
        },
        meta: { multiEndpoint: true, multiEndpointSkip: ["humidity"] },
        ota: true,
        extend: [
            addSprutVocCluster(),
            addSprutNoiseCluster(),
            addSprutIrBlasterCluster(),
            addSprutMsRelativeHumidityCluster(),
            addSprutMsOccupancySensingCluster(),
            addSprutMsTemperatureMeasurementCluster(),
            addSprutMsCO2Cluster(),
            m.illuminance(),
        ],
    },
    {
        zigbeeModel: ["WBMSW4"],
        model: "WB-MSW-ZIGBEE v.4",
        vendor: "Wirenboard",
        description: "Wall-mounted multi sensor",
        extend: [
            addSprutVocCluster(),
            addSprutNoiseCluster(),
            addSprutIrBlasterCluster(),
            addSprutMsRelativeHumidityCluster(),
            addSprutMsOccupancySensingCluster(),
            addSprutMsTemperatureMeasurementCluster(),
            addSprutMsCO2Cluster(),
            m.deviceAddCustomCluster("genBasic", {
                name: "genBasic",
                ID: 0,
                attributes: {
                    deviceVersion: { name: "deviceVersion", ID: 26113, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR, manufacturerCode: sprutCode, write: true },
                    deviceSignature: { name: "deviceSignature", ID: 26114, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR, manufacturerCode: sprutCode, write: true },
                    deviceBootVersion: { name: "deviceBootVersion", ID: 26115, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR, manufacturerCode: sprutCode, write: true },
                    componentVersion: { name: "componentVersion", ID: 26117, type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR, manufacturerCode: sprutCode, write: true },
                    componentSignature: {
                        name: "componentSignature",
                        ID: 26118,
                        type: zigbee_herdsman_1.Zcl.DataType.CHAR_STR,
                        manufacturerCode: sprutCode,
                        write: true,
                    },
                },
                commands: {},
                commandsResponse: {},
            }),
            m.deviceAddCustomCluster("sprutDevice", {
                name: "sprutDevice",
                ID: 26112,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.CUSTOM_SPRUT_DEVICE,
                attributes: {
                    isConnected: { name: "isConnected", ID: 26116, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
                    UartBaudRate: { name: "UartBaudRate", ID: 26113, type: zigbee_herdsman_1.Zcl.DataType.UINT32, write: true, max: 0xffffffff },
                },
                commands: {
                    debug: {
                        name: "debug",
                        ID: 103,
                        parameters: [{ name: "data", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
                    },
                },
                commandsResponse: {},
            }),
            m.deviceEndpoints({
                endpoints: { default: 1, l1: 2, l2: 3, l3: 4, indicator: 5 },
                multiEndpointSkip: ["occupancy"],
            }),
            m.onOff({ powerOnBehavior: false, endpointNames: ["l1", "l2", "l3"] }),
            sprutActivityIndicator({ endpointName: "indicator" }),
            sprutIsConnected(),
            m.temperature(),
            sprutTemperatureOffset(),
            m.humidity(),
            sprutThHeater(),
            m.co2(),
            m.illuminance(),
            m.occupancy(),
            sprutOccupancySensitivity(),
            sprutOccupancyLevel(),
            sprutOccupancyTimeout(),
            sprutNoise(),
            sprutNoiseDetectLevel(),
            sprutNoiseDetected(),
            sprutNoiseTimeout(),
            sprutVoc(),
            sprutIrBlaster(),
            sprutUartBaudRate(),
        ],
        ota: true,
    },
];
//# sourceMappingURL=wirenboard.js.map