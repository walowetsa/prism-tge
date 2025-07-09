/* eslint-disable @typescript-eslint/no-unused-vars */
// Create this file: lib/sftp-utils.ts
// This utility can be used by both the download endpoint and transcription API

import { Client } from "ssh2";
import { readFileSync } from "fs";
import * as path from "path";

// Define the SFTP connection configuration type
type SftpConfig = {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase: string;
};

// Define the SFTP configuration (same as your existing endpoint)
const sftpConfig: SftpConfig = {
  host: process.env.SFTP_HOST!,
  port: parseInt(process.env.SFTP_PORT!),
  username: process.env.SFTP_USERNAME!,
  privateKey: readFileSync(
    path.resolve(process.env.HOME || "~", ".ssh/sftp_key")
  ),
  passphrase: process.env.SFTP_PASSPHRASE!,
};

/**
 * Enhanced path resolution logic (from your existing endpoint)
 */
function resolveSftpPath(filename: string): string[] {
  let remotePath = filename;
  
  // Check various formats - full awareness of possible path patterns
  const knownPrefixes = [
    './tsa-dialler/', 
    '/tsa-dialler/', 
    'tsa-dialler/', 
    'amazon-connect-b1a9c08821e5/tsa-dialler/'
  ];
  
  const hasKnownPrefix = knownPrefixes.some(prefix => 
    filename.startsWith(prefix)
  );
  
  // If no known prefix, assume it's just a filename and add the path
  if (!hasKnownPrefix) {
    // Get today's date for the folder structure
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    
    remotePath = `./tsa-dialler/${year}/${month}/${day}/${filename}`;
    console.log(`No path prefix detected, using current date path: ${remotePath}`);
  } else {
    console.log(`Using provided path: ${remotePath}`);
  }
  
  // For amazon-connect prefix, we might need to strip it
  if (remotePath.startsWith('amazon-connect-b1a9c08821e5/')) {
    remotePath = remotePath.replace('amazon-connect-b1a9c08821e5/', '');
    console.log(`Stripped amazon-connect prefix, using: ${remotePath}`);
  }
  
  // Ensure path starts with ./ or / for SFTP
  if (!remotePath.startsWith('./') && !remotePath.startsWith('/')) {
    remotePath = `./${remotePath}`;
  }
  
  console.log(`Primary SFTP path: ${remotePath}`);
  
  // Create fallback path
  const fallbackPath = `./tsa-dialler/2025/05/20/${filename.split('/').pop()}`;
  
  return [remotePath, fallbackPath];
}

/**
 * Download a file from SFTP and return as Buffer (for transcription API)
 * @param filename The filename or path on the SFTP server
 * @returns Promise<Buffer> The file content as a buffer
 */
export async function downloadSftpFileAsBuffer(filename: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const chunks: Buffer[] = [];
    
    // Add timeout
    const connectionTimeout = setTimeout(() => {
      console.error("SFTP connection timeout");
      conn.end();
      reject(new Error("SFTP connection timeout"));
    }, 30000);

    console.log(`SFTP buffer download requested for: ${filename}`);

    conn.on("ready", () => {
      console.log("SFTP connection ready for buffer download.");
      clearTimeout(connectionTimeout);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("SFTP session error:", err);
          reject(err);
          return;
        }

        const [primaryPath, fallbackPath] = resolveSftpPath(filename);

        const tryDownload = (pathToTry: string, isSecondAttempt = false) => {
          console.log(`Attempting download from: ${pathToTry}`);
          
          const readStream = sftp.createReadStream(pathToTry);

          readStream.on("error", (err: Error) => {
            console.error(`File read error for ${pathToTry}:`, err);
            
            if (!isSecondAttempt) {
              console.log(`Primary path failed, trying fallback: ${fallbackPath}`);
              tryDownload(fallbackPath, true);
            } else {
              console.error("Both primary and fallback paths failed");
              conn.end();
              reject(new Error(`File not found: ${filename}. Tried ${primaryPath} and ${fallbackPath}`));
            }
          });

          readStream.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            console.log(`Downloaded ${chunk.length} bytes, total: ${chunks.reduce((sum, c) => sum + c.length, 0)} bytes`);
          });

          readStream.on("end", () => {
            console.log(`Finished downloading ${pathToTry}`);
            const finalBuffer = Buffer.concat(chunks);
            console.log(`Final buffer size: ${finalBuffer.length} bytes`);
            conn.end();
            resolve(finalBuffer);
          });
        };

        // Start with primary path
        tryDownload(primaryPath);
      });
    });

    conn.on("error", (err) => {
      console.error("SFTP connection error:", err);
      clearTimeout(connectionTimeout);
      reject(err);
    });

    // Establish the connection
    try {
      conn.connect(sftpConfig);
    } catch (e) {
      console.error("SFTP connection error:", e);
      clearTimeout(connectionTimeout);
      reject(e);
    }
  });
}

/**
 * Download a file from SFTP as a stream (for HTTP endpoints)
 * @param filename The filename or path on the SFTP server
 * @returns Promise<{stream: ReadableStream, cleanup: () => void}> 
 */
export async function downloadSftpFileAsStream(filename: string): Promise<{
  stream: ReadableStream<Uint8Array>;
  cleanup: () => void;
}> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    
    const cleanup = () => {
      try {
        conn.end();
      } catch (e) {
        console.warn("Error closing SFTP connection:", e);
      }
    };

    // Add timeout
    const connectionTimeout = setTimeout(() => {
      console.error("SFTP connection timeout");
      cleanup();
      reject(new Error("SFTP connection timeout"));
    }, 30000);

    console.log(`SFTP stream download requested for: ${filename}`);

    conn.on("ready", () => {
      console.log("SFTP connection ready for stream download.");
      clearTimeout(connectionTimeout);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("SFTP session error:", err);
          cleanup();
          reject(err);
          return;
        }

        const [primaryPath, fallbackPath] = resolveSftpPath(filename);

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;

            const tryDownload = (pathToTry: string, isSecondAttempt = false) => {
              console.log(`Attempting stream download from: ${pathToTry}`);
              
              const readStream = sftp.createReadStream(pathToTry);

              readStream.on("error", (err: Error) => {
                console.error(`File read error for ${pathToTry}:`, err);
                
                if (!isSecondAttempt) {
                  console.log(`Primary path failed, trying fallback: ${fallbackPath}`);
                  tryDownload(fallbackPath, true);
                } else {
                  console.error("Both primary and fallback paths failed");
                  controller.error(new Error(`File not found: ${filename}`));
                  cleanup();
                }
              });

              readStream.on("data", (chunk: Buffer) => {
                try {
                  controller.enqueue(new Uint8Array(chunk));
                  console.log(`Streamed ${chunk.length} bytes`);
                } catch (e) {
                  console.error("Error enqueueing chunk:", e);
                  cleanup();
                }
              });

              readStream.on("end", () => {
                console.log(`Finished streaming ${pathToTry}`);
                controller.close();
                cleanup();
              });
            };

            // Start with primary path
            tryDownload(primaryPath);
          },

          cancel() {
            console.log("Stream cancelled");
            cleanup();
          }
        });

        resolve({ stream, cleanup });
      });
    });

    conn.on("error", (err) => {
      console.error("SFTP connection error:", err);
      clearTimeout(connectionTimeout);
      cleanup();
      reject(err);
    });

    // Establish the connection
    try {
      conn.connect(sftpConfig);
    } catch (e) {
      console.error("SFTP connection error:", e);
      clearTimeout(connectionTimeout);
      cleanup();
      reject(e);
    }
  });
}