var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../packages/core/dist/types.js
function isTier(value) {
  return TIERS.includes(value);
}
var TIERS;
var init_types = __esm({
  "../../packages/core/dist/types.js"() {
    "use strict";
    TIERS = ["local", "mid", "frontier"];
  }
});

// ../../packages/core/dist/globs.js
function escapeForGlob(text) {
  return text.replace(REGEX_SPECIALS, String.raw`\$&`);
}
function globToRegexSource(glob) {
  let out = "";
  for (const ch of glob) {
    if (ch === "*")
      out += ".*";
    else if (ch === "?")
      out += ".";
    else
      out += escapeForGlob(ch);
  }
  return out;
}
function globToSegmentRegexSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeForGlob(ch);
    }
  }
  return out;
}
function isValidRegex(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
function compilePattern(pattern) {
  const source = isValidRegex(pattern) ? pattern : globToRegexSource(pattern);
  return new RegExp(source);
}
function classifyGlob(path, pattern) {
  return compilePattern(pattern).test(path);
}
var REGEX_SPECIALS;
var init_globs = __esm({
  "../../packages/core/dist/globs.js"() {
    "use strict";
    REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
  }
});

// ../../packages/core/dist/yaml.js
function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === "\\" && quote === '"')
        i += 1;
      else if (ch === quote)
        quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "	")) {
      return raw.slice(0, i);
    }
  }
  return raw;
}
function toLines(text) {
  const lines = [];
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i += 1) {
    const raw = all[i] ?? "";
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === "")
      continue;
    if (withoutComment.trim() === "---") {
      if (lines.length > 0) {
        throw new YamlError("Multiple YAML documents are not supported", i + 1);
      }
      continue;
    }
    if (withoutComment.trim() === "...")
      continue;
    if (/\t/.test(withoutComment.slice(0, withoutComment.length - withoutComment.trimStart().length))) {
      throw new YamlError("Tabs are not allowed for indentation", i + 1);
    }
    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trim(),
      lineNumber: i + 1
    });
  }
  return lines;
}
function findKeySeparator(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"')
        i += 1;
      else if (ch === quote)
        quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#")
      return -1;
    if (ch === "[" || ch === "{")
      return -1;
    if (ch === ":" && (i + 1 === text.length || text[i + 1] === " "))
      return i;
  }
  return -1;
}
function unquote(text) {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      const inner = text.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
    }
  }
  return text;
}
function parseScalar(text) {
  const trimmed = text.trim();
  if (trimmed === "")
    return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return unquote(trimmed);
  }
  if (trimmed === "true" || trimmed === "True")
    return true;
  if (trimmed === "false" || trimmed === "False")
    return false;
  if (trimmed === "null" || trimmed === "~")
    return null;
  if (/^[-+]?\d+$/.test(trimmed))
    return Number.parseInt(trimmed, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "")
      return [];
    return splitInline(inner).map((item) => parseScalar(item));
  }
  if (trimmed.startsWith("|") || trimmed.startsWith(">")) {
    throw new YamlError("Block scalars are not supported");
  }
  if (trimmed.startsWith("&") || trimmed.startsWith("*")) {
    throw new YamlError("Anchors and aliases are not supported");
  }
  return trimmed;
}
function splitInline(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        if (i + 1 < text.length)
          current += text[i + 1];
        i += 1;
      } else if (ch === quote)
        quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{")
      depth += 1;
    if (ch === "]" || ch === "}")
      depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "")
    parts.push(current.trim());
  return parts;
}
function parseYaml(text) {
  const lines = toLines(text);
  if (lines.length === 0)
    return {};
  const parser = new Parser(lines);
  const result = parser.parseNode(lines[0]?.indent ?? 0);
  const leftover = parser.peek();
  if (leftover) {
    throw new YamlError(`Unexpected content "${leftover.text}"`, leftover.lineNumber);
  }
  return result;
}
var YamlError, Parser;
var init_yaml = __esm({
  "../../packages/core/dist/yaml.js"() {
    "use strict";
    YamlError = class extends Error {
      line;
      constructor(message, line) {
        super(message);
        this.line = line;
        this.name = "YamlError";
      }
    };
    Parser = class {
      lines;
      index = 0;
      constructor(lines) {
        this.lines = lines;
      }
      /** Package-visible so the module-level entry point can check for leftovers. */
      peek() {
        return this.lines[this.index];
      }
      parseNode(minIndent) {
        const first = this.peek();
        if (!first || first.indent < minIndent)
          return {};
        if (first.text.startsWith("- ") || first.text === "-") {
          return this.parseSequence(first.indent);
        }
        return this.parseMapping(first.indent);
      }
      parseSequence(indent) {
        const items = [];
        while (true) {
          const line = this.peek();
          if (!line || line.indent !== indent)
            break;
          if (!(line.text.startsWith("- ") || line.text === "-"))
            break;
          this.index += 1;
          const rest = line.text === "-" ? "" : line.text.slice(2).trim();
          if (rest === "") {
            const child = this.peek();
            if (child && child.indent > indent) {
              items.push(this.parseNode(child.indent));
            } else {
              items.push(null);
            }
            continue;
          }
          const separator = findKeySeparator(rest);
          if (separator !== -1) {
            const inline = {};
            const key = unquote(rest.slice(0, separator).trim());
            const value = rest.slice(separator + 1).trim();
            if (value === "") {
              const child = this.peek();
              if (child && child.indent > indent) {
                inline[key] = this.parseNode(child.indent);
              } else {
                inline[key] = null;
              }
            } else {
              inline[key] = parseScalar(value);
            }
            const rest2 = this.parseMappingInto(inline, indent + 2);
            Object.assign(inline, rest2);
            items.push(inline);
            continue;
          }
          items.push(parseScalar(rest));
        }
        return items;
      }
      parseMapping(indent) {
        return this.parseMappingInto({}, indent);
      }
      parseMappingInto(target, indent) {
        while (true) {
          const line = this.peek();
          if (!line || line.indent < indent)
            break;
          if (line.text.startsWith("- ") || line.text === "-")
            break;
          if (line.indent > indent) {
            throw new YamlError(`Unexpected indentation (line ${line.lineNumber})`, line.lineNumber);
          }
          const separator = findKeySeparator(line.text);
          if (separator === -1) {
            throw new YamlError(`Expected "key: value" but found "${line.text}"`, line.lineNumber);
          }
          this.index += 1;
          const key = unquote(line.text.slice(0, separator).trim());
          const value = line.text.slice(separator + 1).trim();
          if (value === "") {
            const child = this.peek();
            if (child && child.indent > indent) {
              target[key] = this.parseNode(child.indent);
            } else if (child && child.indent === indent && child.text.startsWith("- ")) {
              target[key] = this.parseSequence(indent);
            } else {
              target[key] = null;
            }
            continue;
          }
          target[key] = parseScalar(value);
        }
        return target;
      }
    };
  }
});

// ../../packages/core/dist/config.js
function parseConfig(text, format = "yaml") {
  let raw;
  if (format === "json") {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`Invalid JSON: ${error.message}`);
    }
  } else {
    try {
      raw = parseYaml(text);
    } catch (error) {
      if (error instanceof YamlError) {
        throw new ConfigError(`Invalid YAML: ${error.message}`);
      }
      throw error;
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("Config must be a mapping at the top level");
  }
  const config = raw;
  const tiers = {
    local: emptyTier(),
    mid: emptyTier(),
    frontier: emptyTier()
  };
  const rawTiers = config["tiers"] ?? {};
  for (const name of TIER_NAMES) {
    const entry = rawTiers[name];
    if (!entry || typeof entry !== "object")
      continue;
    const tier = entry;
    tiers[name] = {
      name,
      description: str(tier["description"], ""),
      providers: normaliseProviders(tier["providers"]),
      maxRetries: num(tier["max_retries"] ?? tier["maxRetries"], 2),
      costPerToken: num(tier["cost_per_token"] ?? tier["costPerToken"], 0)
    };
  }
  const rawRouter = config["router"] ?? {};
  const rawEscalation = rawRouter["escalation"] ?? {};
  const rawSafety = config["safety"] ?? {};
  const rawLimits = rawSafety["spend_limits"] ?? {};
  const rawProviders = config["providers"] ?? {};
  const rawLearned = config["learned_classifier"] ?? {};
  const rawLogging = config["logging"] ?? {};
  const defaultTier = str(rawRouter["default_tier"] ?? rawRouter["defaultTier"], "mid");
  if (!TIER_NAMES.includes(defaultTier)) {
    throw new ConfigError(`router.default_tier must be one of ${TIER_NAMES.join(", ")}`);
  }
  return {
    tiers,
    router: {
      defaultTier,
      escalation: {
        enabled: bool(rawEscalation["enabled"], true),
        maxAttemptsPerTier: num(rawEscalation["max_attempts_per_tier"] ?? rawEscalation["maxAttemptsPerTier"], 2),
        autoPromoteOnFailure: bool(rawEscalation["auto_promote_on_failure"] ?? rawEscalation["autoPromoteOnFailure"], true),
        maxEscalations: num(rawEscalation["max_escalations"] ?? rawEscalation["maxEscalations"], 2)
      },
      manualOverride: nullableStr(rawRouter["manual_override"] ?? rawRouter["manualOverride"]),
      heuristics: normaliseHeuristics(rawRouter["heuristics"])
    },
    providers: {
      timeoutSeconds: num(rawProviders["timeout_seconds"] ?? rawProviders["timeoutSeconds"], 120),
      maxRetries: num(rawProviders["max_retries"] ?? rawProviders["maxRetries"], 2),
      retryBaseDelay: num(rawProviders["retry_base_delay"] ?? rawProviders["retryBaseDelay"], 1),
      retryMaxDelay: num(rawProviders["retry_max_delay"] ?? rawProviders["retryMaxDelay"], 30)
    },
    learnedClassifier: {
      enabled: bool(rawLearned["enabled"], false),
      modelFile: str(rawLearned["model_file"] ?? rawLearned["modelFile"], "learned_model.json"),
      minSamples: num(rawLearned["min_samples"] ?? rawLearned["minSamples"], 10),
      blend: num(rawLearned["blend"], 0.5),
      ...rawLearned["learning_rate"] !== void 0 ? { learningRate: num(rawLearned["learning_rate"], 0.5) } : {},
      ...rawLearned["epochs"] !== void 0 ? { epochs: num(rawLearned["epochs"], 50) } : {}
    },
    safety: {
      requireApproval: strArray(rawSafety["require_approval"] ?? rawSafety["requireApproval"]),
      spendLimits: {
        perSession: num(rawLimits["per_session"] ?? rawLimits["perSession"], 10),
        perDay: num(rawLimits["per_day"] ?? rawLimits["perDay"], 50),
        perTask: num(rawLimits["per_task"] ?? rawLimits["perTask"], 5)
      },
      sandboxAllowed: strArray(rawSafety["sandbox_allowed"] ?? rawSafety["sandboxAllowed"]),
      blockedCommands: strArray(rawSafety["blocked_commands"] ?? rawSafety["blockedCommands"])
    },
    logging: {
      enabled: bool(rawLogging["enabled"], true),
      level: str(rawLogging["level"], "INFO"),
      file: str(rawLogging["file"], "waypoint.log"),
      logRoutingDecisions: bool(rawLogging["log_routing_decisions"] ?? rawLogging["logRoutingDecisions"], true),
      logEscalations: bool(rawLogging["log_escalations"] ?? rawLogging["logEscalations"], true),
      logCosts: bool(rawLogging["log_costs"] ?? rawLogging["logCosts"], true),
      feedbackFile: str(rawLogging["feedback_file"] ?? rawLogging["feedbackFile"], "feedback.jsonl")
    }
  };
}
function normaliseProviders(value) {
  if (!Array.isArray(value))
    return [];
  const providers = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object")
      continue;
    const record = entry;
    const name = str(record["name"], "");
    if (!name)
      continue;
    const provider = {
      name,
      models: strArray(record["models"])
    };
    const baseUrl = nullableStr(record["base_url"] ?? record["baseUrl"]);
    if (baseUrl)
      provider.baseUrl = baseUrl;
    const apiKeyEnv = nullableStr(record["api_key_env"] ?? record["apiKeyEnv"]);
    if (apiKeyEnv)
      provider.apiKeyEnv = apiKeyEnv;
    providers.push(provider);
  }
  return providers;
}
function normaliseHeuristics(value) {
  if (!value || typeof value !== "object")
    return {};
  const record = value;
  const out = {};
  const simple = record["simple_keywords"] ?? record["simpleKeywords"];
  if (simple)
    out.simpleKeywords = strArray(simple);
  const complex = record["complex_keywords"] ?? record["complexKeywords"];
  if (complex)
    out.complexKeywords = strArray(complex);
  const patterns = record["complex_file_patterns"] ?? record["complexFilePatterns"];
  if (patterns)
    out.complexFilePatterns = strArray(patterns);
  const minFiles = record["min_files_for_complex"] ?? record["minFilesForComplex"];
  if (minFiles !== void 0)
    out.minFilesForComplex = num(minFiles, 3);
  return out;
}
function emptyTier() {
  return { name: "local", description: "", providers: [], maxRetries: 2, costPerToken: 0 };
}
function str(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
function nullableStr(value) {
  if (value === null || value === void 0)
    return null;
  return typeof value === "string" ? value : null;
}
function num(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return fallback;
}
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function strArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((item) => typeof item === "string");
}
var ConfigError, TIER_NAMES;
var init_config = __esm({
  "../../packages/core/dist/config.js"() {
    "use strict";
    init_yaml();
    ConfigError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "ConfigError";
      }
    };
    TIER_NAMES = ["local", "mid", "frontier"];
  }
});

// ../../packages/core/dist/classifier.js
function globToRegex(glob) {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(ESCAPE_PATTERN, String.raw`\$&`);
    }
  }
  return out;
}
function isValidRegex2(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
function compilePatterns(patterns) {
  return patterns.map((pattern) => {
    const source = isValidRegex2(pattern) ? pattern : globToRegex(pattern);
    return new RegExp(source);
  });
}
var DEFAULT_SIMPLE_KEYWORDS, DEFAULT_COMPLEX_KEYWORDS, DEFAULT_COMPLEX_FILE_PATTERNS, ESCAPE_PATTERN, TaskClassifier;
var init_classifier = __esm({
  "../../packages/core/dist/classifier.js"() {
    "use strict";
    DEFAULT_SIMPLE_KEYWORDS = [
      "typo",
      "spelling",
      "whitespace",
      "formatting",
      "lint",
      "rename",
      "comment",
      "readme",
      "documentation",
      "boilerplate",
      "template",
      "simple",
      "small",
      "fix"
    ];
    DEFAULT_COMPLEX_KEYWORDS = [
      "architecture",
      "refactor",
      "optimize",
      "performance",
      "bottleneck",
      "security",
      "concurrency",
      "race condition",
      "deadlock",
      "memory leak",
      "distributed",
      "migration",
      "redesign",
      "scale",
      "debug",
      "investigate",
      "complex"
    ];
    DEFAULT_COMPLEX_FILE_PATTERNS = [
      String.raw`\.rs$`,
      String.raw`\.go$`,
      String.raw`\.cpp$`,
      String.raw`\.c$`,
      String.raw`_test\.`,
      String.raw`tests?/`,
      String.raw`src/core/`,
      String.raw`src/engine/`,
      String.raw`migrations?`,
      "deploy",
      "infra"
    ];
    ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;
    TaskClassifier = class {
      simpleKeywords;
      complexKeywords;
      complexFilePatterns;
      minFilesForComplex;
      constructor(options = {}) {
        this.simpleKeywords = options.simpleKeywords ?? DEFAULT_SIMPLE_KEYWORDS;
        this.complexKeywords = options.complexKeywords ?? DEFAULT_COMPLEX_KEYWORDS;
        this.complexFilePatterns = compilePatterns(options.complexFilePatterns ?? DEFAULT_COMPLEX_FILE_PATTERNS);
        this.minFilesForComplex = options.minFilesForComplex ?? 3;
      }
      classify(context) {
        const scores = { local: 0, mid: 0, frontier: 0 };
        const reasons = [];
        const description = context.description.toLowerCase();
        const simpleMatches = this.simpleKeywords.filter((keyword) => description.includes(keyword.toLowerCase())).length;
        const complexMatches = this.complexKeywords.filter((keyword) => description.includes(keyword.toLowerCase())).length;
        scores.local += simpleMatches * 0.3;
        scores.frontier += complexMatches * 0.3;
        if (simpleMatches > 0) {
          reasons.push(`Found ${simpleMatches} simple-task keywords`);
        }
        if (complexMatches > 0) {
          reasons.push(`Found ${complexMatches} complex-task keywords`);
        }
        const complexFiles = context.filesTouched.filter((file) => this.complexFilePatterns.some((pattern) => pattern.test(file))).length;
        if (complexFiles > 0) {
          scores.frontier += complexFiles * 0.2;
          reasons.push(`${complexFiles} complex file patterns matched`);
        }
        if (context.filesTouched.length >= this.minFilesForComplex) {
          scores.frontier += 0.3;
          reasons.push(`Many files touched (${context.filesTouched.length})`);
        }
        if (context.errorLoops > 0) {
          scores.frontier += context.errorLoops * 0.4;
          reasons.push(`${context.errorLoops} error loops detected`);
        }
        if (context.testFailures > 0) {
          scores.frontier += context.testFailures * 0.3;
          reasons.push(`${context.testFailures} test failures`);
        }
        if (context.previousTier === "local" && (context.previousAttempts ?? 0) >= 2) {
          scores.mid += 0.5;
          reasons.push("Escalating from local after repeated failures");
        } else if (context.previousTier === "mid" && (context.previousAttempts ?? 0) >= 2) {
          scores.frontier += 0.5;
          reasons.push("Escalating from mid after repeated failures");
        }
        const maxScore = Math.max(scores.local, scores.mid, scores.frontier);
        if (maxScore === 0) {
          return {
            tier: "mid",
            confidence: 0.5,
            reasons: ["No strong signals, defaulting to mid tier"],
            scores
          };
        }
        const winner = Object.keys(scores).reduce((best, tier) => scores[tier] > scores[best] ? tier : best);
        const sorted = Object.values(scores).sort((a, b) => b - a);
        const margin = (sorted[0] ?? 0) - (sorted[1] ?? 0);
        const confidence = Math.min(0.5 + margin * 0.3, 1);
        return {
          tier: winner,
          confidence: Math.round(confidence * 100) / 100,
          reasons,
          scores
        };
      }
    };
  }
});

// ../../packages/core/dist/learned-classifier.js
function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}
function featuresFor(text) {
  const tokens = tokenize(text);
  const counts = /* @__PURE__ */ new Map();
  for (const token of tokens) {
    counts.set(`w:${token}`, (counts.get(`w:${token}`) ?? 0) + 1);
  }
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const key = `b:${tokens[i]}_${tokens[i + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function normalize(features) {
  let total = 0;
  for (const value of features.values())
    total += value * value;
  if (total === 0)
    return features;
  const scale = 1 / Math.sqrt(total);
  const out = /* @__PURE__ */ new Map();
  for (const [name, value] of features)
    out.set(name, value * scale);
  return out;
}
function emptyWeights() {
  return {
    weights: { local: /* @__PURE__ */ new Map(), mid: /* @__PURE__ */ new Map(), frontier: /* @__PURE__ */ new Map() },
    bias: { local: 0, mid: 0, frontier: 0 },
    trainedOn: 0,
    accuracy: 0
  };
}
function serializeWeights(weights) {
  const out = {
    local: {},
    mid: {},
    frontier: {}
  };
  for (const tier of TIER_KEYS) {
    for (const [name, weight] of weights.weights[tier]) {
      out[tier][name] = weight;
    }
  }
  return {
    weights: out,
    bias: { ...weights.bias },
    trainedOn: weights.trainedOn,
    accuracy: weights.accuracy
  };
}
function deserializeWeights(data) {
  const weights = emptyWeights();
  for (const tier of TIER_KEYS) {
    for (const [name, weight] of Object.entries(data.weights?.[tier] ?? {})) {
      weights.weights[tier].set(name, weight);
    }
    weights.bias[tier] = data.bias?.[tier] ?? 0;
  }
  weights.trainedOn = data.trainedOn ?? 0;
  weights.accuracy = data.accuracy ?? 0;
  return weights;
}
var TIER_KEYS, LearnedClassifier, HybridClassifier;
var init_learned_classifier = __esm({
  "../../packages/core/dist/learned-classifier.js"() {
    "use strict";
    init_globs();
    TIER_KEYS = ["local", "mid", "frontier"];
    LearnedClassifier = class {
      weights = emptyWeights();
      learningRate;
      epochs;
      l2;
      constructor(options = {}) {
        this.learningRate = options.learningRate ?? 0.5;
        this.epochs = options.epochs ?? 50;
        this.l2 = options.l2 ?? 1e-3;
      }
      get isTrained() {
        return this.weights.trainedOn > 0;
      }
      scores(features) {
        const result = { local: 0, mid: 0, frontier: 0 };
        for (const tier of TIER_KEYS) {
          let score = this.weights.bias[tier];
          const tierWeights = this.weights.weights[tier];
          for (const [name, value] of features) {
            score += (tierWeights.get(name) ?? 0) * value;
          }
          result[tier] = score;
        }
        return result;
      }
      softmax(scores) {
        const max = Math.max(scores.local, scores.mid, scores.frontier);
        const exps = {
          local: Math.exp(scores.local - max),
          mid: Math.exp(scores.mid - max),
          frontier: Math.exp(scores.frontier - max)
        };
        const total = exps.local + exps.mid + exps.frontier;
        if (total === 0)
          return { local: 1 / 3, mid: 1 / 3, frontier: 1 / 3 };
        return {
          local: exps.local / total,
          mid: exps.mid / total,
          frontier: exps.frontier / total
        };
      }
      predictProba(description) {
        if (!this.isTrained) {
          return { local: 1 / 3, mid: 1 / 3, frontier: 1 / 3 };
        }
        return this.softmax(this.scores(normalize(featuresFor(description))));
      }
      predict(description) {
        const probabilities = this.predictProba(description);
        const best = TIER_KEYS.reduce((a, b) => probabilities[a] >= probabilities[b] ? a : b);
        return { tier: best, confidence: probabilities[best] };
      }
      train(samples) {
        if (samples.length === 0)
          return this.weights;
        this.weights = emptyWeights();
        const prepared = samples.map((sample) => ({
          features: normalize(featuresFor(sample.description)),
          trueIndex: TIER_KEYS.indexOf(sample.tier)
        }));
        for (let epoch = 0; epoch < this.epochs; epoch += 1) {
          const order = epoch % 2 === 1 ? [...prepared].reverse() : prepared;
          for (const { features, trueIndex } of order) {
            const probabilities = this.softmax(this.scores(features));
            for (const tier of TIER_KEYS) {
              const target = TIER_KEYS.indexOf(tier) === trueIndex ? 1 : 0;
              const error = target - probabilities[tier];
              this.weights.bias[tier] += this.learningRate * error;
              const tierWeights = this.weights.weights[tier];
              for (const [name, value] of features) {
                tierWeights.set(name, (tierWeights.get(name) ?? 0) + this.learningRate * error * value);
              }
            }
          }
          if (this.l2 > 0) {
            for (const tier of TIER_KEYS) {
              const tierWeights = this.weights.weights[tier];
              for (const [name, weight] of tierWeights) {
                tierWeights.set(name, weight * (1 - this.l2));
              }
            }
          }
        }
        this.weights.trainedOn = samples.length;
        let correct = 0;
        for (const sample of samples) {
          if (this.predict(sample.description).tier === sample.tier)
            correct += 1;
        }
        this.weights.accuracy = correct / samples.length;
        return this.weights;
      }
      /** Strongest positive weights for a tier, for inspecting what was learned. */
      topFeatures(tier, n = 10) {
        const ranked = [...this.weights.weights[tier].entries()].filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
        return ranked.map(([feature, weight]) => ({
          feature,
          weight: Math.round(weight * 1e4) / 1e4
        }));
      }
    };
    HybridClassifier = class {
      learned;
      minSamples;
      blend;
      heuristic;
      constructor(options) {
        this.learned = options.learned ?? new LearnedClassifier();
        this.minSamples = options.minSamples ?? 10;
        this.blend = options.blend ?? 0.5;
        this.heuristic = options.heuristic;
      }
      get learnedReady() {
        return this.learned.weights.trainedOn >= this.minSamples;
      }
      classify(context) {
        const heuristic = this.heuristic.classify(context);
        if (!this.learnedReady) {
          return {
            ...heuristic,
            reasons: [
              ...heuristic.reasons,
              `Learned model not active (${this.learned.weights.trainedOn}/${this.minSamples} samples)`
            ]
          };
        }
        const probabilities = this.learned.predictProba(context.description);
        const best = TIER_KEYS.reduce((a, b) => probabilities[a] >= probabilities[b] ? a : b);
        const learnedConfidence = probabilities[best];
        const agree = best === heuristic.tier;
        let combined = this.blend * learnedConfidence + (1 - this.blend) * heuristic.confidence;
        let tier = heuristic.tier;
        if (!agree) {
          tier = heuristic.tier;
          combined *= 0.75;
        }
        return {
          tier,
          confidence: Math.round(Math.min(combined, 1) * 100) / 100,
          reasons: [
            ...heuristic.reasons,
            `Learned model favoured ${best} (${Math.round(learnedConfidence * 100)}%); ` + (agree ? "agreed with heuristics" : "overridden by heuristics")
          ],
          scores: heuristic.scores
        };
      }
    };
  }
});

// ../../packages/core/dist/router.js
var TIER_ORDER, TierRouter;
var init_router = __esm({
  "../../packages/core/dist/router.js"() {
    "use strict";
    init_classifier();
    init_learned_classifier();
    TIER_ORDER = ["local", "mid", "frontier"];
    TierRouter = class {
      classifier;
      tiers = /* @__PURE__ */ new Map();
      tasks = /* @__PURE__ */ new Map();
      escalationEnabled;
      maxAttemptsPerTier;
      defaultTier;
      manualOverride;
      constructor(config, options = {}) {
        const heuristics = config.router.heuristics ?? {};
        const heuristic = new TaskClassifier({ ...heuristics });
        const learnedConfig = config.learnedClassifier;
        const learned = options.learnedModel && learnedConfig?.enabled ? Object.assign(new LearnedClassifier(), {
          weights: deserializeWeights(options.learnedModel)
        }) : void 0;
        this.classifier = options.classifier ?? (learned && learned.isTrained ? new HybridClassifier({
          learned,
          heuristic,
          minSamples: learnedConfig?.minSamples ?? 10,
          blend: learnedConfig?.blend ?? 0.5
        }) : heuristic);
        this.escalationEnabled = config.router.escalation.enabled;
        this.maxAttemptsPerTier = config.router.escalation.maxAttemptsPerTier;
        this.defaultTier = config.router.defaultTier;
        this.manualOverride = config.router.manualOverride;
        for (const tier of TIER_ORDER) {
          const entry = config.tiers[tier];
          if (entry) {
            this.tiers.set(tier, {
              ...entry,
              providers: entry.providers.map((provider) => ({ ...provider }))
            });
          }
        }
      }
      /**
       * Resolve a manual override to a tier, provider, and model.
       *
       * Accepts a bare model name ("gpt-4o"), a qualified name
       * ("anthropic/claude-sonnet-4"), or an OpenRouter-style id
       * ("openrouter/anthropic/claude-3-haiku"). Returns undefined when the
       * override matches nothing configured.
       */
      resolveOverride(override) {
        const trimmed = override.trim();
        let providerHint;
        let modelName = trimmed;
        if (trimmed.includes("/")) {
          for (const tier of this.tiers.values()) {
            for (const provider of tier.providers) {
              const prefix = `${provider.name}/`;
              if (trimmed.startsWith(prefix)) {
                providerHint = provider.name;
                modelName = trimmed.slice(prefix.length);
                break;
              }
            }
          }
          if (providerHint === void 0) {
            const slash = trimmed.indexOf("/");
            providerHint = trimmed.slice(0, slash);
            modelName = trimmed.slice(slash + 1);
          }
        }
        for (const [tier, tierConfig] of this.tiers) {
          for (const provider of tierConfig.providers) {
            if (providerHint && provider.name !== providerHint)
              continue;
            for (const model of provider.models) {
              if (model === modelName) {
                return { tier, provider, model };
              }
            }
          }
        }
        return void 0;
      }
      route(taskId, context) {
        if (this.manualOverride) {
          const resolved = this.resolveOverride(this.manualOverride);
          if (resolved) {
            return {
              tier: resolved.tier,
              provider: resolved.provider,
              model: resolved.model,
              confidence: 1,
              reasons: [`Manual override: ${this.manualOverride}`],
              escalated: false,
              attempt: 1
            };
          }
        }
        let state2 = this.tasks.get(taskId);
        if (!state2) {
          state2 = { attempts: 0, failures: 0, tier: null };
          this.tasks.set(taskId, state2);
        }
        state2.attempts += 1;
        const classification = this.classifier.classify(context);
        const reasons = [...classification.reasons];
        if (this.manualOverride && !this.resolveOverride(this.manualOverride)) {
          reasons.push(`Manual override '${this.manualOverride}' matched no configured model; falling back to automatic routing`);
        }
        let tier = classification.tier;
        let escalated = false;
        if (this.escalationEnabled && state2.failures >= this.maxAttemptsPerTier) {
          const index = TIER_ORDER.indexOf(tier);
          if (index >= 0 && index < TIER_ORDER.length - 1) {
            const next = TIER_ORDER[index + 1];
            if (next) {
              reasons.push(`Escalating from ${tier} to ${next} after repeated failures`);
              tier = next;
              escalated = true;
              state2.failures = 0;
            }
          }
        }
        let tierConfig = this.tiers.get(tier);
        if (!tierConfig || tierConfig.providers.length === 0) {
          reasons.push(`No config for tier ${tier}, falling back to ${this.defaultTier}`);
          tier = this.defaultTier;
          tierConfig = this.tiers.get(tier);
        }
        if (!tierConfig || tierConfig.providers.length === 0) {
          throw new Error("No usable model tiers configured. Add at least one provider under 'tiers' in your config.");
        }
        const provider = tierConfig.providers[(state2.attempts - 1) % tierConfig.providers.length];
        const model = provider?.models[0] ?? "";
        state2.tier = tier;
        return {
          tier,
          provider,
          model,
          confidence: classification.confidence,
          reasons,
          escalated,
          attempt: state2.attempts
        };
      }
      reportFailure(taskId) {
        const state2 = this.tasks.get(taskId);
        if (state2)
          state2.failures += 1;
      }
      reportSuccess(taskId) {
        const state2 = this.tasks.get(taskId);
        if (state2)
          state2.failures = 0;
      }
      getTaskState(taskId) {
        return this.tasks.get(taskId);
      }
      getConfiguredTiers() {
        return [...this.tiers.keys()];
      }
    };
  }
});

// ../../packages/core/dist/providers.js
function buildMessages(prompt, system) {
  const messages = [];
  if (system)
    messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  return messages;
}
function normaliseToolCalls(value) {
  if (!Array.isArray(value))
    return [];
  const calls = [];
  for (const entry of value) {
    const fn = entry["function"] ?? {};
    const name = String(fn["name"] ?? "");
    if (!name)
      continue;
    let args = {};
    if (typeof fn["arguments"] === "string") {
      try {
        args = JSON.parse(fn["arguments"]);
      } catch {
        args = {};
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}
function describe(error) {
  if (error instanceof Error)
    return error.message;
  return String(error);
}
async function* readLines(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0)
      yield buffer;
  } finally {
    reader.releaseLock();
  }
}
function setFetchImpl(impl) {
  globalFetch = impl;
}
function fetchImpl(url, init) {
  const impl = globalFetch ?? globalThis.fetch;
  if (!impl) {
    throw new ProviderError("No fetch implementation available", {
      retryable: false
    });
  }
  return impl(url, init);
}
var ProviderError, ProviderClient, OllamaClient, OpenAICompatClient, AnthropicClient, REGISTRY, DEFAULT_BASE_URLS, LOCAL_PROVIDERS, ProviderFactory, globalFetch;
var init_providers = __esm({
  "../../packages/core/dist/providers.js"() {
    "use strict";
    ProviderError = class extends Error {
      retryable;
      statusCode;
      provider;
      constructor(message, options = {}) {
        super(message);
        this.name = "ProviderError";
        this.retryable = options.retryable ?? true;
        this.statusCode = options.statusCode;
        this.provider = options.provider ?? "unknown";
      }
    };
    ProviderClient = class {
      baseUrl;
      model;
      apiKey;
      timeoutMs;
      constructor(baseUrl, model, apiKey, timeoutMs) {
        this.baseUrl = baseUrl;
        this.model = model;
        this.apiKey = apiKey;
        this.timeoutMs = timeoutMs;
      }
      async request(path, init = {}) {
        const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
        const headers = {
          "Content-Type": "application/json",
          ...init.headers
        };
        if (this.apiKey) {
          headers["Authorization"] ??= `Bearer ${this.apiKey}`;
        }
        const timeoutSignal = new AbortController();
        const timer = setTimeout(() => timeoutSignal.abort(), this.timeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal.signal]) : timeoutSignal.signal;
        let response;
        try {
          response = await fetchImpl(url, {
            method: init.method ?? "GET",
            headers,
            ...init.body === void 0 ? {} : { body: JSON.stringify(init.body) },
            signal
          });
        } catch (error) {
          clearTimeout(timer);
          if (signal.aborted && !init.signal?.aborted) {
            throw new ProviderError(`Request to ${url} timed out`, {
              retryable: true,
              provider: this.providerName
            });
          }
          throw new ProviderError(`Cannot reach ${url}: ${describe(error)}`, {
            retryable: true,
            provider: this.providerName
          });
        }
        clearTimeout(timer);
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const retryable = response.status === 429 || response.status >= 500;
          throw new ProviderError(`HTTP ${response.status} from ${url}: ${detail.slice(0, 300)}`, { retryable, statusCode: response.status, provider: this.providerName });
        }
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new ProviderError(`Invalid JSON from ${url}`, {
            retryable: false,
            provider: this.providerName
          });
        }
      }
      /**
       * Iterate server-sent events, yielding the decoded JSON payload.
       *
       * Handles both `data: {...}` framing and bare JSON lines. Lives on the base
       * class so every client shares one implementation.
       */
      async *sse(path, body, signal, extraHeaders) {
        const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
        const headers = {
          "Content-Type": "application/json",
          ...extraHeaders
        };
        if (this.apiKey && !extraHeaders?.["x-api-key"]) {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...signal ? { signal } : {}
        });
        if (!response.ok || !response.body) {
          throw new ProviderError(`Stream request failed: HTTP ${response.status}`, {
            retryable: response.status === 429 || response.status >= 500,
            statusCode: response.status,
            provider: this.providerName
          });
        }
        for await (const line of readLines(response.body)) {
          let text = line.trim();
          if (text.startsWith("data:"))
            text = text.slice(5).trim();
          if (text === "")
            continue;
          if (text === "[DONE]")
            return;
          try {
            yield JSON.parse(text);
          } catch {
          }
        }
      }
      async post(path, body, headers, signal) {
        return this.request(path, {
          method: "POST",
          body,
          ...headers ? { headers } : {},
          ...signal ? { signal } : {}
        });
      }
      async get(path, headers, signal) {
        return this.request(path, {
          method: "GET",
          ...headers ? { headers } : {},
          ...signal ? { signal } : {}
        });
      }
    };
    OllamaClient = class extends ProviderClient {
      providerName = "ollama";
      async complete(prompt, options = {}) {
        const payload = {
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: options.temperature ?? 0,
            num_predict: options.maxTokens ?? 2048
          }
        };
        if (options.system)
          payload["system"] = options.system;
        const data = await this.post("/api/generate", payload, void 0, options.signal);
        return {
          content: String(data["response"] ?? ""),
          model: String(data["model"] ?? this.model),
          usage: {
            tokensIn: Number(data["prompt_eval_count"] ?? 0),
            tokensOut: Number(data["eval_count"] ?? 0)
          },
          finishReason: String(data["done_reason"] ?? "stop"),
          toolCalls: []
        };
      }
      async *stream(prompt, options = {}) {
        const payload = {
          model: this.model,
          prompt,
          stream: true,
          options: {
            temperature: options.temperature ?? 0,
            num_predict: options.maxTokens ?? 2048
          }
        };
        if (options.system)
          payload["system"] = options.system;
        for await (const chunk of this.sse("/api/generate", payload, options.signal)) {
          const text = chunk["response"];
          if (typeof text === "string" && text.length > 0)
            yield text;
          if (chunk["done"])
            return;
        }
      }
      async healthCheck(signal) {
        try {
          const data = await this.get("/api/tags", void 0, signal);
          return "models" in data;
        } catch {
          return false;
        }
      }
      async listModels(signal) {
        try {
          const data = await this.get("/api/tags", void 0, signal);
          const models = data["models"];
          if (!Array.isArray(models))
            return [];
          return models.map((m) => String(m["name"] ?? ""));
        } catch {
          return [];
        }
      }
    };
    OpenAICompatClient = class extends ProviderClient {
      providerName = "openai-compatible";
      async complete(prompt, options = {}) {
        const data = await this.post("/v1/chat/completions", {
          model: this.model,
          messages: buildMessages(prompt, options.system),
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? 2048,
          stream: false
        }, void 0, options.signal);
        const choices = data["choices"];
        if (!Array.isArray(choices) || choices.length === 0) {
          throw new ProviderError("No choices in provider response", {
            retryable: false,
            provider: this.providerName
          });
        }
        const first = choices[0];
        const message = first["message"] ?? {};
        const usage = data["usage"] ?? {};
        return {
          content: typeof message["content"] === "string" ? message["content"] : "",
          model: String(data["model"] ?? this.model),
          usage: {
            tokensIn: Number(usage["prompt_tokens"] ?? 0),
            tokensOut: Number(usage["completion_tokens"] ?? 0)
          },
          finishReason: String(first["finish_reason"] ?? "stop"),
          toolCalls: normaliseToolCalls(message["tool_calls"])
        };
      }
      async *stream(prompt, options = {}) {
        const payload = {
          model: this.model,
          messages: buildMessages(prompt, options.system),
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? 2048,
          stream: true
        };
        for await (const chunk of this.sse("/v1/chat/completions", payload, options.signal)) {
          const choices = chunk["choices"];
          if (!Array.isArray(choices) || choices.length === 0)
            continue;
          const first = choices[0];
          const delta = first["delta"] ?? {};
          const token = delta["content"];
          if (typeof token === "string" && token.length > 0)
            yield token;
        }
      }
      async healthCheck(signal) {
        try {
          const data = await this.get("/v1/models", void 0, signal);
          return "data" in data;
        } catch {
          return false;
        }
      }
      async listModels(signal) {
        try {
          const data = await this.get("/v1/models", void 0, signal);
          const models = data["data"];
          if (!Array.isArray(models))
            return [];
          return models.map((m) => String(m["id"] ?? ""));
        } catch {
          return [];
        }
      }
    };
    AnthropicClient = class extends ProviderClient {
      providerName = "anthropic";
      authHeaders() {
        return {
          "x-api-key": this.apiKey ?? "",
          "anthropic-version": "2023-06-01"
        };
      }
      async complete(prompt, options = {}) {
        const payload = {
          model: this.model,
          max_tokens: options.maxTokens ?? 2048,
          temperature: options.temperature ?? 0,
          messages: [{ role: "user", content: prompt }]
        };
        if (options.system)
          payload["system"] = options.system;
        const data = await this.post("/v1/messages", payload, this.authHeaders(), options.signal);
        const blocks = data["content"];
        let content = "";
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block["type"] === "text" && typeof block["text"] === "string") {
              content += block["text"];
            }
          }
        }
        const usage = data["usage"] ?? {};
        return {
          content,
          model: String(data["model"] ?? this.model),
          usage: {
            tokensIn: Number(usage["input_tokens"] ?? 0),
            tokensOut: Number(usage["output_tokens"] ?? 0)
          },
          finishReason: String(data["stop_reason"] ?? "stop"),
          toolCalls: []
        };
      }
      async *stream(prompt, options = {}) {
        const payload = {
          model: this.model,
          max_tokens: options.maxTokens ?? 2048,
          temperature: options.temperature ?? 0,
          messages: [{ role: "user", content: prompt }],
          stream: true
        };
        if (options.system)
          payload["system"] = options.system;
        for await (const event of this.sse("/v1/messages", payload, options.signal, this.authHeaders())) {
          if (event["type"] === "content_block_delta") {
            const delta = event["delta"] ?? {};
            const token = delta["text"];
            if (typeof token === "string" && token.length > 0)
              yield token;
          }
        }
      }
      async healthCheck(signal) {
        try {
          await this.complete("ping", { maxTokens: 1, ...signal ? { signal } : {} });
          return true;
        } catch {
          return false;
        }
      }
      async listModels() {
        return [this.model];
      }
    };
    REGISTRY = {
      ollama: OllamaClient,
      anthropic: AnthropicClient
    };
    DEFAULT_BASE_URLS = {
      ollama: "http://localhost:11434",
      lm_studio: "http://localhost:1234",
      llama_cpp: "http://localhost:8080",
      llamacpp: "http://localhost:8080",
      vllm: "http://localhost:8000",
      openai: "https://api.openai.com",
      openrouter: "https://openrouter.ai/api",
      together: "https://api.together.xyz",
      groq: "https://api.groq.com/openai",
      anthropic: "https://api.anthropic.com",
      claude: "https://api.anthropic.com"
    };
    LOCAL_PROVIDERS = /* @__PURE__ */ new Set([
      "ollama",
      "lm_studio",
      "llama_cpp",
      "llamacpp",
      "vllm"
    ]);
    ProviderFactory = class {
      env;
      timeoutMs;
      constructor(options = {}) {
        this.env = options.env ?? {};
        this.timeoutMs = options.timeoutMs ?? 12e4;
        if (options.fetchImpl)
          setFetchImpl(options.fetchImpl);
      }
      create(provider, model) {
        const name = provider.name.toLowerCase().trim();
        const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[name];
        if (!baseUrl) {
          throw new ProviderError(`No baseUrl configured for provider '${provider.name}'. Set tiers.<tier>.providers[].baseUrl in your config.`, { retryable: false, provider: name });
        }
        let apiKey;
        if (provider.apiKeyEnv)
          apiKey = this.env[provider.apiKeyEnv];
        if (!apiKey) {
          for (const candidate of [
            `${name.toUpperCase().replace(/-/g, "_")}_API_KEY`,
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY"
          ]) {
            const found = this.env[candidate];
            if (found) {
              apiKey = found;
              break;
            }
          }
        }
        if (LOCAL_PROVIDERS.has(name))
          apiKey = void 0;
        const target = model ?? provider.models[0] ?? "";
        const ClientClass = REGISTRY[name] ?? OpenAICompatClient;
        return new ClientClass(baseUrl, target, apiKey, this.timeoutMs);
      }
    };
  }
});

// ../../packages/core/dist/retry.js
function calculateDelay(attempt, config) {
  const random = config.random ?? Math.random;
  switch (config.strategy) {
    case "fixed":
      return config.baseDelayMs;
    case "exponential": {
      const delay = config.baseDelayMs * 2 ** attempt;
      return Math.min(delay, config.maxDelayMs);
    }
    case "exponential_with_jitter": {
      const exponential = config.baseDelayMs * 2 ** attempt;
      const capped = Math.min(exponential, config.maxDelayMs);
      return random() * capped;
    }
    default:
      return config.baseDelayMs;
  }
}
async function withRetry(operation, config) {
  const sleep = config.sleep ?? defaultSleep;
  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error))
        throw error;
      if (attempt >= config.maxRetries)
        break;
      const delay = calculateDelay(attempt, config);
      config.onRetry?.(attempt + 1, delay, error);
      if (delay > 0)
        await sleep(delay);
    }
  }
  throw new RetryExhaustedError(`Operation failed after ${config.maxRetries + 1} attempts`, lastError, config.maxRetries + 1);
}
function isRetryable(error) {
  if (error instanceof ProviderError)
    return error.retryable;
  return false;
}
var defaultSleep, RetryExhaustedError, CircuitBreaker;
var init_retry = __esm({
  "../../packages/core/dist/retry.js"() {
    "use strict";
    init_providers();
    defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    RetryExhaustedError = class extends Error {
      lastError;
      attempts;
      constructor(message, lastError, attempts) {
        super(message);
        this.lastError = lastError;
        this.attempts = attempts;
        this.name = "RetryExhaustedError";
      }
    };
    CircuitBreaker = class {
      failureThreshold;
      recoveryMs;
      now;
      state = "closed";
      failureCount = 0;
      lastFailureAt = 0;
      constructor(failureThreshold = 5, recoveryMs = 3e4, now = Date.now) {
        this.failureThreshold = failureThreshold;
        this.recoveryMs = recoveryMs;
        this.now = now;
      }
      canExecute() {
        if (this.state === "closed")
          return true;
        if (this.state === "open") {
          if (this.now() - this.lastFailureAt > this.recoveryMs) {
            this.state = "half_open";
            return true;
          }
          return false;
        }
        return true;
      }
      recordSuccess() {
        this.failureCount = 0;
        if (this.state === "half_open")
          this.state = "closed";
      }
      recordFailure() {
        this.failureCount += 1;
        this.lastFailureAt = this.now();
        if (this.failureCount >= this.failureThreshold)
          this.state = "open";
      }
      async run(operation) {
        if (!this.canExecute()) {
          throw new Error("Circuit breaker is open");
        }
        try {
          const result = await operation();
          this.recordSuccess();
          return result;
        } catch (error) {
          this.recordFailure();
          throw error;
        }
      }
    };
  }
});

// ../../packages/core/dist/orchestrator.js
function describeError(error) {
  if (error instanceof ProviderError)
    return error.message;
  if (error instanceof RetryExhaustedError) {
    return `${error.message}: ${describeError(error.lastError)}`;
  }
  if (error instanceof Error)
    return error.message;
  return String(error);
}
function round2(value) {
  return Math.round(value * 1e4) / 1e4;
}
var BudgetExceededError, SpendTracker, CostTracker, Orchestrator;
var init_orchestrator = __esm({
  "../../packages/core/dist/orchestrator.js"() {
    "use strict";
    init_providers();
    init_retry();
    init_router();
    BudgetExceededError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "BudgetExceeded";
      }
    };
    SpendTracker = class {
      limits;
      now;
      sessionSpend = 0;
      daySpend = 0;
      taskSpend = 0;
      currentTaskId = null;
      dayEntries = [];
      constructor(limits, now = Date.now) {
        this.limits = limits;
        this.now = now;
      }
      startTask(taskId) {
        if (this.currentTaskId !== taskId) {
          this.taskSpend = 0;
          this.currentTaskId = taskId;
        }
      }
      /** Drop day-bucket entries older than 24h and fold them into daySpend. */
      pruneDay() {
        const cutoff = this.now() - 864e5;
        while (this.dayEntries.length > 0 && (this.dayEntries[0]?.at ?? 0) < cutoff) {
          this.dayEntries.shift();
        }
        this.daySpend = this.dayEntries.reduce((sum, entry) => sum + entry.amount, 0);
      }
      canSpend(amount, taskId) {
        if (taskId !== void 0)
          this.startTask(taskId);
        this.pruneDay();
        return this.sessionSpend + amount <= this.limits.perSession && this.daySpend + amount <= this.limits.perDay && this.taskSpend + amount <= this.limits.perTask;
      }
      recordSpend(amount, taskId) {
        if (taskId !== void 0)
          this.startTask(taskId);
        this.sessionSpend += amount;
        this.taskSpend += amount;
        this.dayEntries.push({ at: this.now(), amount });
        this.daySpend += amount;
      }
      resetSession() {
        this.sessionSpend = 0;
        this.daySpend = 0;
        this.taskSpend = 0;
        this.dayEntries.length = 0;
        this.currentTaskId = null;
      }
      getStatus() {
        this.pruneDay();
        return {
          sessionSpend: round2(this.sessionSpend),
          daySpend: round2(this.daySpend),
          taskSpend: round2(this.taskSpend),
          sessionRemaining: round2(this.limits.perSession - this.sessionSpend),
          dayRemaining: round2(this.limits.perDay - this.daySpend),
          taskRemaining: round2(this.limits.perTask - this.taskSpend)
        };
      }
    };
    CostTracker = class {
      calls = 0;
      tokensIn = 0;
      tokensOut = 0;
      tierCost = /* @__PURE__ */ new Map();
      modelCost = /* @__PURE__ */ new Map();
      recordUsage(tier, model, tokensIn, tokensOut) {
        const rate = this.rates.get(tier) ?? 0;
        const cost = (tokensIn + tokensOut) * rate;
        this.calls += 1;
        this.tokensIn += tokensIn;
        this.tokensOut += tokensOut;
        this.tierCost.set(tier, (this.tierCost.get(tier) ?? 0) + cost);
        this.modelCost.set(model, (this.modelCost.get(model) ?? 0) + cost);
        return cost;
      }
      rates = /* @__PURE__ */ new Map();
      setCostPerToken(tier, rate) {
        this.rates.set(tier, rate);
      }
      /** USD per token for a tier, or 0 when the tier is unknown or free. */
      getCostPerToken(tier) {
        return this.rates.get(tier) ?? 0;
      }
      /** Always returns the same keys so callers need no special case. */
      getStats() {
        const costByTier = {};
        for (const [tier, cost] of this.tierCost)
          costByTier[tier] = round2(cost);
        const costByModel = {};
        for (const [model, cost] of this.modelCost)
          costByModel[model] = round2(cost);
        return {
          totalCalls: this.calls,
          totalTokensIn: this.tokensIn,
          totalTokensOut: this.tokensOut,
          totalCostUsd: round2([...this.tierCost.values()].reduce((sum, cost) => sum + cost, 0)),
          costByTier,
          costByModel
        };
      }
      reset() {
        this.calls = 0;
        this.tokensIn = 0;
        this.tokensOut = 0;
        this.tierCost.clear();
        this.modelCost.clear();
      }
    };
    Orchestrator = class {
      router;
      spend;
      cost = new CostTracker();
      providers;
      maxEscalations;
      retryConfig;
      createClient;
      constructor(config, options = {}) {
        this.router = new TierRouter(config);
        this.spend = new SpendTracker(config.safety.spendLimits, options.now);
        this.providers = new ProviderFactory({
          env: options.env ?? {},
          timeoutMs: config.providers.timeoutSeconds * 1e3,
          ...options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
        });
        this.maxEscalations = config.router.escalation.maxEscalations ?? 2;
        this.retryConfig = {
          maxRetries: config.providers.maxRetries,
          baseDelayMs: config.providers.retryBaseDelay * 1e3,
          maxDelayMs: config.providers.retryMaxDelay * 1e3,
          strategy: "exponential_with_jitter",
          ...options.sleep ? { sleep: options.sleep } : {},
          ...options.random ? { random: options.random } : {}
        };
        for (const [tier, tierConfig] of Object.entries(config.tiers)) {
          this.cost.setCostPerToken(tier, tierConfig.costPerToken);
        }
        this.createClient = options.createClient ?? ((provider, model) => this.providers.create(provider, model));
      }
      /**
       * Route and run a task, retrying and escalating as needed.
       */
      async execute(taskId, prompt, options = {}) {
        const startedAt = Date.now();
        const history = [];
        let totalCost = 0;
        let totalIn = 0;
        let totalOut = 0;
        let errorLoops = options.errorLoops ?? 0;
        let escalatedAny = false;
        for (let attempt = 0; attempt <= this.maxEscalations; attempt += 1) {
          const context = {
            description: prompt,
            filesTouched: options.filesTouched ?? [],
            errorLoops,
            testFailures: options.testFailures ?? 0
          };
          const decision = this.router.route(taskId, context);
          if (decision.escalated)
            escalatedAny = true;
          const maxTokens = options.maxTokens ?? 2048;
          const unitCost = this.rateFor(decision.tier);
          const estimated = unitCost * maxTokens;
          if (!this.spend.canSpend(estimated, taskId)) {
            return {
              taskId,
              success: false,
              content: "",
              tier: decision.tier,
              provider: decision.provider.name,
              model: decision.model,
              attempts: attempt + 1,
              escalated: escalatedAny,
              costUsd: round2(totalCost),
              tokensIn: totalIn,
              tokensOut: totalOut,
              durationMs: Date.now() - startedAt,
              confidence: decision.confidence,
              reasons: decision.reasons,
              error: `Budget exceeded: $${estimated.toFixed(4)} would exceed the limit`,
              history
            };
          }
          try {
            const completion = await this.callWithRetry(decision, prompt, options);
            const cost = unitCost * (completion.usage.tokensIn + completion.usage.tokensOut);
            totalCost += cost;
            totalIn += completion.usage.tokensIn;
            totalOut += completion.usage.tokensOut;
            this.cost.recordUsage(decision.tier, decision.model, completion.usage.tokensIn, completion.usage.tokensOut);
            this.spend.recordSpend(cost, taskId);
            this.router.reportSuccess(taskId);
            history.push({
              attempt: attempt + 1,
              tier: decision.tier,
              model: decision.model,
              success: true,
              costUsd: round2(cost)
            });
            return {
              taskId,
              success: true,
              content: completion.content,
              tier: decision.tier,
              provider: decision.provider.name,
              model: decision.model,
              attempts: attempt + 1,
              escalated: escalatedAny,
              costUsd: round2(totalCost),
              tokensIn: totalIn,
              tokensOut: totalOut,
              durationMs: Date.now() - startedAt,
              confidence: decision.confidence,
              reasons: decision.reasons,
              history
            };
          } catch (error) {
            if (options.signal?.aborted) {
              history.push({
                attempt: attempt + 1,
                tier: decision.tier,
                model: decision.model,
                success: false,
                error: "cancelled"
              });
              return {
                taskId,
                success: false,
                content: "",
                tier: decision.tier,
                provider: decision.provider.name,
                model: decision.model,
                attempts: attempt + 1,
                escalated: escalatedAny,
                costUsd: round2(totalCost),
                tokensIn: totalIn,
                tokensOut: totalOut,
                durationMs: Date.now() - startedAt,
                confidence: decision.confidence,
                reasons: decision.reasons,
                error: "cancelled",
                history
              };
            }
            const message = describeError(error);
            this.router.reportFailure(taskId);
            history.push({
              attempt: attempt + 1,
              tier: decision.tier,
              model: decision.model,
              success: false,
              error: message
            });
            errorLoops += 1;
          }
        }
        return {
          taskId,
          success: false,
          content: "",
          attempts: this.maxEscalations + 1,
          escalated: escalatedAny,
          costUsd: round2(totalCost),
          tokensIn: totalIn,
          tokensOut: totalOut,
          durationMs: Date.now() - startedAt,
          confidence: 0,
          reasons: [],
          error: "All attempts failed",
          history
        };
      }
      /**
       * Route a task and stream the response.
       *
       * Streaming responses are not budget-gated, since usage is unknown until
       * the stream completes; the caller sees the tokens either way.
       */
      async *executeStream(taskId, prompt, options = {}) {
        const context = {
          description: prompt,
          filesTouched: options.filesTouched ?? [],
          errorLoops: options.errorLoops ?? 0,
          testFailures: options.testFailures ?? 0
        };
        const decision = this.router.route(taskId, context);
        const client = this.createClient(decision.provider, decision.model);
        const completeOptions = {
          temperature: options.temperature ?? 0,
          maxTokens: options.maxTokens ?? 2048
        };
        if (options.system)
          completeOptions["system"] = options.system;
        if (options.signal)
          completeOptions["signal"] = options.signal;
        for await (const token of client.stream(prompt, completeOptions)) {
          yield token;
        }
      }
      rateFor(tier) {
        return this.cost.getCostPerToken(tier);
      }
      async callWithRetry(decision, prompt, options) {
        const client = this.createClient(decision.provider, decision.model);
        const completeOptions = {
          temperature: options.temperature ?? 0,
          maxTokens: options.maxTokens ?? 2048
        };
        if (options.system)
          completeOptions["system"] = options.system;
        if (options.signal)
          completeOptions["signal"] = options.signal;
        return withRetry(() => client.complete(prompt, completeOptions), this.retryConfig);
      }
    };
  }
});

// ../../packages/core/dist/safety.js
var SafetyManager;
var init_safety = __esm({
  "../../packages/core/dist/safety.js"() {
    "use strict";
    SafetyManager = class _SafetyManager {
      requireApproval;
      sandboxAllowed;
      blockedCommands;
      pending = [];
      constructor(config) {
        this.requireApproval = new Set(config.requireApproval);
        this.sandboxAllowed = config.sandboxAllowed;
        this.blockedCommands = config.blockedCommands;
      }
      /**
       * Classify a command into an operation type.
       *
       * Matching is done on the full command line, so callers must pass the
       * string that will actually execute. Passing a bare subcommand such as
       * "push" instead of "git push" classifies as an ordinary shell command
       * and bypasses the push gate; that was a real bug.
       */
      static classifyOperation(command) {
        const normalized = command.toLowerCase();
        if (normalized.includes("git push --delete") || normalized.includes("git push --mirror")) {
          return "delete_branch";
        }
        if (normalized.includes("git branch -d") || normalized.includes("git branch -D")) {
          return "delete_branch";
        }
        if (normalized.includes("git push")) {
          return normalized.includes("--force") || /\s-f(\s|$)/.test(normalized) ? "git_force_push" : "git_push";
        }
        if (normalized.includes("git merge") || normalized.includes("gh pr merge")) {
          return "merge_pr";
        }
        if (normalized.includes("docker push"))
          return "docker_push";
        if (normalized.includes("fly deploy") || normalized.includes("flyctl deploy")) {
          return "deploy_production";
        }
        if (normalized.includes("vercel") && normalized.includes("--prod")) {
          return "deploy_production";
        }
        if (normalized.includes("wrangler deploy"))
          return "deploy_production";
        if (normalized.includes("npm publish") || normalized.includes("twine upload")) {
          return "deploy_production";
        }
        if (normalized.includes("rm -rf") || normalized.includes("del /")) {
          return "destructive";
        }
        return "shell";
      }
      check(command) {
        for (const blocked of this.blockedCommands) {
          if (command.includes(blocked)) {
            return {
              operation: "blocked",
              command,
              reason: `Command contains blocked pattern: ${blocked}`,
              status: "denied"
            };
          }
        }
        for (const allowed of this.sandboxAllowed) {
          if (command.trimStart().startsWith(allowed)) {
            return {
              operation: "sandbox",
              command,
              reason: "Command is in the sandbox allowlist",
              status: "auto_approved"
            };
          }
        }
        const operation = _SafetyManager.classifyOperation(command);
        if (this.requireApproval.has(operation)) {
          const request = {
            operation,
            command,
            reason: `Operation '${operation}' requires approval`,
            status: "pending"
          };
          this.pending.push(request);
          return request;
        }
        return {
          operation,
          command,
          reason: "No approval required",
          status: "auto_approved"
        };
      }
      approve(request) {
        request.status = "approved";
      }
      deny(request) {
        request.status = "denied";
      }
      getPendingApprovals() {
        return this.pending.filter((request) => request.status === "pending");
      }
      approveCommand(command) {
        const match = this.getPendingApprovals().find((r) => r.command === command);
        if (!match)
          return false;
        this.approve(match);
        return true;
      }
    };
  }
});

// ../../packages/core/dist/health.js
var HealthChecker;
var init_health = __esm({
  "../../packages/core/dist/health.js"() {
    "use strict";
    init_providers();
    HealthChecker = class {
      config;
      router;
      options;
      results = /* @__PURE__ */ new Map();
      failures = /* @__PURE__ */ new Map();
      failureThreshold;
      latencyThresholdMs;
      timeoutMs;
      now;
      constructor(config, router, options = {}) {
        this.config = config;
        this.router = router;
        this.options = options;
        this.failureThreshold = options.failureThreshold ?? 3;
        this.latencyThresholdMs = options.latencyThresholdMs ?? 5e3;
        this.timeoutMs = options.timeoutMs ?? 1e4;
        this.now = options.now ?? Date.now;
      }
      /** Every model referenced by the config, deduplicated. */
      models() {
        const seen = /* @__PURE__ */ new Map();
        for (const tier of Object.values(this.config.tiers)) {
          for (const provider of tier.providers) {
            for (const model of provider.models) {
              const key = `${provider.name}/${model}`;
              if (!seen.has(key))
                seen.set(key, { provider: provider.name, model });
            }
          }
        }
        return [...seen.values()];
      }
      async checkAll(signal) {
        return Promise.all(this.models().map((m) => this.check(m.provider, m.model, signal)));
      }
      async check(providerName, model, signal) {
        const key = `${providerName}/${model}`;
        const started = this.now();
        const client = this.clientFor(providerName, model);
        if (!client) {
          const result = {
            model,
            provider: providerName,
            status: "unknown",
            latencyMs: 0,
            message: "No provider configuration found"
          };
          this.results.set(key, result);
          return result;
        }
        try {
          const controller2 = new AbortController();
          const timer = setTimeout(() => controller2.abort(), this.timeoutMs);
          const combined = signal ? AbortSignal.any([signal, controller2.signal]) : controller2.signal;
          let reachable;
          try {
            reachable = await client.healthCheck(combined);
          } finally {
            clearTimeout(timer);
          }
          const latencyMs = this.now() - started;
          let status;
          let message;
          if (reachable) {
            this.failures.set(key, 0);
            status = "healthy";
            message = "Endpoint reachable";
          } else {
            const count = (this.failures.get(key) ?? 0) + 1;
            this.failures.set(key, count);
            status = count < this.failureThreshold ? "degraded" : "unhealthy";
            message = `Endpoint unreachable (${count} consecutive failures)`;
          }
          if (status === "healthy" && latencyMs > this.latencyThresholdMs) {
            status = "degraded";
            message = `High latency: ${Math.round(latencyMs)}ms`;
          }
          const result = { model, provider: providerName, status, latencyMs, message };
          this.results.set(key, result);
          return result;
        } catch (error) {
          const count = (this.failures.get(key) ?? 0) + 1;
          this.failures.set(key, count);
          const result = {
            model,
            provider: providerName,
            status: count < this.failureThreshold ? "degraded" : "unhealthy",
            latencyMs: this.now() - started,
            message: error instanceof Error ? error.message : String(error)
          };
          this.results.set(key, result);
          return result;
        }
      }
      clientFor(providerName, model) {
        if (this.options.createClient) {
          return this.options.createClient(providerName, model);
        }
        for (const tier of Object.values(this.config.tiers)) {
          for (const provider of tier.providers) {
            if (provider.name === providerName && provider.models.includes(model)) {
              return new ProviderFactory({ timeoutMs: this.timeoutMs }).create(provider, model);
            }
          }
        }
        return void 0;
      }
      getResults() {
        return [...this.results.values()];
      }
      healthy() {
        return this.getResults().filter((r) => r.status === "healthy").map((r) => `${r.provider}/${r.model}`);
      }
      unhealthy() {
        return this.getResults().filter((r) => r.status === "unhealthy" || r.status === "degraded").map((r) => `${r.provider}/${r.model}`);
      }
    };
  }
});

// ../../packages/core/dist/defaults.js
function defaultConfig(env = {}) {
  const hasAnthropic = Boolean(env["ANTHROPIC_API_KEY"]);
  const hasOpenRouter = Boolean(env["OPENROUTER_API_KEY"]);
  return {
    tiers: {
      local: {
        name: "local",
        description: "Local models for simple tasks",
        providers: [
          {
            name: "ollama",
            baseUrl: "http://localhost:11434",
            models: ["qwen2.5-coder", "llama3.2", "deepseek-coder-v2"]
          }
        ],
        maxRetries: 2,
        costPerToken: 0
      },
      mid: {
        name: "mid",
        description: "Mid-tier models for medium complexity",
        providers: hasOpenRouter ? [
          {
            name: "openrouter",
            apiKeyEnv: "OPENROUTER_API_KEY",
            models: ["anthropic/claude-3-haiku", "google/gemini-flash"]
          }
        ] : [],
        maxRetries: 2,
        costPerToken: 1e-4
      },
      frontier: {
        name: "frontier",
        description: "Frontier models for hard tasks",
        providers: hasAnthropic ? [
          {
            name: "anthropic",
            apiKeyEnv: "ANTHROPIC_API_KEY",
            models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"]
          }
        ] : [],
        maxRetries: 3,
        costPerToken: 5e-3
      }
    },
    router: {
      defaultTier: "local",
      escalation: {
        enabled: true,
        maxAttemptsPerTier: 2,
        autoPromoteOnFailure: true,
        maxEscalations: 2
      },
      manualOverride: null,
      heuristics: {
        simpleKeywords: [
          "typo",
          "spelling",
          "whitespace",
          "formatting",
          "lint",
          "rename",
          "comment",
          "readme",
          "documentation",
          "boilerplate",
          "template",
          "simple",
          "small",
          "fix"
        ],
        complexKeywords: [
          "architecture",
          "refactor",
          "optimize",
          "performance",
          "bottleneck",
          "security",
          "concurrency",
          "race condition",
          "deadlock",
          "memory leak",
          "distributed",
          "migration",
          "redesign",
          "scale",
          "debug",
          "investigate",
          "complex"
        ],
        complexFilePatterns: [
          "*.rs",
          "*.go",
          "*_test.*",
          "src/core/*",
          "src/engine/*"
        ],
        minFilesForComplex: 3
      }
    },
    providers: {
      timeoutSeconds: 120,
      maxRetries: 2,
      retryBaseDelay: 1,
      retryMaxDelay: 30
    },
    learnedClassifier: {
      enabled: false,
      modelFile: "learned_model.json",
      minSamples: 10,
      blend: 0.5,
      learningRate: 0.5,
      epochs: 50
    },
    safety: {
      requireApproval: [
        "git_push",
        "git_force_push",
        "deploy_production",
        "merge_pr",
        "delete_branch"
      ],
      spendLimits: {
        perSession: 10,
        perDay: 50,
        perTask: 5
      },
      sandboxAllowed: ["git status", "git log", "git diff", "ls", "cat", "pytest"],
      blockedCommands: ["rm -rf", "sudo", "chmod 777", "dd if="]
    },
    logging: {
      enabled: true,
      level: "INFO",
      file: "waypoint.log",
      logRoutingDecisions: true,
      logEscalations: true,
      logCosts: true,
      feedbackFile: "feedback.jsonl"
    }
  };
}
var init_defaults = __esm({
  "../../packages/core/dist/defaults.js"() {
    "use strict";
  }
});

// ../../packages/core/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  AnthropicClient: () => AnthropicClient,
  BudgetExceededError: () => BudgetExceededError,
  CircuitBreaker: () => CircuitBreaker,
  ConfigError: () => ConfigError,
  CostTracker: () => CostTracker,
  DEFAULT_BASE_URLS: () => DEFAULT_BASE_URLS,
  DEFAULT_COMPLEX_FILE_PATTERNS: () => DEFAULT_COMPLEX_FILE_PATTERNS,
  DEFAULT_COMPLEX_KEYWORDS: () => DEFAULT_COMPLEX_KEYWORDS,
  DEFAULT_SIMPLE_KEYWORDS: () => DEFAULT_SIMPLE_KEYWORDS,
  HealthChecker: () => HealthChecker,
  HybridClassifier: () => HybridClassifier,
  LearnedClassifier: () => LearnedClassifier,
  OllamaClient: () => OllamaClient,
  OpenAICompatClient: () => OpenAICompatClient,
  Orchestrator: () => Orchestrator,
  ProviderClient: () => ProviderClient,
  ProviderError: () => ProviderError,
  ProviderFactory: () => ProviderFactory,
  RetryExhaustedError: () => RetryExhaustedError,
  SafetyManager: () => SafetyManager,
  SpendTracker: () => SpendTracker,
  TIERS: () => TIERS,
  TIER_NAMES: () => TIER_NAMES,
  TaskClassifier: () => TaskClassifier,
  TierRouter: () => TierRouter,
  VERSION: () => VERSION,
  YamlError: () => YamlError,
  calculateDelay: () => calculateDelay,
  classifyGlob: () => classifyGlob,
  compilePattern: () => compilePattern,
  defaultConfig: () => defaultConfig,
  deserializeWeights: () => deserializeWeights,
  emptyWeights: () => emptyWeights,
  featuresFor: () => featuresFor,
  globToRegexSource: () => globToRegexSource,
  globToSegmentRegexSource: () => globToSegmentRegexSource,
  isTier: () => isTier,
  normalize: () => normalize,
  parseConfig: () => parseConfig,
  parseScalar: () => parseScalar,
  parseYaml: () => parseYaml,
  serializeWeights: () => serializeWeights,
  setFetchImpl: () => setFetchImpl,
  tokenize: () => tokenize,
  withRetry: () => withRetry
});
var VERSION;
var init_dist = __esm({
  "../../packages/core/dist/index.js"() {
    "use strict";
    init_types();
    init_globs();
    init_yaml();
    init_config();
    init_classifier();
    init_learned_classifier();
    init_router();
    init_providers();
    init_retry();
    init_orchestrator();
    init_safety();
    init_health();
    init_defaults();
    VERSION = "0.2.0";
  }
});

// ../app-core/dist/conversation.js
function initialState() {
  return {
    messages: [],
    draft: "",
    busy: false,
    sessionSpendUsd: 0,
    limits: { perTask: 5, perSession: 10, perDay: 50 },
    error: null
  };
}
var counter = 0;
function nextId(prefix = "m") {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}
function reducer(state2, action) {
  switch (action.type) {
    case "setDraft":
      return { ...state2, draft: action.draft };
    case "submit":
      return {
        ...state2,
        busy: true,
        error: null,
        draft: "",
        messages: [
          ...state2.messages,
          {
            id: action.messageId,
            role: "user",
            content: state2.draft,
            at: Date.now()
          },
          {
            id: `${action.messageId}-reply`,
            role: "assistant",
            content: "",
            at: Date.now(),
            pending: true
          }
        ]
      };
    case "streamStart":
      return patchMessage(state2, action.messageId, { pending: true });
    case "streamToken":
      return appendToMessage(state2, action.messageId, action.token);
    case "streamEnd":
      return patchMessage(state2, action.messageId, { pending: false });
    case "succeeded":
      return {
        ...patchMessage(state2, `${action.messageId}-reply`, {
          content: action.result.content,
          pending: false,
          error: void 0,
          ...action.result.tier ? { tier: action.result.tier } : {},
          ...action.result.model ? { model: action.result.model } : {},
          confidence: action.result.confidence,
          costUsd: action.result.costUsd,
          durationMs: action.result.durationMs
        }),
        busy: false,
        sessionSpendUsd: round(state2.sessionSpendUsd + action.result.costUsd)
      };
    case "failed":
      return {
        ...patchMessage(state2, `${action.messageId}-reply`, {
          pending: false,
          error: action.error
        }),
        busy: false,
        error: action.error
      };
    case "setSpend":
      return { ...state2, sessionSpendUsd: action.spendUsd };
    case "dismissError":
      return { ...state2, error: null };
    case "clear":
      return { ...initialState(), limits: state2.limits };
    default:
      return state2;
  }
}
function patchMessage(state2, id, patch) {
  let found = false;
  const messages = state2.messages.map((message) => {
    if (message.id !== id)
      return message;
    found = true;
    return { ...message, ...patch };
  });
  if (!found)
    return state2;
  return { ...state2, messages };
}
function appendToMessage(state2, id, token) {
  let found = false;
  const messages = state2.messages.map((message) => {
    if (message.id !== id)
      return message;
    found = true;
    return { ...message, content: message.content + token };
  });
  if (!found)
    return state2;
  return { ...state2, messages };
}
function spendFraction(state2) {
  if (state2.limits.perSession <= 0)
    return 1;
  return Math.min(state2.sessionSpendUsd / state2.limits.perSession, 1);
}
function budgetExhausted(state2) {
  return state2.sessionSpendUsd >= state2.limits.perSession;
}
function canSubmit(state2) {
  return !state2.busy && state2.draft.trim().length > 0;
}
function round(value) {
  return Math.round(value * 1e4) / 1e4;
}

// ../app-core/dist/controller.js
init_dist();
var AppController = class {
  options;
  orchestrator;
  health;
  safety;
  inFlight = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
    this.orchestrator = new Orchestrator(options.config, {
      env: options.env ?? readEnvironment(),
      ...options.createClient ? { createClient: options.createClient } : {},
      ...options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
    });
    this.health = new HealthChecker(options.config, this.orchestrator.router, {
      timeoutMs: options.timeoutMs ?? 5e3,
      latencyThresholdMs: options.latencyThresholdMs ?? 3e4,
      // Forwarded so health probes use the same client construction as
      // execution. Without this the checker builds its own clients and hits
      // the network even when a factory was injected.
      ...options.createClient ? { createClient: options.createClient } : {}
    });
    this.safety = new SafetyManager(options.config.safety);
  }
  /**
   * Show which tier would handle a prompt, without spending anything.
   *
   * The UI calls this while the user is still typing so the chosen tier can
   * be shown before they commit.
   */
  preview(prompt, filesTouched = []) {
    const decision = this.decision(prompt, filesTouched);
    return {
      tier: decision.tier,
      provider: decision.provider.name,
      model: decision.model,
      confidence: decision.confidence,
      reasons: decision.reasons
    };
  }
  decision(prompt, filesTouched) {
    const context = {
      description: prompt,
      filesTouched,
      errorLoops: 0,
      testFailures: 0
    };
    return this.orchestrator.router.route(`preview-${Date.now()}`, context);
  }
  /** Run a request and return the result. */
  async submit(options) {
    const controller2 = new AbortController();
    this.inFlight.set(options.taskId, controller2);
    try {
      if (options.stream) {
        return await this.submitStreaming(options, controller2.signal);
      }
      const result = await this.orchestrator.execute(options.taskId, options.prompt, {
        filesTouched: options.filesTouched ?? [],
        maxTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0,
        ...options.system ? { system: options.system } : {},
        signal: controller2.signal
      });
      return result;
    } finally {
      this.inFlight.delete(options.taskId);
    }
  }
  async submitStreaming(options, signal) {
    const started = Date.now();
    let content = "";
    const iterator = this.orchestrator.executeStream(options.taskId, options.prompt, {
      filesTouched: options.filesTouched ?? [],
      maxTokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0,
      ...options.system ? { system: options.system } : {},
      signal
    });
    for await (const token of iterator) {
      content += token;
      options.onToken?.(token, content);
    }
    return {
      taskId: options.taskId,
      success: true,
      content,
      attempts: 1,
      escalated: false,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - started,
      confidence: 0,
      reasons: ["streamed response; usage is not reported by every provider"],
      history: [
        { attempt: 1, tier: "local", model: "unknown", success: true }
      ]
    };
  }
  /** Cancel an in-flight request. */
  cancel(taskId) {
    const controller2 = this.inFlight.get(taskId);
    if (!controller2)
      return false;
    controller2.abort();
    return true;
  }
  /** Abort everything, used when the window closes. */
  cancelAll() {
    for (const controller2 of this.inFlight.values())
      controller2.abort();
    this.inFlight.clear();
  }
  inFlightCount() {
    return this.inFlight.size;
  }
  async checkHealth(signal) {
    return this.health.checkAll(signal);
  }
  spendStatus() {
    return this.orchestrator.spend.getStatus();
  }
  costStats() {
    return this.orchestrator.cost.getStats();
  }
  limits() {
    return this.options.config.safety.spendLimits;
  }
  /** Exposed so the UI can preview a gated command before running it. */
  gate(command) {
    return this.safety.check(command);
  }
  getRouter() {
    return this.orchestrator.router;
  }
};
function readEnvironment() {
  const env = globalThis.process?.env;
  return env ?? {};
}

// ../app-core/dist/samples.js
var SAMPLE_PROMPTS = [
  {
    id: "readme-typo",
    title: "Fix a typo",
    prompt: "Fix the typo in the second paragraph of README.md",
    expectedTier: "local",
    why: "One small edit. A local coder model handles this for free."
  },
  {
    id: "rename-symbol",
    title: "Rename a symbol",
    prompt: "Rename the user_id variable to accountId across this file",
    expectedTier: "local",
    why: "Mechanical rename with a clear scope."
  },
  {
    id: "add-endpoint",
    title: "Add an API endpoint",
    prompt: "Add a paginated GET endpoint for listing user activity, wired to the existing router and tests",
    expectedTier: "mid",
    why: "Touches routing, a service, and tests, but the shape is known."
  },
  {
    id: "write-tests",
    title: "Write tests for a function",
    prompt: "Write unit tests for the parseConfig function covering malformed input",
    expectedTier: "mid",
    why: "Needs reasoning about edge cases without deep design work."
  },
  {
    id: "debug-race",
    title: "Debug a race condition",
    prompt: "Investigate an intermittent race condition between the cache writer and the flush timer under load",
    expectedTier: "frontier",
    why: "Concurrency bugs need the strongest reasoning available."
  },
  {
    id: "design-architecture",
    title: "Design an architecture",
    prompt: "Design the architecture for a multi-tenant billing system with per-tenant isolation and safe migrations",
    expectedTier: "frontier",
    why: "Architecture decisions are expensive to get wrong."
  },
  {
    id: "optimize-query",
    title: "Optimize a slow query",
    prompt: "This query takes 4 seconds on 2M rows. Optimize it and explain the trade-offs",
    expectedTier: "frontier",
    why: "Performance work needs careful reasoning about access patterns."
  },
  {
    id: "format-code",
    title: "Format and tidy",
    prompt: "Fix the lint warnings in this file and remove the unused imports",
    expectedTier: "local",
    why: "Mechanical cleanup with no design decisions."
  }
];

// src/renderer.ts
init_dist();
var bridge = window.waypoint ?? {};
var state = initialState();
var controller;
var activeTaskId = null;
var els = {
  transcript: byId("transcript"),
  welcome: byId("welcome"),
  samples: byId("samples"),
  input: byId("input"),
  send: byId("send"),
  cancel: byId("cancel"),
  clear: byId("clear"),
  health: byId("health-button"),
  healthDialog: byId("health-dialog"),
  healthBody: byId("health-body"),
  tierBadge: byId("tier-badge"),
  spendFill: byId("spend-fill"),
  spendMeter: byId("spend-meter"),
  hint: byId("hint")
};
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: #${id}`);
  return element;
}
function dispatch(action) {
  state = reducer(state, action);
  render();
}
function updateFromController() {
  if (!controller) return;
  const status = controller.spendStatus();
  dispatch({ type: "setSpend", spendUsd: status.sessionSpend });
}
function render() {
  renderTranscript();
  renderTierBadge();
  renderSpend();
  renderComposer();
}
function renderTranscript() {
  const previousCount = els.transcript.querySelectorAll(".message").length;
  if (previousCount === state.messages.length) {
    updateLastMessage();
    return;
  }
  els.transcript.querySelectorAll(".message").forEach((node) => node.remove());
  if (state.messages.length > 0 && els.welcome.isConnected) {
    els.welcome.remove();
  }
  for (const message of state.messages) {
    els.transcript.appendChild(renderMessage(message));
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
function updateLastMessage() {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;
  const nodes = els.transcript.querySelectorAll(".message");
  const node = nodes[nodes.length - 1];
  if (!node) {
    renderTranscript();
    return;
  }
  const body = node.querySelector(".message-body");
  if (body && body.textContent !== last.content) {
    body.textContent = last.content;
  }
  node.classList.toggle("caret", last.pending === true);
}
function renderMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;
  if (message.pending) wrapper.classList.add("caret");
  const role = document.createElement("div");
  role.className = "message-role";
  role.textContent = message.role === "user" ? "You" : "Waypoint";
  wrapper.appendChild(role);
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = message.content;
  wrapper.appendChild(body);
  if (message.tier || message.costUsd !== void 0 || message.durationMs !== void 0) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    if (message.tier) meta.appendChild(metaItem("tier", message.tier));
    if (message.model) meta.appendChild(metaItem("model", message.model));
    if (message.confidence !== void 0) {
      meta.appendChild(metaItem("confidence", `${Math.round(message.confidence * 100)}%`));
    }
    if (message.durationMs !== void 0) {
      meta.appendChild(metaItem("took", `${message.durationMs}ms`));
    }
    if (message.costUsd) meta.appendChild(metaItem("cost", `$${message.costUsd.toFixed(4)}`));
    wrapper.appendChild(meta);
  }
  if (message.error) {
    const error = document.createElement("div");
    error.className = "message-error";
    error.textContent = message.error;
    wrapper.appendChild(error);
  }
  return wrapper;
}
function metaItem(label, value) {
  const span = document.createElement("span");
  span.textContent = `${label}: ${value}`;
  return span;
}
function renderTierBadge() {
  const draft = state.draft.trim();
  if (!draft || !controller) {
    els.tierBadge.textContent = "no prompt";
    els.tierBadge.className = "tier-badge tier-none";
    return;
  }
  const preview = controller.preview(draft);
  els.tierBadge.textContent = preview.tier;
  els.tierBadge.className = `tier-badge tier-${preview.tier}`;
  els.tierBadge.title = `${preview.provider}/${preview.model} - ${preview.reasons.join("; ")}`;
}
function renderSpend() {
  const fraction = spendFraction(state);
  els.spendFill.style.width = `${Math.round(fraction * 100)}%`;
  els.spendFill.className = "spend-fill" + (fraction >= 1 ? " spend-full" : fraction >= 0.7 ? " warn" : "");
  els.spendMeter.title = `$${state.sessionSpendUsd.toFixed(4)} of $${state.limits.perSession}`;
}
function renderComposer() {
  els.send.disabled = !canSubmit(state);
  els.cancel.hidden = !state.busy;
  if (budgetExhausted(state)) {
    els.hint.textContent = "Session budget reached. Raise safety.spend_limits or clear the session to keep going.";
    els.hint.classList.add("warn");
  }
}
function renderSamples() {
  els.samples.textContent = "";
  for (const sample of SAMPLE_PROMPTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sample";
    button.title = sample.why;
    const title = document.createElement("span");
    title.className = "sample-title";
    title.textContent = sample.title;
    const why = document.createElement("span");
    why.className = "sample-why";
    why.textContent = sample.why;
    button.append(title, why);
    button.addEventListener("click", () => {
      els.input.value = sample.prompt;
      els.input.focus();
      dispatch({ type: "setDraft", draft: sample.prompt });
    });
    els.samples.appendChild(button);
  }
}
async function send() {
  const prompt = state.draft.trim();
  if (!prompt || state.busy || !controller) return;
  const messageId = nextId("turn");
  activeTaskId = messageId;
  dispatch({ type: "submit", messageId });
  try {
    const result = await controller.submit({
      taskId: messageId,
      prompt,
      stream: true,
      onToken: (_token, accumulated) => {
        state = {
          ...state,
          messages: state.messages.map(
            (message) => message.id === `${messageId}-reply` ? { ...message, content: accumulated } : message
          )
        };
        render();
      }
    });
    dispatch({ type: "streamEnd", messageId: `${messageId}-reply` });
    if (result.success) {
      dispatch({ type: "succeeded", messageId, result });
    } else {
      dispatch({ type: "failed", messageId, error: result.error ?? "Request failed" });
    }
  } catch (error) {
    dispatch({
      type: "failed",
      messageId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    activeTaskId = null;
    updateFromController();
    render();
  }
}
function cancel() {
  if (!activeTaskId || !controller) return;
  controller.cancel(activeTaskId);
  dispatch({ type: "streamEnd", messageId: `${activeTaskId}-reply` });
  activeTaskId = null;
  render();
}
async function showHealth() {
  if (!controller) return;
  els.healthBody.textContent = "Checking...";
  if (typeof els.healthDialog.showModal === "function") els.healthDialog.showModal();
  const results = await controller.checkHealth();
  els.healthBody.textContent = "";
  if (results.length === 0) {
    els.healthBody.textContent = "No models configured.";
    return;
  }
  for (const result of results) {
    const row = document.createElement("div");
    row.className = "health-row";
    const name = document.createElement("span");
    name.textContent = `${result.provider}/${result.model}`;
    const status = document.createElement("span");
    status.className = `health-status-${result.status}`;
    status.textContent = result.status;
    row.append(name, status);
    els.healthBody.appendChild(row);
  }
}
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 192)}px`;
}
async function resolveConfig() {
  if (bridge.readConfig) {
    try {
      const loaded = await bridge.readConfig();
      return { config: loaded.config, error: loaded.error };
    } catch (error) {
      return {
        config: defaultConfig(readEnv()),
        error: `Could not read host config: ${error.message}`
      };
    }
  }
  try {
    const response = await fetch("./waypoint.config.json");
    if (response.ok) {
      const { parseConfig: parseConfig2 } = await Promise.resolve().then(() => (init_dist(), dist_exports));
      return { config: parseConfig2(await response.text(), "json"), error: null };
    }
  } catch {
  }
  return { config: defaultConfig(readEnv()), error: null };
}
function readEnv() {
  return {};
}
async function main() {
  renderSamples();
  const { config, error } = await resolveConfig();
  state = { ...state, limits: config.safety.spendLimits };
  controller = new AppController({
    config,
    // The renderer has no environment, so keys come from the host via the
    // bridge or from the served config. Local models need neither.
    env: {}
  });
  if (error) {
    els.hint.textContent = `Config problem: ${error}`;
    els.hint.classList.add("warn");
  }
  els.send.addEventListener("click", () => void send());
  els.cancel.addEventListener("click", cancel);
  els.health.addEventListener("click", () => void showHealth());
  els.clear.addEventListener("click", () => {
    controller?.cancelAll();
    activeTaskId = null;
    state = { ...initialState(), limits: state.limits };
    if (!els.welcome.isConnected) {
      els.transcript.prepend(els.welcome);
    }
    els.transcript.querySelectorAll(".message").forEach((node) => node.remove());
    els.input.value = "";
    autoGrow();
    render();
  });
  els.input.addEventListener("input", () => {
    autoGrow();
    dispatch({ type: "setDraft", draft: els.input.value });
  });
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  bridge.on?.("config:error", (message) => {
    els.hint.textContent = `Config problem: ${message}`;
    els.hint.classList.add("warn");
  });
  window.addEventListener("beforeunload", () => controller?.cancelAll());
  render();
}
void main();
