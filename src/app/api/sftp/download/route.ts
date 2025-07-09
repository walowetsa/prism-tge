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

      // Enhanced path handling logic
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
        
        remotePath = `./${year}/${month}/${day}/${filename}`;
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
      
      console.log(`Final SFTP path: ${remotePath}`);

      // Create a read stream for the file
      const readStream = sftp.createReadStream(remotePath);

      // Handle potential errors on the read stream
      readStream.on("error", (err: Error) => {
        console.error("File read error:", err);
        
        // Try a fallback path if the first attempt fails
        if (!remotePath.includes("2025/06/01")) {
          const fallbackPath = `./2025/06/01/${filename.split('/').pop()}`;
          console.log(`First path failed, trying fallback: ${fallbackPath}`);
          
          const fallbackStream = sftp.createReadStream(fallbackPath);
          
          fallbackStream.on("error", (fallbackErr: Error) => {
            console.error("Fallback path also failed:", fallbackErr);
            writer.close();
            conn.end();
          });
          
          fallbackStream.on("data", async (chunk: Buffer) => {
            try {
              await writer.write(chunk);
              console.log(`Read ${chunk.length} bytes from fallback SFTP path`);
            } catch (e) {
              console.error("Error writing chunk from fallback:", e);
              conn.end();
            }
          });
          
          fallbackStream.on("end", async () => {
            console.log("Finished reading from fallback SFTP path");
            await writer.close();
            conn.end();
          });
          
          return;
        }
        
        writer.close();
        conn.end();
      });

      // Process the data in chunks
      readStream.on("data", async (chunk: Buffer) => {
        try {
          await writer.write(chunk);
          // Add some debug information to track data flow
          console.log(`Read ${chunk.length} bytes from SFTP file`);
        } catch (e) {
          console.error("Error writing chunk:", e);
          conn.end();
        }
      });

      readStream.on("end", async () => {
        console.log("Finished reading SFTP file");
        await writer.close();
        conn.end();
      });
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

  // Return the response with appropriate headers
  return new NextResponse(stream.readable, {
    headers: {
      "Content-Disposition": `attachment; filename="${filename.split('/').pop()}"`,
      "Content-Type": "application/octet-stream",
    },
  });
}