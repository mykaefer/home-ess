"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.definitions = void 0;
const modernExtend_1 = require("../lib/modernExtend");
exports.definitions = [
    {
        zigbeeModel: ["AGGE Zigbee 2 gang smart push dimmer"],
        model: "2619839",
        vendor: "Handshake Finland",
        description: "2 gang smart push dimmer",
        meta: { multiEndpoint: true },
        extend: [(0, modernExtend_1.deviceEndpoints)({ endpoints: { l1: 1, l2: 2 } }), (0, modernExtend_1.light)({ endpointNames: ["l1", "l2"], configureReporting: true })],
    },
];
//# sourceMappingURL=handshake_finland.js.map