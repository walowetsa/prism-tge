/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

/**
 * Helper function to save transcription to Supabase
 */
async function saveToSupabase(
  callId: string,
  transcriptData: any,
  transcriptText: string
) {
  try {
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
    const apiUrl = `${serverUrl}/api/supabase/save-transcription`;

    console.log(`💾 Saving transcription to Supabase for call ID: ${callId}`);

    const payload = {
      contact_id: callId,
      recording_location: transcriptData.recording_location || "",
      transcript_text: transcriptText,
      queue_name: transcriptData.queue_name || null,
      agent_username: transcriptData.agent_username || "",
      initiation_timestamp: transcriptData.initiation_timestamp || new Date().toISOString(),
      speaker_data: transcriptData.utterances ? JSON.stringify(transcriptData.utterances) : null,
      sentiment_analysis: transcriptData.sentiment_analysis_results ? JSON.stringify(transcriptData.sentiment_analysis_results) : null,
      entities: transcriptData.entities ? JSON.stringify(transcriptData.entities) : null,
      disposition_title: transcriptData.disposition_title || null,
      call_summary: transcriptData.summary || null,
      campaign_name: transcriptData.campaign_name || null,
      campaign_id: transcriptData.campaign_id || null,
      customer_cli: transcriptData.customer_cli || null,
      agent_hold_time: transcriptData.agent_hold_time || null,
      total_hold_time: transcriptData.total_hold_time || null,
      time_in_queue: transcriptData.time_in_queue || null,
      call_duration: transcriptData.call_duration || null,
      categories: transcriptData.topic_categorization?.all_topics ? JSON.stringify(transcriptData.topic_categorization.all_topics) : null,
      primary_category: transcriptData.topic_categorization?.primary_topic || null,
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Supabase save failed for ${callId}:`, errorText);
      throw new Error(`Supabase save failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`✅ Successfully saved to Supabase:`, result.data?.contact_id);
    return result.data;
  } catch (error) {
    console.error("❌ Error saving to Supabase:", error);
    return null;
  }
}

/// Enhanced transcribe/route.ts with better error handling and debugging

/**
 * Improved SFTP audio download with better path resolution
 */
async function getSftpAudio(sftpFilename: string) {
  console.log("🔄 Starting SFTP download for:", sftpFilename);

  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
  const sftpApiUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // Increased timeout

    const audioResponse = await fetch(sftpApiUrl, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`📡 SFTP Response: ${audioResponse.status} - ${audioResponse.statusText}`);

    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("❌ SFTP download failed:", errorText);
      
      // Provide more specific error messages
      if (audioResponse.status === 404) {
        throw new Error(`File not found: ${sftpFilename}. Check if the file exists on the SFTP server.`);
      } else if (audioResponse.status === 500) {
        throw new Error(`SFTP server error: ${errorText}`);
      } else {
        throw new Error(`SFTP download failed: ${audioResponse.status} - ${errorText}`);
      }
    }

    // Get content length for validation
    const contentLength = audioResponse.headers.get('content-length');
    console.log(`📏 Expected content length: ${contentLength} bytes`);

    const audioArrayBuffer = await audioResponse.arrayBuffer();
    console.log(`📁 Actual downloaded size: ${audioArrayBuffer.byteLength} bytes`);

    // Validate download
    if (audioArrayBuffer.byteLength === 0) {
      throw new Error("Downloaded file is empty");
    }

    if (contentLength && parseInt(contentLength) !== audioArrayBuffer.byteLength) {
      console.warn(`⚠️ Size mismatch: expected ${contentLength}, got ${audioArrayBuffer.byteLength}`);
    }

    // Enhanced WAV validation
    const uint8Array = new Uint8Array(audioArrayBuffer);
    const validationResult = validateWavFile(uint8Array);
    
    if (!validationResult.isValid) {
      console.warn("⚠️ WAV validation issues:", validationResult.issues);
      // Don't throw error, just warn - AssemblyAI might still handle it
    } else {
      console.log("✅ WAV file validation passed");
    }

    // Create blob with proper MIME type
    const audioBlob = new Blob([audioArrayBuffer], { 
      type: 'audio/wav' 
    });
    
    console.log(`🎵 Created audio blob: ${audioBlob.size} bytes`);
    return audioBlob;

  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("SFTP download timed out after 45 seconds");
      }
      throw error;
    }
    throw new Error("Unknown SFTP download error");
  }
}

/**
 * Enhanced WAV file validation
 */
function validateWavFile(uint8Array: Uint8Array) {
  const issues: string[] = [];
  let isValid = true;

  // Check minimum file size
  if (uint8Array.length < 44) {
    issues.push("File too small to be a valid WAV (< 44 bytes)");
    return { isValid: false, issues };
  }

  // Check RIFF header
  const riffHeader = Array.from(uint8Array.slice(0, 4)).map(b => String.fromCharCode(b)).join('');
  if (riffHeader !== 'RIFF') {
    issues.push(`Invalid RIFF header: "${riffHeader}"`);
    isValid = false;
  }

  // Check WAVE identifier
  const waveHeader = Array.from(uint8Array.slice(8, 12)).map(b => String.fromCharCode(b)).join('');
  if (waveHeader !== 'WAVE') {
    issues.push(`Invalid WAVE identifier: "${waveHeader}"`);
    isValid = false;
  }

  // Check file size consistency
  try {
    const fileSize = new DataView(uint8Array.buffer).getUint32(4, true);
    const expectedSize = uint8Array.length - 8;
    if (Math.abs(fileSize - expectedSize) > 100) { // Allow small discrepancy
      issues.push(`File size mismatch: header says ${fileSize}, actual is ${expectedSize}`);
    }
  } catch (e) {
    issues.push("Could not read file size from header");
  }

  // Look for format chunk
  let hasFormatChunk = false;
  let hasDataChunk = false;
  
  try {
    let offset = 12;
    while (offset < uint8Array.length - 8) {
      const chunkId = Array.from(uint8Array.slice(offset, offset + 4)).map(b => String.fromCharCode(b)).join('');
      const chunkSize = new DataView(uint8Array.buffer).getUint32(offset + 4, true);
      
      if (chunkId === 'fmt ') {
        hasFormatChunk = true;
        
        // Check audio format (should be 1 for PCM)
        const audioFormat = new DataView(uint8Array.buffer).getUint16(offset + 8, true);
        if (audioFormat !== 1) {
          issues.push(`Non-PCM audio format: ${audioFormat} (AssemblyAI prefers PCM)`);
        }
      } else if (chunkId === 'data') {
        hasDataChunk = true;
      }
      
      offset += 8 + chunkSize;
      if (chunkSize % 2 === 1) offset++; // Padding byte
      
      if (offset >= uint8Array.length) break;
    }
  } catch (e) {
    issues.push("Error parsing WAV chunks");
  }

  if (!hasFormatChunk) {
    issues.push("Missing format chunk");
    isValid = false;
  }

  if (!hasDataChunk) {
    issues.push("Missing data chunk");
    isValid = false;
  }

  return { isValid, issues };
}

/**
 * Improved AssemblyAI upload with multiple strategies
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string, originalFilename?: string) {
  console.log("⬆️ Starting AssemblyAI upload...");
  console.log(`📁 Blob details: ${audioBlob.size} bytes, type: ${audioBlob.type}`);

  if (audioBlob.size === 0) {
    throw new Error("Cannot upload empty audio blob");
  }

  if (audioBlob.size > 500 * 1024 * 1024) { // 500MB limit
    throw new Error("File too large for AssemblyAI (max 500MB)");
  }

  // Try multiple upload strategies
  const uploadStrategies = [
    { 
      type: 'audio/wav', 
      description: 'Standard WAV MIME type',
      headers: { Authorization: apiKey }
    },
    { 
      type: 'audio/x-wav', 
      description: 'Alternative WAV MIME type',
      headers: { Authorization: apiKey }
    },
    { 
      type: 'application/octet-stream', 
      description: 'Binary stream fallback',
      headers: { Authorization: apiKey }
    }
  ];

  let lastError: Error | null = null;

  for (const strategy of uploadStrategies) {
    try {
      console.log(`🔄 Trying upload strategy: ${strategy.description}`);

      // Create fresh blob with specific MIME type
      const arrayBuffer = await audioBlob.arrayBuffer();
      const strategicBlob = new Blob([arrayBuffer], { type: strategy.type });
      
      // Create FormData
      const formData = new FormData();
      const filename = originalFilename?.endsWith('.wav') ? originalFilename : 'audio.wav';
      formData.append('file', strategicBlob, filename);

      console.log(`📤 Uploading with MIME type: ${strategy.type}, filename: ${filename}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

      const response = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: strategy.headers,
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      console.log(`📡 Upload response: ${response.status} - ${response.statusText}`);

      if (response.ok) {
        const result = await response.json();
        if (result.upload_url) {
          console.log(`✅ Upload successful with strategy: ${strategy.description}`);
          return result.upload_url;
        } else {
          throw new Error("No upload_url in response");
        }
      } else {
        const errorText = await response.text();
        console.warn(`❌ Strategy failed: ${strategy.description} - ${response.status}: ${errorText}`);
        lastError = new Error(`${strategy.description} failed: ${response.status} - ${errorText}`);
        continue; // Try next strategy
      }

    } catch (error) {
      console.warn(`❌ Strategy error: ${strategy.description}`, error);
      lastError = error instanceof Error ? error : new Error(String(error));
      continue; // Try next strategy
    }
  }

  // If all strategies failed, throw the last error
  throw new Error(`All upload strategies failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Enhanced transcription request with better polling
 */
async function transcribeWithAssemblyAI(uploadUrl: string, apiKey: string, speakerCount: number = 2) {
  console.log("🎤 Submitting transcription request...");

  const transcriptRequestBody = {
    audio_url: uploadUrl,
    speech_model: "slam-1", // Latest model
    keyterms_prompt: [
      "mycar", "tyre", "auto", "rego", "speaking", "you're", "Pirelli",
      "end", "of", "financial", "year", "sale", "care", "plan",
      "end of financial year sale", "tyre care plan", "quote", "email",
    ],
    speaker_labels: true,
    speakers_expected: speakerCount,
    summarization: true,
    summary_model: "conversational",
    summary_type: "paragraph",
    entity_detection: true,
    sentiment_analysis: true,
    auto_highlights: true,
    dual_channel: false, // Set to true if you have stereo files with separate channels
  };

  // Submit transcription request
  const response = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(transcriptRequestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Transcription request failed: ${JSON.stringify(errorData)}`);
  }

  const { id } = await response.json();
  console.log(`🆔 Transcription job ID: ${id}`);

  // Enhanced polling with exponential backoff
  let transcript;
  let status = "processing";
  let attempts = 0;
  let pollInterval = 1000; // Start with 1 second
  const maxAttempts = 300; // 5 minutes max with exponential backoff
  const maxInterval = 10000; // Max 10 second intervals

  console.log("⏳ Starting transcription polling...");

  while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    attempts++;

    try {
      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { Authorization: apiKey },
      });

      if (!statusResponse.ok) {
        throw new Error(`Status check failed: ${statusResponse.status}`);
      }

      transcript = await statusResponse.json();
      status = transcript.status;

      if (attempts % 10 === 0) {
        console.log(`⏳ Polling attempt ${attempts}/${maxAttempts}, status: ${status}`);
      }

      // Exponential backoff: gradually increase poll interval
      if (attempts > 30) {
        pollInterval = Math.min(pollInterval * 1.1, maxInterval);
      }

    } catch (error) {
      console.error(`❌ Error during polling attempt ${attempts}:`, error);
      if (attempts > 10) {
        throw new Error(`Polling failed after ${attempts} attempts: ${error}`);
      }
      // Continue polling for early attempts
    }
  }

  if (status !== "completed") {
    if (attempts >= maxAttempts) {
      throw new Error(`Transcription timed out after ${attempts} attempts`);
    } else {
      throw new Error(`Transcription failed with status: ${status}. Error: ${transcript?.error || 'Unknown error'}`);
    }
  }

  console.log(`✅ Transcription completed after ${attempts} attempts`);
  return transcript;
}

// Example of improved error handling in the main POST handler
export async function POST(request: Request) {
  console.log("🎯 Enhanced Transcribe API called");
  
  try {
    const body = await request.json();
    const {
      audioUrl,
      speakerCount = 2,
      filename,
      isDirectSftpFile = false,
      sftpFilename = null,
    } = body;

    // Validation with better error messages
    if (!audioUrl && !isDirectSftpFile) {
      return NextResponse.json(
        { 
          error: "Missing audio source",
          details: "Either audioUrl or isDirectSftpFile + sftpFilename must be provided",
          requiredFields: ["audioUrl OR (isDirectSftpFile + sftpFilename)"]
        },
        { status: 400 }
      );
    }

    if (!filename) {
      return NextResponse.json(
        { 
          error: "Missing filename",
          details: "Filename is required for processing and caching",
          requiredFields: ["filename"]
        },
        { status: 400 }
      );
    }

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      console.error("❌ AssemblyAI API key not configured");
      return NextResponse.json(
        { 
          error: "Service configuration error",
          details: "AssemblyAI API key is not properly configured on the server"
        },
        { status: 500 }
      );
    }

    let fileToTranscribe: string;

    // Enhanced audio processing
    if (isDirectSftpFile && sftpFilename) {
      try {
        console.log("🔄 Processing SFTP file...");
        const audioBlob = await getSftpAudio(sftpFilename);
        const originalFilename = sftpFilename.split('/').pop() || filename;
        fileToTranscribe = await uploadToAssemblyAI(audioBlob, apiKey, originalFilename);
      } catch (error) {
        console.error("❌ SFTP processing failed:", error);
        return NextResponse.json(
          { 
            error: "Audio processing failed",
            details: error instanceof Error ? error.message : "Unknown error during audio processing",
            stage: "sftp_download_or_upload",
            troubleshooting: [
              "Check if the file exists on the SFTP server",
              "Verify the file is a valid WAV format",
              "Ensure the file is not corrupted",
              "Check SFTP server connectivity",
              "Verify AssemblyAI service status"
            ]
          },
          { status: 500 }
        );
      }
    } else if (audioUrl) {
      fileToTranscribe = audioUrl;
    } else {
      return NextResponse.json(
        { error: "No valid audio source provided" },
        { status: 400 }
      );
    }

    // Enhanced transcription
    try {
      const transcript = await transcribeWithAssemblyAI(fileToTranscribe, apiKey, speakerCount);
      
      // Process transcript results
      if (transcript.utterances?.length > 0) {
        transcript.utterances = transcript.utterances.map((utterance: any) => ({
          ...utterance,
          speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      if (transcript.words?.length > 0) {
        transcript.words = transcript.words.map((word: any) => ({
          ...word,
          speakerRole: word.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      console.log("🎉 Transcription completed successfully");
      return NextResponse.json(transcript);

    } catch (error) {
      console.error("❌ Transcription failed:", error);
      return NextResponse.json(
        { 
          error: "Transcription failed",
          details: error instanceof Error ? error.message : "Unknown transcription error",
          stage: "assemblyai_transcription"
        },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error("💥 Unexpected error:", error);
    return NextResponse.json(
      { 
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
        stack: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.stack : undefined) : undefined
      },
      { status: 500 }
    );
  }
}