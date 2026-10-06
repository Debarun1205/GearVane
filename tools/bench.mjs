#!/usr/bin/env node
/**
 * B5 Bench tool: measure model performance.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main() {
  const args = process.argv.slice(2);

  const options = {
    provider: undefined,
    model: undefined,
    baseUrl: undefined,
    iterations: 5,
    maxTokens: 256,
    temperature: 0,
    warmup: 2,
    timeoutMs: 120000,
    prompt: 'Hello, world!',
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];

    if (arg === '--provider') { options.provider = process.argv[++i]; }
    else if (arg === '--model') { options.model = process.argv[++i]; }
    else if (arg === '--base-url') { options.baseUrl = process.argv[++i]; }
    else if (arg === '--iterations') { options.iterations = parseInt(process.argv[++i], 10); }
    else if (arg === '--prompt') { options.prompt = process.argv[++i]; }
    else if (arg === '--max-tokens') { options.maxTokens = parseInt(process.argv[++i], 10); }
    else if (arg === '--temperature') { options.temperature = parseFloat(process.argv[++i]); }
    else if (arg === '--warmup') { options.warmup = parseInt(process.argv[++i], 10); }
    else if (arg === '--timeout') { options.timeoutMs = parseInt(process.argv[++i], 10); }
    else if (arg === '--help') {
      console.log(`Usage: bench --provider <name> [options]\nRequired: --provider <name>\nOptional: --model, --base-url, --iterations, --prompt, --max-tokens, --temperature, --warmup, --timeout`);
      process.exit(0);
    }
  }

  if (!options.provider) { console.error('Error: --provider is required'); process.exit(1); }
  if (!process.argv.includes('--prompt')) options.prompt = 'Hello, world!';
  if (!options.model) console.error('Warning: --model not specified');

  const core = require(join(process.cwd(), 'packages', 'core', 'dist', 'index.js'));
  const { ProviderFactory } = core;

  const factory = new core.ProviderFactory({ timeoutMs: options.timeoutMs || 120000 });
  const client = factory.create({ name: options.provider, baseUrl: options.baseUrl, models: options.model ? [options.model] : [] }, options.model);

  console.error(`Warming up (${options.warmup} iterations)...`);
  for (let i = 0; i < (options.warmup || 2); i++) {
    try { await client.complete(options.prompt, { maxTokens: options.maxTokens || 256, temperature: options.temperature || 0 }); }
    catch (e) { console.error(`Warmup ${i + 1} failed: ${e.message}`); }
  }

  const iterations = options.iterations || 5;
  console.error(`Running ${iterations} benchmark iterations...`);

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    let ttft = 0, tokens = 0, success = false, error;

    try {
      const stream = client.stream(options.prompt || 'Hello, world!', { maxTokens: options.maxTokens || 256, temperature: options.temperature || 0 });
      let firstToken = true;
      for await (const token of stream) {
        if (firstToken) { ttft = Date.now() - start; firstToken = false; }
        tokens++;
      }
      const latency = Date.now() - start;
      console.error(`Iteration ${i + 1}: ${latency}ms, TTFT: ${ttft}ms, ${tokens} tokens`);
      console.log(JSON.stringify({ iteration: i + 1, success: true, latencyMs: latency, timeToFirstTokenMs: ttft, tokensGenerated: tokens, tokensPerSecond: latency > 0 ? Math.round((tokens / latency) * 1000) : 0 }));
    } catch (e) {
      const latency = Date.now() - start;
      const error = e.message;
      console.error(`Iteration ${i + 1} failed: ${error}`);
      console.log(JSON.stringify({ iteration: i + 1, success: false, latencyMs: latency, timeToFirstTokenMs: 0, tokensGenerated: 0, tokensPerSecond: 0, error }));
    }
  }

  const result = {
    provider: process.argv[process.argv.indexOf('--provider') + 1] || 'unknown',
    model: process.argv[process.argv.indexOf('--model') + 1] || 'unknown',
    iterations: process.argv.includes('--iterations') ? parseInt(process.argv[process.argv.indexOf('--iterations') + 1], 10) : 5,
    warmup: process.argv.includes('--warmup') ? parseInt(process.argv[process.argv.indexOf('--warmup') + 1], 10) : 2,
    successful: 0, failed: 0, totalLatencyMs: 0, timeToFirstTokenMs: 0, tokensPerSecond: 0, totalTokens: 0,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });