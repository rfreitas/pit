import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

const tools = [
  createBashTool(cwd),
  createReadTool(cwd),
  createWriteTool(cwd),
  createEditTool(cwd),
  createFindTool(cwd),
  createGrepTool(cwd),
  createLsTool(cwd),
];

for (const tool of tools) {
  console.log("=".repeat(60));
  console.log("name:", tool.name);
  console.log("input schema:", JSON.stringify(tool.parameters, null, 2));
  console.log();
}
