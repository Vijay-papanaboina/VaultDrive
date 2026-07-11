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
Decrypts a combined payload file containing an encrypted filename and file body.

Usage:
  node tools/decrypt-file.mjs [options]

Options:
  --file, -f        Path to the encrypted payload file
  --output, -o      Output directory (default: current directory)
  --help, -h        Display this help message
`);
}

async function main() {
  const args = process.argv.slice(2);
  let filePath = "";
  let outputDir = ".";
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" || args[i] === "-f") {
      filePath = args[++i];
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

  if (!filePath) {
    console.error("Error: Missing required argument --file (-f).");
    printUsage();
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: Encrypted file does not exist at ${filePath}`);
    process.exit(1);
  }

  // Ask for passphrase
  const passphrase = await askPassphrase("Enter decryption passphrase: ");
  if (!passphrase || !passphrase.trim()) {
    console.error("\nError: Passphrase cannot be empty.");
    process.exit(1);
  }

  const identity = deriveAgeIdentity(passphrase.trim());

  console.log("\nReading and parsing encrypted package...");
  const rawBuffer = fs.readFileSync(filePath);
  if (rawBuffer.length < 4) {
    console.error("Error: File is too small to contain a valid header.");
    process.exit(1);
  }

  const nameLen = rawBuffer.readUInt32BE(0);
  if (rawBuffer.length < 4 + nameLen) {
    console.error("Error: Encrypted file is corrupted (name length mismatch).");
    process.exit(1);
  }

  const encNameBytes = new Uint8Array(rawBuffer.subarray(4, 4 + nameLen));
  const encPayloadBytes = new Uint8Array(rawBuffer.subarray(4 + nameLen));

  console.log("Decrypting original filename...");
  let originalName = "";
  try {
    const nameDec = new Decrypter();
    nameDec.addIdentity(identity);
    const nameBytes = await nameDec.decrypt(encNameBytes);
    originalName = Buffer.from(nameBytes).toString("utf8");
    console.log(`🔑 Extracted Original Filename: ${originalName}`);
  } catch (err) {
    console.error("Error: Decryption failed for filename. Wrong passphrase?");
    process.exit(1);
  }

  console.log("Decrypting file payload...");
  let decryptedPayload;
  try {
    const dec = new Decrypter();
    dec.addIdentity(identity);
    decryptedPayload = await dec.decrypt(encPayloadBytes);
  } catch (err) {
    console.error(`Error: Decryption failed for payload: ${err.message}`);
    process.exit(1);
  }

  // Write output file
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const resolvedOutputPath = path.join(outputDir, originalName);
  fs.writeFileSync(resolvedOutputPath, decryptedPayload);
  console.log(`\n🎉 Success! Decrypted file written to: ${resolvedOutputPath}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
