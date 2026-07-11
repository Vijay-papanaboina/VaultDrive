import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

// Core crypto libraries used to verify output
import * as fflate from "fflate";
import { bech32 } from "@scure/base";
import { Decrypter } from "age-encryption";

const TEST_DIR = path.resolve("./ignore");
const OUTPUT_DIR = path.resolve("./ignore/encrypted-output");
const DECRYPTED_DIR = path.resolve("./ignore/decrypted-output");
const PASSPHRASE = "test-secure-passphrase-12345";
const START_ID = 100;

// Test cases data (including one intentional failure test case)
const TEST_CASES = [
  { name: "file1.mp4", content: "mock mp4 file content bytes", thumb: "file1.webp", thumbContent: "fake-webp-image-bytes-1" },
  { name: "file2.txt", content: "simple text details file content", thumb: "file2.webp", thumbContent: "fake-webp-image-bytes-2" },
  { name: "file3.bin", content: "random binary content mock data 12345", thumb: "file3.webp", thumbContent: "fake-webp-image-bytes-3" },
  { name: "file4.mkv", content: "correct original file content here", thumb: "file4.webp", thumbContent: "original-thumbnail-bytes-here", isIntentionalFailure: true },
];

// Reference tracking variables used during verification
const verificationState = {
  file4ExpectedSize: 0,
  file4ExpectedThumb: ""
};

/**
 * Derive deterministic X25519 identity keypair matching the browser implementation.
 */
function deriveAgeIdentity(passphrase) {
  const salt = Buffer.from("vaultdrive-deterministic-salt-x25519-generation");
  const privateKeyBytes = crypto.pbkdf2Sync(
    passphrase,
    salt,
    10000,
    32,
    "sha256"
  );
  return bech32.encodeFromBytes("AGE-SECRET-KEY-", privateKeyBytes).toUpperCase();
}

async function runPackager() {
  return new Promise((resolve, reject) => {
    console.log("🚀 Spawning vaultdrive-cli.mjs...");
    const child = spawn("node", [
      "tools/vaultdrive-cli.mjs",
      "-i", "ignore",
      "-o", "encrypted-output",
      "-s", String(START_ID)
    ], { stdio: ["pipe", "pipe", "inherit"] });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      process.stdout.write(data);
      if (data.includes("Enter decryption passphrase:")) {
        // Auto-input passphrase when prompt appears
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

async function verifyOutput() {
  console.log("\n🧪 Running verification checks on output files...");

  // 1. Read mapping.json
  const mappingPath = path.join(OUTPUT_DIR, "mapping.json");
  if (!fs.existsSync(mappingPath)) {
    throw new Error(`mapping.json not found at ${mappingPath}`);
  }
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  console.log("✅ mapping.json exists.");

  // Derive private identity key
  const identity = deriveAgeIdentity(PASSPHRASE);
  console.log(`🔑 Derived verification identity key: ${identity}`);

  let failedIntentionalCount = 0;
  let hasRealFailures = false;

  const fileIds = Object.keys(mapping).map(Number).sort((a, b) => a - b);

  // 2. Loop through every single file in mapping.json (checks both test cases and preexisting files)
  for (const fileId of fileIds) {
    const originalName = mapping[fileId];
    const metaFileName = `${fileId}.meta`;
    const metaPath = path.join(OUTPUT_DIR, metaFileName);

    // Look for matching mock test case
    const testCase = TEST_CASES.find((tc) => tc.name === originalName);
    const isIntentionalFailure = testCase?.isIntentionalFailure ?? false;

    console.log(`\nChecking ${metaFileName} (${originalName})${isIntentionalFailure ? " [Intentional Failure Case]" : ""}...`);

    const report = {
      mapping: { status: "pending", details: "" },
      decryption: { status: "pending", details: "" },
      unzip: { status: "pending", details: "" },
      detailsJson: { status: "pending", details: "" },
      thumbnail: { status: "pending", details: "" },
      payload: { status: "pending", details: "" }
    };

    // Helper to print step results clearly
    const printStep = (stepName, stepData) => {
      const icon = stepData.status === "passed" ? "✓" : "✗";
      const color = stepData.status === "passed" ? "\x1b[32m" : "\x1b[31m";
      const reset = "\x1b[0m";
      console.log(`  [${color}${icon}${reset}] ${stepName}: ${stepData.details}`);
    };

    try {
      // 1. Verify mapping name match
      if (testCase) {
        if (mapping[fileId] !== testCase.name) {
          report.mapping = { status: "failed", details: `Mismatch! Expected: "${testCase.name}", Got: "${mapping[fileId]}"` };
          throw new Error("Mapping check failed");
        }
        report.mapping = { status: "passed", details: `Matches test case "${testCase.name}"` };
      } else {
        // Fallback for pre-existing files: verify file exists on disk
        const refPath = path.join(TEST_DIR, originalName);
        if (!fs.existsSync(refPath)) {
          report.mapping = { status: "failed", details: `Reference file "${originalName}" not found in ignore/ directory` };
          throw new Error("Reference file check failed");
        }
        report.mapping = { status: "passed", details: `Found original reference file on disk: "${originalName}"` };
      }

      // Verify meta file exists on disk
      if (!fs.existsSync(metaPath)) {
        report.decryption = { status: "failed", details: `File not found on disk at ${metaPath}` };
        throw new Error("Meta file not found");
      }

      // 2. Decrypt file bytes using age
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

      // 3. Unzip contents in-memory
      let unzipped;
      try {
        unzipped = fflate.unzipSync(zipBytes);
        report.unzip = { status: "passed", details: "Zip archive decompressed successfully" };
      } catch (unzipErr) {
        report.unzip = { status: "failed", details: `Decompression failed: ${unzipErr.message}` };
        throw unzipErr;
      }

      // 4. Verify details.json structure and values
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

      if (details.name !== originalName) {
        report.detailsJson = { status: "failed", details: `Filename in JSON mismatch! Expected: "${originalName}", Decrypted: "${details.name}"` };
        throw new Error("JSON Name mismatch");
      }

      // Compute expected size (either corrupted mock expected value, mock value, or actual file stat from disk)
      let expectedSize;
      if (testCase) {
        expectedSize = isIntentionalFailure ? verificationState.file4ExpectedSize : Buffer.byteLength(testCase.content);
      } else {
        expectedSize = fs.statSync(path.join(TEST_DIR, originalName)).size;
      }

      if (details.extra?.size_bytes !== expectedSize) {
        report.detailsJson = { status: "failed", details: `Size mismatch! Expected: ${expectedSize} bytes, Decrypted: ${details.extra?.size_bytes} bytes` };
        throw new Error("JSON Size mismatch");
      }
      report.detailsJson = { status: "passed", details: `Valid schema. Matches name "${details.name}" and size ${details.extra.size_bytes} bytes` };

      // 5. Verify thumbnail image bytes
      const thumbBytes = unzipped["thumbnail.webp"];
      if (!thumbBytes) {
        report.thumbnail = { status: "failed", details: "thumbnail.webp missing from decrypted package" };
        throw new Error("thumbnail.webp missing");
      }

      let expectedThumb;
      if (testCase) {
        expectedThumb = isIntentionalFailure ? verificationState.file4ExpectedThumb : testCase.thumbContent;
      } else {
        // Read actual webp thumbnail content from disk
        const thumbName = originalName.substring(0, originalName.lastIndexOf(".")) + ".webp";
        expectedThumb = fs.readFileSync(path.join(TEST_DIR, thumbName), "utf8");
      }

      const thumbContent = fflate.strFromU8(thumbBytes);
      if (thumbContent !== expectedThumb) {
        report.thumbnail = { status: "failed", details: `Byte mismatch! Image bytes did not match the original webp file.` };
        throw new Error("Thumbnail mismatch");
      }
      report.thumbnail = { status: "passed", details: "Image bytes match the original webp thumbnail perfectly" };

      // 6. Verify original file payload
      const payloadPath = path.join(OUTPUT_DIR, String(fileId));
      if (!fs.existsSync(payloadPath)) {
        report.payload = { status: "failed", details: `Payload file not found on disk at ${payloadPath}` };
        throw new Error("Payload file not found");
      }

      let decryptedPayload;
      let decryptedName = "";
      try {
        const rawBuffer = fs.readFileSync(payloadPath);
        if (rawBuffer.length < 4) throw new Error("File too small to contain length header");
        const nameLen = rawBuffer.readUInt32BE(0);
        
        if (rawBuffer.length < 4 + nameLen) throw new Error("File corrupted: length mismatch");
        const encName = new Uint8Array(rawBuffer.subarray(4, 4 + nameLen));
        const encPayload = new Uint8Array(rawBuffer.subarray(4 + nameLen));

        // Decrypt filename
        const nameDec = new Decrypter();
        nameDec.addIdentity(identity);
        const nameBytes = await nameDec.decrypt(encName);
        decryptedName = Buffer.from(nameBytes).toString("utf8");

        if (decryptedName !== originalName) {
          throw new Error(`Filename mismatch! Decrypted: "${decryptedName}", Expected: "${originalName}"`);
        }

        // Decrypt payload
        const dec = new Decrypter();
        dec.addIdentity(identity);
        decryptedPayload = await dec.decrypt(encPayload);
        
        report.payload = { status: "passed", details: `Decrypted name "${decryptedName}" and payload successfully using derived key` };
      } catch (payErr) {
        report.payload = { status: "failed", details: `Payload verification failed: ${payErr.message}` };
        throw payErr;
      }

      // Compare decrypted payload bytes with original file bytes
      let expectedPayload;
      if (testCase) {
        expectedPayload = Buffer.from(testCase.content);
      } else {
        expectedPayload = fs.readFileSync(path.join(TEST_DIR, originalName));
      }

      const isPayloadMatch = Buffer.compare(Buffer.from(decryptedPayload), expectedPayload) === 0;
      if (!isPayloadMatch) {
        report.payload = { status: "failed", details: "Byte mismatch! Decrypted payload does not match original file." };
        throw new Error("Payload content mismatch");
      }
      report.payload = { status: "passed", details: `Payload bytes match the original file "${originalName}" perfectly` };

      // Write decrypted payload file to disk for inspection
      const decryptedFilePath = path.join(DECRYPTED_DIR, decryptedName);
      fs.writeFileSync(decryptedFilePath, decryptedPayload);

      // Print all passed steps
      printStep("Mapping Check", report.mapping);
      printStep("Age Decryption", report.decryption);
      printStep("Zip Decompression", report.unzip);
      printStep("details.json Verification", report.detailsJson);
      printStep("thumbnail.webp Verification", report.thumbnail);
      printStep("Payload Verification", report.payload);

      // If this was an intentional failure case but it fully succeeded, that is an error.
      if (isIntentionalFailure) {
        throw new Error(`Intentional failure case succeeded when it was expected to fail.`);
      }

    } catch (err) {
      if (isIntentionalFailure) {
        failedIntentionalCount++;
        // Print the statuses leading up to the failure so the user sees exactly what failed
        printStep("Mapping Check", report.mapping);
        if (report.decryption.status !== "pending") printStep("Age Decryption", report.decryption);
        if (report.unzip.status !== "pending") printStep("Zip Decompression", report.unzip);
        if (report.detailsJson.status !== "pending") printStep("details.json Verification", report.detailsJson);
        if (report.thumbnail.status !== "pending") printStep("thumbnail.webp Verification", report.thumbnail);
        if (report.payload.status !== "pending") printStep("Payload Verification", report.payload);
        
        console.log(`  \x1b[33m⚠️ Verification failed as expected!\x1b[0m`);
      } else {
        // Real verification failure
        hasRealFailures = true;
        printStep("Mapping Check", report.mapping);
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

  if (failedIntentionalCount === 1) {
    console.log("\n🎉 ALL VERIFICATION CHECKS PASSED (and intentional failure test failed successfully!)");
  } else {
    throw new Error("Intentional failure check did not fail.");
  }
}

async function run() {
  try {
    // Make sure test directory exists
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }

    // Clear output folder of metadata files to ensure fresh run,
    // but KEEP preexisting manual webp/media files in "ignore/" so the user's manual tests are preserved
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(DECRYPTED_DIR)) {
      fs.rmSync(DECRYPTED_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DECRYPTED_DIR, { recursive: true });

    console.log("📦 Creating mock files inside ignore/ folder...");
    TEST_CASES.forEach((tc) => {
      fs.writeFileSync(path.join(TEST_DIR, tc.name), tc.content);
      fs.writeFileSync(path.join(TEST_DIR, tc.thumb), tc.thumbContent);
    });

    // Capture correct states before we overwrite reference data
    const file4Case = TEST_CASES.find(tc => tc.isIntentionalFailure);
    verificationState.file4ExpectedSize = Buffer.byteLength(file4Case.content);
    verificationState.file4ExpectedThumb = file4Case.thumbContent;

    // Run the packager CLI
    await runPackager();

    // Now corrupt/change reference values for the intentional failure checks
    console.log("\n⚠️ Corrupting reference variables for verification of file4.mkv...");
    verificationState.file4ExpectedSize = 999999;
    verificationState.file4ExpectedThumb = "original-thumbn"; // cut in half

    // Verify results
    await verifyOutput();

  } catch (err) {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  }
}

run();
