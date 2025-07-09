/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-const */
// app/api/sftp/download/route.ts - Stable version focused on reliability

import { Client } from "ssh2";
import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import * as path from "path";

type SftpConfig = {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase: string;
};

function getSftpConfig(): SftpConfig {
  return {
    host: process.env.SFTP_HOST!,
    port: parseInt(process.env.SFTP_PORT!),
    username: process.env.SFTP_USERNAME!,
    privateKey: readFileSync(path.resolve(process.env.HOME || "~", ".ssh/sftp_key")),
    passphrase: process.env.SFTP_PASSPHRASE!,
  };
}

function getAudioMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const extensionMimeTypes: Record<string, string> = {
    'wav': 'audio/wav',
    'mp3': 'audio/mpeg', 
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'ogg': 'audio/ogg',
  };
  return extensionMimeTypes[ext] || 'audio/wav';
}

// Simple but thorough path construction
function constructSftpPath(filename: string): string[] {
  const possiblePaths = [];
  
  // Decode URL encoding
  let decodedFilename = filename;
  try {
    decodedFilename = decodeURIComponent(filename);
  } catch (error) {
    console.log(`⚠️ Could not decode filename: ${filename}`);
  }
  
  // If filename has path structure, use it first
  if (decodedFilename.includes('/')) {
    let cleanPath = decodedFilename;
    
    // Handle known prefixes
    if (cleanPath.startsWith('amazon-connect-b1a9c08821e5/')) {
      cleanPath = cleanPath.replace('amazon-connect-b1a9c08821e5/', '');
    }
    
    if (!cleanPath.startsWith('./') && !cleanPath.startsWith('/')) {
      cleanPath = `./${cleanPath}`;
    }
    
    possiblePaths.push(cleanPath);
    
    // Also try without leading ./
    if (cleanPath.startsWith('./')) {
      possiblePaths.push(cleanPath.substring(2));
    }
  }
  
  // Extract filename for date-based searches
  const justFilename = decodedFilename.split('/').pop() || decodedFilename;
  
  // Try current date and previous 7 days
  const currentDate = new Date();
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const targetDate = new Date(currentDate);
    targetDate.setDate(currentDate.getDate() - daysBack);
    
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const day = targetDate.getDate();
    
    const datePath = `${year}/${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`;
    
    possiblePaths.push(`./${datePath}/${justFilename}`);
    possiblePaths.push(`${datePath}/${justFilename}`);
  }
  
  // Try direct access as fallback
  possiblePaths.push(`./${justFilename}`);
  possiblePaths.push(justFilename);
  
  // Remove duplicates while preserving order
  return Array.from(new Set(possiblePaths));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filename = url.searchParams.get("filename");

  if (!filename) {
    return NextResponse.json({ error: "Filename is required" }, { status: 400 });
  }

  console.log(`🎵 STABLE SFTP download for: ${filename}`);
  
  const requestStart = Date.now();

  let sftpConfig: SftpConfig;
  try {
    sftpConfig = getSftpConfig();
  } catch (error) {
    console.error("❌ SFTP config error:", error);
    return NextResponse.json({ error: "SFTP configuration error" }, { status: 500 });
  }

  return new Promise<NextResponse>((resolve) => {
    const conn = new Client();
    let resolved = false;
    let sftpSession: any = null;

    // Cleanup function
    const cleanup = () => {
      try {
        if (sftpSession) {
          sftpSession.end();
          sftpSession = null;
        }
        conn.end();
      } catch (e) {
        console.log("Cleanup error:", e);
      }
    };

    // Overall timeout - generous for call recordings
    const overallTimeout = setTimeout(() => {
      if (!resolved) {
        console.error(`⏰ Overall timeout after ${Date.now() - requestStart}ms`);
        resolved = true;
        cleanup();
        resolve(NextResponse.json({ 
          error: "Download timeout - please try again" 
        }, { status: 504 }));
      }
    }, 180000); // 3 minutes total

    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      if (!resolved) {
        console.error("⏰ SFTP connection timeout");
        resolved = true;
        cleanup();
        resolve(NextResponse.json({ 
          error: "SFTP connection timeout" 
        }, { status: 504 }));
      }
    }, 25000); // 25 seconds for connection

    // Handle connection ready
    conn.on("ready", () => {
      console.log("✅ SFTP connection ready");
      clearTimeout(connectionTimeout);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("❌ SFTP session error:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(overallTimeout);
            cleanup();
            resolve(NextResponse.json({ error: "SFTP session error" }, { status: 500 }));
          }
          return;
        }

        sftpSession = sftp;
        const possiblePaths = constructSftpPath(filename);
        console.log(`🔍 Searching ${possiblePaths.length} paths`);
        
        let pathIndex = 0;
        
        const tryNextPath = async () => {
          if (resolved) return; // Safety check
          
          if (pathIndex >= possiblePaths.length) {
            console.error(`❌ File not found in ${possiblePaths.length} paths`);
            if (!resolved) {
              resolved = true;
              clearTimeout(overallTimeout);
              cleanup();
              resolve(NextResponse.json({ 
                error: "Audio file not found"
              }, { status: 404 }));
            }
            return;
          }
          
          const currentPath = possiblePaths[pathIndex];
          console.log(`🔍 Trying path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
          
          try {
            // Use promises to avoid callback hell and improve error handling
            const stats = await new Promise<any>((resolveStats, rejectStats) => {
              const statTimeout = setTimeout(() => {
                rejectStats(new Error("Stat timeout"));
              }, 15000); // 15 seconds for stat operation
              
              sftp.stat(currentPath, (statErr, statsResult) => {
                clearTimeout(statTimeout);
                if (statErr) {
                  rejectStats(statErr);
                } else {
                  resolveStats(statsResult);
                }
              });
            });

            const sizeInMB = stats.size / (1024 * 1024);
            console.log(`📊 Found file: ${sizeInMB.toFixed(2)}MB`);
            
            // Basic validation
            if (stats.size === 0) {
              console.log(`⚠️ Empty file, trying next`);
              pathIndex++;
              return tryNextPath();
            }

            if (stats.size < 10000) {
              console.log(`⚠️ File too small: ${stats.size} bytes`);
              pathIndex++;
              return tryNextPath();
            }

            // Download the file
            console.log(`📥 Downloading ${stats.size} bytes from: ${currentPath}`);
            
            const fileData = await new Promise<Buffer>((resolveDownload, rejectDownload) => {
              const fileBuffers: Buffer[] = [];
              let totalBytesReceived = 0;
              const downloadStartTime = Date.now();
              
              // Create download timeout based on file size
              const downloadTimeout = Math.min(60000 + (sizeInMB * 20000), 120000); // 1min + 20s per MB, max 2min
              
              const downloadTimeoutId = setTimeout(() => {
                rejectDownload(new Error("Download timeout"));
              }, downloadTimeout);
              
              const readStream = sftp.createReadStream(currentPath, {
                highWaterMark: 256 * 1024, // 256KB chunks
              });

              readStream.on("error", (readErr: Error) => {
                clearTimeout(downloadTimeoutId);
                rejectDownload(readErr);
              });

              readStream.on("data", (chunk: Buffer) => {
                fileBuffers.push(chunk);
                totalBytesReceived += chunk.length;
                
                // Progress logging
                if (totalBytesReceived % (1024 * 1024) < chunk.length) { // Every 1MB
                  const progress = ((totalBytesReceived / stats.size) * 100).toFixed(0);
                  console.log(`📦 Progress: ${progress}%`);
                }
              });

              readStream.on("end", () => {
                clearTimeout(downloadTimeoutId);
                const audioBuffer = Buffer.concat(fileBuffers);
                const downloadTime = Date.now() - downloadStartTime;
                
                console.log(`✅ Downloaded: ${audioBuffer.length} bytes in ${downloadTime}ms`);
                
                // Verify size
                if (audioBuffer.length !== stats.size) {
                  rejectDownload(new Error("Size mismatch"));
                } else {
                  resolveDownload(audioBuffer);
                }
              });
            });

            // Success! Return the file
            const decodedFilename = decodeURIComponent(filename);
            const mimeType = getAudioMimeType(decodedFilename);
            const downloadFilename = decodedFilename.split('/').pop() || decodedFilename;
            
            console.log(`✅ Serving ${fileData.length} bytes as ${mimeType}`);

            if (!resolved) {
              resolved = true;
              clearTimeout(overallTimeout);
              cleanup();
              
              // FIXED: Convert Buffer to Uint8Array for NextResponse compatibility
              const uint8Array = new Uint8Array(fileData);
              
              resolve(
                new NextResponse(uint8Array, {
                  status: 200,
                  headers: {
                    "Content-Type": mimeType,
                    "Content-Length": fileData.length.toString(),
                    "Content-Disposition": `attachment; filename="${downloadFilename}"`,
                    "Cache-Control": "public, max-age=3600",
                    "Accept-Ranges": "bytes",
                  },
                })
              );
            }
            return;

          } catch (error) {
            console.log(`❌ Error with path ${pathIndex + 1}: ${error instanceof Error ? error.message : 'Unknown'}`);
            pathIndex++;
            
            // Add small delay to prevent rapid retries
            setTimeout(tryNextPath, 200);
          }
        };
        
        // Start trying paths
        tryNextPath();
      });
    });

    // Handle connection errors
    conn.on("error", (err) => {
      console.error("❌ SFTP connection error:", err.message);
      clearTimeout(connectionTimeout);
      clearTimeout(overallTimeout);
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(NextResponse.json({ 
          error: "SFTP connection failed",
          details: err.message 
        }, { status: 500 }));
      }
    });

    conn.on("close", () => {
      console.log("🔌 SFTP connection closed");
    });

    // Connect with stable settings - NO COMPRESSION to avoid Zlib errors
    try {
      console.log("🔌 Connecting to SFTP with stable settings...");
      conn.connect({
        ...sftpConfig,
        readyTimeout: 25000,
        keepaliveInterval: 30000, // Longer keepalive interval
        keepaliveCountMax: 2,
        algorithms: {
          compress: ['none'], // DISABLE COMPRESSION - this prevents Zlib errors
        },
        // Additional stability settings
        tryKeyboard: false,
      });
    } catch (e) {
      console.error("❌ Connection setup error:", e);
      clearTimeout(connectionTimeout);
      clearTimeout(overallTimeout);
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ 
          error: "Failed to initialize SFTP connection" 
        }, { status: 500 }));
      }
    }
  });
}