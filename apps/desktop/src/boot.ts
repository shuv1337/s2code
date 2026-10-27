import { applyProductEnvironment } from "@t3tools/shared/productIdentity";
applyProductEnvironment(process.env);
require("./compileCache.cjs");
require("./main.cjs");
