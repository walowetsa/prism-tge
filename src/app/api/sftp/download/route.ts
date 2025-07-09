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

// Helper function to validate audio file format
function validateAudioBuffer(buffer: Buffer): { isValid: boolean; fileType: string; details: string } {
  if (buffer.length < 12) {
    return { isValid: false, fileType: "unknown", details: "File too small to be valid audio" };
  }

  // Check for WAV format (RIFF container with WAVE format)
  const riffHeader = buffer.subarray(0, 4).toString('ascii');
  const waveHeader = buffer.subarray(8, 12).toString('ascii');
  
  if (riffHeader === 'RIFF' && waveHeader === 'WAVE') {
    return { isValid: true, fileType: "audio/wav", details: "Valid WAV file" };
  }

  // Check for MP3 format
  if (buffer.length >= 3) {
    // MP3 files can start with ID3 tags or direct audio frames
    const id3Header = buffer.subarray(0, 3).toString('ascii');
    if (id3Header === 'ID3') {
      return { isValid: true, fileType: "audio/mpeg", details: "Valid MP3 file with ID3 tags" };
    }
    
    // Check for MP3 frame sync (0xFF followed by 0xFB, 0xFA, or 0xF3, 0xF2)
    if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
      return { isValid: true, fileType: "audio/mpeg", details: "Valid MP3 file" };
    }
  }

  // Check for OGG format
  if (buffer.length >= 4) {
    const oggHeader = buffer.subarray(0, 4).toString('ascii');
    if (oggHeader === 'OggS') {
      return { isValid: true, fileType: "audio/ogg", details: "Valid OGG file" };
    }
  }

  // Check for M4A/AAC format
  if (buffer.length >= 8) {
    const m4aHeader = buffer.subarray(4, 8).toString('ascii');
    if (m4aHeader === 'ftyp') {
      return { isValid: true, fileType: "audio/mp4", details: "Valid M4A/MP4 audio file" };
    }
  }

  // If we get here, it's not a recognized audio format
  const firstBytes = buffer.subarray(0, 16).toString('hex');
  const textContent = buffer.subarray(0, 100).toString('ascii').replace(/[^\x20-\x7E]/g, '.');
  return { 
    isValid: false, 
    fileType: "application/octet-stream", 
    details: `Unrecognized audio format. First 16 bytes: ${firstBytes}. Text content: "${textContent}"`
  };
}

// Helper function to construct the proper SFTP path following ./YYYY/MM/DD/filename structure
function constructSftpPath(filename: string): string[] {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  const currentDay = currentDate.getDate();
  
  // Known prefixes that indicate a full path is already provided
  const knownPrefixes = [
    `./`,
    `/`,
    `${currentYear}/`,
    `tsa-dialler/`,
    `amazon-connect-b1a9c08821e5/tsa-dialler/`
  ];
  
  const hasKnownPrefix = knownPrefixes.some(prefix => 
    filename.startsWith(prefix)
  );
  
  const possiblePaths = [];
  
  if (hasKnownPrefix) {
    // Clean up the path if it has unwanted prefixes
    let cleanPath = filename;
    
    if (cleanPath.startsWith('amazon-connect-b1a9c08821e5/')) {
      cleanPath = cleanPath.replace('amazon-connect-b1a9c08821e5/', '');
    }
    
    if (!cleanPath.startsWith('./') && !cleanPath.startsWith('/')) {
      cleanPath = `./${cleanPath}`;
    }
    
    possiblePaths.push(cleanPath);
  } else {
    // If no known prefix, try multiple date combinations
    const justFilename = filename.split('/').pop() || filename;
    
    // Try current date first
    possiblePaths.push(
      `./${currentYear}/${currentMonth.toString().padStart(2, '0')}/${currentDay.toString().padStart(2, '0')}/${justFilename}`
    );
    
    // Try a few days back in case file is from previous days
    for (let daysBack = 1; daysBack <= 7; daysBack++) {
      const pastDate = new Date(currentDate);
      pastDate.setDate(currentDate.getDate() - daysBack);
      
      const year = pastDate.getFullYear();
      const month = pastDate.getMonth() + 1;
      const day = pastDate.getDate();
      
      possiblePaths.push(
        `./${year}/${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${justFilename}`
      );
    }
    
    // Try the current month but different days
    for (let day = 1; day <= 31; day++) {
      if (day !== currentDay) {
        possiblePaths.push(
          `./${currentYear}/${currentMonth.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${justFilename}`
        );
      }
    }
  }
  
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

  return new Promise<NextResponse>((resolve, reject) => {
    const conn = new Client();
    let resolved = false;

    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      if (!resolved) {
        console.error("⏰ SFTP connection timeout");
        resolved = true;
        conn.end();
        reject(NextResponse.json({ error: "Connection timeout" }, { status: 504 }));
      }
    }, 30000);

    conn.on("ready", () => {
      console.log("✅ SFTP connection ready for audio download");
      clearTimeout(connectionTimeout);

      conn.sftp((err, sftp) => {
        if (err) {
          console.error("❌ SFTP session error:", err);
          if (!resolved) {
            resolved = true;
            reject(NextResponse.json({ error: "SFTP session error" }, { status: 500 }));
          }
          return;
        }

        const possiblePaths = constructSftpPath(filename);
        console.log(`🔍 Trying ${possiblePaths.length} possible paths for audio file`);
        
        let pathIndex = 0;
        let fileFound = false;
        
        const tryNextPath = () => {
          if (pathIndex >= possiblePaths.length) {
            console.error(`❌ Audio file not found in any of the ${possiblePaths.length} attempted paths`);
            if (!resolved) {
              resolved = true;
              reject(NextResponse.json({ error: "Audio file not found" }, { status: 404 }));
            }
            conn.end();
            return;
          }
          
          const currentPath = possiblePaths[pathIndex];
          console.log(`🔍 Attempting audio path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
          
          // First check if file exists and get its stats
          sftp.stat(currentPath, (statErr, stats) => {
            if (statErr) {
              console.log(`❌ Path ${pathIndex + 1} stat failed: ${statErr.message}`);
              pathIndex++;
              tryNextPath();
              return;
            }

            console.log(`📊 File stats - Size: ${stats.size} bytes, Mode: ${stats.mode}`);
            
            if (stats.size === 0) {
              console.log(`⚠️ File at path ${pathIndex + 1} is empty, trying next path`);
              pathIndex++;
              tryNextPath();
              return;
            }

            if (stats.size < 1000) {
              console.log(`⚠️ File at path ${pathIndex + 1} is too small (${stats.size} bytes), trying next path`);
              pathIndex++;
              tryNextPath();
              return;
            }

            // File exists and has content, now download it
            console.log(`📥 Starting download of ${stats.size} bytes from: ${currentPath}`);
            
            const fileBuffer: Buffer[] = [];
            let totalBytesReceived = 0;
            let downloadStartTime = Date.now();
            
            const readStream = sftp.createReadStream(currentPath);

            // Set up download timeout
            const downloadTimeout = setTimeout(() => {
              console.error(`⏰ Download timeout for ${currentPath}`);
              readStream.destroy();
              pathIndex++;
              tryNextPath();
            }, 60000); // 60 second download timeout

            readStream.on("error", (readErr: Error) => {
              console.log(`❌ Read stream error for path ${pathIndex + 1}: ${readErr.message}`);
              clearTimeout(downloadTimeout);
              pathIndex++;
              tryNextPath();
            });

            readStream.on("data", (chunk: Buffer) => {
              if (!fileFound) {
                fileFound = true;
                console.log(`✅ Audio file found and downloading from: ${currentPath}`);
              }
              
              fileBuffer.push(chunk);
              totalBytesReceived += chunk.length;
              
              // Log progress every 1MB or 10% of file size, whichever is smaller
              const progressInterval = Math.min(1024 * 1024, Math.floor(stats.size / 10));
              if (totalBytesReceived % progressInterval < chunk.length) {
                const progress = ((totalBytesReceived / stats.size) * 100).toFixed(1);
                console.log(`📦 Download progress: ${totalBytesReceived}/${stats.size} bytes (${progress}%)`);
              }
            });

            readStream.on("end", () => {
              clearTimeout(downloadTimeout);
              
              const audioBuffer = Buffer.concat(fileBuffer);
              const downloadTime = Date.now() - downloadStartTime;
              
              console.log(`✅ Audio download complete: ${audioBuffer.length} bytes from ${currentPath} in ${downloadTime}ms`);
              
              // Verify we got the expected amount of data
              if (audioBuffer.length !== stats.size) {
                console.error(`❌ Downloaded size mismatch! Expected: ${stats.size}, Got: ${audioBuffer.length}`);
                pathIndex++;
                tryNextPath();
                return;
              }
              
              if (audioBuffer.length === 0) {
                console.error("❌ Downloaded audio buffer is empty");
                pathIndex++;
                tryNextPath();
                return;
              }

              // Validate the audio file format
              const validation = validateAudioBuffer(audioBuffer);
              console.log(`🔍 Audio validation result:`, validation);

              if (!validation.isValid) {
                console.error(`❌ Invalid audio file format: ${validation.details}`);
                console.error(`🔍 File appears to be: ${validation.fileType}`);
                
                // Log more details for debugging
                const firstBytes = audioBuffer.subarray(0, 32).toString('hex');
                const textContent = audioBuffer.subarray(0, 200).toString('ascii').replace(/[^\x20-\x7E]/g, '.');
                console.error(`🔍 First 32 bytes (hex): ${firstBytes}`);
                console.error(`🔍 First 200 bytes (text): "${textContent}"`);
                
                if (!resolved) {
                  resolved = true;
                  reject(NextResponse.json({ 
                    error: "Invalid audio file format", 
                    details: validation.details,
                    fileType: validation.fileType,
                    actualContent: textContent.substring(0, 100)
                  }, { status: 400 }));
                }
                conn.end();
                return;
              }

              console.log(`✅ Valid audio file confirmed: ${validation.details}`);

              // Extract just the filename for the download header
              const downloadFilename = filename.split('/').pop() || filename;
              
              if (!resolved) {
                resolved = true;
                // Return the audio file with proper headers based on detected format
                const mimeType = validation.fileType;
                resolve(
                  new NextResponse(audioBuffer, {
                    status: 200,
                    headers: {
                      "Content-Type": mimeType,
                      "Content-Length": audioBuffer.length.toString(),
                      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
                      "Cache-Control": "no-cache",
                      "X-Audio-Format": validation.details,
                      "X-File-Size": audioBuffer.length.toString(),
                    },
                  })
                );
              }
              
              conn.end();
            });

            readStream.on("close", () => {
              console.log(`🔐 Read stream closed for ${currentPath}`);
            });
          });
        };
        
        // Start trying paths
        tryNextPath();
      });
    });

    conn.on("error", (err) => {
      console.error("❌ SFTP connection error:", err);
      clearTimeout(connectionTimeout);
      if (!resolved) {
        resolved = true;
        reject(NextResponse.json({ error: "SFTP connection error" }, { status: 500 }));
      }
    });

    // Establish the connection
    try {
      conn.connect(sftpConfig);
    } catch (e) {
      console.error("❌ SFTP connection initiation error:", e);
      if (!resolved) {
        resolved = true;
        reject(NextResponse.json({ error: "Failed to initiate SFTP connection" }, { status: 500 }));
      }
    }
  });
}