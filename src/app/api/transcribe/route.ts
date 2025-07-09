/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-const */
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

/**
 * GREATLY IMPROVED: Audio validation with better detection and debugging
 */
function validateAudioFile(buffer: ArrayBuffer): { isValid: boolean; fileType: string; details: string; extension: string } {
  const uint8Array = new Uint8Array(buffer);
  
  console.log(`🔍 Validating audio file: ${uint8Array.length} bytes`);
  
  if (uint8Array.length < 8) {
    return { isValid: false, fileType: "unknown", details: "File too small to be valid audio", extension: ".bin" };
  }

  // Log first 32 bytes for debugging
  const firstBytes = Array.from(uint8Array.slice(0, Math.min(32, uint8Array.length)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
  console.log(`🔍 First ${Math.min(32, uint8Array.length)} bytes: ${firstBytes}`);

  // Convert first bytes to text for debugging
  const textStart = Array.from(uint8Array.slice(0, Math.min(100, uint8Array.length)))
    .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
    .join('');
  console.log(`🔍 Text interpretation: "${textStart}"`);

  // IMPROVED: Check for error responses first (HTML, JSON, etc.)
  if (textStart.toLowerCase().includes('<html') || 
      textStart.toLowerCase().includes('<!doctype') ||
      textStart.toLowerCase().includes('error') ||
      textStart.toLowerCase().includes('{') && textStart.includes('"')) {
    console.error(`❌ File appears to be an error response, not audio: ${textStart.substring(0, 50)}`);
    return { 
      isValid: false, 
      fileType: "text/html", 
      details: `Server returned error response instead of audio file: ${textStart.substring(0, 100)}`, 
      extension: ".html" 
    };
  }

  // IMPROVED: WAV format detection with better error handling
  try {
    if (uint8Array.length >= 12) {
      const riffHeader = String.fromCharCode(...uint8Array.slice(0, 4));
      const waveHeader = String.fromCharCode(...uint8Array.slice(8, 12));
      
      console.log(`🔍 WAV headers - RIFF: "${riffHeader}", WAVE: "${waveHeader}"`);
      
      if (riffHeader === 'RIFF' && waveHeader === 'WAVE') {
        // Additional WAV validation
        const fileSize = new DataView(buffer, 4, 4).getUint32(0, true);
        console.log(`🔍 WAV file size from header: ${fileSize}, actual: ${uint8Array.length}`);
        
        // WAV files should have format chunk
        if (uint8Array.length >= 20) {
          const fmtChunk = String.fromCharCode(...uint8Array.slice(12, 16));
          console.log(`🔍 WAV format chunk: "${fmtChunk}"`);
          
          if (fmtChunk === 'fmt ') {
            return { isValid: true, fileType: "audio/wav", details: "Valid WAV file", extension: ".wav" };
          } else {
            console.warn(`⚠️ WAV file missing format chunk, but proceeding anyway`);
            return { isValid: true, fileType: "audio/wav", details: "WAV file (missing format chunk)", extension: ".wav" };
          }
        }
        
        return { isValid: true, fileType: "audio/wav", details: "Valid WAV file (basic)", extension: ".wav" };
      }
    }
  } catch (error) {
    console.error(`❌ Error checking WAV format: ${error}`);
  }

  // IMPROVED: MP3 format detection
  try {
    if (uint8Array.length >= 3) {
      // Check for ID3 tags
      const id3Header = String.fromCharCode(...uint8Array.slice(0, 3));
      console.log(`🔍 Checking ID3 header: "${id3Header}"`);
      
      if (id3Header === 'ID3') {
        return { isValid: true, fileType: "audio/mpeg", details: "Valid MP3 file with ID3 tags", extension: ".mp3" };
      }
      
      // Check for MP3 frame sync
      if (uint8Array.length >= 4) {
        for (let i = 0; i < Math.min(100, uint8Array.length - 1); i++) {
          if (uint8Array[i] === 0xFF && (uint8Array[i + 1] & 0xE0) === 0xE0) {
            console.log(`🔍 Found MP3 sync at byte ${i}: 0x${uint8Array[i].toString(16)} 0x${uint8Array[i + 1].toString(16)}`);
            return { isValid: true, fileType: "audio/mpeg", details: "Valid MP3 file", extension: ".mp3" };
          }
        }
      }
    }
  } catch (error) {
    console.error(`❌ Error checking MP3 format: ${error}`);
  }

  // IMPROVED: OGG format detection
  try {
    if (uint8Array.length >= 4) {
      const oggHeader = String.fromCharCode(...uint8Array.slice(0, 4));
      console.log(`🔍 Checking OGG header: "${oggHeader}"`);
      
      if (oggHeader === 'OggS') {
        return { isValid: true, fileType: "audio/ogg", details: "Valid OGG file", extension: ".ogg" };
      }
    }
  } catch (error) {
    console.error(`❌ Error checking OGG format: ${error}`);
  }

  // IMPROVED: M4A/MP4 format detection
  try {
    if (uint8Array.length >= 8) {
      const m4aHeader = String.fromCharCode(...uint8Array.slice(4, 8));
      console.log(`🔍 Checking M4A header: "${m4aHeader}"`);
      
      if (m4aHeader === 'ftyp') {
        return { isValid: true, fileType: "audio/mp4", details: "Valid M4A/MP4 audio file", extension: ".m4a" };
      }
    }
  } catch (error) {
    console.error(`❌ Error checking M4A format: ${error}`);
  }

  // NEW: Check for common audio signatures that might be missed
  try {
    // Some audio files might have different headers
    const headerSignatures = [
      { bytes: [0x46, 0x4C, 0x41, 0x43], type: "audio/flac", ext: ".flac", name: "FLAC" },
      { bytes: [0x4D, 0x54, 0x68, 0x64], type: "audio/midi", ext: ".mid", name: "MIDI" },
      { bytes: [0x30, 0x26, 0xB2, 0x75], type: "audio/wma", ext: ".wma", name: "WMA" },
    ];

    for (const sig of headerSignatures) {
      if (uint8Array.length >= sig.bytes.length) {
        const matches = sig.bytes.every((byte, index) => uint8Array[index] === byte);
        if (matches) {
          console.log(`🔍 Found ${sig.name} signature`);
          return { isValid: true, fileType: sig.type, details: `Valid ${sig.name} file`, extension: sig.ext };
        }
      }
    }
  } catch (error) {
    console.error(`❌ Error checking additional signatures: ${error}`);
  }

  // NEW: Lenient validation - if it's not obviously an error page and has reasonable size, try as WAV
  if (uint8Array.length > 1000 && 
      !textStart.includes('<') && 
      !textStart.includes('{') && 
      !textStart.includes('Error') &&
      !textStart.includes('error')) {
    console.warn(`⚠️ Unknown format but appears to be binary data, treating as WAV`);
    return { 
      isValid: true, 
      fileType: "audio/wav", 
      details: "Unknown audio format, attempting as WAV", 
      extension: ".wav" 
    };
  }

  // If we get here, it's definitely not recognized audio
  return { 
    isValid: false, 
    fileType: "application/octet-stream", 
    details: `Unrecognized format. Size: ${uint8Array.length} bytes. Start: ${textStart.substring(0, 50)}`,
    extension: ".bin"
  };
}

/**
 * IMPROVED: SFTP download with better error detection and response validation
 */
async function getSftpAudioBuffer(sftpFilename: string): Promise<ArrayBuffer> {
  console.log("🔄 Downloading SFTP file:", sftpFilename);

  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
  const sftpApiUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;

  console.log("📡 SFTP API URL:", sftpApiUrl);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // Increased timeout

    const audioResponse = await fetch(sftpApiUrl, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`📡 SFTP Response Status: ${audioResponse.status}`);
    console.log(`📡 SFTP Response Headers:`, Object.fromEntries(audioResponse.headers.entries()));

    // IMPROVED: Check content-type from response
    const contentType = audioResponse.headers.get('content-type') || '';
    console.log(`📡 SFTP Response Content-Type: ${contentType}`);

    // IMPROVED: Detect error responses by content-type and status
    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("❌ SFTP download failed:", errorText);
      
      // Check if it's a specific error message
      if (errorText.includes('ENOENT') || errorText.includes('not found')) {
        throw new Error(`File not found on SFTP server: ${sftpFilename}`);
      }
      
      throw new Error(`SFTP download failed (${audioResponse.status}): ${errorText}`);
    }

    // IMPROVED: Warn if content-type suggests this isn't audio
    if (contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('text/html')) {
      console.warn(`⚠️ SFTP response has suspicious content-type: ${contentType}`);
    }

    // Get as ArrayBuffer directly
    const audioArrayBuffer = await audioResponse.arrayBuffer();
    console.log(`📁 Audio ArrayBuffer size: ${audioArrayBuffer.byteLength} bytes`);

    if (audioArrayBuffer.byteLength === 0) {
      throw new Error("Retrieved audio file is empty");
    }

    if (audioArrayBuffer.byteLength < 500) { // Reduced minimum size
      console.warn(`⚠️ Audio file is very small: ${audioArrayBuffer.byteLength} bytes`);
    }

    // IMPROVED: Pre-validate the downloaded data
    const validation = validateAudioFile(audioArrayBuffer);
    console.log(`🔍 SFTP download validation result:`, validation);

    if (!validation.isValid) {
      const uint8Array = new Uint8Array(audioArrayBuffer);
      const textContent = Array.from(uint8Array.slice(0, 200))
        .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
        .join('');
      
      console.error(`❌ Downloaded data is not valid audio:`);
      console.error(`🔍 Content preview: "${textContent}"`);
      console.error(`🔍 Validation details: ${validation.details}`);
      
      // Check if this looks like an error page
      if (textContent.includes('<html') || textContent.includes('<!DOCTYPE') || textContent.includes('Error')) {
        throw new Error(`SFTP server returned error page instead of audio file. Content starts with: ${textContent.substring(0, 100)}`);
      }
      
      // For other validation failures, we'll still try to proceed but warn
      console.warn(`⚠️ Proceeding despite validation failure: ${validation.details}`);
    }

    console.log(`✅ SFTP download completed: ${validation.details}`);
    return audioArrayBuffer;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("SFTP download timed out after 45 seconds");
      }
      throw new Error(`SFTP download error: ${error.message}`);
    }
    throw new Error("Unknown SFTP download error");
  }
}

/**
 * FIXED: Upload function with improved error handling and file creation
 */
async function uploadToAssemblyAI(audioBuffer: ArrayBuffer, apiKey: string, originalFilename?: string) {
  console.log("⬆️ Uploading to AssemblyAI...");
  console.log(`📁 Upload buffer size: ${audioBuffer.byteLength} bytes`);

  if (audioBuffer.byteLength === 0) {
    throw new Error("Audio buffer is empty");
  }

  if (audioBuffer.byteLength < 100) {
    throw new Error("Audio buffer is too small to be valid");
  }

  try {
    // IMPROVED: Re-validate before upload with more lenient approach
    const validation = validateAudioFile(audioBuffer);
    console.log(`🔍 Pre-upload validation:`, validation);

    // CHANGED: More lenient validation - proceed even if validation is uncertain
    if (!validation.isValid && validation.fileType === "text/html") {
      // Only reject if it's clearly an error page
      throw new Error(`Cannot upload error page: ${validation.details}`);
    }

    // IMPROVED: Better filename and MIME type selection
    let mimeType = validation.fileType;
    let extension = validation.extension;
    
    // If validation failed but it's not an error page, assume WAV
    if (!validation.isValid && validation.fileType === "application/octet-stream") {
      console.warn(`⚠️ Validation failed, but assuming WAV format for upload`);
      mimeType = "audio/wav";
      extension = ".wav";
    }

    // Construct filename
    let filename: string;
    if (originalFilename) {
      const baseName = originalFilename.replace(/\.[^/.]+$/, '') || originalFilename;
      filename = `${baseName}${extension}`;
    } else {
      filename = `audio${extension}`;
    }
    
    console.log(`📋 Upload details: filename="${filename}", mimeType="${mimeType}"`);
    
    // IMPROVED: Create File object more safely
    const uint8Array = new Uint8Array(audioBuffer);
    let audioFile: File;
    
    try {
      audioFile = new File([uint8Array], filename, { type: mimeType });
    } catch (fileError) {
      console.warn(`⚠️ File creation failed with mime type ${mimeType}, trying generic audio type`);
      audioFile = new File([uint8Array], filename, { type: "audio/wav" });
    }
    
    // Validate File object
    if (audioFile.size !== audioBuffer.byteLength) {
      throw new Error(`File object size mismatch: expected ${audioBuffer.byteLength}, got ${audioFile.size}`);
    }
    
    console.log(`📋 File object created successfully: ${audioFile.name} (${audioFile.size} bytes, ${audioFile.type})`);

    // Create FormData
    const uploadFormData = new FormData();
    uploadFormData.append("file", audioFile);

    // IMPROVED: Longer timeout for larger files
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes

    console.log(`🚀 Starting upload to AssemblyAI...`);

    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        Authorization: apiKey,
      },
      body: uploadFormData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`⬆️ AssemblyAI Upload Status: ${uploadResponse.status}`);

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("❌ AssemblyAI upload error response:", errorText);
      
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText };
      }
      
      // IMPROVED: Better error messages
      if (uploadResponse.status === 400) {
        console.error("🚨 AssemblyAI rejected the file:");
        console.error("🔍 This usually means the file format is not supported or corrupted");
        console.error("🔍 File details:", {
          filename: audioFile.name,
          size: audioFile.size,
          type: audioFile.type,
          detectedFormat: validation.details
        });
        
        throw new Error(`AssemblyAI rejected the audio file (400). ${JSON.stringify(errorData)}. The file may be corrupted or in an unsupported format.`);
      } else if (uploadResponse.status === 413) {
        throw new Error(`File too large for AssemblyAI (413): ${JSON.stringify(errorData)}`);
      } else if (uploadResponse.status === 401) {
        throw new Error(`AssemblyAI authentication failed (401): Check API key`);
      }
      
      throw new Error(`AssemblyAI upload failed (${uploadResponse.status}): ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    console.log("✅ Upload successful. Upload URL:", uploadData.upload_url);
    
    if (!uploadData.upload_url || typeof uploadData.upload_url !== 'string') {
      console.error("❌ Invalid upload response:", uploadData);
      throw new Error("AssemblyAI upload succeeded but returned invalid upload_url");
    }
    
    return uploadData.upload_url;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("AssemblyAI upload timed out after 3 minutes");
      }
      throw new Error(`AssemblyAI upload error: ${error.message}`);
    }
    throw new Error("Unknown AssemblyAI upload error");
  }
}

export async function POST(request: Request) {
  console.log("🎯 Transcribe API called");
  
  try {
    const body = await request.json();
    console.log("📝 Request body:", {
      hasAudioUrl: !!body.audioUrl,
      isDirectSftpFile: body.isDirectSftpFile,
      sftpFilename: body.sftpFilename,
      filename: body.filename,
      speakerCount: body.speakerCount
    });

    const {
      audioUrl,
      speakerCount = 2,
      filename,
      isDirectSftpFile = false,
      sftpFilename = null,
    } = body;

    // Validation
    if (!audioUrl && !isDirectSftpFile) {
      return NextResponse.json(
        { error: "Either Audio URL or SFTP filename is required" },
        { status: 400 }
      );
    }

    if (!filename) {
      return NextResponse.json(
        { error: "Filename is required for caching" },
        { status: 400 }
      );
    }

    // Check API key
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      console.error("❌ AssemblyAI API key not configured");
      return NextResponse.json(
        { error: "AssemblyAI API key is not configured" },
        { status: 500 }
      );
    }
    console.log("🔑 AssemblyAI API key found");

    let fileToTranscribe: string;

    try {
      if (isDirectSftpFile && sftpFilename) {
        console.log("🔄 Processing SFTP file:", sftpFilename);
        
        // IMPROVED: Download with better error handling
        const audioBuffer = await getSftpAudioBuffer(sftpFilename);
        console.log("✅ SFTP download successful");
        
        const originalFilename = sftpFilename.split('/').pop() || filename;
        console.log(`📝 Using filename for upload: ${originalFilename}`);
        
        // IMPROVED: Upload with more lenient validation
        fileToTranscribe = await uploadToAssemblyAI(audioBuffer, apiKey, originalFilename);
        console.log("✅ AssemblyAI upload successful");
      } else if (audioUrl) {
        console.log("🔄 Processing audio URL:", audioUrl);
        fileToTranscribe = audioUrl;
      } else {
        throw new Error("No valid audio source provided");
      }
    } catch (error) {
      console.error("❌ Error processing audio:", error);
      
      // IMPROVED: More detailed error reporting
      let errorDetails = "Failed during audio processing";
      let troubleshooting: string[] = [];
      
      if (error instanceof Error) {
        if (error.message.includes("File not found")) {
          errorDetails = "Audio file not found on SFTP server";
          troubleshooting = [
            "1. Verify the file path is correct",
            "2. Check if the file exists on the SFTP server",
            "3. Ensure proper file permissions",
            "4. Check if the file was moved or deleted"
          ];
        } else if (error.message.includes("error page") || error.message.includes("Error")) {
          errorDetails = "SFTP server returned an error instead of the audio file";
          troubleshooting = [
            "1. Check SFTP server logs for errors",
            "2. Verify SFTP service is running properly",
            "3. Check file path format and encoding",
            "4. Test SFTP connection manually",
            "5. Ensure the file isn't locked or in use"
          ];
        } else if (error.message.includes("AssemblyAI rejected")) {
          errorDetails = "Audio file format not supported by AssemblyAI";
          troubleshooting = [
            "1. Check if file is a valid audio format (WAV, MP3, OGG, M4A)",
            "2. Verify file is not corrupted",
            "3. Try converting to WAV format",
            "4. Check file size (not too large or too small)",
            "5. Ensure file has proper audio headers"
          ];
        } else if (error.message.includes("timeout")) {
          errorDetails = "Operation timed out - file may be too large";
          troubleshooting = [
            "1. Check file size - smaller files process faster",
            "2. Verify network connectivity",
            "3. Try again during off-peak hours",
            "4. Check server resources"
          ];
        }
      }
      
      return NextResponse.json(
        { 
          error: error instanceof Error ? error.message : "Error processing audio file",
          details: errorDetails,
          troubleshooting,
          timestamp: new Date().toISOString(),
          sftpFilename: sftpFilename || "N/A"
        },
        { status: 500 }
      );
    }

    console.log("🎤 Submitting transcription request to AssemblyAI with file:", fileToTranscribe);

    // Submit the transcription request to AssemblyAI
    const transcriptRequestBody = {
      audio_url: fileToTranscribe,
      speech_model: "slam-1",
      keyterms_prompt: [
        "mycar", "tyre", "auto", "rego", "speaking", "you're", "Pirelli",
        "end", "of", "financial", "year", "sale", "care", "plan",
        "end of financial year sale", "tyre care plan", "quote", "email",
      ],
      speaker_labels: true,
      speakers_expected: speakerCount || 2,
      summarization: true,
      summary_model: "conversational",
      summary_type: "paragraph",
      entity_detection: true,
      sentiment_analysis: true,
    };

    console.log("📋 Transcription request config:", {
      speakers_expected: transcriptRequestBody.speakers_expected,
      speech_model: transcriptRequestBody.speech_model,
      keyterms_count: transcriptRequestBody.keyterms_prompt.length
    });

    const transcriptResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transcriptRequestBody),
    });

    console.log(`📡 AssemblyAI Transcript Request Status: ${transcriptResponse.status}`);

    if (!transcriptResponse.ok) {
      const errorData = await transcriptResponse.json();
      console.error("❌ Transcription request error:", errorData);
      return NextResponse.json(
        { error: "Failed to initiate transcription", details: errorData },
        { status: 500 }
      );
    }

    const { id } = await transcriptResponse.json();
    console.log(`🆔 Transcription job created with ID: ${id}`);

    // Poll for the transcription result
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes

    console.log("⏳ Starting polling for transcription result...");

    while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;

      if (attempts % 10 === 0) { // Log every 10 attempts
        console.log(`⏳ Polling attempt ${attempts}/${maxAttempts}, status: ${status}`);
      }

      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { Authorization: apiKey },
      });

      if (!statusResponse.ok) {
        const errorData = await statusResponse.json();
        console.error("❌ Status check error:", errorData);
        return NextResponse.json(
          { error: "Failed to check transcription status", details: errorData },
          { status: 500 }
        );
      }

      transcript = await statusResponse.json();
      status = transcript.status;
    }

    console.log(`🏁 Final transcription status: ${status} after ${attempts} attempts`);

    if (status === "completed") {
      console.log("✅ Transcription completed successfully");
      console.log(`📝 Transcript length: ${transcript.text?.length || 0} characters`);
      console.log(`🗣️ Utterances count: ${transcript.utterances?.length || 0}`);

      // Map speaker labels to Agent and Customer
      if (transcript.utterances && transcript.utterances.length > 0) {
        transcript.utterances = transcript.utterances.map((utterance: { speaker: string }) => ({
          ...utterance,
          speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      if (transcript.words && transcript.words.length > 0) {
        transcript.words = transcript.words.map((word: { speaker: string }) => ({
          ...word,
          speakerRole: word.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      // Call topic categorization endpoint
      try {
        console.log("🏷️ Starting topic categorization...");
        const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

        const topicResponse = await fetch(`${serverUrl}/api/openAI/categorise`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });

        if (topicResponse.ok) {
          const topicData = await topicResponse.json();
          console.log("✅ Topic categorization completed:", topicData);

          if (topicData.topic_categories && topicData.topic_categories.length > 0) {
            transcript.topic_categorization = {
              primary_topic: topicData.primary_category,
              all_topics: topicData.topic_categories,
              confidence: topicData.confidence || 1.0,
            };
            console.log("🏷️ Added topic categorization to transcript");
          } else {
            console.warn("⚠️ Invalid categorization data received");
            transcript.topic_categorization = {
              primary_topic: "Uncategorised",
              all_topics: ["Uncategorised"],
              confidence: 0,
            };
          }
        } else {
          const errorText = await topicResponse.text();
          console.error("❌ Topic categorization failed:", topicResponse.status, errorText);
          transcript.topic_categorization = {
            primary_topic: "Uncategorised",
            all_topics: ["Uncategorised"],
            confidence: 0,
          };
        }
      } catch (topicError) {
        console.error("❌ Error in topic categorization:", topicError);
        transcript.topic_categorization = {
          primary_topic: "Uncategorised",
          all_topics: ["Uncategorised"],
          confidence: 0,
        };
      }

      // Save to Supabase
      try {
        const callId = filename.replace(/\.[^/.]+$/, "");
        const transcriptText = transcript.text || "";
        console.log("💾 Attempting to save to Supabase...");
        await saveToSupabase(callId, transcript, transcriptText);
      } catch (supabaseError) {
        console.error("❌ Supabase save failed (continuing anyway):", supabaseError);
      }

      console.log("🎉 Transcription process completed successfully");
      return NextResponse.json(transcript);

    } else if (attempts >= maxAttempts) {
      console.error("⏰ Transcription timed out");
      return NextResponse.json(
        { error: "Transcription timed out. The file might be too large or the service is busy." },
        { status: 504 }
      );
    } else {
      console.error(`❌ Transcription failed with status: ${status}`);
      return NextResponse.json(
        {
          error: `Transcription failed with status: ${status}`,
          details: transcript?.error || "Unknown error",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("💥 Unexpected error in transcribe API route:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        message: error instanceof Error ? error.message : "Unknown Error",
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}