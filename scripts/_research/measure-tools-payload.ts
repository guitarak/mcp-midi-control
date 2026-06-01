/**
 * Boots the MCP server's tool registry (without MIDI) and measures
 * the ACTUAL serialized tools/list JSON Schema payload that Claude
 * Desktop receives over the wire.
 *
 * Run: npx tsx scripts/_research/measure-tools-payload.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

import { registerMidiControlTools } from '../../packages/server-all/src/server/tools/midi-control.js';

import { registerDevice as registerMcpDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { registerUnifiedTools } from '@mcp-midi-control/core/protocol-generic/tools.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { CORE_TOOLS } from '../../packages/server-all/src/server/toolProfiles.js';

// Register all device descriptors (same order as the real server)
registerMcpDevice(AXEFX3_DESCRIPTOR);
registerMcpDevice(AXEFX2_DESCRIPTOR);
registerMcpDevice(AM4_DESCRIPTOR);
registerMcpDevice(HYDRASYNTH_DESCRIPTOR);

// Create a server and register the core-profile tools
const server = new McpServer({
  name: 'mcp-midi-control',
  version: '0.1.0',
});

registerMidiControlTools(server);
registerUnifiedTools(server);

// Access the internal registered tools via private field (plain object in SDK)
const registeredTools = (server as any)._registeredTools as Record<string, any>;

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const };

// Reproduce the SDK's tools/list serialization
interface WireTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

const wireTools: WireTool[] = [];
for (const [name, tool] of Object.entries(registeredTools)) {
  const obj = normalizeObjectSchema(tool.inputSchema);
  const inputSchema = obj
    ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' })
    : EMPTY_OBJECT_JSON_SCHEMA;
  wireTools.push({
    name,
    description: tool.description,
    inputSchema,
    annotations: tool.annotations,
  });
}

// Filter to core profile
const coreTools = wireTools.filter((t) => CORE_TOOLS.has(t.name));
const corePayload = JSON.stringify({ tools: coreTools });

console.log(`\n=== MCP tools/list WIRE payload size (JSON Schema, as sent to Claude Desktop) ===\n`);
console.log(`  CORE profile tools:      ${coreTools.length}`);
console.log(`  All registered tools:    ${wireTools.length}`);
console.log(`\n--- CORE profile (default) ---\n`);
console.log(`  Compact JSON size:       ${corePayload.length.toLocaleString()} chars`);
console.log(`  Approx tokens (~4 c/t):  ~${Math.round(corePayload.length / 4).toLocaleString()}`);
console.log(`  Approx tokens (~3.5):    ~${Math.round(corePayload.length / 3.5).toLocaleString()}`);

// Break down by tool
console.log(`\n=== Per-tool wire sizes (compact JSON, sorted desc) ===\n`);
const perTool: { name: string; size: number; descLen: number; schemaLen: number }[] = [];
for (const tool of coreTools) {
  const toolJson = JSON.stringify(tool);
  const schemaJson = JSON.stringify(tool.inputSchema);
  perTool.push({
    name: tool.name,
    size: toolJson.length,
    descLen: (tool.description ?? '').length,
    schemaLen: schemaJson.length,
  });
}
perTool.sort((a, b) => b.size - a.size);

let descTotal = 0;
let schemaTotal = 0;
for (const t of perTool) {
  schemaTotal += t.schemaLen;
  descTotal += t.descLen;
  console.log(
    `  ${t.name.padEnd(25)} ${String(t.size).padStart(9)} total ` +
    `(desc: ${String(t.descLen).padStart(5)}, schema: ${String(t.schemaLen).padStart(9)})`,
  );
}

console.log(`\n--- Totals ---`);
console.log(`  Description chars:       ${descTotal.toLocaleString()}`);
console.log(`  Schema JSON chars:       ${schemaTotal.toLocaleString()}`);
console.log(`  Combined (compact):      ${corePayload.length.toLocaleString()}`);
console.log(`\n--- Token estimates (core profile wire payload) ---`);
console.log(`  At ~4 chars/token:       ~${Math.round(corePayload.length / 4).toLocaleString()} tokens`);
console.log(`  At ~3.5 chars/token:     ~${Math.round(corePayload.length / 3.5).toLocaleString()} tokens`);
console.log(`  At ~3 chars/token:       ~${Math.round(corePayload.length / 3).toLocaleString()} tokens`);

// Peek at the biggest schema to understand the shape
const applyPreset = coreTools.find(t => t.name === 'apply_preset');
if (applyPreset) {
  const schemaStr = JSON.stringify(applyPreset.inputSchema);
  const enumCount = (schemaStr.match(/"enum"/g) || []).length;
  const oneOfCount = (schemaStr.match(/"oneOf"/g) || []).length;
  const anyOfCount = (schemaStr.match(/"anyOf"/g) || []).length;
  console.log(`\n--- apply_preset schema shape ---`);
  console.log(`  Schema size:             ${schemaStr.length.toLocaleString()} chars`);
  console.log(`  "enum" arrays:           ${enumCount}`);
  console.log(`  "oneOf" patterns:        ${oneOfCount}`);
  console.log(`  "anyOf" patterns:        ${anyOfCount}`);
}

process.exit(0);
