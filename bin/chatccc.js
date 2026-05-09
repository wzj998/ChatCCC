#!/usr/bin/env node
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("tsx/esm", pathToFileURL("./"));

await import("../src/index.js");