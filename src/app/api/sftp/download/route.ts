/* eslint-disable @typescript-eslint/no-unused-vars */
// app/api/sftp/download/route.ts
// Updated to use the shared SFTP utility

import { NextResponse } from "next/server";
import { downloadSftpFileAsStream } from "@/lib/sftp-utils";

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

  try {
    // Use the shared utility to get the file as a stream
    const { stream, cleanup } = await downloadSftpFileAsStream(filename);

    // Return the response with appropriate headers
    return new NextResponse(stream, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename.split('/').pop()}"`,
        "Content-Type": "application/octet-stream",
      },
    });

  } catch (error) {
    console.error("SFTP download error:", error);
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    // Return appropriate error response
    if (errorMessage.includes("File not found")) {
      return NextResponse.json(
        { error: "File not found", filename, details: errorMessage },
        { status: 404 }
      );
    } else if (errorMessage.includes("timeout")) {
      return NextResponse.json(
        { error: "Connection timeout", filename, details: errorMessage },
        { status: 504 }
      );
    } else {
      return NextResponse.json(
        { error: "SFTP download failed", filename, details: errorMessage },
        { status: 500 }
      );
    }
  }
}