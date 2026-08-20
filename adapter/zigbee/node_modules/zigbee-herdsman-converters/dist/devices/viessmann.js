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
const logger_1 = require("../lib/logger");
const m = __importStar(require("../lib/modernExtend"));
const reporting = __importStar(require("../lib/reporting"));
const e = exposes.presets;
const ea = exposes.access;
const NS = "zhc:viessmann";
const viessmannExtend = {
    viessmannHvacThermostatCluster: () => m.deviceAddCustomCluster("hvacThermostat", {
        name: "hvacThermostat",
        ID: zigbee_herdsman_1.Zcl.Clusters.hvacThermostat.ID,
        attributes: {
            viessmannWindowOpenInternal: {
                name: "viessmannWindowOpenInternal",
                ID: 0x4000,
                type: zigbee_herdsman_1.Zcl.DataType.ENUM8,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH,
                write: true,
                max: 0xff,
            },
            viessmannWindowOpenForce: {
                name: "viessmannWindowOpenForce",
                ID: 0x4003,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH,
                write: true,
            },
            viessmannAssemblyMode: {
                name: "viessmannAssemblyMode",
                ID: 0x4012,
                type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN,
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH,
                write: true,
            },
        },
        commands: {},
        commandsResponse: {},
    }),
};
const tzLocal = {
    viessmann_window_open: {
        key: ["window_open"],
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["viessmannWindowOpenInternal"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH,
            });
        },
    },
    viessmann_window_open_force: {
        key: ["window_open_force"],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value === "boolean") {
                await entity.write("hvacThermostat", { viessmannWindowOpenForce: value ? 1 : 0 }, { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH });
                return { state: { window_open_force: value } };
            }
            logger_1.logger.error("window_open_force must be a boolean!", NS);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["viessmannWindowOpenForce"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH,
            });
        },
    },
    viessmann_assembly_mode: {
        key: ["assembly_mode"],
        convertGet: async (entity, key, meta) => {
            await entity.read("hvacThermostat", ["viessmannAssemblyMode"], {
                manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH,
            });
        },
    },
};
const fzLocal = {
    viessmann_thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = fz.thermostat.convert(model, msg, publish, options, meta);
            if (result) {
                // ViessMann TRVs report piHeatingDemand from 0-5
                // NOTE: remove the result for now, but leave it configure for reporting
                //       it will show up in the debug log still to help try and figure out
                //       what this value potentially means.
                delete result.pi_heating_demand;
                // viessmannWindowOpenInternal
                // 0-2, 5: unknown
                // 3: window open (OO on display, no heating)
                // 4: window open (OO on display, heating)
                if (msg.data.viessmannWindowOpenInternal !== undefined) {
                    result.window_open = msg.data.viessmannWindowOpenInternal === 3 || msg.data.viessmannWindowOpenInternal === 4;
                }
                // viessmannWindowOpenForce (rw, bool)
                if (msg.data.viessmannWindowOpenForce !== undefined) {
                    result.window_open_force = msg.data.viessmannWindowOpenForce === 1;
                }
                // viessmannAssemblyMode (ro, bool)
                // 0: TRV installed
                // 1: TRV ready to install (-- on display)
                if (msg.data.viessmannAssemblyMode !== undefined) {
                    result.assembly_mode = msg.data.viessmannAssemblyMode === 1;
                }
            }
            return result;
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["7377019"],
        model: "7377019",
        vendor: "Viessmann",
        description: "ViCare CO2, temperature and humidity sensor",
        fromZigbee: [fz.co2, fz.temperature, fz.humidity, fz.battery],
        toZigbee: [],
        exposes: [e.battery(), e.co2(), e.temperature(), e.humidity()],
    },
    {
        zigbeeModel: ["7637435"],
        model: "ZK03839",
        vendor: "Viessmann",
        description: "ViCare climate sensor",
        fromZigbee: [fz.temperature, fz.humidity, fz.battery],
        toZigbee: [],
        exposes: [e.battery(), e.temperature(), e.humidity()],
    },
    {
        zigbeeModel: ["7963223"],
        model: "7963223",
        vendor: "Viessmann",
        description: "ViCare climate sensor",
        fromZigbee: [fz.temperature, fz.humidity, fz.battery],
        toZigbee: [],
        exposes: [e.battery(), e.temperature(), e.humidity()],
    },
    {
        zigbeeModel: ["7637434"],
        model: "ZK03840",
        vendor: "Viessmann",
        description: "ViCare radiator thermostat valve",
        extend: [viessmannExtend.viessmannHvacThermostatCluster()],
        fromZigbee: [fzLocal.viessmann_thermostat, fz.battery, fz.hvac_user_interface],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_control_sequence_of_operation,
            tz.thermostat_system_mode,
            tz.thermostat_keypad_lockout,
            tzLocal.viessmann_window_open,
            tzLocal.viessmann_window_open_force,
            tzLocal.viessmann_assembly_mode,
            tz.thermostat_weekly_schedule,
            tz.thermostat_clear_weekly_schedule,
        ],
        exposes: [
            e
                .climate()
                .withSetpoint("occupied_heating_setpoint", 7, 30, 1)
                .withLocalTemperature()
                .withSystemMode(["heat", "sleep"])
                .withWeeklySchedule(["heat"]),
            e.binary("window_open", ea.STATE_GET, true, false).withDescription("Detected by sudden temperature drop or set manually."),
            e.binary("window_open_force", ea.ALL, true, false).withDescription("Manually set window_open, ~1 minute to take affect."),
            e.keypad_lockout(),
            e.battery(),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);
            const options = { manufacturerCode: zigbee_herdsman_1.Zcl.ManufacturerCode.VIESSMANN_ELEKTRONIK_GMBH };
            await reporting.bind(endpoint, coordinatorEndpoint, ["genBasic", "genPowerCfg", "genIdentify", "genTime", "hvacThermostat"]);
            // standard ZCL attributes
            await reporting.batteryPercentageRemaining(endpoint);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatPIHeatingDemand(endpoint);
            // manufacturer attributes
            await endpoint.configureReporting("hvacThermostat", [{ attribute: "viessmannWindowOpenInternal", minimumReportInterval: 60, maximumReportInterval: 3600, reportableChange: 1 }], options);
            // read window_open_force, we don't need reporting as it cannot be set physically on the device
            await endpoint.read("hvacThermostat", ["viessmannWindowOpenForce"], options);
            // read keypadLockout, we don't need reporting as it cannot be set physically on the device
            await endpoint.read("hvacUserInterfaceCfg", ["keypadLockout"]);
        },
    },
];
//# sourceMappingURL=viessmann.js.map