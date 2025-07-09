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
  // Get the filename from the query parameters
  const url = new URL(request.url);
  const filename = url.searchParams.get("filename");

  if (!filename) {
    return NextResponse.json(
      { error: "Filename is required" },
      { status: 400 }
    );
  }

  console.log(`SFTP download requested for: ${filename}`);

  // Get SFTP config only when needed (runtime)
  let sftpConfig: SftpConfig;
  try {
    sftpConfig = getSftpConfig();
  } catch (error) {
    console.error("Failed to load SFTP configuration:", error);
    return NextResponse.json(
      { error: "SFTP configuration error" },
      { status: 500 }
    );
  }

  // Create a response stream
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const conn = new Client();

  // Add a timeout to prevent hanging requests
  const connectionTimeout = setTimeout(() => {
    console.error("SFTP connection timeout");
    conn.end();
    writer.close();
  }, 30000); // 30 second timeout

  // Connect to the SFTP server
  conn.on("ready", () => {
    console.log("SFTP connection ready for download.");
    clearTimeout(connectionTimeout);

    conn.sftp((err, sftp) => {
      if (err) {
        console.error("SFTP session error:", err);
        writer.close();
        return;
      }

      // Get all possible paths for the file
      const possiblePaths = constructSftpPath(filename);
      console.log(`Trying ${possiblePaths.length} possible paths for file: ${filename}`);
      
      let pathIndex = 0;
      let fileFound = false;
      
      const tryNextPath = () => {
        if (pathIndex >= possiblePaths.length) {
          console.error(`File not found in any of the ${possiblePaths.length} attempted paths`);
          writer.close();
          conn.end();
          return;
        }
        
        const currentPath = possiblePaths[pathIndex];
        console.log(`Attempting path ${pathIndex + 1}/${possiblePaths.length}: ${currentPath}`);
        
        // Create a read stream for the file
        const readStream = sftp.createReadStream(currentPath);

        // Handle potential errors on the read stream
        readStream.on("error", (readErr: Error) => {
          console.log(`Path ${pathIndex + 1} failed: ${readErr.message}`);
          pathIndex++;
          tryNextPath();
        });

        // Process the data in chunks
        readStream.on("data", async (chunk: Buffer) => {
          if (!fileFound) {
            fileFound = true;
            console.log(`✅ File found at path: ${currentPath}`);
          }
          
          try {
            await writer.write(chunk);
            console.log(`Read ${chunk.length} bytes from SFTP file`);
          } catch (e) {
            console.error("Error writing chunk:", e);
            conn.end();
          }
        });

        readStream.on("end", async () => {
          console.log(`✅ Finished reading SFTP file from: ${currentPath}`);
          await writer.close();
          conn.end();
        });
      };
      
      // Start trying paths
      tryNextPath();
    });
  });

  conn.on("error", (err) => {
    console.error("Connection error:", err);
    clearTimeout(connectionTimeout);
    writer.close();
  });

  // Establish the connection
  try {
    conn.connect(sftpConfig);
  } catch (e) {
    console.error("SFTP connection error:", e);
    writer.close();
  }

  // Extract just the filename for the download header
  const downloadFilename = filename.split('/').pop() || filename;
  
  // Return the response with appropriate headers for WAV files
  return new NextResponse(stream.readable, {
    headers: {
      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
      "Content-Type": "audio/wav",
    },
  });
}