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
const utils_1 = require("../lib/utils");
const e = exposes.presets;
const ea = exposes.access;
// Endpoint definitions for all hardware variants
const ALL_INPUT_ENDPOINTS = [
    1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
];
const ALL_OUTPUT_ENDPOINTS = [21, 22, 23, 24, 25, 26, 27, 28, 51, 52, 53, 54, 55, 56, 57, 58];
const fzLocal = {
    cigolInput: {
        cluster: "genMultistateInput",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            const value = msg.data.presentValue;
            const lookup = { 0: "off", 1: "single", 2: "double", 4: "hold" };
            payload[`input_${msg.endpoint.ID}`] = (0, utils_1.getFromLookup)(value, lookup, "off");
            return payload;
        },
    },
    cigolOutputStateReport: {
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (Object.hasOwn(msg.data, "onOff")) {
                return { [`state_${msg.endpoint.ID}`]: msg.data.onOff ? "ON" : "OFF" };
            }
            return {};
        },
    },
    cigolSwitchActionReport: {
        cluster: "genOnOffSwitchCfg",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (!Object.hasOwn(msg.data, "switchActions")) {
                return {};
            }
            const value = msg.data.switchActions;
            const lookup = { 0: "on", 1: "off", 2: "toggle" };
            const action = (0, utils_1.getFromLookup)(value, lookup, "off");
            return { [`switch_action_${msg.endpoint.ID}`]: action };
        },
    },
};
const tzLocal = {
    cigolOutputWrite: {
        key: ["state"],
        convertSet: async (entity, key, value, meta) => {
            const endpoint = (0, utils_1.determineEndpoint)(entity, meta, "genOnOff");
            if (!endpoint) {
                throw new Error("Endpoint not found");
            }
            const state = value.toString().toLowerCase();
            if (state === "on") {
                await endpoint.command("genOnOff", "on", {});
            }
            else if (state === "off") {
                await endpoint.command("genOnOff", "off", {});
            }
            else if (state === "toggle") {
                await endpoint.command("genOnOff", "toggle", {});
            }
            else {
                throw new Error(`Invalid state value: ${value}`);
            }
            return { state: { state: state.toUpperCase() } };
        },
        convertGet: async (entity, key, meta) => {
            const endpoint = (0, utils_1.determineEndpoint)(entity, meta, "genOnOff");
            if (!endpoint) {
                throw new Error("Endpoint not found");
            }
            await endpoint.read("genOnOff", ["onOff"]);
        },
    },
    cigolSwitchAction: {
        key: ["switch_action"],
        convertSet: async (entity, key, value, meta) => {
            const endpoint = (0, utils_1.determineEndpoint)(entity, meta, "genOnOffSwitchCfg");
            if (!endpoint) {
                throw new Error("Endpoint not found");
            }
            if (typeof value !== "string") {
                throw new Error(`Invalid switch action payload: ${JSON.stringify(value)}. Expected a string value: off, on, toggle`);
            }
            const lookup = { on: 0, off: 1, toggle: 2 };
            const switchActionsValue = (0, utils_1.getFromLookup)(value.toLowerCase(), lookup);
            if (switchActionsValue === undefined) {
                throw new Error(`Invalid switch action: ${value}. Valid values: Off, On, Toggle`);
            }
            await endpoint.write("genOnOffSwitchCfg", { switchActions: switchActionsValue });
            await endpoint.read("genOnOffSwitchCfg", ["switchActions"]);
            return {};
        },
        convertGet: async (entity, key, meta) => {
            const endpoint = (0, utils_1.determineEndpoint)(entity, meta, "genOnOffSwitchCfg");
            if (!endpoint) {
                throw new Error("Endpoint not found");
            }
            await endpoint.read("genOnOffSwitchCfg", ["switchActions"]);
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["CIGOL_CONNECT"],
        model: "Cigol Connect",
        vendor: "Cigol Electronics",
        description: "Zigbee interface module for LK IHC installations",
        ota: true,
        fromZigbee: [fzLocal.cigolInput, fzLocal.cigolOutputStateReport, fzLocal.cigolSwitchActionReport],
        toZigbee: [tzLocal.cigolOutputWrite, tzLocal.cigolSwitchAction],
        exposes: (device, options) => {
            if ((0, utils_1.isDummyDevice)(device)) {
                return [e.binary("state", ea.STATE_SET, "ON", "OFF").withDescription("Output state")];
            }
            const hasEndpoint = (ep) => {
                return !!device.getEndpoint(ep);
            };
            const exposesArray = [];
            for (const ep of ALL_INPUT_ENDPOINTS) {
                if (hasEndpoint(ep)) {
                    let label;
                    if (ep < 30)
                        label = `Input A-${ep}`;
                    else
                        label = `Input B-${ep - 30}`;
                    exposesArray.push(e
                        .enum("input", ea.ALL, ["off", "single", "double", "hold"])
                        .withDescription(`${label} (Off, Single, Double, Hold)`)
                        .withLabel(label)
                        .withEndpoint(`${ep}`));
                }
            }
            for (const ep of ALL_OUTPUT_ENDPOINTS) {
                if (hasEndpoint(ep)) {
                    let label;
                    if (ep < 50)
                        label = `Output A-${ep - 20}`;
                    else
                        label = `Output B-${ep - 50}`;
                    exposesArray.push(e.binary("state", ea.ALL, "ON", "OFF").withDescription(`Output ${ep}`).withLabel(label).withEndpoint(`${ep}`));
                }
            }
            for (const ep of ALL_INPUT_ENDPOINTS) {
                if (hasEndpoint(ep)) {
                    let label;
                    if (ep < 30)
                        label = `A-${ep}`;
                    else
                        label = `B-${ep - 30}`;
                    exposesArray.push(e
                        .enum("switch_action", ea.ALL, ["off", "on", "toggle"])
                        .withDescription("Select what activating the input should do: Turn Off, Turn On, or Toggle")
                        .withLabel(`Activation function for input ${label}`)
                        .withEndpoint(`${ep}`));
                }
            }
            return exposesArray;
        },
        meta: {
            multiEndpoint: true,
        },
        endpoint: (device) => {
            const map = {};
            for (const ep of ALL_INPUT_ENDPOINTS) {
                if (device.getEndpoint(ep)) {
                    map[`${ep}`] = ep;
                }
            }
            for (const ep of ALL_OUTPUT_ENDPOINTS) {
                if (device.getEndpoint(ep)) {
                    map[`${ep}`] = ep;
                }
            }
            return map;
        },
        configure: async (device, coordinatorEndpoint) => {
            for (const ep of ALL_INPUT_ENDPOINTS) {
                const endpoint = device.getEndpoint(ep);
                if (endpoint) {
                    try {
                        await endpoint.bind("genMultistateInput", coordinatorEndpoint);
                        await endpoint.configureReporting("genMultistateInput", [
                            {
                                attribute: "presentValue",
                                minimumReportInterval: 0,
                                maximumReportInterval: 0,
                                reportableChange: 1,
                            },
                        ]);
                    }
                    catch (err) {
                        console.warn(`Failed configuring input endpoint ${ep}: ${err}`);
                    }
                    await endpoint.read("genMultistateInput", ["presentValue"]);
                    await endpoint.read("genOnOffSwitchCfg", ["switchActions"]);
                }
            }
            for (const ep of ALL_OUTPUT_ENDPOINTS) {
                const endpoint = device.getEndpoint(ep);
                if (endpoint) {
                    try {
                        await endpoint.bind("genOnOff", coordinatorEndpoint);
                        await endpoint.configureReporting("genOnOff", [
                            {
                                attribute: "onOff",
                                minimumReportInterval: 5,
                                maximumReportInterval: 300,
                                reportableChange: 1,
                            },
                        ]);
                    }
                    catch (err) {
                        console.warn(`Failed configuring output endpoint ${ep}: ${err}`);
                    }
                    await endpoint.read("genOnOff", ["onOff"]);
                }
            }
        },
    },
];
//# sourceMappingURL=cigol.js.map