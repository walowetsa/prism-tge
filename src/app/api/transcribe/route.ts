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
 * Helper function to validate audio file format
 */
function validateAudioFile(buffer: ArrayBuffer): { isValid: boolean; fileType: string; details: string } {
  const uint8Array = new Uint8Array(buffer);
  
  if (uint8Array.length < 12) {
    return { isValid: false, fileType: "unknown", details: "File too small to be valid audio" };
  }

  // Check for WAV format (RIFF container with WAVE format)
  const riffHeader = Array.from(uint8Array.slice(0, 4)).map(b => String.fromCharCode(b)).join('');
  const waveHeader = Array.from(uint8Array.slice(8, 12)).map(b => String.fromCharCode(b)).join('');
  
  if (riffHeader === 'RIFF' && waveHeader === 'WAVE') {
    return { isValid: true, fileType: "audio/wav", details: "Valid WAV file" };
  }

  // Check for MP3 format
  if (uint8Array.length >= 3) {
    // MP3 files can start with ID3 tags or direct audio frames
    const id3Header = Array.from(uint8Array.slice(0, 3)).map(b => String.fromCharCode(b)).join('');
    if (id3Header === 'ID3') {
      return { isValid: true, fileType: "audio/mpeg", details: "Valid MP3 file with ID3 tags" };
    }
    
    // Check for MP3 frame sync (0xFF followed by 0xFB, 0xFA, or 0xF3, 0xF2)
    if (uint8Array[0] === 0xFF && (uint8Array[1] & 0xE0) === 0xE0) {
      return { isValid: true, fileType: "audio/mpeg", details: "Valid MP3 file" };
    }
  }

  // Check for OGG format
  if (uint8Array.length >= 4) {
    const oggHeader = Array.from(uint8Array.slice(0, 4)).map(b => String.fromCharCode(b)).join('');
    if (oggHeader === 'OggS') {
      return { isValid: true, fileType: "audio/ogg", details: "Valid OGG file" };
    }
  }

  // Check for M4A/AAC format
  if (uint8Array.length >= 8) {
    const m4aHeader = Array.from(uint8Array.slice(4, 8)).map(b => String.fromCharCode(b)).join('');
    if (m4aHeader === 'ftyp') {
      return { isValid: true, fileType: "audio/mp4", details: "Valid M4A/MP4 audio file" };
    }
  }

  // If we get here, it's not a recognized audio format
  const firstBytes = Array.from(uint8Array.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  return { 
    isValid: false, 
    fileType: "application/octet-stream", 
    details: `Unrecognized audio format. First 16 bytes: ${firstBytes}`
  };
}

/**
 * Helper function to download a file from SFTP with improved error handling
 * Returns ArrayBuffer instead of Blob
 */
async function getSftpAudioBuffer(sftpFilename: string): Promise<ArrayBuffer> {
  console.log("🔄 Downloading SFTP file:", sftpFilename);

  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
  const sftpApiUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;

  console.log("📡 SFTP API URL:", sftpApiUrl);

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const audioResponse = await fetch(sftpApiUrl, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`📡 SFTP Response Status: ${audioResponse.status}`);
    console.log(`📡 SFTP Response Headers:`, Object.fromEntries(audioResponse.headers.entries()));

    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("❌ SFTP download failed:", errorText);
      throw new Error(`SFTP download failed: ${audioResponse.status} - ${errorText}`);
    }

    // Get as ArrayBuffer directly
    const audioArrayBuffer = await audioResponse.arrayBuffer();
    console.log(`📁 Audio ArrayBuffer size: ${audioArrayBuffer.byteLength} bytes`);

    if (audioArrayBuffer.byteLength === 0) {
      throw new Error("Retrieved audio file is empty");
    }

    if (audioArrayBuffer.byteLength < 1000) {
      throw new Error("Audio file is too small to be valid (< 1KB)");
    }

    // Validate the audio file format
    const validation = validateAudioFile(audioArrayBuffer);
    console.log(`🔍 Audio validation result:`, validation);

    if (!validation.isValid) {
      const uint8Array = new Uint8Array(audioArrayBuffer);
      const firstBytes = Array.from(uint8Array.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.error(`❌ Invalid audio file format. Details: ${validation.details}`);
      console.error(`🔍 First 32 bytes: ${firstBytes}`);
      
      // Try to detect if this might be a text file or HTML error page
      const textContent = Array.from(uint8Array.slice(0, 100))
        .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
        .join('');
      console.error(`🔍 Text interpretation of first 100 bytes: "${textContent}"`);
      
      throw new Error(`Invalid audio file format: ${validation.details}. File appears to be ${validation.fileType}`);
    }

    console.log(`✅ Valid ${validation.fileType} file detected: ${validation.details}`);
    return audioArrayBuffer;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("SFTP download timed out after 30 seconds");
      }
      throw new Error(`SFTP download error: ${error.message}`);
    }
    throw new Error("Unknown SFTP download error");
  }
}

/**
 * Helper function to upload audio to AssemblyAI using ArrayBuffer
 * Eliminates blob conversion which may cause issues
 */
async function uploadToAssemblyAI(audioBuffer: ArrayBuffer, apiKey: string, originalFilename?: string) {
  console.log("⬆️ Uploading to AssemblyAI...");
  console.log(`📁 Upload buffer size: ${audioBuffer.byteLength} bytes`);

  // Validate audio buffer
  if (audioBuffer.byteLength === 0) {
    throw new Error("Audio buffer is empty");
  }

  if (audioBuffer.byteLength < 1000) {
    throw new Error("Audio buffer is too small to be valid (< 1KB)");
  }

  try {
    // Re-validate the audio file format before upload
    const validation = validateAudioFile(audioBuffer);
    console.log(`🔍 Pre-upload validation:`, validation);

    if (!validation.isValid) {
      throw new Error(`Cannot upload invalid audio file: ${validation.details}`);
    }
    
    // Determine proper file extension and MIME type
    let fileExtension = '.wav';
    let mimeType = validation.fileType;
    
    if (validation.fileType === 'audio/mpeg') {
      fileExtension = '.mp3';
    } else if (validation.fileType === 'audio/ogg') {
      fileExtension = '.ogg';
    } else if (validation.fileType === 'audio/mp4') {
      fileExtension = '.m4a';
    }
    
    // Create proper filename with correct extension
    let filename = originalFilename || 'audio.wav';
    if (originalFilename && !originalFilename.includes('.')) {
      filename = originalFilename + fileExtension;
    } else if (originalFilename && !originalFilename.endsWith(fileExtension)) {
      // Replace extension if it doesn't match detected format
      filename = originalFilename.replace(/\.[^/.]+$/, fileExtension);
    }
    
    console.log(`📋 Using filename: ${filename} with MIME type: ${mimeType}`);
    
    // Create a File object directly from the ArrayBuffer
    const audioFile = new File([audioBuffer], filename, { 
      type: mimeType,
      lastModified: Date.now()
    });
    
    // Create FormData
    const uploadFormData = new FormData();
    uploadFormData.append("file", audioFile);

    // Log detailed information for debugging
    console.log(`📋 FormData details:`);
    console.log(`   - Filename: ${filename}`);
    console.log(`   - File size: ${audioFile.size} bytes`);
    console.log(`   - MIME type: ${audioFile.type}`);
    console.log(`   - Detected format: ${validation.details}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 seconds for larger files

    console.log(`🚀 Starting upload to AssemblyAI...`);

    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        // Don't set Content-Type manually - let browser set it with boundary for multipart/form-data
      },
      body: uploadFormData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log(`⬆️ AssemblyAI Upload Status: ${uploadResponse.status}`);
    console.log(`📋 AssemblyAI Response Headers:`, Object.fromEntries(uploadResponse.headers.entries()));

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("❌ AssemblyAI upload error response:", errorText);
      
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText };
      }
      
      // Provide more specific error information
      if (uploadResponse.status === 400) {
        console.error("🚨 Bad Request - likely audio format issue");
        console.error("🔍 File validation details:", validation);
        console.error("🔍 Check if AssemblyAI supports this audio format");
      } else if (uploadResponse.status === 413) {
        console.error("🚨 File too large for AssemblyAI");
      }
      
      throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    console.log("✅ Upload successful. Upload URL:", uploadData.upload_url);
    
    // Validate we got a proper upload URL
    if (!uploadData.upload_url) {
      throw new Error("AssemblyAI upload succeeded but no upload_url returned");
    }
    
    return uploadData.upload_url;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error("AssemblyAI upload timed out after 90 seconds");
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
        
        // Get audio buffer from SFTP (no blob creation)
        const audioBuffer = await getSftpAudioBuffer(sftpFilename);
        console.log("✅ SFTP download successful");
        
        // Extract filename for better upload handling
        const originalFilename = sftpFilename.split('/').pop() || filename;
        console.log(`📝 Using filename for upload: ${originalFilename}`);
        
        // Upload to AssemblyAI using ArrayBuffer directly
        fileToTranscribe = await uploadToAssemblyAI(audioBuffer, apiKey, originalFilename);
        console.log("✅ AssemblyAI upload successful");
      } else if (audioUrl) {
        console.log("🔄 Processing audio URL:", audioUrl);
        // For URL-based audio, use the URL directly
        fileToTranscribe = audioUrl;
      } else {
        throw new Error("No valid audio source provided");
      }
    } catch (error) {
      console.error("❌ Error processing audio:", error);
      
      // Provide more specific error information for debugging
      let errorDetails = "Failed during audio acquisition or upload phase";
      if (error instanceof Error) {
        if (error.message.includes("SFTP download")) {
          errorDetails = "SFTP download failed - check if file exists and is accessible";
        } else if (error.message.includes("AssemblyAI upload")) {
          errorDetails = "AssemblyAI upload failed - likely audio format issue";
        } else if (error.message.includes("empty")) {
          errorDetails = "Audio file is empty or corrupted";
        } else if (error.message.includes("WAV headers")) {
          errorDetails = "Audio file doesn't appear to be a valid WAV file";
        }
      }
      
      return NextResponse.json(
        { 
          error: error instanceof Error ? error.message : "Error processing audio file",
          details: errorDetails,
          troubleshooting: [
            "1. Check if the file exists on SFTP server",
            "2. Verify file is a valid audio format (WAV, MP3, OGG, M4A)",
            "3. Ensure file size > 1KB and is not corrupted",
            "4. Check if SFTP server is returning an error page instead of the audio file",
            "5. Verify the SFTP download endpoint is working correctly",
            "6. Check server logs for detailed error information",
            "7. Try downloading a small test file first to verify SFTP connectivity"
          ]
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