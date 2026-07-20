import fs from "fs";
import path from "path";
import argon2 from "argon2";
import { spawn } from "child_process";


// Core crypto libraries used to verify output
import * as fflate from "fflate";
import { bech32 } from "@scure/base";
import { Decrypter } from "age-encryption";

const TEST_DIR = path.resolve("./ignore/test-input");
const MIRROR_OUTPUT_DIR = path.resolve("./ignore/encrypted-output");
const DECRYPTED_DIR = path.resolve("./ignore/decrypted-output");
const PASSPHRASE = "test-secure-passphrase-12345";
const TEST_EMAIL = "test@example.com";
const START_ID = 100;

// Test cases grouped by directory level
const TEST_LEVELS = {
  ".": [
    { name: "file1.mp4", content: "mock mp4 file content bytes", thumb: "file1.webp", thumbContent: "fake-webp-image-bytes-1" },
    { name: "file4.mkv", content: "correct original file content here", thumb: "file4.webp", thumbContent: "original-thumbnail-bytes-here", isIntentionalFailure: true },
  ],
  "subfolder": [
    { name: "some-extremely-long-filename-to-verify-that-the-cli-tool-properly-handles-long-paths-without-crashing-or-truncating-buffers.txt", content: "simple text details file content", thumb: "some-extremely-long-filename-to-verify-that-the-cli-tool-properly-handles-long-paths-without-crashing-or-truncating-buffers.webp", thumbContent: "fake-webp-image-bytes-2" },
    { name: "file3.bin", content: "random binary content mock data 12345", thumb: "file3.webp", thumbContent: "fake-webp-image-bytes-3" },
  ]
};

const verificationState = {
  file4ExpectedSize: 0,
  file4ExpectedThumb: ""
};

/**
 * Derive deterministic X25519 identity keypair matching the browser implementation.
 */
async function deriveAgeIdentity(passphrase, email = TEST_EMAIL) {
  const privateKeyBytes = await argon2.hash(passphrase, {
    raw: true,
    salt: Buffer.from(email),
    timeCost: 3,
    memoryCost: 65536,
    hashLength: 32,
    parallelism: 1,
    type: argon2.argon2id,
  });
  return bech32.encodeFromBytes("AGE-SECRET-KEY-", privateKeyBytes).toUpperCase();
}

async function runPackager(args) {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 Spawning vaultdrive-cli.mjs with args: ${args.join(" ")}`);
    const child = spawn("node", [
      "tools/vaultdrive-cli.mjs",
      "-e", TEST_EMAIL,
      ...args
    ], { stdio: ["pipe", "pipe", "inherit"] });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      process.stdout.write(data);
      if (data.includes("Enter encryption passphrase:") || data.includes("Enter passphrase to derive keys:")) {
        child.stdin.write(PASSPHRASE + "\n");
      }
      if (data.includes("Confirm encryption passphrase:") || data.includes("Confirm passphrase:")) {
        child.stdin.write(PASSPHRASE + "\n");
        child.stdin.end();
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Packager exited with code ${code}`));
      }
    });
  });
}

async function verifyLevel(outputLevelDir, refLevelDir, testCases, identity) {
  console.log(`\n🧪 Verifying files in output level: ${outputLevelDir}`);

  if (!fs.existsSync(outputLevelDir)) {
    throw new Error(`Output directory does not exist: ${outputLevelDir}`);
  }

  const filesInDir = fs.readdirSync(outputLevelDir);
  const metaFiles = filesInDir.filter((f) => f.toLowerCase().endsWith(".meta"));

  if (metaFiles.length !== testCases.length) {
    throw new Error(`Expected ${testCases.length} meta files, but found ${metaFiles.length} at ${outputLevelDir}`);
  }

  let failedIntentionalCount = 0;
  let hasRealFailures = false;

  // Sort metaFiles numerically by their ID
  const sortedMetaFiles = metaFiles.sort((a, b) => {
    const aId = Number(path.parse(a).name);
    const bId = Number(path.parse(b).name);
    return aId - bId;
  });

  for (const metaFile of sortedMetaFiles) {
    const fileId = path.parse(metaFile).name;
    const metaPath = path.join(outputLevelDir, metaFile);

    const report = {
      decryption: { status: "pending", details: "" },
      unzip: { status: "pending", details: "" },
      detailsJson: { status: "pending", details: "" },
      thumbnail: { status: "pending", details: "" },
      payload: { status: "pending", details: "" }
    };

    const printStep = (stepName, stepData) => {
      const icon = stepData.status === "passed" ? "✓" : "✗";
      const color = stepData.status === "passed" ? "\x1b[32m" : "\x1b[31m";
      const reset = "\x1b[0m";
      console.log(`  [${color}${icon}${reset}] ${stepName}: ${stepData.details}`);
    };

    let originalName = "";
    let testCase = null;
    let isIntentionalFailure = false;

    try {
      // 1. Decrypt meta file bytes using age
      let zipBytes;
      try {
        const encryptedBytes = new Uint8Array(fs.readFileSync(metaPath));
        const dec = new Decrypter();
        dec.addIdentity(identity);
        zipBytes = await dec.decrypt(encryptedBytes);
        report.decryption = { status: "passed", details: "Decrypted successfully using derived identity key" };
      } catch (decErr) {
        report.decryption = { status: "failed", details: `Decryption failed: ${decErr.message}` };
        throw decErr;
      }

      // 2. Unzip contents in-memory
      let unzipped;
      try {
        unzipped = fflate.unzipSync(zipBytes);
        report.unzip = { status: "passed", details: "Zip archive decompressed successfully" };
      } catch (unzipErr) {
        report.unzip = { status: "failed", details: `Decompression failed: ${unzipErr.message}` };
        throw unzipErr;
      }

      // 3. Verify details.json structure and values
      const detailsBytes = unzipped["details.json"];
      if (!detailsBytes) {
        report.detailsJson = { status: "failed", details: "details.json file missing from the decrypted package" };
        throw new Error("details.json missing");
      }

      let details;
      try {
        details = JSON.parse(fflate.strFromU8(detailsBytes));
      } catch (jsonErr) {
        report.detailsJson = { status: "failed", details: `JSON parse failed: ${jsonErr.message}` };
        throw jsonErr;
      }

      originalName = details.name;
      testCase = testCases.find((tc) => tc.name === originalName);
      if (!testCase) {
        report.detailsJson = { status: "failed", details: `Filename in JSON "${originalName}" does not match any test case.` };
        throw new Error(`Filename in JSON "${originalName}" not found in test suite.`);
      }
      isIntentionalFailure = testCase.isIntentionalFailure ?? false;

      console.log(`\nChecking ${metaFile} (${originalName})${isIntentionalFailure ? " [Intentional Failure Case]" : ""}...`);

      const expectedSize = isIntentionalFailure ? verificationState.file4ExpectedSize : Buffer.byteLength(testCase.content);
      if (details.extra?.size_bytes !== expectedSize) {
        report.detailsJson = { status: "failed", details: `Size mismatch! Expected: ${expectedSize} bytes, Decrypted: ${details.extra?.size_bytes} bytes` };
        throw new Error("JSON Size mismatch");
      }
      report.detailsJson = { status: "passed", details: `Valid schema. Matches name "${details.name}" and size ${details.extra.size_bytes} bytes` };

      // 4. Verify thumbnail image bytes
      const thumbBytes = unzipped["thumbnail.webp"];
      if (!thumbBytes) {
        report.thumbnail = { status: "failed", details: "thumbnail.webp missing from decrypted package" };
        throw new Error("thumbnail.webp missing");
      }

      const expectedThumb = isIntentionalFailure ? verificationState.file4ExpectedThumb : testCase.thumbContent;
      const thumbContent = fflate.strFromU8(thumbBytes);
      if (thumbContent !== expectedThumb) {
        report.thumbnail = { status: "failed", details: `Byte mismatch! Image bytes did not match the original webp file.` };
        throw new Error("Thumbnail mismatch");
      }
      report.thumbnail = { status: "passed", details: "Image bytes match the original webp thumbnail perfectly" };

      // 5. Verify original file payload
      const payloadPath = path.join(outputLevelDir, String(fileId));
      if (!fs.existsSync(payloadPath)) {
        report.payload = { status: "failed", details: `Payload file not found on disk at ${payloadPath}` };
        throw new Error("Payload file not found");
      }

      let decryptedPayload;
      let decryptedName = "";
      try {
        const rawBuffer = new Uint8Array(fs.readFileSync(payloadPath));
        const dec = new Decrypter();
        dec.addIdentity(identity);
        const unencryptedBytes = await dec.decrypt(rawBuffer);

        const nameLen = Buffer.from(unencryptedBytes.buffer, unencryptedBytes.byteOffset, 4).readUInt32BE(0);
        decryptedName = Buffer.from(unencryptedBytes.buffer, unencryptedBytes.byteOffset + 4, nameLen).toString("utf8");

        if (decryptedName !== originalName) {
          throw new Error(`Filename mismatch! Decrypted: "${decryptedName}", Expected: "${originalName}"`);
        }

        decryptedPayload = unencryptedBytes.subarray(4 + nameLen);
        
        report.payload = { status: "passed", details: `Decrypted name "${decryptedName}" and payload successfully using derived key` };
      } catch (payErr) {
        report.payload = { status: "failed", details: `Payload verification failed: ${payErr.message}` };
        throw payErr;
      }

      const expectedPayload = Buffer.from(testCase.content);
      const isPayloadMatch = Buffer.compare(Buffer.from(decryptedPayload), expectedPayload) === 0;
      if (!isPayloadMatch) {
        report.payload = { status: "failed", details: "Byte mismatch! Decrypted payload does not match original file." };
        throw new Error("Payload content mismatch");
      }
      report.payload = { status: "passed", details: `Payload bytes match the original file "${originalName}" perfectly` };

      // Write decrypted payload file to disk for inspection
      const decryptedFilePath = path.join(DECRYPTED_DIR, decryptedName);
      fs.mkdirSync(path.dirname(decryptedFilePath), { recursive: true });
      fs.writeFileSync(decryptedFilePath, decryptedPayload);

      // Print all passed steps
      printStep("Age Decryption", report.decryption);
      printStep("Zip Decompression", report.unzip);
      printStep("details.json Verification", report.detailsJson);
      printStep("thumbnail.webp Verification", report.thumbnail);
      printStep("Payload Verification", report.payload);

      if (isIntentionalFailure) {
        throw new Error(`Intentional failure case succeeded when it was expected to fail.`);
      }

    } catch (err) {
      if (isIntentionalFailure) {
        failedIntentionalCount++;
        if (report.decryption.status !== "pending") printStep("Age Decryption", report.decryption);
        if (report.unzip.status !== "pending") printStep("Zip Decompression", report.unzip);
        if (report.detailsJson.status !== "pending") printStep("details.json Verification", report.detailsJson);
        if (report.thumbnail.status !== "pending") printStep("thumbnail.webp Verification", report.thumbnail);
        if (report.payload.status !== "pending") printStep("Payload Verification", report.payload);
        
        console.log(`  \x1b[33m⚠️ Verification failed as expected!\x1b[0m`);
      } else {
        hasRealFailures = true;
        if (report.decryption.status !== "pending") printStep("Age Decryption", report.decryption);
        if (report.unzip.status !== "pending") printStep("Zip Decompression", report.unzip);
        if (report.detailsJson.status !== "pending") printStep("details.json Verification", report.detailsJson);
        if (report.thumbnail.status !== "pending") printStep("thumbnail.webp Verification", report.thumbnail);
        if (report.payload.status !== "pending") printStep("Payload Verification", report.payload);
        
        console.log(`  \x1b[31m❌ Verification failed!\x1b[0m error: ${err.message}`);
      }
    }
  }

  if (hasRealFailures) {
    throw new Error("One or more real verification checks failed.");
  }

  return failedIntentionalCount;
}

async function verifyAllLevels(outputBaseDir, isMirrorMode) {
  const identity = await deriveAgeIdentity(PASSPHRASE, TEST_EMAIL);
  console.log(`🔑 Derived verification identity key: ${identity}`);

  let totalFailedIntentional = 0;

  for (const [level, testCases] of Object.entries(TEST_LEVELS)) {
    const levelOutputDir = isMirrorMode
      ? path.join(outputBaseDir, level)
      : path.join(TEST_DIR, level, "encrypted");

    const refLevelDir = path.join(TEST_DIR, level);
    const failedIntentionalCount = await verifyLevel(levelOutputDir, refLevelDir, testCases, identity);
    totalFailedIntentional += failedIntentionalCount;
  }

  if (totalFailedIntentional !== 1) {
    throw new Error(`Intentional failure checks did not fail properly. Expected 1 failure, got ${totalFailedIntentional}`);
  }
}

function recreateCleanTestDir() {
  const parentIgnoreDir = path.resolve("./ignore");
  if (fs.existsSync(parentIgnoreDir)) {
    fs.rmSync(parentIgnoreDir, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(MIRROR_OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(DECRYPTED_DIR, { recursive: true });

  console.log("📦 Creating mock files inside ignore/ folder hierarchy...");
  for (const [level, testCases] of Object.entries(TEST_LEVELS)) {
    const levelDir = path.join(TEST_DIR, level);
    fs.mkdirSync(levelDir, { recursive: true });
    testCases.forEach((tc) => {
      fs.writeFileSync(path.join(levelDir, tc.name), tc.content);
      fs.writeFileSync(path.join(levelDir, tc.thumb), tc.thumbContent);
    });
  }

  // Set reference verification values for intentional failure (searching all levels)
  const file4Case = Object.values(TEST_LEVELS).flat().find(tc => tc.isIntentionalFailure);
  verificationState.file4ExpectedSize = Buffer.byteLength(file4Case.content);
  verificationState.file4ExpectedThumb = file4Case.thumbContent;
}

async function run() {
  try {
    // === PHASE 1: TEST MIRROR MODE (-o flag set) ===
    console.log("\n==================================================");
    console.log("🚀 PHASE 1: Testing Mirrored Structure Mode (-o)");
    console.log("==================================================");
    recreateCleanTestDir();

    await runPackager([
      "-i", TEST_DIR,
      "-o", MIRROR_OUTPUT_DIR,
      "-s", String(START_ID)
    ]);

    // Corrupt reference values for verify level intentional check
    verificationState.file4ExpectedSize = 999999;
    verificationState.file4ExpectedThumb = "original-thumbn";

    await verifyAllLevels(MIRROR_OUTPUT_DIR, true);
    console.log("🟢 Phase 1 (Mirror Mode) Passed.");

    // === PHASE 2: TEST IN-PLACE MODE (no -o flag) ===
    console.log("\n==================================================");
    console.log("🚀 PHASE 2: Testing In-Place Mode (no -o)");
    console.log("==================================================");
    recreateCleanTestDir();

    await runPackager([
      "-i", TEST_DIR,
      "-s", String(START_ID)
    ]);

    // Corrupt reference values for verify level intentional check
    verificationState.file4ExpectedSize = 999999;
    verificationState.file4ExpectedThumb = "original-thumbn";

    await verifyAllLevels(TEST_DIR, false);
    console.log("🟢 Phase 2 (In-Place Mode) Passed.");

    console.log("\n🎉 ALL TEST PHASES SUCCEEDED!");
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  }
}

run();
