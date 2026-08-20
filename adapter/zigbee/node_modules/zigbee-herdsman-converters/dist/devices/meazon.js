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
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const meazonExtend = {
    meazonSeMeteringCluster: () => m.deviceAddCustomCluster("seMetering", {
        name: "seMetering",
        ID: zigbee_herdsman_1.Zcl.Clusters.seMetering.ID,
        attributes: {
            atr1: { name: "atr1", ID: 0x1005, type: zigbee_herdsman_1.Zcl.DataType.UINT48 },
            lineFrequency: { name: "lineFrequency", ID: 0x2000, type: zigbee_herdsman_1.Zcl.DataType.INT16 },
            // power:  {name: "power", ID: 0x2001, type: Zcl.DataType.INT16},  // 8193
            // voltage:  {name: "voltage", ID: 0x2004, type: Zcl.DataType.INT16},  // 8196
        },
        commands: {},
        commandsResponse: {},
    }),
};
const fzLocal = {
    meazon_meter: {
        cluster: "seMetering",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            // typo on property name to stick with zcl definition
            if (msg.data.inletTempreature !== undefined) {
                result.inlet_temperature = utils.precisionRound(msg.data.inletTempreature, 2);
                result.inletTemperature = result.inlet_temperature; // deprecated
            }
            if (msg.data.status !== undefined) {
                result.status = utils.precisionRound(msg.data.status, 2);
            }
            if (msg.data.lineFrequency !== undefined) {
                result.line_frequency = utils.precisionRound(msg.data.lineFrequency / 100.0, 2);
                result.linefrequency = result.line_frequency; // deprecated
            }
            if (msg.data["8193"] !== undefined) {
                result.power = utils.precisionRound(msg.data["8193"], 2);
            }
            if (msg.data["8196"] !== undefined) {
                result.voltage = utils.precisionRound(msg.data["8196"], 2);
            }
            if (msg.data["8213"] !== undefined) {
                result.voltage = utils.precisionRound(msg.data["8213"], 2);
            }
            if (msg.data["8199"] !== undefined) {
                result.current = utils.precisionRound(msg.data["8199"], 2);
            }
            if (msg.data["8216"] !== undefined) {
                result.current = utils.precisionRound(msg.data["8216"], 2);
            }
            if (msg.data["8202"] !== undefined) {
                result.reactive_power = utils.precisionRound(msg.data["8202"], 2);
                result.reactivepower = result.reactive_power; // deprecated
            }
            if (msg.data["12288"] !== undefined) {
                result.energy_consumed = utils.precisionRound(msg.data["12288"], 2); // deprecated
                result.energyconsumed = result.energy_consumed; // deprecated
                result.energy = result.energy_consumed;
            }
            if (msg.data["12291"] !== undefined) {
                result.energy_produced = utils.precisionRound(msg.data["12291"], 2);
                result.energyproduced = result.energy_produced; // deprecated
            }
            if (msg.data["12294"] !== undefined) {
                result.reactive_summation = utils.precisionRound(msg.data["12294"], 2);
                result.reactivesummation = result.reactive_summation; // deprecated
            }
            if (msg.data["16408"] !== undefined) {
                result.measure_serial = utils.precisionRound(msg.data["16408"], 2);
                result.measureserial = result.measure_serial; // deprecated
            }
            return result;
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["101.301.001649", "101.301.001838", "101.301.001802", "101.301.001738", "101.301.001412", "101.301.001765", "101.301.001814"],
        model: "MEAZON_BIZY_PLUG",
        vendor: "Meazon",
        description: "Bizy plug meter",
        extend: [meazonExtend.meazonSeMeteringCluster()],
        fromZigbee: [fz.command_on, fz.command_off, fz.on_off, fzLocal.meazon_meter],
        exposes: [e.switch(), e.power(), e.voltage(), e.current(), e.energy()],
        toZigbee: [tz.on_off],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(10);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "seMetering"]);
            await reporting.onOff(endpoint, { min: 1, max: 0xfffe });
            const options = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.MEAZON_S_A, disableDefaultResponse: false };
            await endpoint.write("seMetering", { atr1: 0x063e }, options);
            await endpoint.configureReporting("seMetering", reporting.payload("lineFrequency", 1, constants.repInterval.MINUTES_5, 1), options);
        },
    },
    {
        zigbeeModel: ["102.106.000235", "102.106.001111", "102.106.000348", "102.106.000256", "102.106.001242", "102.106.000540"],
        model: "MEAZON_DINRAIL",
        vendor: "Meazon",
        description: "DinRail 1-phase meter",
        extend: [meazonExtend.meazonSeMeteringCluster()],
        fromZigbee: [fz.command_on, fz.command_off, fz.on_off, fzLocal.meazon_meter],
        exposes: [e.switch(), e.power(), e.voltage(), e.current()],
        toZigbee: [tz.on_off],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(10);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "seMetering"]);
            await reporting.onOff(endpoint);
            const options = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.MEAZON_S_A, disableDefaultResponse: false };
            await endpoint.write("seMetering", { atr1: 0x063e }, options);
            await reporting.onOff(endpoint);
            await endpoint.configureReporting("seMetering", reporting.payload("lineFrequency", 1, constants.repInterval.MINUTES_5, 1), options);
        },
    },
];
//# sourceMappingURL=meazon.js.map