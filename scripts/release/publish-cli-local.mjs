#!/usr/bin/env node
import path from "node:path";
import { planCliUpdate, runCliUpdate } from "../update/cli.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const plan = await planCliUpdate({ sourceRoot, channel: "stable" });
const result = await runCliUpdate({ sourceRoot, plan });
console.log(JSON.stringify(result, null, 2));
