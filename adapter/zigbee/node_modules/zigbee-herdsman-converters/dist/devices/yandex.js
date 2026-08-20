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
const exposes_1 = require("../lib/exposes");
const logger_1 = require("../lib/logger");
const m = __importStar(require("../lib/modernExtend"));
const utils_1 = require("../lib/utils");
const NS = "zhc:yandex";
const manufacturerCodeOld = 0x140a;
const manufacturerCodeNew = 0x132f;
function enumLookupWithSetCommand(args) {
    const { name, lookup, cluster, attribute, zigbeeCommandOptions, setCommand } = args;
    const attributeKey = (0, utils_1.isString)(attribute) ? attribute : attribute.ID;
    const access = exposes_1.access[args.access ?? "ALL"];
    const mExtend = m.enumLookup(args);
    const toZigbee = [
        {
            key: [name],
            convertSet: access & exposes_1.access.SET
                ? async (entity, key, value, meta) => {
                    const payloadValue = (0, utils_1.getFromLookup)(value, lookup);
                    await (0, utils_1.determineEndpoint)(entity, meta, cluster).command(cluster, setCommand, { value: payloadValue }, zigbeeCommandOptions);
                    await (0, utils_1.determineEndpoint)(entity, meta, cluster).read(cluster, [attributeKey], zigbeeCommandOptions);
                    return { state: { [key]: value } };
                }
                : undefined,
            convertGet: access & exposes_1.access.GET
                ? async (entity, key, meta) => {
                    await (0, utils_1.determineEndpoint)(entity, meta, cluster).read(cluster, [attributeKey], zigbeeCommandOptions);
                }
                : undefined,
        },
    ];
    return { ...mExtend, toZigbee };
}
function binaryWithSetCommand(args) {
    const { name, cluster, attribute, valueOn, valueOff, zigbeeCommandOptions, setCommand } = args;
    const access = exposes_1.access[args.access ?? "ALL"];
    const mExtend = m.binary(args);
    const toZigbee = [
        {
            key: [name],
            convertSet: access & exposes_1.access.SET
                ? async (entity, key, value, meta) => {
                    const payloadValue = value === valueOn[0] ? valueOn[1] : valueOff[1];
                    await (0, utils_1.determineEndpoint)(entity, meta, cluster).command(cluster, setCommand, { value: payloadValue }, zigbeeCommandOptions);
                    await (0, utils_1.determineEndpoint)(entity, meta, cluster).read(cluster, [attribute], zigbeeCommandOptions);
                    return { state: { [key]: value } };
                }
                : undefined,
            convertGet: access & exposes_1.access.GET
                ? async (entity, key, meta) => {
                    await (0, utils_1.determineEndpoint)(entity, meta, cluster).read(cluster, [attribute], zigbeeCommandOptions);
                }
                : undefined,
        },
    ];
    return { ...mExtend, toZigbee };
}
function YandexCluster(manufacturerCode) {
    return m.deviceAddCustomCluster("manuSpecificYandex", {
        name: "manuSpecificYandex",
        ID: 0xfc03,
        manufacturerCode: manufacturerCode,
        attributes: {
            switchMode: { name: "switchMode", ID: 0x0001, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true, max: 0xff },
            switchType: { name: "switchType", ID: 0x0002, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true, max: 0xff },
            powerType: { name: "powerType", ID: 0x0003, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true, max: 0xff },
            ledIndicator: { name: "ledIndicator", ID: 0x0005, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            interlock: { name: "interlock", ID: 0x0007, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            buttonMode: { name: "buttonMode", ID: 0x0008, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true, max: 0xff },
            displayFlip: { name: "displayFlip", ID: 0x0009, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            windowDetection: { name: "windowDetection", ID: 0x000a, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            frostProtection: { name: "frostProtection", ID: 0x000d, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            scaleProtection: { name: "scaleProtection", ID: 0x000e, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            autoCalibration: { name: "autoCalibration", ID: 0x000f, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
        },
        commands: {
            switchMode: {
                name: "switchMode",
                ID: 0x01,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
            switchType: {
                name: "switchType",
                ID: 0x02,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
            powerType: {
                name: "powerType",
                ID: 0x03,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
            ledIndicator: {
                name: "ledIndicator",
                ID: 0x05,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN }],
            },
            interlock: {
                name: "interlock",
                ID: 0x07,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
            buttonMode: {
                name: "buttonMode",
                ID: 0x08,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
            displayFlip: {
                name: "displayFlip",
                ID: 0x09,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN }],
            },
            windowDetection: {
                name: "windowDetection",
                ID: 0x0a,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN }],
            },
        },
        commandsResponse: {},
    });
}
function YandexThermostatCluster(manufacturerCode) {
    return m.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            calibrated: {
                name: "calibrated",
                ID: 0xf000,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                manufacturerCode: manufacturerCode,
                write: true,
            },
        },
        commands: {
            calibrate: {
                name: "calibrate",
                ID: 0x00,
                parameters: [{ name: "value", type: zigbee_herdsman_1.Zcl.DataType.UINT8, max: 0xff }],
            },
        },
        commandsResponse: {},
    });
}
function reinterview() {
    let coordEnd = 1;
    const configure = [
        (device, coordinatorEndpoint, definition) => {
            coordEnd = coordinatorEndpoint;
        },
    ];
    const onEvent = [
        async (event) => {
            if (event.type === "deviceAnnounce") {
                // reinterview
                const { device, deviceExposesChanged } = event.data;
                try {
                    await device.interview(true);
                    logger_1.logger.info(`Successfully interviewed '${device.ieeeAddr}'`, NS);
                    // bind extended endpoint to coordinator
                    for (const endpoint of device.endpoints) {
                        if (endpoint.supportsOutputCluster("genOnOff")) {
                            await endpoint.bind("genOnOff", coordEnd);
                        }
                    }
                    // send updates to clients
                    deviceExposesChanged();
                }
                catch (error) {
                    logger_1.logger.error(`Reinterview failed for '${device.ieeeAddr} with error '${error}'`, NS);
                }
            }
        },
    ];
    return { onEvent, configure, isModernExtend: true };
}
exports.definitions = [
    {
        zigbeeModel: ["YNDX-00537"],
        model: "YNDX_00537",
        vendor: "Yandex",
        description: "Single relay",
        ota: true,
        extend: [
            reinterview(),
            YandexCluster(manufacturerCodeOld),
            m.deviceEndpoints({
                endpoints: { "1": 1, "": 2 },
            }),
            m.onOff({
                endpointNames: ["1"],
            }),
            enumLookupWithSetCommand({
                name: "power_type",
                cluster: "manuSpecificYandex",
                attribute: "powerType",
                setCommand: "powerType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Power supply type",
                lookup: {
                    full: 0x03,
                    low: 0x02,
                    medium: 0x01,
                    high: 0x00,
                },
                entityCategory: "config",
            }),
            enumLookupWithSetCommand({
                name: "switch_type",
                cluster: "manuSpecificYandex",
                attribute: "switchType",
                setCommand: "switchType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                endpointName: "1",
                description: "External switch type 1",
                lookup: {
                    rocker: 0x00,
                    button: 0x01,
                    decoupled: 0x02,
                },
                entityCategory: "config",
            }),
            m.commandsOnOff({ endpointNames: [""] }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00538"],
        model: "YNDX_00538",
        vendor: "Yandex",
        description: "Double relay",
        ota: true,
        extend: [
            reinterview(),
            YandexCluster(manufacturerCodeOld),
            m.deviceEndpoints({
                endpoints: { "1": 1, "2": 2, b1: 3, b2: 4 },
            }),
            m.onOff({
                endpointNames: ["1", "2"],
            }),
            enumLookupWithSetCommand({
                name: "power_type",
                cluster: "manuSpecificYandex",
                attribute: "powerType",
                setCommand: "powerType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Power supply type",
                lookup: {
                    full: 0x03,
                    low: 0x02,
                    medium: 0x01,
                    high: 0x00,
                },
                entityCategory: "config",
            }),
            binaryWithSetCommand({
                name: "interlock",
                cluster: "manuSpecificYandex",
                attribute: "interlock",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                setCommand: "interlock",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Interlock",
                entityCategory: "config",
            }),
            enumLookupWithSetCommand({
                name: "switch_type",
                cluster: "manuSpecificYandex",
                attribute: "switchType",
                setCommand: "switchType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                endpointName: "1",
                description: "External switch type 1",
                lookup: {
                    rocker: 0x00,
                    button: 0x01,
                    decoupled: 0x02,
                },
                entityCategory: "config",
            }),
            enumLookupWithSetCommand({
                name: "switch_type",
                cluster: "manuSpecificYandex",
                attribute: "switchType",
                setCommand: "switchType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                endpointName: "2",
                description: "External switch type 2",
                lookup: {
                    rocker: 0x00,
                    button: 0x01,
                    decoupled: 0x02,
                },
                entityCategory: "config",
            }),
            m.commandsOnOff({ endpointNames: ["b1", "b2"] }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00534"],
        model: "YNDX_00534",
        vendor: "Yandex",
        description: "Single gang wireless switch",
        ota: true,
        extend: [
            YandexCluster(manufacturerCodeOld),
            m.deviceEndpoints({
                endpoints: { down: 1, up: 2 },
            }),
            m.commandsOnOff({ endpointNames: ["up", "down"] }),
            m.battery(),
        ],
    },
    {
        zigbeeModel: ["YNDX-00535"],
        model: "YNDX_00535",
        vendor: "Yandex",
        description: "Double gang wireless switch",
        ota: true,
        extend: [
            YandexCluster(manufacturerCodeOld),
            m.deviceEndpoints({
                endpoints: { b1_down: 1, b2_down: 2, b1_up: 3, b2_up: 4 },
            }),
            m.commandsOnOff({ endpointNames: ["b1_up", "b1_down", "b2_up", "b2_down"] }),
            m.battery(),
        ],
    },
    {
        zigbeeModel: ["YNDX-00531"],
        model: "YNDX_00531",
        vendor: "Yandex",
        description: "Single gang switch",
        ota: true,
        extend: [
            reinterview(),
            YandexCluster(manufacturerCodeOld),
            m.deviceEndpoints({
                endpoints: { "1": 1, down: 2, up: 3 },
            }),
            m.onOff({
                endpointNames: ["1"],
            }),
            enumLookupWithSetCommand({
                name: "power_type",
                cluster: "manuSpecificYandex",
                attribute: "powerType",
                setCommand: "powerType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Power supply type",
                lookup: {
                    full: 0x03,
                    low: 0x02,
                    medium: 0x01,
                    high: 0x00,
                },
                entityCategory: "config",
            }),
            m.commandsOnOff({ endpointNames: ["up", "down"] }),
            enumLookupWithSetCommand({
                name: "operation_mode",
                cluster: "manuSpecificYandex",
                attribute: "switchMode",
                setCommand: "switchMode",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Switch mode (control_relay - the button control the relay, decoupled - button send events when pressed)",
                lookup: {
                    control_relay: 0x00,
                    up_decoupled: 0x01,
                    decoupled: 0x02,
                    down_decoupled: 0x03,
                },
                entityCategory: "config",
                endpointName: "1",
            }),
            m.binary({
                name: "led_indicator",
                cluster: "manuSpecificYandex",
                attribute: "ledIndicator",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Led indicator",
                entityCategory: "config",
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00532"],
        model: "YNDX_00532",
        vendor: "Yandex",
        description: "Double gang switch",
        ota: true,
        extend: [
            reinterview(),
            YandexCluster(manufacturerCodeOld),
            m.deviceEndpoints({
                endpoints: { "1": 1, "2": 2, b1_down: 3, b2_down: 4, b1_up: 5, b2_up: 6 },
            }),
            m.onOff({
                endpointNames: ["1", "2"],
            }),
            enumLookupWithSetCommand({
                name: "power_type",
                cluster: "manuSpecificYandex",
                attribute: "powerType",
                setCommand: "powerType",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Power supply type",
                lookup: {
                    full: 0x03,
                    low: 0x02,
                    medium: 0x01,
                    high: 0x00,
                },
                entityCategory: "config",
            }),
            m.commandsOnOff({ endpointNames: ["b1_up", "b1_down", "b2_up", "b2_down"] }),
            enumLookupWithSetCommand({
                name: "operation_mode",
                cluster: "manuSpecificYandex",
                attribute: "switchMode",
                setCommand: "switchMode",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Switch mode (control_relay - the button control the relay, decoupled - button send events when pressed)",
                lookup: {
                    control_relay: 0x00,
                    up_decoupled: 0x01,
                    decoupled: 0x02,
                    down_decoupled: 0x03,
                },
                entityCategory: "config",
                endpointName: "1",
            }),
            enumLookupWithSetCommand({
                name: "operation_mode",
                cluster: "manuSpecificYandex",
                attribute: "switchMode",
                setCommand: "switchMode",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Switch mode (control_relay - the buttons control the relay, decoupled - buttons send events when pressed)",
                lookup: {
                    control_relay: 0x00,
                    up_decoupled: 0x01,
                    decoupled: 0x02,
                    down_decoupled: 0x03,
                },
                entityCategory: "config",
                endpointName: "2",
            }),
            m.binary({
                name: "led_indicator",
                cluster: "manuSpecificYandex",
                attribute: "ledIndicator",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Led indicator",
                entityCategory: "config",
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00530"],
        model: "YNDX_00530",
        vendor: "Yandex",
        description: "Dimmer",
        ota: true,
        extend: [
            YandexCluster(manufacturerCodeOld),
            m.light({
                effect: true,
                powerOnBehavior: true,
                configureReporting: true,
                levelReportingConfig: { min: "MIN", max: "MAX", change: 1 },
            }),
            m.lightingBallast(),
            binaryWithSetCommand({
                name: "led_indicator",
                cluster: "manuSpecificYandex",
                attribute: "ledIndicator",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                setCommand: "ledIndicator",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Led indicator",
                entityCategory: "config",
            }),
            enumLookupWithSetCommand({
                name: "button_mode",
                cluster: "manuSpecificYandex",
                attribute: "buttonMode",
                setCommand: "buttonMode",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeOld },
                description: "Dimmer button mode",
                lookup: {
                    general: 0x00,
                    alternative: 0x01,
                },
                entityCategory: "config",
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00518"],
        model: "YNDX-00518",
        vendor: "Yandex",
        description: "Thermostatic radiator valve",
        ota: true,
        extend: [
            YandexCluster(manufacturerCodeNew),
            YandexThermostatCluster(manufacturerCodeNew),
            m.onOff({
                powerOnBehavior: false,
            }),
            m.thermostat({
                localTemperature: {
                    configure: { reporting: { min: "1_MINUTE", max: "2_MINUTES", change: 50 } },
                },
                setpoints: {
                    values: { occupiedHeatingSetpoint: { min: 5, max: 30, step: 0.5 } },
                    configure: { reporting: { min: "1_SECOND", max: "2_MINUTES", change: 50 } },
                },
                localTemperatureCalibration: {
                    values: true,
                },
            }),
            binaryWithSetCommand({
                name: "display_flip",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                cluster: "manuSpecificYandex",
                attribute: "displayFlip",
                setCommand: "displayFlip",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
                description: "Flip display orientation",
                entityCategory: "config",
            }),
            m.binary({
                name: "child_lock",
                valueOn: ["LOCK", 1],
                valueOff: ["UNLOCK", 0],
                cluster: "hvacUserInterfaceCfg",
                attribute: "keypadLockout",
                description: "Enables/disables physical input on the device",
                access: "ALL",
                reporting: { min: 0, max: 3600, change: 0 },
            }),
            m.binary({
                name: "frost_protection",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                cluster: "manuSpecificYandex",
                attribute: "frostProtection",
                description: "Enables/disables antifreeze function",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
            binaryWithSetCommand({
                name: "window_detection",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                cluster: "manuSpecificYandex",
                setCommand: "windowDetection",
                attribute: "windowDetection",
                description: "Enables/disables window detection on the device",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
            m.binary({
                name: "scale_protection",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                cluster: "manuSpecificYandex",
                attribute: "scaleProtection",
                description: "Enables/disables anti-scale protection",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
            m.binary({
                name: "auto_calibration",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                cluster: "manuSpecificYandex",
                attribute: "autoCalibration",
                description: "Enables/disables auto calibration",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
            binaryWithSetCommand({
                name: "calibrated",
                valueOn: ["ON", 1],
                valueOff: ["OFF", 0],
                cluster: "hvacThermostat",
                attribute: "calibrated",
                setCommand: "calibrate",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
                description: "OFF if calibration needs to be performed",
                entityCategory: "config",
                reporting: { min: 0, max: 3600, change: 0 },
            }),
            m.battery({
                voltage: true,
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00591", "YNDX-00592"],
        model: "YNDX-00591",
        vendor: "Yandex",
        description: "Window cover",
        ota: true,
        extend: [
            m.windowCovering({
                controls: ["lift"],
                configureReporting: true,
                coverMode: true,
                coverInverted: false,
            }),
            m.enumLookup({
                name: "velocity",
                lookup: { slow: 6, normal: 9, fast: 12 },
                cluster: "closuresWindowCovering",
                attribute: "velocityLift",
                description: "Velocity",
                access: "ALL",
            }),
            m.numeric({
                name: "max_position",
                unit: "%",
                valueMin: 0,
                valueMax: 100,
                cluster: "closuresWindowCovering",
                attribute: { ID: 0xf001, type: zigbee_herdsman_1.Zcl.DataType.UINT8 },
                description: "Max position",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
            m.numeric({
                name: "min_position",
                unit: "%",
                valueMin: 0,
                valueMax: 100,
                cluster: "closuresWindowCovering",
                attribute: { ID: 0xf002, type: zigbee_herdsman_1.Zcl.DataType.UINT8 },
                description: "Min position",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00526"],
        model: "YNDX_00526",
        vendor: "Yandex",
        description: "Contact sensor",
        ota: true,
        extend: [
            m.iasZoneAlarm({
                zoneType: "contact",
                zoneAttributes: ["alarm_1", "battery_low"],
            }),
            m.battery({
                voltage: true,
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00527"],
        model: "YNDX_00527",
        vendor: "Yandex",
        description: "Leak sensor",
        ota: true,
        extend: [
            m.iasZoneAlarm({
                zoneType: "water_leak",
                zoneAttributes: ["alarm_1", "battery_low"],
            }),
            m.battery({
                voltage: true,
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00528"],
        model: "YNDX_00528",
        vendor: "Yandex",
        description: "Motion and illuminance sensor",
        ota: true,
        extend: [
            m.enumLookup({
                name: "sensitivity",
                lookup: { low: 0, medium: 1, high: 2 },
                cluster: "msOccupancySensing",
                attribute: { ID: 0xf000, type: zigbee_herdsman_1.Zcl.DataType.ENUM8 },
                description: "Sensor sensitivity",
                access: "ALL",
                zigbeeCommandOptions: { manufacturerCode: manufacturerCodeNew },
            }),
            m.occupancy(),
            m.illuminance(),
            m.battery({
                voltage: true,
            }),
        ],
    },
    {
        zigbeeModel: ["YNDX-00529"],
        model: "YNDX_00529",
        vendor: "Yandex",
        description: "Temperature and humidity and pressure sensor",
        ota: true,
        extend: [
            m.temperature(),
            m.humidity(),
            m.pressure(),
            m.battery({
                voltage: true,
            }),
        ],
    },
];
//# sourceMappingURL=yandex.js.map