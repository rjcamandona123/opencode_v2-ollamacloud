#!/usr/bin/env node
/**
 * llm — one-command local LLM setup for OpenCode (Ollama or llama.cpp).
 *
 *   llm setup            detect → install → start → pull → configure → verify
 *   llm status           what is installed, running, and configured
 *   llm models           list models served by the local backend
 *   llm pull <model>     add a model (ollama tag or HF repo:quant)
 *   llm start | stop     control the backend
 *   llm config           rewrite OpenCode config from the live model list
 *
 * Design goals: idempotent, non-interactive, no prompts, no surprises.
 * Every config write is backed up first.
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = os.homedir()
const IS_WIN = process.platform === "win32"
const IS_MAC = process.platform === "darwin"
const STATE_DIR = path.join(HOME, ".llm")
const PID_FILE = path.join(STATE_DIR, "server.pid")
const LOG_FILE = path.join(STATE_DIR, "server.log")
const MODEL_FILE = path.join(STATE_DIR, "model")
const CFG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
  : path.join(HOME, ".config", "opencode")
const CFG = path.join(CFG_DIR, "opencode.jsonc")

const OLLAMA_PORT = 11434
const LLAMA_PORT = 8080
const DEFAULT_OLLAMA_MODEL = process.env.LLM_MODEL || "qwen3:1.7b"
const DEFAULT_LLAMA_MODEL = process.env.LLM_GGUF || "unsloth/Qwen3-1.7B-GGUF:Q4_K_M"

/* ── tiny helpers ───────────────────────────────────────────────────────── */

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function log(msg) {
  console.log(msg)
}
function step(msg) {
  console.log(`${c.dim("•")} ${msg}`)
}
function ok(msg) {
  console.log(`${c.ok("✓")} ${msg}`)
}
function warn(msg) {
  console.log(`${c.warn("!")} ${msg}`)
}

function which(bin) {
  const probe = IS_WIN ? "where" : "which"
  const r = spawnSync(probe, [bin], { encoding: "utf8" })
  if (r.status !== 0) return null
  return (r.stdout || "").split(/\r?\n/).find(Boolean) || null
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts })
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") }
}

function readIf(p) {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function currentModel() {
  return (readIf(MODEL_FILE) || "").trim() || DEFAULT_LLAMA_MODEL
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

async function httpJson(url, timeout = 2500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function waitFor(url, seconds = 180) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    const j = await httpJson(url, 1500)
    if (j) return j
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ── platform detection ─────────────────────────────────────────────────── */

function detect() {
  const osRelease = readIf("/etc/os-release") || ""
  const id = (osRelease.match(/^ID="?([^"\n]+)"?/m) || [])[1] || ""
  const uname = run("uname", ["-a"]).out
  const android = /android/i.test(uname)
  const musl = run("ldd", ["--version"]).out.includes("musl") || id === "alpine"
  const arch = process.arch
  const ollama = which("ollama")
  const llamaServer = which("llama-server")
  const brew = which("brew")
  const apk = which("apk")
  const apt = which("apt-get")

  return {
    platform: process.platform,
    arch,
    id,
    android,
    musl,
    ollama,
    llamaServer,
    brew,
    apk,
    apt,
    // Ollama ships glibc builds; musl/Android needs llama.cpp.
    prefer: ollama ? "ollama" : llamaServer ? "llamacpp" : musl ? "llamacpp" : "ollama",
  }
}

function printDetect(d) {
  log(c.bold("environment"))
  log(`  os          ${d.platform}${d.id ? ` (${d.id})` : ""}${d.android ? " android" : ""}`)
  log(`  arch        ${d.arch}`)
  log(`  libc        ${d.musl ? "musl" : "glibc"}`)
  log(`  ollama      ${d.ollama || c.dim("not installed")}`)
  log(`  llama.cpp   ${d.llamaServer || c.dim("not installed")}`)
  log(`  backend     ${c.bold(d.prefer)}`)
}

/* ── backend install ────────────────────────────────────────────────────── */

function installOllama(d) {
  step("installing Ollama")
  if (IS_WIN) {
    if (which("winget")) {
      const r = run("winget", ["install", "-e", "--id", "Ollama.Ollama", "--accept-package-agreements", "--accept-source-agreements"])
      if (r.code === 0) return which("ollama")
    }
    warn("install Ollama from https://ollama.com/download, then rerun `llm setup`")
    return null
  }
  if (IS_MAC && d.brew) {
    run("brew", ["install", "ollama"])
    return which("ollama")
  }
  // official script: glibc Linux only
  const r = run("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { stdio: "inherit" })
  if (r.code === 0) return which("ollama")
  return null
}

function installBuildDeps(d) {
  if (d.apk) return run("apk", ["add", "--no-cache", "build-base", "cmake", "linux-headers", "curl-dev", "git"], { stdio: "inherit" }).code === 0
  if (d.apt) {
    run("sh", ["-c", "apt-get update -qq"], { stdio: "inherit" })
    return run("apt-get", ["install", "-y", "build-essential", "cmake", "libcurl4-openssl-dev", "git"], { stdio: "inherit" }).code === 0
  }
  return false
}

// Compiling llama.cpp with one job per core exhausts RAM on phones and small
// VPSes (internal compiler error: Bus error). Scale jobs to free memory.
function buildJobs() {
  if (process.env.LLM_JOBS) return String(Math.max(1, Number(process.env.LLM_JOBS) || 1))
  const cpus = os.cpus().length || 1
  const freeMB = os.freemem() / 1048576
  const perJobMB = 900
  const byMem = Math.floor(freeMB / perJobMB)
  return String(Math.max(1, Math.min(cpus, byMem)))
}

function buildLlamaCpp(d) {
  const src = path.join(STATE_DIR, "llama.cpp")
  const build = path.join(STATE_DIR, "build")
  const bin = path.join(build, "bin", IS_WIN ? "llama-server.exe" : "llama-server")

  if (fs.existsSync(bin)) return bin

  step("installing build tools (one time)")
  if (!installBuildDeps(d)) {
    warn("could not install build tools automatically")
    return null
  }

  if (!fs.existsSync(src)) {
    step("fetching llama.cpp")
    const r = run("git", ["clone", "--depth", "1", "https://github.com/ggml-org/llama.cpp", src], { stdio: "inherit" })
    if (r.code !== 0) return null
  }

  step("building llama.cpp (this takes a few minutes)")
  const flags = [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DLLAMA_CURL=ON",
    "-DLLAMA_BUILD_SERVER=ON",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_UI=OFF",
  ]
  let r = run("cmake", ["-S", src, "-B", build, ...flags], { stdio: "inherit" })
  if (r.code !== 0) return null
  const jobs = buildJobs()
  step(`compiling with ${jobs} job(s)`)
  r = run("cmake", ["--build", build, "-j", jobs, "--target", "llama-server"], { stdio: "inherit" })
  if (r.code !== 0) return null

  return fs.existsSync(bin) ? bin : null
}

function ensureBackend(d) {
  if (d.prefer === "ollama") {
    if (d.ollama) return { kind: "ollama", bin: d.ollama }
    const bin = installOllama(d)
    if (bin) return { kind: "ollama", bin }
    warn("Ollama install failed; falling back to llama.cpp")
  }

  if (d.llamaServer) return { kind: "llamacpp", bin: d.llamaServer }

  if (IS_MAC && d.brew) {
    step("installing llama.cpp via Homebrew")
    run("brew", ["install", "llama.cpp"])
    const b = which("llama-server")
    if (b) return { kind: "llamacpp", bin: b }
  }

  const bin = buildLlamaCpp(d)
  if (bin) return { kind: "llamacpp", bin }
  return null
}

/* ── server lifecycle ───────────────────────────────────────────────────── */

function pidAlive() {
  const raw = readIf(PID_FILE)
  if (!raw) return null
  const pid = Number(raw.trim())
  if (!pid) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

async function startOllama(bin) {
  const base = `http://127.0.0.1:${OLLAMA_PORT}`
  if (await httpJson(`${base}/api/tags`)) {
    ok(`Ollama already running at ${base}`)
    return base
  }
  ensureDir(STATE_DIR)
  step("starting ollama serve")
  const out = fs.openSync(LOG_FILE, "a")
  const child = spawn(bin, ["serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
  })
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  if (!(await waitFor(`${base}/api/tags`, 60))) throw new Error("Ollama did not start")
  ok(`Ollama listening on ${base}`)
  return base
}

function modelAlias(model) {
  const last = model.split("/").pop() || model
  return last.replace(/[:]/g, "-").toLowerCase()
}

async function startLlamaCpp(bin, model) {
  const base = `http://127.0.0.1:${LLAMA_PORT}`
  if (await httpJson(`${base}/v1/models`)) {
    ok(`llama.cpp already running at ${base}`)
    return base
  }
  ensureDir(STATE_DIR)
  step(`starting llama-server with ${model}`)
  const out = fs.openSync(LOG_FILE, "a")
  const alias = modelAlias(model)
  const ngl = process.env.LLM_NGL || (process.platform === "android" ? "0" : "99")
  const args = [
    "-hf", model,
    "--alias", alias,
    "--host", "127.0.0.1",
    "--port", String(LLAMA_PORT),
    "-c", process.env.LLM_CTX || "8192",
    "-ngl", ngl,
    "--jinja", // enables tool calling via the model's chat template
  ]
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", out, out] })
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  if (!(await waitFor(`${base}/v1/models`, 900))) throw new Error("llama-server did not start (see " + LOG_FILE + ")")
  ok(`llama.cpp listening on ${base}`)
  return base
}

function stopServer() {
  const pid = pidAlive()
  if (!pid) {
    ok("nothing to stop")
    return
  }
  try {
    process.kill(pid, "SIGTERM")
    ok(`stopped pid ${pid}`)
  } catch (e) {
    warn(`could not stop pid ${pid}: ${e.message}`)
  }
  try {
    fs.unlinkSync(PID_FILE)
  } catch {}
}

/* ── models ─────────────────────────────────────────────────────────────── */

async function listModels(kind, base) {
  if (kind === "ollama") {
    const j = await httpJson(`${base}/api/tags`)
    return (j?.models || []).map((m) => m.name)
  }
  const j = await httpJson(`${base}/v1/models`)
  return (j?.data || []).map((m) => m.id)
}

async function ensureOllamaModel(bin, model) {
  const have = (await httpJson(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`))?.models?.map((m) => m.name) || []
  const norm = (s) => (s.includes(":") ? s : `${s}:latest`)
  if (have.some((n) => norm(n) === norm(model))) {
    ok(`model present: ${model}`)
    return
  }
  step(`pulling ${model} (one time)`)
  const r = run(bin, ["pull", model], { stdio: "inherit" })
  if (r.code !== 0) warn(`pull failed for ${model}`)
}

/* ── config ─────────────────────────────────────────────────────────────── */

function parseJsonc(src) {
  let out = ""
  let i = 0
  let inStr = false
  let esc = false
  while (i < src.length) {
    const ch = src[i]
    const nx = src[i + 1]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i++
      continue
    }
    if (ch === "/" && nx === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (ch === "/" && nx === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] === "}" || src[j] === "]") {
        i++
        continue
      }
    }
    out += ch
    i++
  }
  return JSON.parse(out)
}

function loadConfig() {
  const raw = readIf(CFG)
  if (!raw) return {}
  try {
    return parseJsonc(raw)
  } catch (e) {
    warn(`could not parse ${CFG}: ${e.message}`)
    return {}
  }
}

function saveConfig(cfg) {
  ensureDir(CFG_DIR)
  if (fs.existsSync(CFG)) {
    const bak = `${CFG}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`
    fs.copyFileSync(CFG, bak)
    step(`backup: ${bak}`)
  }
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n")
}

function providerConfig(kind, base, models) {
  if (kind === "ollama") {
    // OpenCode discovers Ollama models natively; no model list needed.
    return {
      ollama: {
        settings: { baseURL: `${base}/v1` },
      },
    }
  }
  const map = {}
  for (const id of models) {
    map[id] = {
      name: id,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: Number(process.env.LLM_CTX || 8192), output: 4096 },
    }
  }
  if (Object.keys(map).length === 0) {
    const alias = modelAlias(DEFAULT_LLAMA_MODEL)
    map[alias] = {
      modelID: alias,
      name: alias,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: Number(process.env.LLM_CTX || 8192), output: 4096 },
    }
  }
  return {
    llamacpp: {
      name: "llama.cpp (local)",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${base}/v1` },
      models: map,
    },
  }
}

function applyConfig(kind, base, models, setDefault) {
  const cfg = loadConfig()
  cfg.$schema ||= "https://opencode.ai/config.json"
  cfg.providers = { ...(cfg.providers || {}), ...providerConfig(kind, base, models) }

  // "allow all automatically": catch-all allow appended after existing rules.
  const perms = Array.isArray(cfg.permissions) ? cfg.permissions.slice() : []
  const hasAll = perms.some((p) => p && p.action === "*" && p.resource === "*" && p.effect === "allow")
  if (!hasAll) perms.push({ action: "*", resource: "*", effect: "allow" })
  cfg.permissions = perms

  const pol = Array.isArray(cfg.policies) ? cfg.policies.slice() : []
  const hasProvider = pol.some((p) => p && p.action === "provider.use" && p.resource === "*" && p.effect === "allow")
  if (!hasProvider) pol.push({ action: "provider.use", resource: "*", effect: "allow" })
  cfg.policies = pol

  if (setDefault) {
    const id = kind === "ollama" ? models[0] : Object.keys(providerConfig(kind, base, models).llamacpp.models)[0]
    if (id) cfg.model = `${kind}/${id}`
  }

  saveConfig(cfg)
  ok(`config updated: ${CFG}`)
}

/* ── commands ───────────────────────────────────────────────────────────── */

async function cmdSetup(argv) {
  const setDefault = argv.includes("--default")
  const noModel = argv.includes("--no-model")
  const d = detect()
  printDetect(d)

  const backend = ensureBackend(d)
  if (!backend) {
    warn("no backend available")
    process.exit(1)
  }
  ok(`backend: ${backend.kind} (${backend.bin})`)

  let base
  let model = backend.kind === "ollama" ? DEFAULT_OLLAMA_MODEL : currentModel()

  if (backend.kind === "ollama") {
    base = await startOllama(backend.bin)
    if (!noModel) await ensureOllamaModel(backend.bin, model)
  } else {
    base = await startLlamaCpp(backend.bin, model)
  }

  const models = await listModels(backend.kind, base)
  if (models.length) ok(`models: ${models.join(", ")}`)
  else warn("no models reported yet")

  applyConfig(backend.kind, base, models, setDefault)

  if (which("opencode")) {
    const r = run("opencode", ["reload"])
    if (r.code === 0) ok("opencode reloaded")
    else warn("opencode reload failed — run `opencode reload` manually")
  }

  log("")
  log(c.bold("done"))
  log(`  backend  ${backend.kind}`)
  log(`  endpoint ${base}/v1`)
  log(`  config   ${CFG}`)
  log(`  open     /models in OpenCode`)
}

async function cmdStatus() {
  const d = detect()
  printDetect(d)
  const pid = pidAlive()
  const ollama = await httpJson(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`)
  const llama = await httpJson(`http://127.0.0.1:${LLAMA_PORT}/v1/models`)
  log(c.bold("runtime"))
  log(`  pid        ${pid || c.dim("none")}`)
  log(`  ollama     ${ollama ? c.ok("up") : c.dim("down")}`)
  log(`  llama.cpp  ${llama ? c.ok("up") : c.dim("down")}`)
  if (ollama) log(`  models     ${(ollama.models || []).map((m) => m.name).join(", ") || "-"}`)
  if (llama) log(`  models     ${(llama.data || []).map((m) => m.id).join(", ") || "-"}`)
  log(`  config     ${CFG}`)
}

async function cmdModels() {
  const d = detect()
  const base = d.prefer === "ollama" ? `http://127.0.0.1:${OLLAMA_PORT}` : `http://127.0.0.1:${LLAMA_PORT}`
  const models = await listModels(d.prefer, base)
  if (!models.length) {
    warn("backend is not running — try `llm start`")
    return
  }
  for (const m of models) log(`  ${m}`)
}

async function cmdStart() {
  const d = detect()
  const backend = ensureBackend(d)
  if (!backend) process.exit(1)
  if (backend.kind === "ollama") await startOllama(backend.bin)
  else await startLlamaCpp(backend.bin, currentModel())
}

async function cmdPull(model) {
  if (!model) {
    warn("usage: llm pull <ollama-tag | hf-repo:quant>")
    process.exit(1)
  }
  const d = detect()
  if (d.prefer === "ollama") {
    const bin = d.ollama || installOllama(d)
    if (!bin) process.exit(1)
    const r = run(bin, ["pull", model], { stdio: "inherit" })
    process.exit(r.code)
  }
  // llama.cpp: remember the model, then restart so the server serves it.
  ensureDir(STATE_DIR)
  fs.writeFileSync(MODEL_FILE, model + "\n")
  stopServer()
  const backend = ensureBackend(d)
  if (!backend) process.exit(1)
  await startLlamaCpp(backend.bin, model)
}

async function cmdCloud(key) {
  const fromEnv = !key && process.env.OLLAMA_CLOUD_API_KEY
  const apiKey = key || process.env.OLLAMA_CLOUD_API_KEY
  if (!apiKey) {
    warn("usage: llm cloud <api-key>   (or set OLLAMA_CLOUD_API_KEY)")
    warn("get a key at https://ollama.com/settings/keys — no weights downloaded")
    process.exit(1)
  }
  const cfg = loadConfig()
  cfg.$schema ||= "https://opencode.ai/config.json"
  cfg.providers = {
    ...(cfg.providers || {}),
    ollama: {
      settings: {
        baseURL: "https://ollama.com/v1",
        apiKey: fromEnv ? "{env:OLLAMA_CLOUD_API_KEY}" : apiKey,
      },
    },
  }
  saveConfig(cfg)
  try {
    fs.chmodSync(CFG, 0o600)
  } catch {}
  ok("OpenCode now uses Ollama Cloud (no local weights)")
  step("pick a cloud model, e.g. `llm cloud-model gemma4:31b`")
}

async function cmdCloudModel(model) {
  if (!model) {
    warn("usage: llm cloud-model <name>   e.g. gemma4:31b")
    process.exit(1)
  }
  const cfg = loadConfig()
  cfg.providers ||= {}
  cfg.providers.ollama ||= { settings: { baseURL: "https://ollama.com/v1" } }
  cfg.providers.ollama.models = {
    ...(cfg.providers.ollama.models || {}),
    [model]: { modelID: model, name: model },
  }
  cfg.model = `ollama/${model}`
  saveConfig(cfg)
  ok(`default model: ollama/${model}`)
  step("OpenCode downloads nothing — the model runs on Ollama's GPUs")
}

function cmdConfig() {
  // Regenerate from whatever is running.
  return cmdSetup(["setup", "--no-model"]).then(() => {})
}

function usage() {
  log(`${c.bold("llm")} — one-command local LLM for OpenCode`)
  log("")
  log("  llm setup [--default] [--no-model]   install, start, configure")
  log("  llm status                            show environment + runtime")
  log("  llm models                            list served models")
  log("  llm pull <model>                      add a model")
  log("  llm start | stop                      control the backend")
  log("  llm config                            regenerate OpenCode config")
  log("  llm cloud <api-key>                   use Ollama Cloud (no download)")
  log("  llm cloud-model <name>                set default cloud model")
  log("")
  log(`  config: ${CFG}`)
  log(`  state:  ${STATE_DIR}`)
}

const [, , cmd, ...rest] = process.argv

try {
  switch (cmd) {
    case "setup":
      await cmdSetup(rest)
      break
    case "status":
      await cmdStatus()
      break
    case "models":
      await cmdModels()
      break
    case "start":
      await cmdStart()
      break
    case "stop":
      stopServer()
      break
    case "pull":
      await cmdPull(rest[0])
      break
    case "config":
      await cmdConfig()
      break
    case "cloud":
      await cmdCloud(rest[0])
      break
    case "cloud-model":
      await cmdCloudModel(rest[0])
      break
    default:
      usage()
  }
} catch (e) {
  warn(e.message)
  process.exit(1)
}
