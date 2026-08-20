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
exports.definitions = exports.stelproExtend = exports.fzLocal = exports.tzLocal = void 0;
const zigbee_herdsman_1 = require("zigbee-herdsman");
const fz = __importStar(require("../converters/fromZigbee"));
const tz = __importStar(require("../converters/toZigbee"));
const constants = __importStar(require("../lib/constants"));
const exposes = __importStar(require("../lib/exposes"));
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const utils = __importStar(require("../lib/utils"));
const e = exposes.presets;
const ea = exposes.access;
exports.tzLocal = {
    thermostat_outdoor_temperature: {
        key: ["outdoor_temperature_display"],
        convertSet: async (entity, key, value, meta) => {
            utils.assertNumber(value, key);
            if (value < -32 || value > 119) {
                throw new Error("Outdoor temperature must be between -32 and 119 degrees Celsius");
            }
            await entity.write("hvacThermostat", { stelproOutdoorTemp: value * 100 });
        },
    },
    peak_demand_event_icon: {
        key: ["peak_demand_icon"],
        convertSet: async (entity, key, value, meta) => {
            const hours = Number(value);
            const seconds = hours * 3600;
            if (seconds < 0 || seconds > 65535) {
                throw new Error("Peak demand duration must be between 0 and 18 hours");
            }
            await entity.write("hvacThermostat", { peakDemandIcon: seconds });
            return { state: { [key]: hours } };
        },
    },
};
exports.fzLocal = {
    power: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.power !== undefined) {
                return { power: msg.data.power };
            }
        },
    },
    energy: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.energy !== undefined) {
                return { energy: msg.data.energy / 1000 };
            }
        },
    },
    stelpro_thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = fz.thermostat.convert(model, msg, publish, options, meta);
            if (result && msg.data.stelproSystemMode === 5) {
                // 'Eco' mode is translated into 'auto' here
                result.system_mode = constants.thermostatSystemModes[1];
            }
            if (result && msg.data.pIHeatingDemand !== undefined) {
                result.running_state = msg.data.pIHeatingDemand >= 10 ? "heat" : "idle";
            }
            return result;
        },
    },
};
exports.stelproExtend = {
    addStelproHvacThermostatCluster: () => m.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            stelproOutdoorTemp: { name: "stelproOutdoorTemp", ID: 0x4001, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768, max: 32767 },
            power: { name: "power", ID: 0x4008, type: zigbee_herdsman_1.Zcl.DataType.UINT16 },
            energy: { name: "energy", ID: 0x4009, type: zigbee_herdsman_1.Zcl.DataType.UINT32 },
            stelproSystemMode: { name: "stelproSystemMode", ID: 0x401c, type: zigbee_herdsman_1.Zcl.DataType.ENUM8, write: true, max: 0xff },
            peakDemandIcon: { name: "peakDemandIcon", ID: 0x4105, type: zigbee_herdsman_1.Zcl.DataType.UINT16, write: true },
        },
        commands: {},
        commandsResponse: {},
    }),
};
exports.definitions = [
    {
        zigbeeModel: ["HT402"],
        model: "HT402",
        vendor: "Stelpro",
        description: "Hilo thermostat",
        extend: [exports.stelproExtend.addStelproHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.stelpro_thermostat, fz.hvac_user_interface, exports.fzLocal.power, exports.fzLocal.energy],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupancy,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
            tz.thermostat_system_mode,
            tz.thermostat_running_state,
            exports.tzLocal.peak_demand_event_icon,
            exports.tzLocal.thermostat_outdoor_temperature,
        ],
        exposes: [
            e.keypad_lockout(),
            e.power(),
            e.energy(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["heat"])
                .withRunningState(["idle", "heat"]),
            e
                .numeric("peak_demand_icon", ea.SET)
                .withUnit("hours")
                .withDescription("Set peak demand event icon for the specified number of hours")
                .withValueMin(0)
                .withValueMax(18),
            e
                .numeric("outdoor_temperature_display", ea.SET)
                .withUnit("°C")
                .withDescription("Outdoor temperature displayed on the thermostat")
                .withValueMin(-32)
                .withValueMax(199),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(25);
            const binds = ["genBasic", "genIdentify", "genGroups", "hvacThermostat", "hvacUserInterfaceCfg", "msTemperatureMeasurement"];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatKeypadLockMode(endpoint);
            // Has Unknown power source, force it.
            device.powerSource = "Mains (single phase)";
            device.save();
        },
    },
    {
        zigbeeModel: ["ST218", "SonomaStyle"],
        model: "ST218",
        vendor: "Stelpro",
        description: "Ki convector, line-voltage thermostat",
        extend: [exports.stelproExtend.addStelproHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.stelpro_thermostat, fz.hvac_user_interface],
        whiteLabel: [{ description: "Style Fan Heater", model: "SonomaStyle", fingerprint: [{ modelID: "SonomaStyle" }] }],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupancy,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
            tz.thermostat_system_mode,
            tz.thermostat_running_state,
            exports.tzLocal.thermostat_outdoor_temperature,
        ],
        exposes: [
            e.local_temperature(),
            e.keypad_lockout(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"])
                .withPiHeatingDemand(),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(25);
            const binds = ["genBasic", "genIdentify", "genGroups", "hvacThermostat", "hvacUserInterfaceCfg", "msTemperatureMeasurement"];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            // Those exact parameters (min/max/change) are required for reporting to work with Stelpro Ki
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatKeypadLockMode(endpoint);
            // cluster 0x0201 attribute 0x401c
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "stelproSystemMode",
                    minimumReportInterval: constants.repInterval.MINUTE,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
        },
    },
    {
        zigbeeModel: ["STZB402+", "STZB402"],
        model: "STZB402",
        vendor: "Stelpro",
        description: "Ki, line-voltage thermostat",
        extend: [exports.stelproExtend.addStelproHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.stelpro_thermostat, fz.hvac_user_interface, fz.humidity],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupancy,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
            tz.thermostat_system_mode,
            tz.thermostat_running_state,
            exports.tzLocal.thermostat_outdoor_temperature,
        ],
        exposes: [
            e.local_temperature(),
            e.keypad_lockout(),
            e.humidity(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"]),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(25);
            const binds = ["genBasic", "genIdentify", "genGroups", "hvacThermostat", "hvacUserInterfaceCfg", "msTemperatureMeasurement"];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            // Those exact parameters (min/max/change) are required for reporting to work with Stelpro Ki
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatKeypadLockMode(endpoint);
            // cluster 0x0201 attribute 0x401c
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "stelproSystemMode",
                    minimumReportInterval: constants.repInterval.MINUTE,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
        },
    },
    {
        zigbeeModel: ["MaestroStat"],
        model: "SMT402",
        vendor: "Stelpro",
        description: "Maestro, line-voltage thermostat",
        extend: [exports.stelproExtend.addStelproHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.stelpro_thermostat, fz.hvac_user_interface, fz.humidity],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupancy,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
            tz.thermostat_system_mode,
            tz.thermostat_running_state,
            exports.tzLocal.thermostat_outdoor_temperature,
        ],
        exposes: [
            e.local_temperature(),
            e.keypad_lockout(),
            e.humidity(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"]),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(25);
            const binds = [
                "genBasic",
                "genIdentify",
                "genGroups",
                "hvacThermostat",
                "hvacUserInterfaceCfg",
                "msRelativeHumidity",
                "msTemperatureMeasurement",
            ];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            // Those exact parameters (min/max/change) are required for reporting to work with Stelpro Maestro
            await reporting.thermostatTemperature(endpoint);
            await reporting.humidity(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatKeypadLockMode(endpoint);
            // cluster 0x0201 attribute 0x401c
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "stelproSystemMode",
                    minimumReportInterval: constants.repInterval.MINUTE,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
        },
    },
    {
        zigbeeModel: ["SORB"],
        model: "SORB",
        vendor: "Stelpro",
        description: "ORLÉANS fan heater",
        extend: [exports.stelproExtend.addStelproHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.stelpro_thermostat, fz.hvac_user_interface],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
            tz.thermostat_system_mode,
            tz.thermostat_running_state,
        ],
        exposes: [
            e.local_temperature(),
            e.keypad_lockout(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"]),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(25);
            const binds = ["genBasic", "genIdentify", "genGroups", "hvacThermostat", "hvacUserInterfaceCfg", "msTemperatureMeasurement"];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            // Those exact parameters (min/max/change) are required for reporting to work with Stelpro SORB
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatKeypadLockMode(endpoint);
            // cluster 0x0201 attribute 0x401c
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "stelproSystemMode",
                    minimumReportInterval: constants.repInterval.MINUTE,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
        },
    },
    {
        zigbeeModel: ["SMT402AD"],
        model: "SMT402AD",
        vendor: "Stelpro",
        description: "Maestro, line-voltage thermostat",
        extend: [exports.stelproExtend.addStelproHvacThermostatCluster()],
        fromZigbee: [exports.fzLocal.stelpro_thermostat, fz.hvac_user_interface, fz.humidity],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupancy,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
            tz.thermostat_system_mode,
            tz.thermostat_running_state,
            exports.tzLocal.thermostat_outdoor_temperature,
        ],
        exposes: [
            e.local_temperature(),
            e.keypad_lockout(),
            e.humidity(),
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 5, 30, 0.5)
                .withLocalTemperature()
                .withSystemMode(["off", "auto", "heat"])
                .withRunningState(["idle", "heat"]),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(25);
            const binds = [
                "genBasic",
                "genIdentify",
                "genGroups",
                "hvacThermostat",
                "hvacUserInterfaceCfg",
                "msRelativeHumidity",
                "msTemperatureMeasurement",
            ];
            await reporting.bind(endpoint, coordinatorEndpoint, binds);
            // Those exact parameters (min/max/change) are required for reporting to work with Stelpro Maestro
            await reporting.thermostatTemperature(endpoint);
            await reporting.humidity(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            await reporting.thermostatKeypadLockMode(endpoint);
            // cluster 0x0201 attribute 0x401c
            await endpoint.configureReporting("hvacThermostat", [
                {
                    attribute: "stelproSystemMode",
                    minimumReportInterval: constants.repInterval.MINUTE,
                    maximumReportInterval: constants.repInterval.HOUR,
                    reportableChange: 1,
                },
            ]);
        },
    },
];
//# sourceMappingURL=stelpro.js.map