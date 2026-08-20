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
const ptvo = __importStar(require("../devices/custom_devices_diy"));
const constants = __importStar(require("../lib/constants"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const ea = exposes.access;
const diyruzExtend = {
    addDiyruzGenOnOffCluster: () => m.deviceAddCustomCluster("genOnOff", {
        name: "genOnOff",
        ID: zigbee_herdsman_1.Zcl.Clusters.genOnOff.ID,
        attributes: {
            cpuTemperature: { name: "cpuTemperature", ID: 0xa191, type: zigbee_herdsman_1.Zcl.DataType.INT16 }, // 41361
            power: { name: "power", ID: 0xa194, type: zigbee_herdsman_1.Zcl.DataType.INT16 }, // 41364
            action: { name: "action", ID: 0xa197, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN }, // 41367
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzMsIlluminanceLevelSensingCluster: () => m.deviceAddCustomCluster("msIlluminanceLevelSensing", {
        name: "msIlluminanceLevelSensing",
        ID: zigbee_herdsman_1.Zcl.Clusters.msIlluminanceLevelSensing.ID,
        attributes: {
            sensitivity: { name: "sensitivity", ID: 0xf000, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true }, // 61440
            ledFeedback: { name: "ledFeedback", ID: 0xf001, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true }, // 61441
            buzzerFeedback: { name: "buzzerFeedback", ID: 0xf002, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true }, // 61442
            sensorsCount: { name: "sensorsCount", ID: 0xf003, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true }, // 61443
            sensorsType: { name: "sensorsType", ID: 0xf004, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true }, // 61444
            alertThreshold: { name: "alertThreshold", ID: 0xf005, type: zigbee_herdsman_1.Zcl.DataType.UINT32, write: true }, // 61445
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzMsIlluminanceMeasurementCluster: () => m.deviceAddCustomCluster("msIlluminanceMeasurement", {
        name: "msIlluminanceMeasurement",
        ID: zigbee_herdsman_1.Zcl.Clusters.msIlluminanceMeasurement.ID,
        attributes: {
            radioactiveEventsPerMinute: { name: "radioactiveEventsPerMinute", ID: 0xf001, type: zigbee_herdsman_1.Zcl.DataType.UINT16 }, // 61441
            radiationDosePerHour: { name: "radiationDosePerHour", ID: 0xf002, type: zigbee_herdsman_1.Zcl.DataType.UINT32 }, // 61442
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzMsCO2Cluster: () => m.deviceAddCustomCluster("msCO2", {
        name: "msCO2",
        ID: zigbee_herdsman_1.Zcl.Clusters.msCO2.ID,
        attributes: {
            enableAbc: { name: "enableAbc", ID: 0x0202, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            ledFeedback: { name: "ledFeedback", ID: 0x0203, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            threshold1: { name: "threshold1", ID: 0x0204, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true },
            threshold2: { name: "threshold2", ID: 0x0205, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzMsTemperatureMeasurementCluster: () => m.deviceAddCustomCluster("msTemperatureMeasurement", {
        name: "msTemperatureMeasurement",
        ID: zigbee_herdsman_1.Zcl.Clusters.msTemperatureMeasurement.ID,
        attributes: {
            temperatureOffset: { name: "temperatureOffset", ID: 0x0210, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzMsPressureMeasurementCluster: () => m.deviceAddCustomCluster("msPressureMeasurement", {
        name: "msPressureMeasurement",
        ID: zigbee_herdsman_1.Zcl.Clusters.msPressureMeasurement.ID,
        attributes: {
            pressureOffset: { name: "pressureOffset", ID: 0x0210, type: zigbee_herdsman_1.Zcl.DataType.INT32, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzMsRelativeHumidityCluster: () => m.deviceAddCustomCluster("msRelativeHumidity", {
        name: "msRelativeHumidity",
        ID: zigbee_herdsman_1.Zcl.Clusters.msRelativeHumidity.ID,
        attributes: {
            humidityOffset: { name: "humidityOffset", ID: 0x0210, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
    addDiyruzClosuresDoorLockCluster: () => m.deviceAddCustomCluster("closuresDoorLock", {
        name: "closuresDoorLock",
        ID: zigbee_herdsman_1.Zcl.Clusters.closuresDoorLock.ID,
        attributes: {
            state: { name: "state", ID: 0x0050, type: zigbee_herdsman_1.Zcl.DataType.ENUM8 },
            mode: { name: "mode", ID: 0x0051, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true },
            sound: { name: "sound", ID: 0x0052, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            timeRing: { name: "timeRing", ID: 0x0053, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            timeTalk: { name: "timeTalk", ID: 0x0054, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            timeOpen: { name: "timeOpen", ID: 0x0055, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            timeReport: { name: "timeReport", ID: 0x0056, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
            timeBell: { name: "timeBell", ID: 0x0057, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
};
const tzLocal = {
    diyruz_freepad_on_off_config: {
        key: ["switch_type", "switch_actions"],
        convertGet: async (entity, key, meta) => {
            await entity.read("genOnOffSwitchCfg", ["switchType", "switchActions"]);
        },
        convertSet: async (entity, key, value, meta) => {
            const switchTypesLookup = {
                toggle: 0x00,
                momentary: 0x01,
                multifunction: 0x02,
            };
            const switchActionsLookup = {
                on: 0x00,
                off: 0x01,
                toggle: 0x02,
            };
            const intVal = Number(value);
            const switchType = utils.getFromLookup(value, switchTypesLookup, intVal);
            const switchActions = utils.getFromLookup(value, switchActionsLookup, intVal);
            const payloads = {
                switch_type: { switchType },
                switch_actions: { switchActions },
            };
            await entity.write("genOnOffSwitchCfg", payloads[key]);
            return { state: { [`${key}`]: value } };
        },
    },
    diyruz_geiger_config: {
        key: ["sensitivity", "led_feedback", "buzzer_feedback", "sensors_count", "sensors_type", "alert_threshold"],
        convertSet: async (entity, key, rawValue, meta) => {
            const lookup = {
                OFF: 0x00,
                ON: 0x01,
            };
            const sensorsTypeLookup = {
                "СБМ-20/СТС-5/BOI-33": "0",
                "СБМ-19/СТС-6": "1",
                Others: "2",
            };
            let value = utils.getFromLookup(rawValue, lookup, Number(rawValue));
            if (key === "sensors_type") {
                // @ts-expect-error ignore
                value = utils.getFromLookup(rawValue, sensorsTypeLookup, Number(rawValue));
            }
            const payloads = {
                sensitivity: { 61440: { value, type: 0x21 } },
                led_feedback: { 61441: { value, type: 0x10 } },
                buzzer_feedback: { 61442: { value, type: 0x10 } },
                sensors_count: { 61443: { value, type: 0x20 } },
                sensors_type: { 61444: { value, type: 0x30 } },
                alert_threshold: { 61445: { value, type: 0x23 } },
            };
            await entity.write("msIlluminanceLevelSensing", payloads[key]);
            return {
                state: { [key]: rawValue },
            };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("msIlluminanceLevelSensing", [
                "sensitivity",
                "ledFeedback",
                "buzzerFeedback",
            ]);
            await entity.read("msIlluminanceLevelSensing", [
                "sensorsCount",
                "sensorsType",
                "alertThreshold",
            ]);
        },
    },
    diyruz_airsense_config: {
        key: ["led_feedback", "enable_abc", "threshold1", "threshold2", "temperature_offset", "pressure_offset", "humidity_offset"],
        convertSet: async (entity, key, rawValue, meta) => {
            const lookup = { OFF: 0x00, ON: 0x01 };
            const value = utils.getFromLookup(rawValue, lookup, Number(rawValue));
            const payloads = {
                led_feedback: ["msCO2", { 515: { value, type: 0x10 } }],
                enable_abc: ["msCO2", { 514: { value, type: 0x10 } }],
                threshold1: ["msCO2", { 516: { value, type: 0x21 } }],
                threshold2: ["msCO2", { 517: { value, type: 0x21 } }],
                temperature_offset: ["msTemperatureMeasurement", { 528: { value, type: 0x29 } }],
                pressure_offset: ["msPressureMeasurement", { 528: { value, type: 0x2b } }],
                humidity_offset: ["msRelativeHumidity", { 528: { value, type: 0x29 } }],
            };
            await entity.write(payloads[key][0], payloads[key][1]);
            return {
                state: { [key]: rawValue },
            };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("msCO2", ["ledFeedback", "enableAbc", "threshold1", "threshold2"]);
            await entity.read("msTemperatureMeasurement", ["temperatureOffset"]);
            await entity.read("msPressureMeasurement", ["pressureOffset"]);
            await entity.read("msRelativeHumidity", ["humidityOffset"]);
        },
    },
    diyruz_zintercom_config: {
        key: ["mode", "sound", "time_ring", "time_talk", "time_open", "time_bell", "time_report"],
        convertSet: async (entity, key, rawValue, meta) => {
            const lookup = { OFF: 0x00, ON: 0x01 };
            const modeOpenLookup = { never: "0", once: "1", always: "2", drop: "3" };
            let value = utils.getFromLookup(rawValue, lookup, Number(rawValue));
            if (key === "mode") {
                // @ts-expect-error ignore
                value = utils.getFromLookup(rawValue, modeOpenLookup, Number(rawValue));
            }
            const payloads = {
                mode: { 81: { value, type: 0x30 } },
                sound: { 82: { value, type: 0x10 } },
                time_ring: { 83: { value, type: 0x20 } },
                time_talk: { 84: { value, type: 0x20 } },
                time_open: { 85: { value, type: 0x20 } },
                time_bell: { 87: { value, type: 0x20 } },
                time_report: { 86: { value, type: 0x20 } },
            };
            await entity.write("closuresDoorLock", payloads[key]);
            return {
                state: { [key]: rawValue },
            };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("closuresDoorLock", ["mode", "sound", "timeRing", "timeTalk"]);
            await entity.read("closuresDoorLock", ["timeOpen", "timeBell", "timeReport"]);
        },
    },
};
const fzLocal = {
    diyruz_contact: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            return { contact: msg.data.onOff !== 0 };
        },
    },
    diyruz_rspm: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const power = utils.precisionRound(msg.data["41364"], 2);
            return {
                state: msg.data.onOff === 1 ? "ON" : "OFF",
                cpu_temperature: utils.precisionRound(msg.data["41361"], 2),
                power: power,
                current: utils.precisionRound(power / 230, 2),
                action: msg.data["41367"] === 1 ? "hold" : "release",
            };
        },
    },
    diyruz_freepad_clicks: {
        cluster: "genMultistateInput",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            const button = utils.getKey(model.endpoint(msg.device), msg.endpoint.ID);
            const lookup = { 0: "hold", 1: "single", 2: "double", 3: "triple", 4: "quadruple", 255: "release" };
            const clicks = msg.data.presentValue;
            const action = lookup[clicks] ? lookup[clicks] : `many_${clicks}`;
            return { action: `${button}_${action}` };
        },
    },
    diyruz_freepad_config: {
        cluster: "genOnOffSwitchCfg",
        type: ["readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const button = utils.getKey(model.endpoint(msg.device), msg.endpoint.ID);
            const { switchActions, switchType } = msg.data;
            const switchTypesLookup = ["toggle", "momentary", "multifunction"];
            const switchActionsLookup = ["on", "off", "toggle"];
            return {
                [`switch_type_${button}`]: switchTypesLookup[switchType],
                [`switch_actions_${button}`]: switchActionsLookup[switchActions],
            };
        },
    },
    diyruz_geiger: {
        cluster: "msIlluminanceMeasurement",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            return {
                radioactive_events_per_minute: msg.data.radioactiveEventsPerMinute,
                radiation_dose_per_hour: msg.data.radiationDosePerHour,
            };
        },
    },
    diyruz_geiger_config: {
        cluster: "msIlluminanceLevelSensing",
        type: "readResponse",
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.ledFeedback !== undefined) {
                result.led_feedback = msg.data.ledFeedback ? "ON" : "OFF";
            }
            if (msg.data.buzzerFeedback !== undefined) {
                result.buzzer_feedback = msg.data.buzzerFeedback ? "ON" : "OFF";
            }
            if (msg.data.sensitivity !== undefined) {
                result.sensitivity = msg.data.sensitivity;
            }
            if (msg.data.sensorsCount !== undefined) {
                result.sensors_count = msg.data.sensorsCount;
            }
            if (msg.data.sensorsType !== undefined) {
                result.sensors_type = ["СБМ-20/СТС-5/BOI-33", "СБМ-19/СТС-6", "Others"][msg.data.sensorsType];
            }
            if (msg.data.alertThreshold !== undefined) {
                result.alert_threshold = msg.data.alertThreshold;
            }
            return result;
        },
    },
    diyruz_airsense_config_co2: {
        cluster: "msCO2",
        type: "readResponse",
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.ledFeedback !== undefined) {
                result.led_feedback = msg.data.ledFeedback ? "ON" : "OFF";
            }
            if (msg.data.enableAbc !== undefined) {
                result.enable_abc = msg.data.enableAbc ? "ON" : "OFF";
            }
            if (msg.data.threshold1 !== undefined) {
                result.threshold1 = msg.data.threshold1;
            }
            if (msg.data.threshold2 !== undefined) {
                result.threshold2 = msg.data.threshold2;
            }
            return result;
        },
    },
    diyruz_airsense_config_temp: {
        cluster: "msTemperatureMeasurement",
        type: "readResponse",
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.temperatureOffset !== undefined) {
                result.temperature_offset = msg.data.temperatureOffset;
            }
            return result;
        },
    },
    diyruz_airsense_config_pres: {
        cluster: "msPressureMeasurement",
        type: "readResponse",
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.pressureOffset !== undefined) {
                result.pressure_offset = msg.data.pressureOffset;
            }
            return result;
        },
    },
    diyruz_airsense_config_hum: {
        cluster: "msRelativeHumidity",
        type: "readResponse",
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.humidityOffset !== undefined) {
                result.humidity_offset = msg.data.humidityOffset;
            }
            return result;
        },
    },
    diyruz_zintercom_config: {
        cluster: "closuresDoorLock",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.state !== undefined) {
                result.state = ["idle", "ring", "talk", "open", "drop"][msg.data.state];
            }
            if (msg.data.mode !== undefined) {
                result.mode = ["never", "once", "always", "drop"][msg.data.mode];
            }
            if (msg.data.sound !== undefined) {
                result.sound = msg.data.sound ? "ON" : "OFF";
            }
            if (msg.data.timeRing !== undefined) {
                result.time_ring = msg.data.timeRing;
            }
            if (msg.data.timeTalk !== undefined) {
                result.time_talk = msg.data.timeTalk;
            }
            if (msg.data.timeOpen !== undefined) {
                result.time_open = msg.data.timeOpen;
            }
            if (msg.data.timeBell !== undefined) {
                result.time_bell = msg.data.timeBell;
            }
            if (msg.data.timeReport !== undefined) {
                result.time_report = msg.data.timeReport;
            }
            return result;
        },
    },
    keypad20states: {
        cluster: "genOnOff",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            const button = utils.getKey(model.endpoint(msg.device), msg.endpoint.ID);
            const state = msg.data.onOff === 1;
            if (button) {
                return { [button]: state };
            }
        },
    },
    keypad20_battery: {
        cluster: "genPowerCfg",
        type: ["readResponse", "attributeReport"],
        convert: (model, msg, publish, options, meta) => {
            const voltage = msg.data.mainsVoltage / 10;
            return {
                battery: utils.batteryVoltageToPercentage(voltage, "3V_2100"),
                voltage: voltage, // @deprecated
                // voltage: voltage / 1000.0,
            };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["DIYRuZ_R4_5"],
        model: "DIYRuZ_R4_5",
        vendor: "DIYRuZ",
        description: "DiY 4 Relays + 4 switches + 1 buzzer",
        extend: [
            m.deviceEndpoints({ endpoints: { bottom_left: 1, bottom_right: 2, top_left: 3, top_right: 4, center: 5 } }),
            m.onOff({ endpointNames: ["bottom_left", "bottom_right", "top_left", "top_right", "center"] }),
        ],
    },
    {
        zigbeeModel: ["DIYRuZ_KEYPAD20"],
        model: "DIYRuZ_KEYPAD20",
        vendor: "DIYRuZ",
        description: "DiY 20 button keypad",
        fromZigbee: [fzLocal.keypad20states, fzLocal.keypad20_battery],
        toZigbee: [],
        exposes: [e.battery()],
        endpoint: (device) => {
            return {
                btn_1: 1,
                btn_2: 2,
                btn_3: 3,
                btn_4: 4,
                btn_5: 5,
                btn_6: 6,
                btn_7: 7,
                btn_8: 8,
                btn_9: 9,
                btn_10: 10,
                btn_11: 11,
                btn_12: 12,
                btn_13: 13,
                btn_14: 14,
                btn_15: 15,
                btn_16: 16,
                btn_17: 17,
                btn_18: 18,
                btn_19: 19,
                btn_20: 20,
            };
        },
    },
    {
        zigbeeModel: ["DIYRuZ_magnet"],
        model: "DIYRuZ_magnet",
        vendor: "DIYRuZ",
        description: "DIYRuZ contact sensor",
        fromZigbee: [fzLocal.keypad20_battery, fzLocal.diyruz_contact],
        exposes: [e.battery(), e.contact()],
        toZigbee: [],
    },
    {
        zigbeeModel: ["DIYRuZ_rspm"],
        model: "DIYRuZ_rspm",
        vendor: "DIYRuZ",
        description: "DIYRuZ relay switch power meter",
        fromZigbee: [fzLocal.diyruz_rspm],
        toZigbee: [tz.on_off],
        exposes: [e.switch(), e.power(), e.current(), e.cpu_temperature(), e.action(["hold", "release"])],
        endpoint: (device) => {
            return { default: 8 };
        },
    },
    {
        zigbeeModel: ["DIYRuZ_FreePad", "FreePadLeTV8"],
        model: "DIYRuZ_FreePad",
        vendor: "DIYRuZ",
        description: "DiY 8/12/20 button keypad",
        fromZigbee: [fzLocal.diyruz_freepad_clicks, fzLocal.diyruz_freepad_config, fz.battery],
        exposes: [e.battery(), e.action(["*_single", "*_double", "*_triple", "*_quadruple", "*_release", "*_hold"])].concat(((enpoinsCount) => {
            const features = [];
            for (let i = 1; i <= enpoinsCount; i++) {
                const epName = `button_${i}`;
                features.push(e.enum("switch_type", ea.ALL, ["toggle", "momentary", "multifunction"]).withEndpoint(epName));
                features.push(e.enum("switch_actions", ea.ALL, ["on", "off", "toggle"]).withEndpoint(epName));
            }
            return features;
        })(20)),
        toZigbee: [tzLocal.diyruz_freepad_on_off_config],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg"]);
            if (device.applicationVersion < 3) {
                // Legacy PM2 firmwares
                const payload = [
                    {
                        attribute: "batteryPercentageRemaining",
                        minimumReportInterval: 0,
                        maximumReportInterval: 3600,
                        reportableChange: 0,
                    },
                    {
                        attribute: "batteryVoltage",
                        minimumReportInterval: 0,
                        maximumReportInterval: 3600,
                        reportableChange: 0,
                    },
                ];
                await endpoint.configureReporting("genPowerCfg", payload);
            }
            device.endpoints.forEach(async (ep) => {
                if (ep.outputClusters.includes(18)) {
                    await reporting.bind(ep, coordinatorEndpoint, ["genMultistateInput"]);
                }
            });
        },
        endpoint: (device) => {
            return {
                button_1: 1,
                button_2: 2,
                button_3: 3,
                button_4: 4,
                button_5: 5,
                button_6: 6,
                button_7: 7,
                button_8: 8,
                button_9: 9,
                button_10: 10,
                button_11: 11,
                button_12: 12,
                button_13: 13,
                button_14: 14,
                button_15: 15,
                button_16: 16,
                button_17: 17,
                button_18: 18,
                button_19: 19,
                button_20: 20,
            };
        },
    },
    {
        zigbeeModel: ["FreePad_LeTV_8"],
        model: "FreePad_LeTV_8",
        vendor: "DIYRuZ",
        description: "LeTV 8key FreePad mod",
        fromZigbee: [fzLocal.diyruz_freepad_clicks, fzLocal.diyruz_freepad_config, fz.battery],
        exposes: [e.battery(), e.action(["*_single", "*_double", "*_triple", "*_quadruple", "*_release"])].concat(((enpoinsCount) => {
            const features = [];
            for (let i = 1; i <= enpoinsCount; i++) {
                const epName = `button_${i}`;
                features.push(e.enum("switch_type", ea.ALL, ["toggle", "momentary", "multifunction"]).withEndpoint(epName));
                features.push(e.enum("switch_actions", ea.ALL, ["on", "off", "toggle"]).withEndpoint(epName));
            }
            return features;
        })(8)),
        toZigbee: [tzLocal.diyruz_freepad_on_off_config],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genPowerCfg"]);
            if (device.applicationVersion < 3) {
                // Legacy PM2 firmwares
                const payload = [
                    {
                        attribute: "batteryPercentageRemaining",
                        minimumReportInterval: 0,
                        maximumReportInterval: 3600,
                        reportableChange: 0,
                    },
                    {
                        attribute: "batteryVoltage",
                        minimumReportInterval: 0,
                        maximumReportInterval: 3600,
                        reportableChange: 0,
                    },
                ];
                await endpoint.configureReporting("genPowerCfg", payload);
            }
            device.endpoints.forEach(async (ep) => {
                if (ep.outputClusters.includes(18)) {
                    await reporting.bind(ep, coordinatorEndpoint, ["genMultistateInput"]);
                }
            });
        },
        endpoint: (device) => {
            return { button_1: 1, button_2: 2, button_3: 3, button_4: 4, button_5: 5, button_6: 6, button_7: 7, button_8: 8 };
        },
    },
    {
        zigbeeModel: ["DIYRuZ_Geiger"],
        model: "DIYRuZ_Geiger",
        vendor: "DIYRuZ",
        description: "DiY Geiger counter",
        extend: [diyruzExtend.addDiyruzMsIlluminanceLevelSensingCluster(), diyruzExtend.addDiyruzMsIlluminanceMeasurementCluster()],
        fromZigbee: [fzLocal.diyruz_geiger, fz.command_on, fz.command_off, fzLocal.diyruz_geiger_config],
        exposes: [
            e.action(["on", "off"]),
            e.numeric("radioactive_events_per_minute", ea.STATE).withUnit("rpm").withDescription("Current count radioactive pulses per minute"),
            e.numeric("radiation_dose_per_hour", ea.STATE).withUnit("μR/h").withDescription("Current radiation level"),
            e.binary("led_feedback", ea.ALL, "ON", "OFF").withDescription("Enable LED feedback"),
            e.binary("buzzer_feedback", ea.ALL, "ON", "OFF").withDescription("Enable buzzer feedback"),
            e.numeric("alert_threshold", ea.ALL).withUnit("μR/h").withDescription("Critical radiation level").withValueMin(0).withValueMax(10000),
            e.enum("sensors_type", ea.ALL, ["СБМ-20/СТС-5/BOI-33", "СБМ-19/СТС-6", "Others"]).withDescription("Type of installed tubes"),
            e.numeric("sensors_count", ea.ALL).withDescription("Count of installed tubes").withValueMin(0).withValueMax(50),
            e.numeric("sensitivity", ea.ALL).withDescription("This is applicable if tubes type is set to other").withValueMin(0).withValueMax(100),
        ],
        toZigbee: [tzLocal.diyruz_geiger_config],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["msIlluminanceMeasurement", "genOnOff"]);
            const payload = [
                {
                    attribute: "radioactiveEventsPerMinute",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.MINUTE,
                    reportableChange: 0,
                },
                {
                    attribute: "radiationDosePerHour",
                    minimumReportInterval: 0,
                    maximumReportInterval: constants.repInterval.MINUTE,
                    reportableChange: 0,
                },
            ];
            await endpoint.configureReporting("msIlluminanceMeasurement", payload);
        },
    },
    {
        zigbeeModel: ["DIYRuZ_R8_8"],
        model: "DIYRuZ_R8_8",
        vendor: "DIYRuZ",
        description: "DiY 8 Relays + 8 switches",
        fromZigbee: [ptvo.fzLocal.ptvo_multistate_action],
        extend: [
            m.deviceEndpoints({ endpoints: { l1: 1, l2: 2, l3: 3, l4: 4, l5: 5, l6: 6, l7: 7, l8: 8 } }),
            m.onOff({ endpointNames: ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"] }),
        ],
    },
    {
        zigbeeModel: ["DIYRuZ_RT"],
        model: "DIYRuZ_RT",
        vendor: "DIYRuZ",
        description: "DiY CC2530 Zigbee 3.0 firmware",
        fromZigbee: [fz.on_off, fz.temperature],
        toZigbee: [tz.on_off],
        exposes: [e.switch(), e.temperature()],
    },
    {
        zigbeeModel: ["DIYRuZ_Flower"],
        model: "DIYRuZ_Flower",
        vendor: "DIYRuZ",
        description: "Flower sensor",
        fromZigbee: [fz.temperature, fz.humidity, fz.soil_moisture, fz.pressure, fz.battery],
        toZigbee: [],
        meta: { multiEndpoint: true, multiEndpointSkip: ["humidity"] },
        endpoint: (device) => {
            return { bme: 1, ds: 2 };
        },
        configure: async (device, coordinatorEndpoint) => {
            const firstEndpoint = device.getEndpoint(1);
            const secondEndpoint = device.getEndpoint(2);
            await reporting.bind(firstEndpoint, coordinatorEndpoint, [
                "genPowerCfg",
                "msTemperatureMeasurement",
                "msRelativeHumidity",
                "msPressureMeasurement",
                "msSoilMoisture",
            ]);
            await reporting.bind(secondEndpoint, coordinatorEndpoint, ["msTemperatureMeasurement"]);
            const overrides = { min: 0, max: 3600, change: 0 };
            await reporting.batteryVoltage(firstEndpoint, overrides);
            await reporting.batteryPercentageRemaining(firstEndpoint, overrides);
            await reporting.temperature(firstEndpoint, overrides);
            await reporting.humidity(firstEndpoint, overrides);
            await reporting.pressureExtended(firstEndpoint, overrides);
            await reporting.soil_moisture(firstEndpoint, overrides);
            await reporting.temperature(secondEndpoint, overrides);
            await firstEndpoint.read("msPressureMeasurement", ["scale"]);
        },
        exposes: [
            e.soil_moisture(),
            e.battery(),
            e.humidity(),
            e.pressure(),
            e.temperature().withEndpoint("ds"),
            e.temperature().withEndpoint("bme"),
        ],
        extend: [m.illuminance()],
    },
    {
        zigbeeModel: ["DIYRuZ_AirSense"],
        model: "DIYRuZ_AirSense",
        vendor: "DIYRuZ",
        description: "Air quality sensor",
        extend: [
            diyruzExtend.addDiyruzMsCO2Cluster(),
            diyruzExtend.addDiyruzMsTemperatureMeasurementCluster(),
            diyruzExtend.addDiyruzMsPressureMeasurementCluster(),
            diyruzExtend.addDiyruzMsRelativeHumidityCluster(),
        ],
        fromZigbee: [
            fz.temperature,
            fz.humidity,
            fz.co2,
            fz.pressure,
            fzLocal.diyruz_airsense_config_co2,
            fzLocal.diyruz_airsense_config_temp,
            fzLocal.diyruz_airsense_config_pres,
            fzLocal.diyruz_airsense_config_hum,
        ],
        toZigbee: [tzLocal.diyruz_airsense_config],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            const clusters = ["msTemperatureMeasurement", "msRelativeHumidity", "msPressureMeasurement", "msCO2"];
            await reporting.bind(endpoint, coordinatorEndpoint, clusters);
            for (const cluster of clusters) {
                await endpoint.configureReporting(cluster, [
                    { attribute: "measuredValue", minimumReportInterval: 0, maximumReportInterval: 3600, reportableChange: 0 },
                ]);
            }
            await endpoint.read("msPressureMeasurement", ["scale"]);
        },
        exposes: [
            e.co2(),
            e.temperature(),
            e.humidity(),
            e.pressure(),
            e.binary("led_feedback", ea.ALL, "ON", "OFF").withDescription("Enable LEDs feedback"),
            e.binary("enable_abc", ea.ALL, "ON", "OFF").withDescription("Enable ABC (Automatic Baseline Correction)"),
            e.numeric("threshold1", ea.ALL).withUnit("ppm").withDescription("Warning (LED2) CO2 level").withValueMin(0).withValueMax(50000),
            e.numeric("threshold2", ea.ALL).withUnit("ppm").withDescription("Critical (LED3) CO2 level").withValueMin(0).withValueMax(50000),
            e.numeric("temperature_offset", ea.ALL).withUnit("°C").withDescription("Adjust temperature").withValueMin(-20).withValueMax(20),
            e.numeric("humidity_offset", ea.ALL).withUnit("%").withDescription("Adjust humidity").withValueMin(-50).withValueMax(50),
            e.numeric("pressure_offset", ea.ALL).withUnit("hPa").withDescription("Adjust pressure").withValueMin(-1000).withValueMax(1000),
        ],
    },
    {
        zigbeeModel: ["DIY_Zintercom"],
        model: "DIYRuZ_Zintercom",
        vendor: "DIYRuZ",
        description: "Matrix intercom auto opener",
        extend: [diyruzExtend.addDiyruzClosuresDoorLockCluster()],
        fromZigbee: [fz.battery, fzLocal.diyruz_zintercom_config],
        toZigbee: [tzLocal.diyruz_zintercom_config],
        configure: async (device, coordinatorEndpoint) => {
            const firstEndpoint = device.getEndpoint(1);
            await reporting.bind(firstEndpoint, coordinatorEndpoint, ["closuresDoorLock", "genPowerCfg"]);
            const payload1 = [
                { attribute: "batteryPercentageRemaining", minimumReportInterval: 0, maximumReportInterval: 3600, reportableChange: 0 },
                { attribute: "batteryVoltage", minimumReportInterval: 0, maximumReportInterval: 3600, reportableChange: 0 },
            ];
            await firstEndpoint.configureReporting("genPowerCfg", payload1);
            const payload2 = [
                { attribute: "state", minimumReportInterval: 0, maximumReportInterval: 3600, reportableChange: 0 },
            ];
            await firstEndpoint.configureReporting("closuresDoorLock", payload2);
        },
        exposes: [
            e.enum("state", ea.STATE, ["idle", "ring", "talk", "open", "drop"]).withDescription("Current state"),
            e.enum("mode", ea.ALL, ["never", "once", "always", "drop"]).withDescription("Select open mode"),
            e.binary("sound", ea.ALL, "ON", "OFF").withProperty("sound").withDescription("Enable or disable sound"),
            e.numeric("time_ring", ea.ALL).withUnit("sec").withDescription("Time to ring before answer").withValueMin(0).withValueMax(600),
            e.numeric("time_talk", ea.ALL).withUnit("sec").withDescription("Time to hold before open").withValueMin(0).withValueMax(600),
            e.numeric("time_open", ea.ALL).withUnit("sec").withDescription("Time to open before end").withValueMin(0).withValueMax(600),
            e.numeric("time_bell", ea.ALL).withUnit("sec").withDescription("Time after last bell to finish ring").withValueMin(0).withValueMax(600),
            e.numeric("time_report", ea.ALL).withUnit("min").withDescription("Reporting interval").withValueMin(0).withValueMax(1440),
            e.battery(),
        ],
    },
];
//# sourceMappingURL=diyruz.js.map