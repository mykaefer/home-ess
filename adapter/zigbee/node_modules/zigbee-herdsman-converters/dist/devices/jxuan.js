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
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const e = exposes.presets;
const ea = exposes.access;
const jxuanExtend = {
    addJxuanGenOnOffCluster: () => m.deviceAddCustomCluster("genOnOff", {
        name: "genOnOff",
        ID: zigbee_herdsman_1.Zcl.Clusters.genOnOff.ID,
        attributes: {
            powerOutageMemory: { name: "powerOutageMemory", ID: 0x2000, type: zigbee_herdsman_1.Zcl.DataType.UINT8 },
        },
        commands: {},
        commandsResponse: {},
    }),
};
const tzLocal = {
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    SPZ01_power_outage_memory: {
        key: ["power_outage_memory"],
        convertSet: async (entity, key, value, meta) => {
            await entity.write("genOnOff", { 8192: { value: value ? 0x01 : 0x00, type: 0x20 } });
            return { state: { power_outage_memory: value } };
        },
    },
};
const fzLocal = {
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    WSZ01_on_off_action: {
        cluster: 65029,
        type: "attributeReport",
        convert: (model, msg, publish, options, meta) => {
            const clickMapping = { 0: "release", 1: "single", 2: "double", 3: "hold" };
            return { action: `${clickMapping[msg.data["1"]]}` };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["wall pir"],
        model: "PRZ01",
        vendor: "J.XUAN",
        description: "Human body movement sensor",
        fromZigbee: [fz.ias_occupancy_alarm_1_with_timeout, fz.battery],
        toZigbee: [],
        exposes: [e.occupancy(), e.battery_low(), e.battery()],
    },
    {
        zigbeeModel: ["door sensor"],
        model: "DSZ01",
        vendor: "J.XUAN",
        description: "Door or window contact switch",
        fromZigbee: [fz.ias_contact_alarm_1, fz.battery],
        toZigbee: [],
        exposes: [e.contact(), e.battery_low(), e.battery()],
    },
    {
        zigbeeModel: ["JD-SWITCH\u000002"],
        model: "WSZ01",
        vendor: "J.XUAN",
        description: "Wireless switch",
        fromZigbee: [fzLocal.WSZ01_on_off_action, fz.battery],
        toZigbee: [],
        exposes: [e.action(["release", "single", "double", "hold"]), e.battery()],
    },
    {
        zigbeeModel: ["00090bdc"],
        model: "SPZ01",
        vendor: "J.XUAN",
        description: "plug",
        extend: [jxuanExtend.addJxuanGenOnOffCluster()],
        fromZigbee: [fz.on_off, fz.electrical_measurement, fz.metering],
        exposes: [e.switch(), e.power(), e.power_outage_memory().withAccess(ea.STATE_SET)],
        toZigbee: [tz.on_off, tzLocal.SPZ01_power_outage_memory],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff", "haElectricalMeasurement"]);
        },
    },
];
//# sourceMappingURL=jxuan.js.map