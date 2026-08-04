import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = "/Users/lanxizhang/.openclaw/workspace";
const outputPath = join(repoRoot, "agent-context.local.js");

const sourcePaths = [
  "constitution/USER_PROFILE.md",
  "constitution/COMMUNICATION.md",
  "kb/concepts/learning-and-reading-system.md",
  "kb/concepts/memory-as-identity-design.md",
  "kb/psychology/emotion-regulation-and-behavior-change.md",
  "projects/captured-actions/tasks.md",
];

function readIfExists(relativePath, maxChars = 5200) {
  const filePath = join(workspaceRoot, relativePath);
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8").replace(/\s+/g, " ").trim();
  return {
    path: relativePath,
    text: text.slice(0, maxChars),
  };
}

function readRecentMemory(maxFiles = 5) {
  const memoryDir = join(workspaceRoot, "memory");
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .slice(-maxFiles)
    .map((name) => readIfExists(`memory/${name}`, 3200))
    .filter(Boolean);
}

function inferKeywords(sources) {
  const text = sources.map((source) => source.text).join(" ");
  const candidates = [
    "意义感",
    "控制感",
    "长期主义",
    "创造",
    "效率",
    "共情",
    "影响",
    "学习系统",
    "主动批注",
    "反馈",
    "行动",
    "记忆",
    "身份",
    "审美",
    "AI 协作",
  ];
  return candidates.filter((item) => text.includes(item)).slice(0, 10);
}

const sources = [
  ...sourcePaths.map((path) => readIfExists(path)).filter(Boolean),
  ...readRecentMemory(),
];

const context = {
  generatedAt: new Date().toISOString(),
  source: "local-agent-context",
  keywords: inferKeywords(sources),
  sources,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `window.READING_AGENT_CONTEXT = ${JSON.stringify(context, null, 2)};\n`,
);

console.log(`Wrote ${outputPath}`);
console.log(`Sources: ${sources.map((source) => source.path).join(", ")}`);
