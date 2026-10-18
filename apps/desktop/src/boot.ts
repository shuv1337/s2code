// Enables the compile cache before the main bundle loads, so the cache also
// covers main.cjs itself.
import { applyProductEnvironment } from "@t3tools/shared/productIdentity";
applyProductEnvironment(process.env);
require("./compileCache.cjs");
require("./main.cjs");
