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

            // File exists and has content, now download it
            const fileBuffer: Buffer[] = [];
            const readStream = sftp.createReadStream(currentPath);

            readStream.on("error", (readErr: Error) => {
              console.log(`❌ Read stream error for path ${pathIndex + 1}: ${readErr.message}`);
              pathIndex++;
              tryNextPath();
            });

            readStream.on("data", (chunk: Buffer) => {
              if (!fileFound) {
                fileFound = true;
                console.log(`✅ Audio file found and downloading from: ${currentPath}`);
              }
              fileBuffer.push(chunk);
              console.log(`📦 Downloaded chunk: ${chunk.length} bytes (total: ${Buffer.concat(fileBuffer).length} bytes)`);
            });

            readStream.on("end", () => {
              const audioBuffer = Buffer.concat(fileBuffer);
              console.log(`✅ Audio download complete: ${audioBuffer.length} bytes from ${currentPath}`);
              
              if (audioBuffer.length === 0) {
                console.error("❌ Downloaded audio buffer is empty");
                if (!resolved) {
                  resolved = true;
                  reject(NextResponse.json({ error: "Downloaded audio file is empty" }, { status: 500 }));
                }
                conn.end();
                return;
              }

              // Validate that this looks like a WAV file
              const isWavFile = audioBuffer.length >= 12 && 
                              audioBuffer.subarray(0, 4).toString() === 'RIFF' &&
                              audioBuffer.subarray(8, 12).toString() === 'WAVE';
              
              if (!isWavFile) {
                console.warn("⚠️ File doesn't appear to be a WAV file based on header check");
                console.log(`🔍 File header: ${audioBuffer.subarray(0, 16).toString('hex')}`);
              } else {
                console.log("✅ WAV file header validation passed");
              }

              // Extract just the filename for the download header
              const downloadFilename = filename.split('/').pop() || filename;
              
              if (!resolved) {
                resolved = true;
                // Return the audio file with proper headers for WAV
                resolve(
                  new NextResponse(audioBuffer, {
                    status: 200,
                    headers: {
                      "Content-Type": "audio/wav",
                      "Content-Length": audioBuffer.length.toString(),
                      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
                      "Cache-Control": "no-cache",
                    },
                  })
                );
              }
              
              conn.end();
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