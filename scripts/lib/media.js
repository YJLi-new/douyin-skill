const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { LIMITS } = require("./constants");
const { ensureDir, fileExists, readJson, writeJsonAtomic } = require("./fs-utils");

const execFileAsync = promisify(execFile);

async function runCommand(binary, args, options = {}) {
  try {
    return await execFileAsync(binary, args, {
      maxBuffer: 1024 * 1024 * 50,
      ...options,
    });
  } catch (error) {
    const wrapped = new Error(`Command failed: ${binary} ${args.join(" ")}\n${error.stderr || error.message}`);
    wrapped.code = "COMMAND_FAILED";
    wrapped.details = {
      binary,
      args,
      stderr: error.stderr || "",
      stdout: error.stdout || "",
      exitCode: error.code,
    };
    throw wrapped;
  }
}

async function computeSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function getVideoMetadata(videoPath, config) {
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    videoPath,
  ];

  const { stdout } = await runCommand(config.ffprobeBin, args);
  const parsed = JSON.parse(stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video") || {};
  const stats = await fsp.stat(videoPath);

  const durationSec = Number(parsed?.format?.duration || 0);
  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);

  return {
    durationSec,
    width,
    height,
    sizeBytes: stats.size,
  };
}

async function extractAudio(videoPath, wavPath, config) {
  const args = [
    "-y",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-f", "wav",
    wavPath,
  ];
  await runCommand(config.ffmpegBin, args);
}

function parseWhisperTimestamp(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, "0").slice(0, 3));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function normalizeWhisperJson(payload) {
  const segments = [];

  if (Array.isArray(payload?.transcription)) {
    for (const item of payload.transcription) {
      const from = parseWhisperTimestamp(item?.timestamps?.from) ?? null;
      const to = parseWhisperTimestamp(item?.timestamps?.to) ?? null;
      const text = String(item?.text || "").trim();
      if (!text) continue;
      segments.push({
        startSec: from,
        endSec: to,
        text,
      });
    }
  } else if (Array.isArray(payload?.segments)) {
    for (const item of payload.segments) {
      const text = String(item?.text || "").trim();
      if (!text) continue;
      const startSec = Number(item.start ?? item.t0 ?? 0);
      const endSec = Number(item.end ?? item.t1 ?? startSec);
      segments.push({
        startSec: Number.isFinite(startSec) ? startSec : null,
        endSec: Number.isFinite(endSec) ? endSec : null,
        text,
      });
    }
  }

  let text = "";
  if (segments.length > 0) {
    text = segments.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  } else if (typeof payload?.text === "string") {
    text = payload.text.trim();
  } else if (typeof payload?.result === "string") {
    text = payload.result.trim();
  }

  return { text, segments };
}

async function runWhisper(audioPath, config) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "douyin-whisper-"));
  const outputPrefix = path.join(tempDir, "transcript");
  const args = [
    "-m", config.whisperModelPath,
    "-f", audioPath,
    "-oj",
    "-of", outputPrefix,
  ];

  if (config.whisperLang) {
    args.push("-l", config.whisperLang);
  }

  await runCommand(config.whisperBin, args);

  const expectedJson = `${outputPrefix}.json`;
  let jsonPath = expectedJson;
  if (!(await fileExists(jsonPath))) {
    const files = await fsp.readdir(tempDir);
    const found = files.find((file) => file.endsWith(".json"));
    if (!found) {
      throw new Error(`Whisper output JSON not found in ${tempDir}`);
    }
    jsonPath = path.join(tempDir, found);
  }

  const payload = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
  return normalizeWhisperJson(payload);
}

async function transcribeVideo(videoPath, videoSha256, config) {
  await ensureDir(config.transcriptCacheDir);

  const cachePath = path.join(config.transcriptCacheDir, `${videoSha256}.json`);
  const cached = await readJson(cachePath, null);
  if (cached && typeof cached.text === "string") {
    return {
      source: "cache",
      text: cached.text,
      segments: Array.isArray(cached.segments) ? cached.segments : [],
    };
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "douyin-asr-"));
  const wavPath = path.join(tmpDir, "audio.wav");

  try {
    await extractAudio(videoPath, wavPath, config);
    const transcription = await runWhisper(wavPath, config);
    const toCache = {
      text: transcription.text,
      segments: transcription.segments,
      updatedAt: new Date().toISOString(),
      videoSha256,
    };
    await writeJsonAtomic(cachePath, toCache, 0o600);

    return {
      source: "whisper",
      text: transcription.text,
      segments: transcription.segments,
    };
  } finally {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (_) {
      // Ignore cleanup failures.
    }
  }
}

function validateDurationOrThrow(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    const error = new Error("Cannot read video duration.");
    error.code = "VIDEO_DURATION_INVALID";
    throw error;
  }

  if (durationSec > LIMITS.maxDurationSec) {
    const error = new Error(`Video duration ${durationSec.toFixed(2)}s exceeds ${LIMITS.maxDurationSec}s.`);
    error.code = "VIDEO_DURATION_LIMIT";
    error.details = {
      durationSec,
      maxDurationSec: LIMITS.maxDurationSec,
    };
    throw error;
  }
}

module.exports = {
  computeSha256,
  getVideoMetadata,
  transcribeVideo,
  validateDurationOrThrow,
  runCommand,
};
