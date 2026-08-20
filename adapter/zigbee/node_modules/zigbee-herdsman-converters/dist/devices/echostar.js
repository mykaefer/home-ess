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
const fz = __importStar(require("../converters/fromZigbee"));
const exposes = __importStar(require("../lib/exposes"));
const globalStore = __importStar(require("../lib/store"));
const e = exposes.presets;
const fzLocal = {
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    SAGE206612_state: {
        cluster: "genOnOff",
        type: ["commandOn", "commandOff"],
        convert: (model, msg, publish, options, meta) => {
            const timeout = 28;
            if (!globalStore.hasValue(msg.endpoint, "action")) {
                globalStore.putValue(msg.endpoint, "action", []);
            }
            const lookup = { commandOn: "bell1", commandOff: "bell2" };
            const timer = setTimeout(() => globalStore.getValue(msg.endpoint, "action").pop(), timeout * 1000).unref();
            const list = globalStore.getValue(msg.endpoint, "action");
            if (list.length === 0 || list.length > 4) {
                list.push(timer);
                return { action: lookup[msg.type] };
            }
            if (timeout > 0) {
                list.push(timer);
            }
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["   Bell"],
        model: "SAGE206612",
        vendor: "EchoStar",
        description: "SAGE by Hughes doorbell sensor",
        fromZigbee: [fzLocal.SAGE206612_state, fz.battery],
        exposes: [e.battery(), e.action(["bell1", "bell2"])],
        toZigbee: [],
        meta: { battery: { voltageToPercentage: { min: 2500, max: 3000 } } },
    },
    {
        zigbeeModel: [" Switch"],
        model: "SAGE206611",
        vendor: "EchoStar",
        description: "SAGE by Hughes single gang light switch",
        fromZigbee: [fz.command_on, fz.command_off],
        exposes: [e.action(["on", "off"])],
        toZigbee: [],
    },
];
//# sourceMappingURL=echostar.js.map