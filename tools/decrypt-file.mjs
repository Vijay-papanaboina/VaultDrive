#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { Writable, Readable } from "stream";

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
Decrypts one or more encrypted files recursively.

Usage:
  node tools/decrypt-file.mjs [options]

Options:
  --file, -f        Path to a single encrypted file (payload or meta)
  --dir, -d         Path to a directory containing encrypted files to scan recursively
  --output, -o      (Optional) Directory where mirrored decrypted structure is written.
                    If omitted, decrypts in-place inside 'decrypted/' folders.
  --help, -h        Display this help message
`);
}

/**
 * Detects if a file is age-encrypted and if it is plain (like a .meta file)
 * or packaged (with a prepended 4-byte filename length and filename).
 */
function detectFileType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buffer, 0, 4, 0);
    if (bytesRead < 4) {
      return { isAge: false };
    }

    // Check direct magic first (at offset 0)
    const directMagicBuffer = Buffer.alloc(21);
    const directRead = fs.readSync(fd, directMagicBuffer, 0, 21, 0);
    if (directRead === 21 && directMagicBuffer.toString("utf8") === "age-encryption.org/v1") {
      return { isAge: true, type: "plain" };
    }

    // Now check if it's a packaged payload file
    const nameLen = buffer.readUInt32BE(0);
    // Sanity check: is nameLen reasonable? (e.g. < 4096 bytes)
    if (nameLen > 0 && nameLen < 4096) {
      const packageMagicBuffer = Buffer.alloc(21);
      const packageRead = fs.readSync(fd, packageMagicBuffer, 0, 21, 4 + nameLen);
      if (packageRead === 21 && packageMagicBuffer.toString("utf8") === "age-encryption.org/v1") {
        return { isAge: true, type: "packaged", nameLen };
      }
    }
  } catch (e) {
    // Ignore errors
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
  return { isAge: false };
}

async function decryptPackagedFile(filePath, nameLen, outputDir, identity) {
  const fd = fs.openSync(filePath, "r");
  const encNameBuffer = Buffer.alloc(nameLen);
  const readNameLen = fs.readSync(fd, encNameBuffer, 0, nameLen, 4);
  fs.closeSync(fd);
  if (readNameLen < nameLen) {
    throw new Error("Encrypted file is corrupted (name length mismatch).");
  }

  // Decrypt filename
  let originalName = "";
  try {
    const nameDec = new Decrypter();
    nameDec.addIdentity(identity);
    const encNameBytes = new Uint8Array(encNameBuffer);
    const nameBytes = await nameDec.decrypt(encNameBytes);
    originalName = Buffer.from(nameBytes).toString("utf8");
  } catch (err) {
    throw new Error("Decryption failed for filename. Wrong passphrase?");
  }

  const resolvedOutputPath = path.join(outputDir, originalName);

  // Create write stream for the decrypted output file
  const writeStream = fs.createWriteStream(resolvedOutputPath);

  // Stream decrypt the rest of the file
  const dec = new Decrypter();
  dec.addIdentity(identity);

  const nodeReadStream = fs.createReadStream(filePath, { start: 4 + nameLen });
  const webReadStream = Readable.toWeb(nodeReadStream);
  const decryptedWebStream = await dec.decrypt(webReadStream);
  const nodeDecryptedReadStream = Readable.fromWeb(decryptedWebStream);

  await new Promise((resolve, reject) => {
    nodeDecryptedReadStream.pipe(writeStream);
    writeStream.on("finish", resolve);
    nodeDecryptedReadStream.on("error", reject);
    writeStream.on("error", reject);
  });

  return resolvedOutputPath;
}

async function decryptPlainFile(filePath, outputDir, identity) {
  const fileName = path.basename(filePath);
  let decryptedName = fileName + ".decrypted";
  if (fileName.toLowerCase().endsWith(".meta")) {
    decryptedName = fileName.slice(0, -5) + "-meta.zip";
  }

  const resolvedOutputPath = path.join(outputDir, decryptedName);
  const writeStream = fs.createWriteStream(resolvedOutputPath);

  const dec = new Decrypter();
  dec.addIdentity(identity);

  const nodeReadStream = fs.createReadStream(filePath);
  const webReadStream = Readable.toWeb(nodeReadStream);
  const decryptedWebStream = await dec.decrypt(webReadStream);
  const nodeDecryptedReadStream = Readable.fromWeb(decryptedWebStream);

  await new Promise((resolve, reject) => {
    nodeDecryptedReadStream.pipe(writeStream);
    writeStream.on("finish", resolve);
    nodeDecryptedReadStream.on("error", reject);
    writeStream.on("error", reject);
  });

  return resolvedOutputPath;
}

async function processDir(currentDir, baseInputDir, resolvedOutputDir, identity, state) {
  const items = fs.readdirSync(currentDir, { withFileTypes: true });
  const files = [];
  const dirs = [];

  for (const item of items) {
    const fullPath = path.join(currentDir, item.name);
    if (item.isDirectory()) {
      if (item.name === "node_modules" || item.name === ".git") {
        continue;
      }
      dirs.push(fullPath);
    } else if (item.isFile()) {
      files.push(fullPath);
    }
  }

  // Filter files that are age files
  const ageFiles = [];
  for (const filePath of files) {
    const info = detectFileType(filePath);
    if (info.isAge) {
      ageFiles.push({ filePath, info });
    }
  }

  if (ageFiles.length > 0) {
    let targetOutputDir = "";
    if (resolvedOutputDir) {
      const relPath = path.relative(baseInputDir, currentDir);
      targetOutputDir = path.join(resolvedOutputDir, relPath);
    } else {
      targetOutputDir = path.join(currentDir, "decrypted");
    }

    if (!fs.existsSync(targetOutputDir)) {
      fs.mkdirSync(targetOutputDir, { recursive: true });
    }

    for (const { filePath, info } of ageFiles) {
      state.totalFiles++;
      const fileName = path.basename(filePath);
      console.log(`Processing file: ${fileName}...`);
      try {
        let resolvedOutputPath = "";
        if (info.type === "packaged") {
          resolvedOutputPath = await decryptPackagedFile(filePath, info.nameLen, targetOutputDir, identity);
        } else {
          resolvedOutputPath = await decryptPlainFile(filePath, targetOutputDir, identity);
        }
        console.log(`  \x1b[32m✓ Decrypted:\x1b[0m ${fileName} -> ${resolvedOutputPath}`);
        state.successCount++;
      } catch (err) {
        console.error(`  \x1b[31m✗ Failed:\x1b[0m ${fileName} - ${err.message}`);
      }
    }
  }

  // Process subdirectories recursively
  for (const dir of dirs) {
    if (path.basename(dir) === "decrypted") {
      continue;
    }
    await processDir(dir, baseInputDir, resolvedOutputDir, identity, state);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let filePath = "";
  let dirPath = "";
  let outputDir = "";
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

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: Encrypted file does not exist at ${filePath}`);
      process.exit(1);
    }
    const info = detectFileType(filePath);
    if (!info.isAge) {
      console.error(`Error: File at ${filePath} is not a valid age-encrypted file.`);
      process.exit(1);
    }

    const passphrase = await askPassphrase("Enter decryption passphrase: ");
    if (!passphrase || !passphrase.trim()) {
      console.error("\nError: Passphrase cannot be empty.");
      process.exit(1);
    }
    const identity = deriveAgeIdentity(passphrase.trim());

    const destDir = outputDir || ".";
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    console.log(`Processing file: ${path.basename(filePath)}...`);
    try {
      let resolvedOutputPath = "";
      if (info.type === "packaged") {
        resolvedOutputPath = await decryptPackagedFile(filePath, info.nameLen, destDir, identity);
      } else {
        resolvedOutputPath = await decryptPlainFile(filePath, destDir, identity);
      }
      console.log(`  \x1b[32m✓ Decrypted:\x1b[0m ${path.basename(filePath)} -> ${resolvedOutputPath}`);
    } catch (err) {
      console.error(`  \x1b[31m✗ Failed:\x1b[0m ${path.basename(filePath)} - ${err.message}`);
      process.exit(1);
    }
  }

  if (dirPath) {
    if (!fs.existsSync(dirPath)) {
      console.error(`Error: Directory does not exist at ${dirPath}`);
      process.exit(1);
    }

    const passphrase = await askPassphrase("Enter decryption passphrase: ");
    if (!passphrase || !passphrase.trim()) {
      console.error("\nError: Passphrase cannot be empty.");
      process.exit(1);
    }
    const identity = deriveAgeIdentity(passphrase.trim());

    const resolvedOutputDir = outputDir ? path.resolve(outputDir) : "";
    const baseInputDir = path.resolve(dirPath);

    console.log(`Scanning directory recursively: ${dirPath}`);
    const state = { totalFiles: 0, successCount: 0 };
    await processDir(baseInputDir, baseInputDir, resolvedOutputDir, identity, state);

    if (state.totalFiles === 0) {
      console.error(`\nError: No age-encrypted files found in directory ${dirPath}`);
      process.exit(1);
    }

    console.log(`\n🎉 Decryption finished. Successfully decrypted: ${state.successCount}/${state.totalFiles} file(s).`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
