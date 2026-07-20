#!/usr/bin/env node
import fs from "fs";
import path from "path";
import argon2 from "argon2";
import readline from "readline";
import { Writable, Readable } from "stream";


// Load ES module dependencies from root
import * as fflate from "fflate";
import { bech32 } from "@scure/base";
import { Encrypter, identityToRecipient } from "age-encryption";

const DEFAULT_EMAIL = "";

function askEmail(query) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: new Writable({ write: () => {} })
      });
      rl.on("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

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
async function deriveAgeKeys(passphrase, email) {
  const privateKeyBytes = await argon2.hash(passphrase, {
    raw: true,
    salt: Buffer.from(email),
    timeCost: 3,
    memoryCost: 65536,
    hashLength: 32,
    parallelism: 1,
    type: argon2.argon2id,
  });

  // Encode to Bech32 matching age specification (uppercase prefix)
  const identity = bech32.encodeFromBytes("AGE-SECRET-KEY-", privateKeyBytes).toUpperCase();
  const recipient = await identityToRecipient(identity);

  return { identity, recipient };
}

function printUsage() {
  console.log(`
VaultDrive CLI Packaging Tool (.mjs)
-----------------------------
Scans a folder recursively for .webp thumbnails, pairs them with original files,
creates metadata zips, and encrypts them to numbered ID files.

Usage:
  node tools/vaultdrive-cli.mjs [options]

Options:
  --input, -i       Directory with original files and .webp images
  --output, -o      (Optional) Directory where mirrored encrypted structure is written.
                    If omitted, encrypts in-place inside 'encrypted/' folders.
  --start-id, -s    Starting ID number for file naming (increments globally for each file)
  --email, -e       Account email address for Argon2id salt derivation
  --keys, -k        Derive and display Public/Private keys from a passphrase, then exit
  --help, -h        Display this help message
`);
}

async function main() {
  const args = process.argv.slice(2);
  let inputDir = "";
  let outputDir = "";
  let startIdStr = "";
  let email = DEFAULT_EMAIL;
  let deriveOnly = false;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" || args[i] === "-i") {
      inputDir = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      outputDir = args[++i];
    } else if (args[i] === "--start-id" || args[i] === "-s") {
      startIdStr = args[++i];
    } else if (args[i] === "--email" || args[i] === "-e") {
      email = args[++i];
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

  // Ensure email is resolved
  if (!email || !email.trim()) {
    email = await askEmail("Enter account email: ");
    if (!email || !email.trim()) {
      console.error("\nError: Account email is required for key derivation.");
      process.exit(1);
    }
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
    console.log("\nDeriving keys with Argon2id...");
    const { identity, recipient } = await deriveAgeKeys(passphrase.trim(), email.trim());
    console.log(`Derived Public Key (Recipient):  ${recipient}`);
    console.log(`Derived Private Key (Identity):  ${identity}`);
    process.exit(0);
  }

  // 3. Normal packaging run — check required flags
  if (!inputDir || !startIdStr) {
    console.error("Error: Missing required arguments for encryption packaging. --input (-i) and --start-id (-s) are required.");
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

  // Resolve outputDir relative to inputDir if it's not an absolute path and is provided
  let resolvedOutputDir = "";
  if (outputDir) {
    resolvedOutputDir = path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(inputDir, outputDir);
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
  const { recipient } = await deriveAgeKeys(passphrase.trim(), email.trim());

  console.log(`Scanning directory recursively: ${inputDir}`);
  const state = { currentId };
  await processDir(inputDir, inputDir, resolvedOutputDir, recipient, state);

  console.log(`\nSuccess! Processing finished. Ending ID: ${state.currentId}`);
}

async function processDir(currentDir, inputDir, resolvedOutputDir, recipient, state) {
  // Read all items in the current directory
  const items = fs.readdirSync(currentDir);

  // Separate files and directories
  const files = [];
  const dirs = [];

  for (const item of items) {
    const fullPath = path.join(currentDir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Ignore directory named 'encrypted'
      if (item === "encrypted") continue;
      // Also ignore standard ignorable directories
      if (item === ".git" || item === "node_modules" || item === ".next") continue;
      dirs.push(fullPath);
    } else if (stat.isFile()) {
      files.push(item);
    }
  }

  // Filter for webp files in the current folder
  const webpFiles = files.filter((f) => f.toLowerCase().endsWith(".webp"));

  let targetOutputDir = "";
  let hasEncryptedFiles = false;

  if (webpFiles.length > 0) {
    // Determine output directory for this level
    if (resolvedOutputDir) {
      const relPath = path.relative(inputDir, currentDir);
      targetOutputDir = path.join(resolvedOutputDir, relPath);
    } else {
      targetOutputDir = path.join(currentDir, "encrypted");
    }

    for (const webpFile of webpFiles) {
      const baseName = path.parse(webpFile).name;
      const webpPath = path.join(currentDir, webpFile);

      // Find the original file matching this base name in current folder
      const origFile = files.find((f) => {
        const parts = path.parse(f);
        if (parts.name !== baseName || f === webpFile) return false;
        const fullPath = path.join(currentDir, f);
        try {
          return fs.statSync(fullPath).isFile();
        } catch {
          return false;
        }
      });

      if (!origFile) {
        continue;
      }

      if (!hasEncryptedFiles) {
        // Create directory on first write at this level
        if (!fs.existsSync(targetOutputDir)) {
          fs.mkdirSync(targetOutputDir, { recursive: true });
        }
        hasEncryptedFiles = true;
      }

      const origPath = path.join(currentDir, origFile);
      const origStat = fs.statSync(origPath);
      const origSize = origStat.size;

      const currentId = state.currentId;
      console.log(`[ID ${currentId}] Processing pair in ${path.relative(inputDir, currentDir) || "."}: ${origFile} <-> ${webpFile} (${(origSize / 1024).toFixed(1)} KB)`);

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
      const metaPath = path.join(targetOutputDir, metaFileName);
      fs.writeFileSync(metaPath, encryptedBytes);

      // 5b. Encrypt single-pass combined stream: [4-byte len] + [filename] + [file contents] -> age -> <ID>
      const filenameBytes = Buffer.from(origFile, "utf8");
      const lenBuffer = Buffer.alloc(4);
      lenBuffer.writeUInt32BE(filenameBytes.length, 0);
      const headerBuffer = Buffer.concat([lenBuffer, filenameBytes]);

      const nodeFileStream = fs.createReadStream(origPath);
      const combinedNodeStream = Readable.from((async function* () {
        yield headerBuffer;
        for await (const chunk of nodeFileStream) {
          yield chunk;
        }
      })());

      const webCombinedStream = Readable.toWeb(combinedNodeStream);
      const payloadEnc = new Encrypter();
      payloadEnc.addRecipient(recipient);

      const encryptedWebStream = await payloadEnc.encrypt(webCombinedStream);
      const nodeEncryptedReadStream = Readable.fromWeb(encryptedWebStream);

      const payloadFileName = `${currentId}`;
      const payloadPath = path.join(targetOutputDir, payloadFileName);
      const writeStream = fs.createWriteStream(payloadPath);

      await new Promise((resolve, reject) => {
        nodeEncryptedReadStream.pipe(writeStream);
        writeStream.on("finish", resolve);
        nodeEncryptedReadStream.on("error", reject);
        writeStream.on("error", reject);
      });

      state.currentId++;
    }
  }

  // Recursively process directories
  for (const dir of dirs) {
    await processDir(dir, inputDir, resolvedOutputDir, recipient, state);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
