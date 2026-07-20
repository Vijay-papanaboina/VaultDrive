#!/usr/bin/env node
import fs from "fs";
import path from "path";
import argon2 from "argon2";
import readline from "readline";
import { Writable, Readable } from "stream";

// Load ES module dependencies from root
import { bech32 } from "@scure/base";
import { Decrypter } from "age-encryption";

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
async function deriveAgeIdentity(passphrase, email) {
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
  --email, -e       Account email address for Argon2id salt derivation
  --help, -h        Display this help message
`);
}

/**
 * Detects if a file is age-encrypted.
 */
function detectFileType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const magicBuffer = Buffer.alloc(21);
    const bytesRead = fs.readSync(fd, magicBuffer, 0, 21, 0);
    if (bytesRead === 21 && magicBuffer.toString("utf8") === "age-encryption.org/v1") {
      return { isAge: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error detecting file type for ${filePath}: ${message}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error closing file descriptor for ${filePath}: ${message}`);
      }
    }
  }
  return { isAge: false };
}

async function decryptSinglePassPayload(filePath, outputDir, identity) {
  const dec = new Decrypter();
  dec.addIdentity(identity);

  const nodeReadStream = fs.createReadStream(filePath);
  const webReadStream = Readable.toWeb(nodeReadStream);
  const decryptedWebStream = await dec.decrypt(webReadStream);
  const nodeDecryptedReadStream = Readable.fromWeb(decryptedWebStream);

  return new Promise((resolve, reject) => {
    let state = "HEADER_LEN";
    let lenBuffer = Buffer.alloc(0);
    let nameLen = 0;
    let nameBuffer = Buffer.alloc(0);
    let writeStream = null;
    let outputPath = "";

    nodeDecryptedReadStream.on("data", (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (state === "HEADER_LEN") {
          const needed = 4 - lenBuffer.length;
          const available = chunk.length - offset;
          const toRead = Math.min(needed, available);
          lenBuffer = Buffer.concat([lenBuffer, chunk.slice(offset, offset + toRead)]);
          offset += toRead;

          if (lenBuffer.length === 4) {
            nameLen = lenBuffer.readUInt32BE(0);
            state = "HEADER_NAME";
          }
        } else if (state === "HEADER_NAME") {
          const needed = nameLen - nameBuffer.length;
          const available = chunk.length - offset;
          const toRead = Math.min(needed, available);
          nameBuffer = Buffer.concat([nameBuffer, chunk.slice(offset, offset + toRead)]);
          offset += toRead;

          if (nameBuffer.length === nameLen) {
            const originalName = nameBuffer.toString("utf8");
            outputPath = path.join(outputDir, originalName);
            writeStream = fs.createWriteStream(outputPath);
            writeStream.on("error", reject);
            state = "STREAMING";
          }
        } else if (state === "STREAMING") {
          const remaining = chunk.slice(offset);
          if (remaining.length > 0 && writeStream) {
            writeStream.write(remaining);
          }
          break;
        }
      }
    });

    nodeDecryptedReadStream.on("end", () => {
      if (writeStream) {
        writeStream.end();
        writeStream.on("finish", () => resolve(outputPath));
      } else {
        reject(new Error("Decryption output ended prematurely before header parsing completed."));
      }
    });

    nodeDecryptedReadStream.on("error", reject);
  });
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

    for (const { filePath } of ageFiles) {
      state.totalFiles++;
      const fileName = path.basename(filePath);
      console.log(`Processing file: ${fileName}...`);
      try {
        let resolvedOutputPath = "";
        if (fileName.toLowerCase().endsWith(".meta")) {
          resolvedOutputPath = await decryptPlainFile(filePath, targetOutputDir, identity);
        } else {
          resolvedOutputPath = await decryptSinglePassPayload(filePath, targetOutputDir, identity);
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
  let email = DEFAULT_EMAIL;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" || args[i] === "-f") {
      filePath = args[++i];
    } else if (args[i] === "--dir" || args[i] === "-d") {
      dirPath = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      outputDir = args[++i];
    } else if (args[i] === "--email" || args[i] === "-e") {
      email = args[++i];
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

  // Ensure email is resolved
  if (!email || !email.trim()) {
    email = await askEmail("Enter account email: ");
    if (!email || !email.trim()) {
      console.error("\nError: Account email is required for key derivation.");
      process.exit(1);
    }
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
    const identity = await deriveAgeIdentity(passphrase.trim(), email.trim());

    const destDir = outputDir || ".";
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    console.log(`Processing file: ${path.basename(filePath)}...`);
    try {
      let resolvedOutputPath = "";
      if (path.basename(filePath).toLowerCase().endsWith(".meta")) {
        resolvedOutputPath = await decryptPlainFile(filePath, destDir, identity);
      } else {
        resolvedOutputPath = await decryptSinglePassPayload(filePath, destDir, identity);
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
    const identity = await deriveAgeIdentity(passphrase.trim(), email.trim());

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
