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

// Simplified path construction - try fewer, more likely paths
function constructSftpPath(filename: string): string[] {
  const possiblePaths = [];
  
  // If filename already has path structure, use it directly
  if (filename.includes('/') || filename.startsWith('./')) {
    let cleanPath = filename;
    
    // Clean up known prefixes
    if (cleanPath.startsWith('amazon-connect-b1a9c08821e5/')) {
      cleanPath = cleanPath.replace('amazon-connect-b1a9c08821e5/', '');
    }
    
    if (!cleanPath.startsWith('./') && !cleanPath.startsWith('/')) {
      cleanPath = `./${cleanPath}`;
    }
    
    possiblePaths.push(cleanPath);
  }
  
  // Try current date structure
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  const currentDay = currentDate.getDate();
  
  const justFilename = filename.split('/').pop() || filename;
  
  // Current date path
  possiblePaths.push(
    `./${currentYear}/${currentMonth.toString().padStart(2, '0')}/${currentDay.toString().padStart(2, '0')}/${justFilename}`
  );
  
  // Try previous 3 days (most common case for recent files)
  for (let daysBack = 1; daysBack <= 3; daysBack++) {
    const pastDate = new Date(currentDate);
    pastDate.setDate(currentDate.getDate() - daysBack);
    
    const year = pastDate.getFullYear();
    const month = pastDate.getMonth() + 1;
    const day = pastDate.getDate();
    
    possiblePaths.push(
      `./${year}/${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${justFilename}`
    );
  }
  
  // Try without date structure (direct file access)
  possiblePaths.push(`./${justFilename}`);
  possiblePaths.push(justFilename);
  
  return possiblePaths;
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
  console.log("  Ends with .wav:", filename.endsWith('.wav'));
  console.log("  Ends with _UTC.wav:", filename.endsWith('_UTC.wav'));
  console.log("  Last 20 chars:", JSON.stringify(filename.slice(-20)));
  
  // Check for any hidden characters or encoding issues
  const lastChars = filename.slice(-10);
  console.log("  Last 10 chars (hex):", Array.from(lastChars).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' '));
  
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

    // Overall request timeout - 2 minutes max
    const overallTimeout = setTimeout(() => {
      if (!resolved) {
        console.error(`⏰ Overall request timeout after ${Date.now() - requestStart}ms`);
        resolved = true;
        conn.end();
        resolve(NextResponse.json({ 
          error: "Request timeout - file download took too long" 
        }, { status: 504 }));
      }
    }, 120000); // 2 minutes

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
        
        // DEBUGGING: Log all possible paths
        console.log("🔍 ALL POSSIBLE PATHS:");
        possiblePaths.forEach((path, index) => {
          console.log(`  ${index + 1}. ${JSON.stringify(path)}`);
          console.log(`     Length: ${path.length}, Ends with .wav: ${path.endsWith('.wav')}`);
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
                searchedPaths: possiblePaths.length
              }, { status: 404 }));
            }
            conn.end();
            return;
          }
          
          const currentPath = possiblePaths[pathIndex];
          console.log(`🔍 Trying path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
          
          // Quick stat check
          sftp.stat(currentPath, (statErr, stats) => {
            if (statErr) {
              console.log(`❌ Path ${pathIndex + 1} not found`);
              pathIndex++;
              tryNextPath();
              return;
            }

            console.log(`📊 File found - Size: ${stats.size} bytes`);
            
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

            // File looks good, download it
            console.log(`📥 Downloading ${stats.size} bytes from: ${currentPath}`);
            
            const fileBuffer: Buffer[] = [];
            let totalBytesReceived = 0;
            const downloadStartTime = Date.now();
            
            const readStream = sftp.createReadStream(currentPath);

            // Download timeout based on file size (minimum 30s, max 90s)
            const downloadTimeoutMs = Math.min(900000, Math.max(30000, stats.size / (1024 * 1024) * 100000)); // 10s per MB
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
              console.log(`❌ Read error: ${readErr.message}`);
              clearTimeout(downloadTimeout);
              pathIndex++;
              tryNextPath();
            });

            readStream.on("data", (chunk: Buffer) => {
              fileBuffer.push(chunk);
              totalBytesReceived += chunk.length;
              
              // Log progress for large files
              if (stats.size > 5 * 1024 * 1024) { // 5MB+
                const progress = ((totalBytesReceived / stats.size) * 100).toFixed(1);
                if (totalBytesReceived % (1024 * 1024) < chunk.length) { // Every MB
                  console.log(`📦 Progress: ${progress}%`);
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

              // Get MIME type (less strict validation)
              const mimeType = getAudioMimeType(audioBuffer, filename);
              const downloadFilename = filename.split('/').pop() || filename;
              
              console.log(`✅ Serving as ${mimeType}: ${downloadFilename}`);
              console.log(`🔍 Response headers will be:`, {
                'Content-Type': mimeType,
                'Content-Length': audioBuffer.length.toString(),
                'Content-Disposition': `attachment; filename="${downloadFilename}"`,
              });

              if (!resolved) {
                resolved = true;
                resolve(
                  new NextResponse(audioBuffer, {
                    status: 200,
                    headers: {
                      "Content-Type": mimeType,
                      "Content-Length": audioBuffer.length.toString(),
                      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
                      "Cache-Control": "no-cache, no-store, max-age=0",
                      "Accept-Ranges": "bytes",
                      "X-File-Size": audioBuffer.length.toString(),
                      "X-Download-Time": `${downloadTime}ms`,
                      // Add explicit audio headers for AssemblyAI
                      "X-Content-Type": mimeType, // Backup header
                      "Access-Control-Expose-Headers": "Content-Type, Content-Length, Content-Disposition",
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

    // Establish connection
    try {
      conn.connect(sftpConfig);
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