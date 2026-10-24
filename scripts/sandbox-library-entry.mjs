import CryptoJS from "crypto-js";
import * as chai from "chai";
globalThis.CryptoJS = CryptoJS;
globalThis.chai = chai;

import lodash from "lodash";
import moment from "moment";
import "moment/locale/zh-cn.js";
import * as uuid from "uuid";
globalThis._ = lodash;
moment.locale("en");
globalThis.moment = moment;
globalThis.uuid = uuid;

import { xml2Json } from "./sandbox-xml.mjs";
globalThis.xml2Json = xml2Json;

import { renderVisualization } from "./sandbox-visualizer.mjs";
globalThis.__renderVisualization = renderVisualization;
