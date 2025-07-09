/* eslint-disable @typescript-eslint/no-unused-vars */
// Create this as: /api/debug-audio/route.ts
// This endpoint helps debug audio file downloads without triggering transcription

import { NextResponse } from "next/server";

/**
 * Helper function to validate if a blob appears to be an audio file
 */
async function validateAudioFile(blob: Blob, filename?: string): Promise<{ isValid: boolean; detectedType?: string; reason?: string }> {
  try {
    if (blob.size < 100) {
      return { isValid: false, reason: "File too small to be valid audio" };
    }

    const buffer = await blob.slice(0, 16).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    
    let detectedType = null;
    
    // Check for audio file signatures
    if (hex.startsWith('52494646') && hex.includes('57415645')) {
      detectedType = 'wav';
    } else if (hex.startsWith('494433') || hex.startsWith('fff')) {
      detectedType = 'mp3';
    } else if (hex.startsWith('664c6143')) {
      detectedType = 'flac';
    } else if (hex.includes('66747970')) {
      detectedType = 'm4a';
    } else if (hex.startsWith('4f676753')) {
      detectedType = 'ogg';
    }

    if (detectedType) {
      return { isValid: true, detectedType };
    }

    // Fallback to file extension
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const audioExts = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'wma'];
      if (ext && audioExts.includes(ext)) {
        return { isValid: true, detectedType: ext, reason: "Validated by file extension" };
      }
    }
    
    return { 
      isValid: false, 
      reason: `Unrecognized format. Header: ${hex.substring(0, 16)}` 
    };
  } catch (error) {
    return { isValid: false, reason: "Failed to validate file" };
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sftpFilename } = body;

    if (!sftpFilename) {
      return NextResponse.json(
        { error: "sftpFilename is required" },
        { status: 400 }
      );
    }

    console.log("=== DEBUG AUDIO DOWNLOAD ===");
    console.log("Requested file:", sftpFilename);

    // Download the file
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
    const sftpApiUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;

    console.log("SFTP API URL:", sftpApiUrl);

    const audioResponse = await fetch(sftpApiUrl);
    
    console.log("SFTP Response Status:", audioResponse.status);
    console.log("SFTP Response Headers:", Object.fromEntries(audioResponse.headers.entries()));

    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("SFTP download failed:", errorText);
      
      return NextResponse.json({
        success: false,
        error: "SFTP download failed",
        details: errorText,
        sftpUrl: sftpApiUrl
      });
    }

    const audioBlob = await audioResponse.blob();
    
    console.log("Downloaded blob info:", {
      size: audioBlob.size,
      type: audioBlob.type,
      sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2)
    });

    // Validate the audio file
    const validation = await validateAudioFile(audioBlob, sftpFilename);
    
    console.log("Validation result:", validation);

    // Read first 32 bytes for debugging
    const headerBuffer = await audioBlob.slice(0, 32).arrayBuffer();
    const headerBytes = new Uint8Array(headerBuffer);
    const headerHex = Array.from(headerBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const headerText = new TextDecoder('utf-8', { fatal: false }).decode(headerBytes);

    return NextResponse.json({
      success: true,
      fileInfo: {
        filename: sftpFilename,
        size: audioBlob.size,
        sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2),
        type: audioBlob.type,
        validation,
        headerHex: headerHex,
        headerText: headerText.replace(/[^\x20-\x7E]/g, '.'), // Replace non-printable chars
      },
      sftpUrl: sftpApiUrl,
      recommendations: validation.isValid 
        ? ["File appears to be valid audio", "Safe to proceed with transcription"]
        : [
            "File does not appear to be valid audio",
            "Check SFTP server and file path",
            "Verify file is not corrupted",
            validation.reason || "Unknown validation issue"
          ]
    });

  } catch (error) {
    console.error("Debug audio error:", error);
    return NextResponse.json({
      success: false,
      error: "Debug process failed",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}