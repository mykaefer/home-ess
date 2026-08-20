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
const legacy = __importStar(require("../lib/legacy"));
const globalStore = __importStar(require("../lib/store"));
const tuya = __importStar(require("../lib/tuya"));
const e = exposes.presets;
const ea = exposes.access;
const fzLocal = {
    javis_lock_report: {
        cluster: "genBasic",
        type: "attributeReport",
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                0: "pairing",
                1: "keypad",
                2: "rfid_card_unlock",
                3: "touch_unlock",
            };
            const utf8FromStr = (s) => {
                const a = [];
                for (let i = 0, enc = encodeURIComponent(s); i < enc.length;) {
                    if (enc[i] === "%") {
                        a.push(Number.parseInt(enc.substr(i + 1, 2), 16));
                        i += 3;
                    }
                    else {
                        a.push(enc.charCodeAt(i++));
                    }
                }
                return a;
            };
            const data = utf8FromStr(msg.data["16896"]);
            clearTimeout(globalStore.getValue(msg.endpoint, "timer"));
            const timer = setTimeout(() => publish({ action: "lock", state: "LOCK" }), 2 * 1000).unref();
            globalStore.putValue(msg.endpoint, "timer", timer);
            return {
                action: "unlock",
                action_user: data[3],
                action_source: data[5],
                action_source_name: lookup[data[5]],
            };
        },
    },
};
exports.definitions = [
    {
        zigbeeModel: ["JAVISLOCK"],
        fingerprint: [
            { modelID: "doorlock_5001", manufacturerName: "Lmiot" },
            { modelID: "E321V000A03", manufacturerName: "Vensi" },
        ],
        model: "JS-SLK2-ZB",
        vendor: "JAVIS",
        description: "Intelligent biometric digital lock",
        fromZigbee: [fzLocal.javis_lock_report, fz.battery],
        toZigbee: [],
        exposes: [e.battery(), e.action(["unlock"])],
    },
    {
        zigbeeModel: ["JAVISSENSOR"],
        fingerprint: tuya.fingerprint("TS0601", ["_TZE200_lgstepha", "_TZE200_kagkgk0i", "_TZE200_i0b1dbqu"]),
        model: "JS-MC-SENSOR-ZB",
        vendor: "JAVIS",
        description: "Microwave sensor",
        fromZigbee: [legacy.fz.javis_microwave_sensor],
        toZigbee: [legacy.tz.javis_microwave_sensor],
        exposes: [
            e.occupancy(),
            e.illuminance(),
            e.binary("led_enable", ea.STATE_SET, true, false).withDescription("Enabled LED"),
            e
                .enum("keep_time", ea.STATE_SET, ["0", "1", "2", "3", "4", "5", "6", "7"])
                .withDescription("PIR keep time 0:5s|1:30s|2:60s|3:180s|4:300s|5:600s|6:1200s|7:1800s"),
            e.enum("sensitivity", ea.STATE_SET, ["25", "50", "75", "100"]),
            e.numeric("illuminance_calibration", ea.STATE_SET).withDescription("Illuminance calibration").withValueMin(-10000).withValueMax(10000),
        ],
    },
];
//# sourceMappingURL=javis.js.map