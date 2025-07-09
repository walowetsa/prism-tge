/* eslint-disable prefer-const */
// app/api/sftp/download/route.ts

import { Client } from "ssh2";
import { NextResponse } from "next/server";
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

// Function to get SFTP config (lazy initialization)
function getSftpConfig(): SftpConfig {
  return {
    host: process.env.SFTP_HOST!,
    port: parseInt(process.env.SFTP_PORT!),
    username: process.env.SFTP_USERNAME!,
    privateKey: readFileSync(
      path.resolve(process.env.HOME || "~", ".ssh/sftp_key")
    ),
    passphrase: process.env.SFTP_PASSPHRASE!,
  };
}

// Simplified audio validation - less strict to avoid false rejections
function getAudioMimeType(buffer: Buffer, filename: string): string {
  // Get MIME type from file extension first - this is the most reliable method
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

  // ALWAYS use extension-based MIME type for known audio formats
  if (extensionMimeTypes[ext]) {
    console.log(`🎵 Using MIME type from extension: ${ext} -> ${extensionMimeTypes[ext]}`);
    return extensionMimeTypes[ext];
  }

  // For unknown extensions, but check if it's likely audio based on filename patterns
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.includes('call') || lowerFilename.includes('recording') || lowerFilename.includes('audio')) {
    console.log(`🎵 Audio-like filename detected, using audio/wav as default`);
    return 'audio/wav';
  }

  // Fallback to buffer detection only if extension is completely unknown
  if (buffer.length >= 12) {
    // Check for WAV
    const riffHeader = buffer.subarray(0, 4).toString('ascii');
    const waveHeader = buffer.subarray(8, 12).toString('ascii');
    if (riffHeader === 'RIFF' && waveHeader === 'WAVE') {
      console.log(`🎵 Detected WAV from buffer`);
      return 'audio/wav';
    }
  }

  if (buffer.length >= 3) {
    // Check for MP3
    const id3Header = buffer.subarray(0, 3).toString('ascii');
    if (id3Header === 'ID3' || (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) {
      console.log(`🎵 Detected MP3 from buffer`);
      return 'audio/mpeg';
    }
  }

  // DEFAULT TO AUDIO/WAV - Never return application/octet-stream for call recordings
  console.log(`🎵 Unknown format for "${filename}", defaulting to audio/wav`);
  return 'audio/wav';
}

// IMPROVED: Path construction with better URL decoding
function constructSftpPath(filename: string): string[] {
  const possiblePaths = [];
  
  // FIXED: First decode any URL encoding in the filename
  let decodedFilename = filename;
  try {
    decodedFilename = decodeURIComponent(filename);
    console.log(`📝 Decoded filename: ${filename} -> ${decodedFilename}`);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    console.log(`⚠️ Could not decode filename, using as-is: ${filename}`);
    decodedFilename = filename;
  }
  
  // If filename already has path structure, use it directly
  if (decodedFilename.includes('/') || decodedFilename.startsWith('./')) {
    let cleanPath = decodedFilename;
    
    // Clean up known prefixes
    if (cleanPath.startsWith('amazon-connect-b1a9c08821e5/')) {
      cleanPath = cleanPath.replace('amazon-connect-b1a9c08821e5/', '');
    }
    
    // Handle different path formats
    if (!cleanPath.startsWith('./') && !cleanPath.startsWith('/')) {
      cleanPath = `./${cleanPath}`;
    }
    
    possiblePaths.push(cleanPath);
    
    // Also try without the leading ./
    if (cleanPath.startsWith('./')) {
      possiblePaths.push(cleanPath.substring(2));
    }
  }
  
  // Extract just the filename for date-based searches
  const justFilename = decodedFilename.split('/').pop() || decodedFilename;
  
  // Try current date structure and previous days
  const currentDate = new Date();
  
  // Try current date and previous 7 days (increased from 3)
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const targetDate = new Date(currentDate);
    targetDate.setDate(currentDate.getDate() - daysBack);
    
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const day = targetDate.getDate();
    
    const datePath = `${year}/${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`;
    
    // Try various path combinations
    possiblePaths.push(`./${datePath}/${justFilename}`);
    possiblePaths.push(`${datePath}/${justFilename}`);
  }
  
  // Try without date structure (direct file access)
  possiblePaths.push(`./${justFilename}`);
  possiblePaths.push(justFilename);
  
  // Remove duplicates while preserving order
  const uniquePaths = Array.from(new Set(possiblePaths));
  
  return uniquePaths;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filename = url.searchParams.get("filename");

  if (!filename) {
    return NextResponse.json(
      { error: "Filename is required" },
      { status: 400 }
    );
  }

  console.log(`🎵 SFTP audio download requested for: ${filename}`);
  
  // DEBUGGING: Detailed filename analysis
  console.log("🔍 SFTP FILENAME DEBUG:");
  console.log("  Raw filename:", JSON.stringify(filename));
  console.log("  Filename length:", filename.length);
  console.log("  Contains %3A (encoded :):", filename.includes('%3A'));
  console.log("  Ends with .wav:", filename.endsWith('.wav'));
  console.log("  Last 30 chars:", JSON.stringify(filename.slice(-30)));
  
  // URL decode check
  const decodedFilename = decodeURIComponent(filename);
  if (decodedFilename !== filename) {
    console.log("  URL encoded difference detected:");
    console.log("    Original:", JSON.stringify(filename));
    console.log("    Decoded:", JSON.stringify(decodedFilename));
  }
  
  const requestStart = Date.now();

  // Get SFTP config
  let sftpConfig: SftpConfig;
  try {
    sftpConfig = getSftpConfig();
  } catch (error) {
    console.error("❌ Failed to load SFTP configuration:", error);
    return NextResponse.json(
      { error: "SFTP configuration error" },
      { status: 500 }
    );
  }

  return new Promise<NextResponse>((resolve) => {
    const conn = new Client();
    let resolved = false;

    // INCREASED: Overall request timeout - 3 minutes for large files
    const overallTimeout = setTimeout(() => {
      if (!resolved) {
        console.error(`⏰ Overall request timeout after ${Date.now() - requestStart}ms`);
        resolved = true;
        conn.end();
        resolve(NextResponse.json({ 
          error: "Request timeout - file download took too long" 
        }, { status: 504 }));
      }
    }, 180000); // 3 minutes

    // Connection timeout - 30 seconds
    const connectionTimeout = setTimeout(() => {
      if (!resolved) {
        console.error("⏰ SFTP connection timeout");
        resolved = true;
        conn.end();
        resolve(NextResponse.json({ 
          error: "SFTP connection timeout" 
        }, { status: 504 }));
      }
    }, 30000);

    conn.on("ready", () => {
      console.log("✅ SFTP connection ready");
      clearTimeout(connectionTimeout);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("❌ SFTP session error:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(overallTimeout);
            resolve(NextResponse.json({ 
              error: "SFTP session error" 
            }, { status: 500 }));
          }
          return;
        }

        const possiblePaths = constructSftpPath(filename);
        console.log(`🔍 Trying ${possiblePaths.length} possible paths`);
        
        // DEBUGGING: Log first few possible paths
        console.log("🔍 FIRST 5 POSSIBLE PATHS:");
        possiblePaths.slice(0, 5).forEach((path, index) => {
          console.log(`  ${index + 1}. ${JSON.stringify(path)}`);
        });
        
        let pathIndex = 0;
        
        const tryNextPath = () => {
          if (pathIndex >= possiblePaths.length) {
            console.error(`❌ File not found in any of ${possiblePaths.length} paths`);
            if (!resolved) {
              resolved = true;
              clearTimeout(overallTimeout);
              resolve(NextResponse.json({ 
                error: "Audio file not found",
                searchedPaths: possiblePaths.length,
                lastPaths: possiblePaths.slice(-3) // Include last few paths tried
              }, { status: 404 }));
            }
            conn.end();
            return;
          }
          
          const currentPath = possiblePaths[pathIndex];
          console.log(`🔍 Trying path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
          
          // Quick stat check with timeout
          const statTimeout = setTimeout(() => {
            console.log(`⏰ Stat timeout for path: ${currentPath}`);
            pathIndex++;
            tryNextPath();
          }, 10000); // 10 second timeout for stat operations
          
          sftp.stat(currentPath, (statErr, stats) => {
            clearTimeout(statTimeout);
            
            if (statErr) {
              console.log(`❌ Path ${pathIndex + 1} not found: ${statErr.message}`);
              pathIndex++;
              tryNextPath();
              return;
            }

            console.log(`📊 File found - Size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
            
            // Basic size validation
            if (stats.size === 0) {
              console.log(`⚠️ Empty file, trying next path`);
              pathIndex++;
              tryNextPath();
              return;
            }

            if (stats.size < 100) {
              console.log(`⚠️ File too small (${stats.size} bytes), trying next path`);
              pathIndex++;
              tryNextPath();
              return;
            }

            // INCREASED: Allow larger files but warn about potential timeouts
            const sizeInMB = stats.size / (1024 * 1024);
            if (sizeInMB > 500) {
              console.log(`⚠️ Very large file (${sizeInMB.toFixed(2)}MB), proceeding but may timeout`);
            }

            // File looks good, download it
            console.log(`📥 Downloading ${stats.size} bytes from: ${currentPath}`);
            
            const fileBuffer: Buffer[] = [];
            let totalBytesReceived = 0;
            const downloadStartTime = Date.now();
            
            const readStream = sftp.createReadStream(currentPath);

            // IMPROVED: Download timeout based on file size (more generous)
            const baseTimeout = 30000; // 30 seconds base
            const sizeBasedTimeout = sizeInMB * 10000; // 10 seconds per MB
            const downloadTimeoutMs = Math.min(150000, baseTimeout + sizeBasedTimeout); // Max 2.5 minutes
            
            console.log(`⏰ Download timeout set to ${downloadTimeoutMs / 1000} seconds for ${sizeInMB.toFixed(2)}MB file`);
            
            const downloadTimeout = setTimeout(() => {
              console.error(`⏰ Download timeout after ${downloadTimeoutMs}ms`);
              readStream.destroy();
              if (!resolved) {
                resolved = true;
                clearTimeout(overallTimeout);
                resolve(NextResponse.json({ 
                  error: "Download timeout - file too large or connection slow" 
                }, { status: 504 }));
              }
              conn.end();
            }, downloadTimeoutMs);

            readStream.on("error", (readErr: Error) => {
              console.log(`❌ Read error for path ${currentPath}: ${readErr.message}`);
              clearTimeout(downloadTimeout);
              
              // If it's a connection error, try next path
              if (readErr.message.includes('No response from server') || 
                  readErr.message.includes('Connection lost') ||
                  readErr.message.includes('ECONN')) {
                console.log(`🔄 Connection error, trying next path...`);
                pathIndex++;
                tryNextPath();
              } else {
                // Other errors might be more serious
                if (!resolved) {
                  resolved = true;
                  clearTimeout(overallTimeout);
                  resolve(NextResponse.json({ 
                    error: `File read error: ${readErr.message}` 
                  }, { status: 500 }));
                }
                conn.end();
              }
            });

            readStream.on("data", (chunk: Buffer) => {
              fileBuffer.push(chunk);
              totalBytesReceived += chunk.length;
              
              // Log progress for large files (less frequent updates)
              if (stats.size > 20 * 1024 * 1024) { // 20MB+
                const progress = ((totalBytesReceived / stats.size) * 100).toFixed(1);
                if (totalBytesReceived % (5 * 1024 * 1024) < chunk.length) { // Every 5MB
                  console.log(`📦 Progress: ${progress}% (${(totalBytesReceived / 1024 / 1024).toFixed(1)}MB/${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
                }
              }
            });

            readStream.on("end", () => {
              clearTimeout(downloadTimeout);
              clearTimeout(overallTimeout);
              
              const audioBuffer = Buffer.concat(fileBuffer);
              const downloadTime = Date.now() - downloadStartTime;
              const totalTime = Date.now() - requestStart;
              
              console.log(`✅ Download complete: ${audioBuffer.length} bytes in ${downloadTime}ms (total: ${totalTime}ms)`);
              
              // Verify size
              if (audioBuffer.length !== stats.size) {
                console.error(`❌ Size mismatch! Expected: ${stats.size}, Got: ${audioBuffer.length}`);
                if (!resolved) {
                  resolved = true;
                  resolve(NextResponse.json({ 
                    error: "Download incomplete - size mismatch" 
                  }, { status: 500 }));
                }
                conn.end();
                return;
              }

              // Get MIME type (ensure it's recognized as audio)
              const mimeType = getAudioMimeType(audioBuffer, decodedFilename);
              const downloadFilename = decodedFilename.split('/').pop() || decodedFilename;
              
              console.log(`✅ Serving as ${mimeType}: ${downloadFilename}`);

              if (!resolved) {
                resolved = true;
                resolve(
                  new NextResponse(audioBuffer, {
                    status: 200,
                    headers: {
                      "Content-Type": mimeType,
                      "Content-Length": audioBuffer.length.toString(),
                      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
                      "Cache-Control": "public, max-age=3600", // Allow caching for 1 hour
                      "Accept-Ranges": "bytes",
                      "X-File-Size": audioBuffer.length.toString(),
                      "X-Download-Time": `${downloadTime}ms`,
                      "X-Content-Type": mimeType, // Backup header
                      "Access-Control-Expose-Headers": "Content-Type, Content-Length, Content-Disposition",
                      // ADDED: Additional headers to ensure audio recognition
                      "X-Audio-Format": mimeType,
                      "Content-Description": "Audio File",
                    },
                  })
                );
              }
              
              conn.end();
            });
          });
        };
        
        // Start the download process
        tryNextPath();
      });
    });

    conn.on("error", (err) => {
      console.error("❌ SFTP connection error:", err);
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

    // Add better connection event handling
    conn.on("close", () => {
      console.log("🔌 SFTP connection closed");
    });

    conn.on("end", () => {
      console.log("🔚 SFTP connection ended");
    });

    // Establish connection with retry logic
    try {
      console.log("🔌 Establishing SFTP connection...");
      conn.connect({
        ...sftpConfig,
        readyTimeout: 30000, // 30 second ready timeout
        keepaliveInterval: 10000, // Send keepalive every 10 seconds
        keepaliveCountMax: 3, // Allow 3 failed keepalive before disconnect
      });
    } catch (e) {
      console.error("❌ Connection initiation error:", e);
      clearTimeout(connectionTimeout);
      clearTimeout(overallTimeout);
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ 
          error: "Failed to initiate SFTP connection" 
        }, { status: 500 }));
      }
    }
  });
}