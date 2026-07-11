#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { Writable } from "stream";

// Load ES module dependencies from root
import { bech32 } from "@scure/base";
import { Decrypter } from "age-encryption";

/**
 * Secure password input using terminal raw mode.
 */
function askPassphrase(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);

    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: new Writable({ write: () => {} })
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
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        if (char === "\u0003") {
          process.exit(0);
        }
        resolve(password);
      } else if (char === "\u007f" || char === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
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
function deriveAgeIdentity(passphrase) {
  const salt = Buffer.from("vaultdrive-deterministic-salt-x25519-generation");
  const privateKeyBytes = crypto.pbkdf2Sync(
    passphrase,
    salt,
    10000, // iterations
    32,    // length
    "sha256"
  );
  return bech32.encodeFromBytes("AGE-SECRET-KEY-", privateKeyBytes).toUpperCase();
}

function printUsage() {
  console.log(`
VaultDrive Decryption Tool
-----------------------------
Decrypts one or more combined payload files containing an encrypted filename and file body.

Usage:
  node tools/decrypt-file.mjs [options]

Options:
  --file, -f        Path to a single encrypted payload file
  --dir, -d         Path to a directory containing multiple encrypted payload files
  --output, -o      Output directory (default: current directory)
  --help, -h        Display this help message
`);
}

async function decryptSingleBuffer(rawBuffer, identity) {
  if (rawBuffer.length < 4) {
    throw new Error("File is too small to contain a valid header.");
  }

  const nameLen = rawBuffer.readUInt32BE(0);
  if (rawBuffer.length < 4 + nameLen) {
    throw new Error("Encrypted file is corrupted (name length mismatch).");
  }

  const encNameBytes = new Uint8Array(rawBuffer.subarray(4, 4 + nameLen));
  const encPayloadBytes = new Uint8Array(rawBuffer.subarray(4 + nameLen));

  // Decrypt filename
  let originalName = "";
  try {
    const nameDec = new Decrypter();
    nameDec.addIdentity(identity);
    const nameBytes = await nameDec.decrypt(encNameBytes);
    originalName = Buffer.from(nameBytes).toString("utf8");
  } catch (err) {
    throw new Error("Decryption failed for filename. Wrong passphrase?");
  }

  // Decrypt payload
  let decryptedPayload;
  try {
    const dec = new Decrypter();
    dec.addIdentity(identity);
    decryptedPayload = await dec.decrypt(encPayloadBytes);
  } catch (err) {
    throw new Error(`Decryption failed for payload: ${err.message}`);
  }

  return { originalName, decryptedPayload };
}

async function main() {
  const args = process.argv.slice(2);
  let filePath = "";
  let dirPath = "";
  let outputDir = ".";
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" || args[i] === "-f") {
      filePath = args[++i];
    } else if (args[i] === "--dir" || args[i] === "-d") {
      dirPath = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      outputDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      showHelp = true;
    }
  }

  if (showHelp) {
    printUsage();
    process.exit(0);
  }

  if (!filePath && !dirPath) {
    console.error("Error: Missing required argument --file (-f) or --dir (-d).");
    printUsage();
    process.exit(1);
  }

  if (filePath && dirPath) {
    console.error("Error: Cannot specify both --file and --dir.");
    process.exit(1);
  }

  // Find files to process
  const filesToDecrypt = [];
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: Encrypted file does not exist at ${filePath}`);
      process.exit(1);
    }
    filesToDecrypt.push({
      path: filePath,
      name: path.basename(filePath)
    });
  } else {
    if (!fs.existsSync(dirPath)) {
      console.error(`Error: Directory does not exist at ${dirPath}`);
      process.exit(1);
    }
    const dirFiles = fs.readdirSync(dirPath)
      .filter((file) => /^\d+$/.test(file)) // only match numeric IDs (e.g. 100, 101, skip .meta)
      .map((file) => ({
        path: path.join(dirPath, file),
        name: file
      }))
      .sort((a, b) => Number(a.name) - Number(b.name));

    if (dirFiles.length === 0) {
      console.error(`Error: No numeric encrypted payload files found in directory ${dirPath}`);
      process.exit(1);
    }
    filesToDecrypt.push(...dirFiles);
  }

  // Ask for passphrase once
  const passphrase = await askPassphrase("Enter decryption passphrase: ");
  if (!passphrase || !passphrase.trim()) {
    console.error("\nError: Passphrase cannot be empty.");
    process.exit(1);
  }

  const identity = deriveAgeIdentity(passphrase.trim());

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`\n🔑 Derived identity key. Processing ${filesToDecrypt.length} file(s)...`);

  let successCount = 0;
  for (const item of filesToDecrypt) {
    console.log(`Processing file: ${item.name}...`);
    try {
      const rawBuffer = fs.readFileSync(item.path);
      const { originalName, decryptedPayload } = await decryptSingleBuffer(rawBuffer, identity);

      const resolvedOutputPath = path.join(outputDir, originalName);
      fs.writeFileSync(resolvedOutputPath, decryptedPayload);

      console.log(`  \x1b[32m✓ Decrypted:\x1b[0m ${item.name} -> ${resolvedOutputPath}`);
      successCount++;
    } catch (err) {
      console.error(`  \x1b[31m✗ Failed:\x1b[0m ${item.name} - ${err.message}`);
    }
  }

  console.log(`\n🎉 Decryption finished. Successfully decrypted: ${successCount}/${filesToDecrypt.length} file(s).`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
