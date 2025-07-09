/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-const */
// app/api/sftp/download/route.ts - Fixed for call recordings

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

function getAudioMimeType(buffer: Buffer, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const extensionMimeTypes: Record<string, string> = {
    'wav': 'audio/wav',
    'mp3': 'audio/mpeg', 
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'ogg': 'audio/ogg',
    'wma': 'audio/x-ms-wma',
  };

  if (extensionMimeTypes[ext]) {
    return extensionMimeTypes[ext];
  }

  // Default to WAV for call recordings
  return 'audio/wav';
}

// FIXED: More efficient path construction for call recordings
function constructSftpPath(filename: string): string[] {
  const possiblePaths = [];
  
  // Decode URL encoding
  let decodedFilename = filename;
  try {
    decodedFilename = decodeURIComponent(filename);
  } catch (error) {
    console.log(`⚠️ Could not decode filename: ${filename}`);
  }
  
  // If filename has path structure, prioritize it
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
  
  // Try current date and previous 7 days (reasonable for call recordings)
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
  
  // Try direct access
  possiblePaths.push(`./${justFilename}`);
  possiblePaths.push(justFilename);
  
  // Remove duplicates
  return Array.from(new Set(possiblePaths));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filename = url.searchParams.get("filename");

  if (!filename) {
    return NextResponse.json({ error: "Filename is required" }, { status: 400 });
  }

  console.log(`🎵 SFTP download for call recording: ${filename}`);
  
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

    // FIXED: Realistic timeouts for call recordings
    const overallTimeout = setTimeout(() => {
      if (!resolved) {
        console.error(`⏰ Overall request timeout after ${Date.now() - requestStart}ms`);
        resolved = true;
        conn.end();
        resolve(NextResponse.json({ 
          error: "Download timeout - call recording may be large or server is slow" 
        }, { status: 504 }));
      }
    }, 180000); // 3 minutes total for call recordings

    const connectionTimeout = setTimeout(() => {
      if (!resolved) {
        console.error("⏰ SFTP connection timeout");
        resolved = true;
        conn.end();
        resolve(NextResponse.json({ 
          error: "SFTP connection timeout" 
        }, { status: 504 }));
      }
    }, 20000); // 20 seconds for connection

    conn.on("ready", () => {
      console.log("✅ SFTP connection ready");
      clearTimeout(connectionTimeout);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("❌ SFTP session error:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(overallTimeout);
            resolve(NextResponse.json({ error: "SFTP session error" }, { status: 500 }));
          }
          return;
        }

        const possiblePaths = constructSftpPath(filename);
        console.log(`🔍 Searching ${possiblePaths.length} paths for call recording`);
        
        let pathIndex = 0;
        
        const tryNextPath = () => {
          if (pathIndex >= possiblePaths.length) {
            console.error(`❌ Call recording not found in ${possiblePaths.length} paths`);
            if (!resolved) {
              resolved = true;
              clearTimeout(overallTimeout);
              resolve(NextResponse.json({ 
                error: "Audio file not found",
                searchedPaths: possiblePaths.length
              }, { status: 404 }));
            }
            conn.end();
            return;
          }
          
          const currentPath = possiblePaths[pathIndex];
          console.log(`🔍 Trying path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
          
          // FIXED: Longer stat timeout for call recordings
          const statTimeout = setTimeout(() => {
            console.log(`⏰ Stat timeout for: ${currentPath}`);
            pathIndex++;
            tryNextPath();
          }, 10000); // 10 seconds for stat
          
          sftp.stat(currentPath, (statErr, stats) => {
            clearTimeout(statTimeout);
            
            if (statErr) {
              console.log(`❌ Path ${pathIndex + 1} not found`);
              pathIndex++;
              tryNextPath();
              return;
            }

            const sizeInMB = stats.size / (1024 * 1024);
            console.log(`📊 Call recording found: ${sizeInMB.toFixed(2)}MB`);
            
            // Basic validation for call recordings
            if (stats.size === 0) {
              console.log(`⚠️ Empty file, trying next`);
              pathIndex++;
              tryNextPath();
              return;
            }

            if (stats.size < 10000) { // Less than 10KB is suspicious for call recordings
              console.log(`⚠️ File too small for call recording: ${stats.size} bytes`);
              pathIndex++;
              tryNextPath();
              return;
            }

            // Log size info for call recordings
            if (sizeInMB > 50) {
              console.log(`📢 Large call recording: ${sizeInMB.toFixed(2)}MB - may take longer to download`);
            }

            // FIXED: Stream call recording with realistic settings
            console.log(`📥 Streaming ${stats.size} bytes from: ${currentPath}`);
            
            const fileBuffers: Buffer[] = [];
            let totalBytesReceived = 0;
            const downloadStartTime = Date.now();
            
            const readStream = sftp.createReadStream(currentPath, {
              // FIXED: Optimized for call recordings - larger chunks for efficiency
              highWaterMark: 256 * 1024, // 256KB chunks for call recordings
            });

            // FIXED: Realistic download timeout based on file size
            const baseTimeout = 60000; // 1 minute base
            const timeoutPerMB = 30000; // 30 seconds per MB
            const downloadTimeout = Math.min(
              baseTimeout + (sizeInMB * timeoutPerMB),
              120000 // 2 minute max
            );
            
            console.log(`⏰ Download timeout set to ${downloadTimeout / 1000} seconds for ${sizeInMB.toFixed(2)}MB file`);
            
            const downloadTimeoutId = setTimeout(() => {
              console.error(`⏰ Download timeout for call recording after ${downloadTimeout}ms`);
              readStream.destroy();
              if (!resolved) {
                resolved = true;
                clearTimeout(overallTimeout);
                resolve(NextResponse.json({ 
                  error: "Call recording download timeout - file may be too large" 
                }, { status: 504 }));
              }
              conn.end();
            }, downloadTimeout);

            readStream.on("error", (readErr: Error) => {
              console.log(`❌ Read error: ${readErr.message}`);
              clearTimeout(downloadTimeoutId);
              
              // For call recordings, try next path on connection errors
              if (readErr.message.includes('No response') || 
                  readErr.message.includes('Connection lost')) {
                console.log(`🔄 Connection error, trying next path`);
                pathIndex++;
                tryNextPath();
              } else {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(overallTimeout);
                  resolve(NextResponse.json({ 
                    error: `Read error: ${readErr.message}` 
                  }, { status: 500 }));
                }
                conn.end();
              }
            });

            readStream.on("data", (chunk: Buffer) => {
              fileBuffers.push(chunk);
              totalBytesReceived += chunk.length;
              
              // Progress logging for call recordings
              const progress = ((totalBytesReceived / stats.size) * 100).toFixed(0);
              if (totalBytesReceived % (1024 * 1024) < chunk.length) { // Every 1MB
                console.log(`📦 Progress: ${progress}% (${(totalBytesReceived / (1024 * 1024)).toFixed(1)}MB/${sizeInMB.toFixed(1)}MB)`);
              }
            });

            readStream.on("end", () => {
              clearTimeout(downloadTimeoutId);
              clearTimeout(overallTimeout);
              
              const audioBuffer = Buffer.concat(fileBuffers);
              const downloadTime = Date.now() - downloadStartTime;
              const totalTime = Date.now() - requestStart;
              
              console.log(`✅ Call recording downloaded: ${audioBuffer.length} bytes in ${downloadTime}ms`);
              
              // Verify size
              if (audioBuffer.length !== stats.size) {
                console.error(`❌ Size mismatch! Expected: ${stats.size}, Got: ${audioBuffer.length}`);
                if (!resolved) {
                  resolved = true;
                  resolve(NextResponse.json({ 
                    error: "Download size mismatch" 
                  }, { status: 500 }));
                }
                conn.end();
                return;
              }

              // Get MIME type
              const decodedFilename = decodeURIComponent(filename);
              const mimeType = getAudioMimeType(audioBuffer, decodedFilename);
              const downloadFilename = decodedFilename.split('/').pop() || decodedFilename;
              
              console.log(`✅ Serving ${audioBuffer.length} bytes as ${mimeType}`);

              if (!resolved) {
                resolved = true;
                resolve(
                  new NextResponse(audioBuffer, {
                    status: 200,
                    headers: {
                      "Content-Type": mimeType,
                      "Content-Length": audioBuffer.length.toString(),
                      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
                      "Cache-Control": "public, max-age=3600", // 1 hour cache for call recordings
                      "Accept-Ranges": "bytes",
                      "X-File-Size": audioBuffer.length.toString(),
                      "X-Download-Time": `${downloadTime}ms`,
                      "X-Total-Time": `${totalTime}ms`,
                      "Access-Control-Expose-Headers": "Content-Type, Content-Length, Content-Disposition",
                    },
                  })
                );
              }
              
              conn.end();
            });
          });
        };
        
        tryNextPath();
      });
    });

    // FIXED: Better connection error handling
    conn.on("error", (err) => {
      console.error("❌ SFTP connection error:", err.message);
      clearTimeout(connectionTimeout);
      clearTimeout(overallTimeout);
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ 
          error: "SFTP connection failed",
          details: err.message 
        }, { status: 500 }));
      }
    });

    conn.on("close", () => {
      console.log("🔌 SFTP connection closed");
    });

    // FIXED: Connection with better settings for call recordings
    try {
      console.log("🔌 Connecting to SFTP...");
      conn.connect({
        ...sftpConfig,
        readyTimeout: 20000, // 20 seconds
        keepaliveInterval: 10000, // 10 second keepalive
        keepaliveCountMax: 3, // Allow 3 failed keepalive
        algorithms: {
          compress: ['zlib@openssh.com', 'zlib', 'none'], // Enable compression for call recordings
        }
      });
    } catch (e) {
      console.error("❌ Connection error:", e);
      clearTimeout(connectionTimeout);
      clearTimeout(overallTimeout);
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ 
          error: "Failed to connect to SFTP" 
        }, { status: 500 }));
      }
    }
  });
}