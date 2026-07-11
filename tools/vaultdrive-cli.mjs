#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { Writable } from "stream";

// Load ES module dependencies from root
import * as fflate from "fflate";
import { bech32 } from "@scure/base";
import { Encrypter, identityToRecipient } from "age-encryption";

/**
 * Secure password input using terminal raw mode.
 * Resolves the issue where readline control keys were converted into extra asterisks.
 */
function askPassphrase(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);

    if (!process.stdin.isTTY) {
      // Fallback for non-TTY piped streams (like test scripts)
      const rl = readline.createInterface({
        input: process.stdin,
        output: new Writable({ write: () => {} }) // discard echo
      });
      rl.on("line", (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let password = "";
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "\u0003") {
        // Enter or Ctrl+C
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        if (char === "\u0003") {
          process.exit(0);
        }
        resolve(password);
      } else if (char === "\u007f" || char === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        // Character input
        password += char;
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Derive deterministic X25519 identity keypair matching the browser implementation.
 */
async function deriveAgeKeys(passphrase) {
  const salt = Buffer.from("vaultdrive-deterministic-salt-x25519-generation");
  const privateKeyBytes = crypto.pbkdf2Sync(
    passphrase,
    salt,
    10000, // iterations
    32,    // length
    "sha256"
  );

  // Encode to Bech32 matching age specification (uppercase prefix)
  const identity = bech32.encodeFromBytes("AGE-SECRET-KEY-", privateKeyBytes).toUpperCase();
  const recipient = await identityToRecipient(identity);

  return { identity, recipient };
}

function printUsage() {
  console.log(`
VaultDrive CLI Packaging Tool (.mjs)
-----------------------------
Scans a folder for .webp thumbnails, pairs them with original files,
creates metadata zips, encrypts them to numbered ID files, and saves mapping.

Usage:
  node tools/vaultdrive-cli.mjs [options]

Options:
  --input, -i       Directory with original files and .webp images
  --output, -o      Directory where encrypted <ID>.meta files will be written
  --start-id, -s    Starting ID number for file naming (increments for each file)
  --keys, -k        Derive and display Public/Private keys from a passphrase, then exit
  --help, -h        Display this help message
`);
}

async function main() {
  const args = process.argv.slice(2);
  let inputDir = "";
  let outputDir = "";
  let startIdStr = "";
  let deriveOnly = false;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" || args[i] === "-i") {
      inputDir = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      outputDir = args[++i];
    } else if (args[i] === "--start-id" || args[i] === "-s") {
      startIdStr = args[++i];
    } else if (args[i] === "--keys" || args[i] === "-k") {
      deriveOnly = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      showHelp = true;
    }
  }

  // 1. Handle help message
  if (showHelp) {
    printUsage();
    process.exit(0);
  }

  // 2. Handle key derivation mode
  if (deriveOnly) {
    const passphrase = await askPassphrase("Enter passphrase to derive keys: ");
    if (!passphrase || !passphrase.trim()) {
      console.error("\nError: Passphrase cannot be empty.");
      process.exit(1);
    }
    const confirm = await askPassphrase("Confirm passphrase: ");
    if (passphrase !== confirm) {
      console.error("\nError: Passphrases do not match.");
      process.exit(1);
    }
    console.log("\nDeriving keys...");
    const { identity, recipient } = await deriveAgeKeys(passphrase.trim());
    console.log(`Derived Public Key (Recipient):  ${recipient}`);
    console.log(`Derived Private Key (Identity):  ${identity}`);
    process.exit(0);
  }

  // 3. Normal packaging run — check required flags
  if (!inputDir || !outputDir || !startIdStr) {
    console.error("Error: Missing required arguments for encryption packaging.");
    printUsage();
    process.exit(1);
  }

  let currentId = parseInt(startIdStr, 10);
  if (isNaN(currentId)) {
    console.error("Error: --start-id must be a valid integer.");
    process.exit(1);
  }

  if (!fs.existsSync(inputDir)) {
    console.error(`Error: Input directory does not exist: ${inputDir}`);
    process.exit(1);
  }

  // Resolve outputDir relative to inputDir if it's not an absolute path
  const resolvedOutputDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(inputDir, outputDir);

  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  // Ask for passphrase securely
  const passphrase = await askPassphrase("Enter encryption passphrase: ");
  if (!passphrase || !passphrase.trim()) {
    console.error("\nError: Passphrase cannot be empty.");
    process.exit(1);
  }
  const confirm = await askPassphrase("Confirm encryption passphrase: ");
  if (passphrase !== confirm) {
    console.error("\nError: Passphrases do not match.");
    process.exit(1);
  }

  // Derive keys silently for the packaging run
  const { recipient } = await deriveAgeKeys(passphrase.trim());

  // Scan input directory for files
  const files = fs.readdirSync(inputDir);
  const webpFiles = files.filter((f) => f.toLowerCase().endsWith(".webp"));

  if (webpFiles.length === 0) {
    console.log("No .webp thumbnail files found in the input folder.");
    process.exit(0);
  }

  console.log(`Found ${webpFiles.length} thumbnail(s). Processing...`);
  const mapping = {};

  for (const webpFile of webpFiles) {
    const baseName = path.parse(webpFile).name;

    const webpPath = path.join(inputDir, webpFile);
    // Ensure the webp target is a file, not a directory
    if (!fs.statSync(webpPath).isFile()) continue;

    // Find the original file matching this base name (must be a file, not a folder)
    const origFile = files.find((f) => {
      const parts = path.parse(f);
      if (parts.name !== baseName || f === webpFile) return false;
      const fullPath = path.join(inputDir, f);
      try {
        return fs.statSync(fullPath).isFile();
      } catch {
        return false;
      }
    });

    if (!origFile) {
      console.warn(`Warning: Could not find matching original file for thumbnail: ${webpFile}`);
      continue;
    }

    const origPath = path.join(inputDir, origFile);
    const origStat = fs.statSync(origPath);
    const origSize = origStat.size;

    console.log(`Processing pair: ${origFile} <-> ${webpFile} (${(origSize / 1024).toFixed(1)} KB)`);

    // 1. Create details JSON
    const details = {
      name: origFile,
      date: new Date().toISOString(),
      extra: {
        size_bytes: origSize,
      },
    };

    // 2. Read thumbnail webp bytes
    const webpBytes = new Uint8Array(fs.readFileSync(webpPath));

    // 3. Zip files in-memory (no compression used as storage container)
    const zipData = fflate.zipSync(
      {
        "details.json": fflate.strToU8(JSON.stringify(details)),
        "thumbnail.webp": webpBytes,
      },
      { level: 0 }
    );

    // 4. Encrypt zip bytes using Derived Recipient Key
    const enc = new Encrypter();
    enc.addRecipient(recipient);
    const encryptedBytes = await enc.encrypt(zipData);

    // 5. Output file as <ID>.meta
    const metaFileName = `${currentId}.meta`;
    const metaPath = path.join(resolvedOutputDir, metaFileName);
    fs.writeFileSync(metaPath, encryptedBytes);

    // 5b. Encrypt filename and payload, output combined package as <ID>
    // Encrypt filename
    const filenameBytes = Buffer.from(origFile, "utf8");
    const nameEnc = new Encrypter();
    nameEnc.addRecipient(recipient);
    const encryptedNameBytes = await nameEnc.encrypt(filenameBytes);

    // Encrypt payload
    const origBytes = new Uint8Array(fs.readFileSync(origPath));
    const payloadEnc = new Encrypter();
    payloadEnc.addRecipient(recipient);
    const encryptedPayloadBytes = await payloadEnc.encrypt(origBytes);

    // Combine: [4-byte big-endian name length] + [encrypted name] + [encrypted payload]
    const lenBuffer = Buffer.alloc(4);
    lenBuffer.writeUInt32BE(encryptedNameBytes.length, 0);

    const finalBuffer = Buffer.concat([
      lenBuffer,
      Buffer.from(encryptedNameBytes),
      Buffer.from(encryptedPayloadBytes),
    ]);

    const payloadFileName = `${currentId}`;
    const payloadPath = path.join(resolvedOutputDir, payloadFileName);
    fs.writeFileSync(payloadPath, finalBuffer);

    // 6. Record mapping
    mapping[currentId] = origFile;

    console.log(`  -> Encrypted to ${metaFileName} and payload ${payloadFileName} with ID ${currentId}`);
    
    // Increment ID for the next file
    currentId++;
  }

  // Save the ID-to-filename mapping index
  const mappingPath = path.join(resolvedOutputDir, "mapping.json");
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  console.log(`\nMapping table written to: ${mappingPath}`);
  console.log("Success! Processing finished.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
